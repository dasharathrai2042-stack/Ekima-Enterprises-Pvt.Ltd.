-- ============================================================================
-- PHASE 1.1 MIGRATION 0001: Core Multi-Company Organization, Nepal Fiscal Year,
--                           RBAC Governance & Complete Row Level Security (RLS)
-- File: 202611190001_phase1_core_org_rbac.sql (Synced with 0001.sql)
-- Target: Supabase PostgreSQL (15+ / 16+) — Non-Destructive & Idempotent
--
-- Prerequisites (Supabase Runtime):
--   - auth schema with auth.users(id) and auth.uid()
--   - Supabase database roles: anon, authenticated, service_role
--
-- Downstream Migration Dependencies Preserved:
--   - 0002 (Accounting): companies(id), branches(id), profiles(id), erp_set_updated_at()
--   - 0003 (Commercial/Inventory/Audit): companies(id), branches(id), profiles(id), erp_set_updated_at()
--   - 0004 (Extended RLS): erp_is_super_admin(), erp_has_company_access(uuid),
--                          erp_has_branch_access(uuid, uuid), erp_has_permission(uuid, varchar)
--
-- SECURITY NOTICE:
--   - Never expose SUPABASE_SERVICE_ROLE_KEY in frontend code.
--   - Do NOT claim production readiness until validated on a live Supabase/PostgreSQL
--     staging environment with real JWT role tests (anon, authenticated, service_role).
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ----------------------------------------------------------------------------
-- 0. PRE-FLIGHT DEPENDENCY CHECK (Fail fast with clear diagnostics if non-Supabase)
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  IF to_regclass('auth.users') IS NULL THEN
    RAISE EXCEPTION 'Migration 0001 dependency missing: auth.users table not found. Run this migration on Supabase PostgreSQL (or provision the auth schema first).';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    RAISE EXCEPTION 'Migration 0001 dependency missing: PostgreSQL role "authenticated" not found. Supabase Auth roles are required for RLS policies.';
  END IF;
END $$;

-- ----------------------------------------------------------------------------
-- 1. SHARED UTILITY, TRUSTED-ADMIN & COMPANY-AWARE NEPAL FISCAL YEAR FUNCTIONS
--    Every function sets explicit search_path = public, pg_catalog to prevent
--    search_path hijacking (Supabase Security Advisor compliant).
-- ----------------------------------------------------------------------------

-- Uses native timestamptz now() to avoid session-timezone cast drift
CREATE OR REPLACE FUNCTION public.erp_set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

-- Detects whether the current transaction is executed by a trusted server-side admin
-- (postgres / supabase_admin / service_role) and NOT a browser/authenticated JWT.
-- Supports both legacy PostgREST request.jwt.claim.role and modern request.jwt.claims JSON.
CREATE OR REPLACE FUNCTION public.erp_is_trusted_server_admin()
RETURNS boolean
LANGUAGE plpgsql
STABLE
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_jwt_role   text;
  v_claims_raw text;
BEGIN
  v_jwt_role := NULLIF(current_setting('request.jwt.claim.role', true), '');

  IF v_jwt_role IS NULL THEN
    v_claims_raw := NULLIF(current_setting('request.jwt.claims', true), '');
    IF v_claims_raw IS NOT NULL THEN
      BEGIN
        v_jwt_role := NULLIF((v_claims_raw::jsonb ->> 'role'), '');
      EXCEPTION WHEN others THEN
        -- Treat malformed JWT claims conservatively as untrusted
        v_jwt_role := 'invalid_jwt_claims';
      END;
    END IF;
  END IF;

  RETURN (
    (
      current_user IN ('postgres', 'supabase_admin', 'service_role')
      AND COALESCE(v_jwt_role, 'service_role') = 'service_role'
    )
    OR (
      v_jwt_role IS NULL
      AND EXISTS (
        SELECT 1
        FROM pg_catalog.pg_roles r
        WHERE r.rolname = current_user
          AND r.rolsuper = true
      )
    )
  );
END;
$$;

-- Dynamic Nepal/company fiscal year start date (defaults to Shrawan 1 ~= July 16)
CREATE OR REPLACE FUNCTION public.erp_nepal_fy_start(
  p_ref_date    date DEFAULT CURRENT_DATE,
  p_start_month integer DEFAULT 7,
  p_start_day   integer DEFAULT 16
)
RETURNS date
LANGUAGE plpgsql
STABLE
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_ref_date date := COALESCE(p_ref_date, CURRENT_DATE);
  v_year     integer;
  v_boundary date;
BEGIN
  IF p_start_month IS NULL OR p_start_month < 1 OR p_start_month > 12 THEN
    RAISE EXCEPTION 'Invalid fiscal year start month: %. Expected 1..12.', p_start_month;
  END IF;
  IF p_start_day IS NULL OR p_start_day < 1 OR p_start_day > 28 THEN
    RAISE EXCEPTION 'Invalid fiscal year start day: %. Expected 1..28.', p_start_day;
  END IF;

  v_year := EXTRACT(YEAR FROM v_ref_date)::integer;
  v_boundary := make_date(v_year, p_start_month, p_start_day);

  IF v_ref_date >= v_boundary THEN
    RETURN v_boundary;
  END IF;
  RETURN make_date(v_year - 1, p_start_month, p_start_day);
END;
$$;

-- Dynamic fiscal year end date (day before next fiscal year start)
CREATE OR REPLACE FUNCTION public.erp_nepal_fy_end(
  p_ref_date    date DEFAULT CURRENT_DATE,
  p_start_month integer DEFAULT 7,
  p_start_day   integer DEFAULT 16
)
RETURNS date
LANGUAGE sql
STABLE
SET search_path = public, pg_catalog
AS $$
  SELECT (public.erp_nepal_fy_start(p_ref_date, p_start_month, p_start_day) + INTERVAL '1 year' - INTERVAL '1 day')::date;
$$;

-- Dynamic Bikram Sambat fiscal year display label (e.g., '2082/83', '2083/84').
-- Accounts for Baisakh 1 (~April 14): dates before April 14 map to AD + 56;
-- dates on/after April 14 map to AD + 57.
CREATE OR REPLACE FUNCTION public.erp_nepal_fy_label_bs(
  p_ref_date    date DEFAULT CURRENT_DATE,
  p_start_month integer DEFAULT 7,
  p_start_day   integer DEFAULT 16
)
RETURNS varchar(20)
LANGUAGE plpgsql
STABLE
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_fy_start      date    := public.erp_nepal_fy_start(p_ref_date, p_start_month, p_start_day);
  v_start_ad_year integer := EXTRACT(YEAR FROM v_fy_start)::integer;
  v_start_month   integer := EXTRACT(MONTH FROM v_fy_start)::integer;
  v_start_day     integer := EXTRACT(DAY FROM v_fy_start)::integer;
  v_bs_start_year integer;
  v_bs_end_short  text;
BEGIN
  IF v_start_month < 4 OR (v_start_month = 4 AND v_start_day < 14) THEN
    v_bs_start_year := v_start_ad_year + 56;
  ELSE
    v_bs_start_year := v_start_ad_year + 57;
  END IF;

  v_bs_end_short := LPAD(((v_bs_start_year + 1) % 100)::text, 2, '0');
  RETURN (v_bs_start_year::text || '/' || v_bs_end_short)::varchar(20);
END;
$$;

-- Company-aware fiscal year display label respecting bs_calendar_enabled
CREATE OR REPLACE FUNCTION public.erp_company_fy_label(
  p_ref_date            date DEFAULT CURRENT_DATE,
  p_start_month         integer DEFAULT 7,
  p_start_day           integer DEFAULT 16,
  p_bs_calendar_enabled boolean DEFAULT true
)
RETURNS varchar(20)
LANGUAGE plpgsql
STABLE
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_fy_start      date;
  v_start_ad_year integer;
  v_end_ad_short  text;
BEGIN
  IF COALESCE(p_bs_calendar_enabled, true) THEN
    RETURN public.erp_nepal_fy_label_bs(p_ref_date, p_start_month, p_start_day);
  END IF;

  v_fy_start := public.erp_nepal_fy_start(p_ref_date, p_start_month, p_start_day);
  v_start_ad_year := EXTRACT(YEAR FROM v_fy_start)::integer;

  -- Calendar-year AD company (Jan 1 - Dec 31) displays '2026'; split AD year displays '2025/26'
  IF EXTRACT(MONTH FROM v_fy_start)::integer = 1 AND EXTRACT(DAY FROM v_fy_start)::integer = 1 THEN
    RETURN v_start_ad_year::varchar(20);
  END IF;

  v_end_ad_short := LPAD(((v_start_ad_year + 1) % 100)::text, 2, '0');
  RETURN (v_start_ad_year::text || '/' || v_end_ad_short)::varchar(20);
END;
$$;

-- ----------------------------------------------------------------------------
-- 2. COMPANIES (Legal Entities / Tenants)
--    Note: current_fiscal_year_bs, fiscal_start_date, fiscal_end_date have NO
--    hardcoded (7, 16) column DEFAULT; trg_companies_sync_fiscal_year computes
--    them dynamically from each company's own fiscal_year_start_month/day and
--    bs_calendar_enabled when omitted, while honoring explicit Shrawan 1 dates.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.companies (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code                     varchar(20) NOT NULL UNIQUE,
  legal_name               varchar(200) NOT NULL,
  trade_name               varchar(200),
  logo_url                 text,
  tax_id_label             varchar(30) NOT NULL DEFAULT 'VAT/PAN',
  pan_vat_number           varchar(50) NOT NULL,
  vat_registered           boolean NOT NULL DEFAULT true,
  default_vat_rate         numeric(5, 2) NOT NULL DEFAULT 13.00 CHECK (default_vat_rate >= 0 AND default_vat_rate <= 100),
  currency_code            varchar(3) NOT NULL DEFAULT 'NPR' CHECK (char_length(currency_code) = 3),
  bs_calendar_enabled      boolean NOT NULL DEFAULT true,
  fiscal_year_start_month  smallint NOT NULL DEFAULT 7 CHECK (fiscal_year_start_month BETWEEN 1 AND 12),
  fiscal_year_start_day    smallint NOT NULL DEFAULT 16 CHECK (fiscal_year_start_day BETWEEN 1 AND 28),
  current_fiscal_year_bs   varchar(20) NOT NULL,
  fiscal_start_date        date NOT NULL,
  fiscal_end_date          date NOT NULL,
  invoice_prefix           varchar(20) NOT NULL DEFAULT 'INV',
  next_invoice_seq         bigint NOT NULL DEFAULT 1001 CHECK (next_invoice_seq >= 1),
  purchase_prefix          varchar(20) NOT NULL DEFAULT 'PUR',
  next_purchase_seq        bigint NOT NULL DEFAULT 1001 CHECK (next_purchase_seq >= 1),
  receipt_prefix           varchar(20) NOT NULL DEFAULT 'RCP',
  next_receipt_seq         bigint NOT NULL DEFAULT 1001 CHECK (next_receipt_seq >= 1),
  payment_prefix           varchar(20) NOT NULL DEFAULT 'PAY',
  next_payment_seq         bigint NOT NULL DEFAULT 1001 CHECK (next_payment_seq >= 1),
  journal_prefix           varchar(20) NOT NULL DEFAULT 'JV',
  next_journal_seq         bigint NOT NULL DEFAULT 1001 CHECK (next_journal_seq >= 1),
  approval_threshold       numeric(18, 2) NOT NULL DEFAULT 500000.00 CHECK (approval_threshold >= 0),
  address                  text NOT NULL DEFAULT '',
  phone                    varchar(50),
  email                    varchar(150),
  is_active                boolean NOT NULL DEFAULT true,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_companies_non_empty_identity CHECK (
    btrim(code) <> '' AND btrim(legal_name) <> '' AND btrim(pan_vat_number) <> ''
  ),
  CONSTRAINT chk_companies_fy_start_bounds CHECK (
    fiscal_year_start_month BETWEEN 1 AND 12 AND fiscal_year_start_day BETWEEN 1 AND 28
  ),
  CONSTRAINT chk_companies_fiscal_range CHECK (fiscal_end_date > fiscal_start_date)
);

-- Non-destructive existing-schema upgrade compatibility for public.companies
ALTER TABLE public.companies
  ADD COLUMN IF NOT EXISTS trade_name              varchar(200),
  ADD COLUMN IF NOT EXISTS logo_url                text,
  ADD COLUMN IF NOT EXISTS tax_id_label            varchar(30) NOT NULL DEFAULT 'VAT/PAN',
  ADD COLUMN IF NOT EXISTS vat_registered          boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS default_vat_rate        numeric(5, 2) NOT NULL DEFAULT 13.00,
  ADD COLUMN IF NOT EXISTS currency_code           varchar(3) NOT NULL DEFAULT 'NPR',
  ADD COLUMN IF NOT EXISTS bs_calendar_enabled     boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS fiscal_year_start_month smallint NOT NULL DEFAULT 7,
  ADD COLUMN IF NOT EXISTS fiscal_year_start_day   smallint NOT NULL DEFAULT 16,
  ADD COLUMN IF NOT EXISTS current_fiscal_year_bs  varchar(20),
  ADD COLUMN IF NOT EXISTS fiscal_start_date       date,
  ADD COLUMN IF NOT EXISTS fiscal_end_date         date,
  ADD COLUMN IF NOT EXISTS invoice_prefix          varchar(20) NOT NULL DEFAULT 'INV',
  ADD COLUMN IF NOT EXISTS next_invoice_seq        bigint NOT NULL DEFAULT 1001,
  ADD COLUMN IF NOT EXISTS purchase_prefix         varchar(20) NOT NULL DEFAULT 'PUR',
  ADD COLUMN IF NOT EXISTS next_purchase_seq       bigint NOT NULL DEFAULT 1001,
  ADD COLUMN IF NOT EXISTS receipt_prefix          varchar(20) NOT NULL DEFAULT 'RCP',
  ADD COLUMN IF NOT EXISTS next_receipt_seq        bigint NOT NULL DEFAULT 1001,
  ADD COLUMN IF NOT EXISTS payment_prefix          varchar(20) NOT NULL DEFAULT 'PAY',
  ADD COLUMN IF NOT EXISTS next_payment_seq        bigint NOT NULL DEFAULT 1001,
  ADD COLUMN IF NOT EXISTS journal_prefix          varchar(20) NOT NULL DEFAULT 'JV',
  ADD COLUMN IF NOT EXISTS next_journal_seq        bigint NOT NULL DEFAULT 1001,
  ADD COLUMN IF NOT EXISTS approval_threshold      numeric(18, 2) NOT NULL DEFAULT 500000.00,
  ADD COLUMN IF NOT EXISTS address                 text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS phone                   varchar(50),
  ADD COLUMN IF NOT EXISTS email                   varchar(150),
  ADD COLUMN IF NOT EXISTS is_active               boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS created_at              timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS updated_at              timestamptz NOT NULL DEFAULT now();

-- Backfill NULL fiscal columns on legacy company rows using each company's own settings
UPDATE public.companies c
SET
  fiscal_start_date = COALESCE(
    c.fiscal_start_date,
    public.erp_nepal_fy_start(CURRENT_DATE, c.fiscal_year_start_month, c.fiscal_year_start_day)
  ),
  fiscal_end_date = COALESCE(
    c.fiscal_end_date,
    public.erp_nepal_fy_end(CURRENT_DATE, c.fiscal_year_start_month, c.fiscal_year_start_day)
  ),
  current_fiscal_year_bs = COALESCE(
    NULLIF(btrim(c.current_fiscal_year_bs), ''),
    public.erp_company_fy_label(CURRENT_DATE, c.fiscal_year_start_month, c.fiscal_year_start_day, c.bs_calendar_enabled)
  )
WHERE c.fiscal_start_date IS NULL
   OR c.fiscal_end_date IS NULL
   OR c.current_fiscal_year_bs IS NULL
   OR btrim(c.current_fiscal_year_bs) = '';

-- Drop any hardcoded column defaults so trg_companies_sync_fiscal_year controls dynamic values
ALTER TABLE public.companies
  ALTER COLUMN current_fiscal_year_bs DROP DEFAULT,
  ALTER COLUMN current_fiscal_year_bs SET NOT NULL,
  ALTER COLUMN fiscal_start_date      DROP DEFAULT,
  ALTER COLUMN fiscal_start_date      SET NOT NULL,
  ALTER COLUMN fiscal_end_date        DROP DEFAULT,
  ALTER COLUMN fiscal_end_date        SET NOT NULL,
  ALTER COLUMN created_at             SET DEFAULT now(),
  ALTER COLUMN updated_at             SET DEFAULT now();

DO $$
DECLARE
  v_invalid_count bigint;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_companies_non_empty_identity'
      AND conrelid = 'public.companies'::regclass
  ) THEN
    ALTER TABLE public.companies
      ADD CONSTRAINT chk_companies_non_empty_identity
      CHECK (btrim(code) <> '' AND btrim(legal_name) <> '' AND btrim(pan_vat_number) <> '') NOT VALID;

    SELECT count(*) INTO v_invalid_count
    FROM public.companies
    WHERE btrim(code) = '' OR btrim(legal_name) = '' OR btrim(pan_vat_number) = '';

    IF v_invalid_count = 0 THEN
      ALTER TABLE public.companies VALIDATE CONSTRAINT chk_companies_non_empty_identity;
    ELSE
      RAISE WARNING 'chk_companies_non_empty_identity left NOT VALID: % legacy company rows have blank code/legal_name/pan_vat_number.', v_invalid_count;
    END IF;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_companies_fy_start_bounds'
      AND conrelid = 'public.companies'::regclass
  ) THEN
    ALTER TABLE public.companies
      ADD CONSTRAINT chk_companies_fy_start_bounds
      CHECK (fiscal_year_start_month BETWEEN 1 AND 12 AND fiscal_year_start_day BETWEEN 1 AND 28) NOT VALID;

    SELECT count(*) INTO v_invalid_count
    FROM public.companies
    WHERE fiscal_year_start_month NOT BETWEEN 1 AND 12 OR fiscal_year_start_day NOT BETWEEN 1 AND 28;

    IF v_invalid_count = 0 THEN
      ALTER TABLE public.companies VALIDATE CONSTRAINT chk_companies_fy_start_bounds;
    ELSE
      RAISE WARNING 'chk_companies_fy_start_bounds left NOT VALID: % legacy company rows out of bounds.', v_invalid_count;
    END IF;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_companies_fiscal_range'
      AND conrelid = 'public.companies'::regclass
  ) THEN
    ALTER TABLE public.companies
      ADD CONSTRAINT chk_companies_fiscal_range
      CHECK (fiscal_end_date > fiscal_start_date) NOT VALID;

    SELECT count(*) INTO v_invalid_count
    FROM public.companies
    WHERE fiscal_end_date <= fiscal_start_date;

    IF v_invalid_count = 0 THEN
      ALTER TABLE public.companies VALIDATE CONSTRAINT chk_companies_fiscal_range;
    ELSE
      RAISE WARNING 'chk_companies_fiscal_range left NOT VALID: % legacy company rows have fiscal_end_date <= fiscal_start_date.', v_invalid_count;
    END IF;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_companies_active ON public.companies (is_active);

DROP TRIGGER IF EXISTS trg_companies_updated_at ON public.companies;
CREATE TRIGGER trg_companies_updated_at
  BEFORE UPDATE ON public.companies
  FOR EACH ROW EXECUTE FUNCTION public.erp_set_updated_at();

-- Respect company-specific fiscal_year_start_month, fiscal_year_start_day, and bs_calendar_enabled
CREATE OR REPLACE FUNCTION public.erp_sync_company_fiscal_year()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_month smallint := COALESCE(NEW.fiscal_year_start_month, 7);
  v_day   smallint := COALESCE(NEW.fiscal_year_start_day, 16);
  v_bs    boolean  := COALESCE(NEW.bs_calendar_enabled, true);
  v_ref   date;
BEGIN
  NEW.fiscal_year_start_month := v_month;
  NEW.fiscal_year_start_day   := v_day;
  NEW.bs_calendar_enabled     := v_bs;

  IF TG_OP = 'INSERT' THEN
    IF NEW.fiscal_start_date IS NULL THEN
      NEW.fiscal_start_date := public.erp_nepal_fy_start(CURRENT_DATE, v_month, v_day);
    END IF;

    IF NEW.fiscal_end_date IS NULL THEN
      NEW.fiscal_end_date := (NEW.fiscal_start_date + INTERVAL '1 year' - INTERVAL '1 day')::date;
    END IF;

    IF NEW.current_fiscal_year_bs IS NULL OR btrim(NEW.current_fiscal_year_bs) = '' THEN
      NEW.current_fiscal_year_bs := public.erp_company_fy_label(
        NEW.fiscal_start_date,
        EXTRACT(MONTH FROM NEW.fiscal_start_date)::integer,
        LEAST(EXTRACT(DAY FROM NEW.fiscal_start_date)::integer, 28),
        v_bs
      );
    END IF;
  ELSIF TG_OP = 'UPDATE' THEN
    -- If fiscal cycle settings changed and caller did not explicitly supply custom dates, recompute from company settings
    IF (
      NEW.fiscal_year_start_month IS DISTINCT FROM OLD.fiscal_year_start_month
      OR NEW.fiscal_year_start_day IS DISTINCT FROM OLD.fiscal_year_start_day
    ) THEN
      IF NEW.fiscal_start_date IS NOT DISTINCT FROM OLD.fiscal_start_date THEN
        NEW.fiscal_start_date := public.erp_nepal_fy_start(CURRENT_DATE, v_month, v_day);
      END IF;
      IF NEW.fiscal_end_date IS NOT DISTINCT FROM OLD.fiscal_end_date THEN
        NEW.fiscal_end_date := (NEW.fiscal_start_date + INTERVAL '1 year' - INTERVAL '1 day')::date;
      END IF;
      IF NEW.current_fiscal_year_bs IS NOT DISTINCT FROM OLD.current_fiscal_year_bs THEN
        NEW.current_fiscal_year_bs := public.erp_company_fy_label(
          NEW.fiscal_start_date,
          EXTRACT(MONTH FROM NEW.fiscal_start_date)::integer,
          LEAST(EXTRACT(DAY FROM NEW.fiscal_start_date)::integer, 28),
          v_bs
        );
      END IF;
    ELSIF NEW.bs_calendar_enabled IS DISTINCT FROM OLD.bs_calendar_enabled
      AND NEW.current_fiscal_year_bs IS NOT DISTINCT FROM OLD.current_fiscal_year_bs THEN
      v_ref := COALESCE(NEW.fiscal_start_date, CURRENT_DATE);
      NEW.current_fiscal_year_bs := public.erp_company_fy_label(
        v_ref,
        EXTRACT(MONTH FROM v_ref)::integer,
        LEAST(EXTRACT(DAY FROM v_ref)::integer, 28),
        v_bs
      );
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_companies_sync_fiscal_year ON public.companies;
CREATE TRIGGER trg_companies_sync_fiscal_year
  BEFORE INSERT OR UPDATE ON public.companies
  FOR EACH ROW EXECUTE FUNCTION public.erp_sync_company_fiscal_year();

-- ----------------------------------------------------------------------------
-- 2B. FISCAL_YEARS (Company-Specific Multi-Year BS/AD Periods & Period Closing)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.fiscal_years (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id               uuid NOT NULL REFERENCES public.companies(id) ON DELETE RESTRICT,
  label_bs                 varchar(20) NOT NULL CHECK (btrim(label_bs) <> ''),
  start_date               date NOT NULL,
  end_date                 date NOT NULL,
  is_current               boolean NOT NULL DEFAULT false,
  is_closed                boolean NOT NULL DEFAULT false,
  closed_at                timestamptz,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, label_bs),
  CONSTRAINT chk_fiscal_years_range CHECK (end_date > start_date),
  CONSTRAINT chk_fiscal_years_closed_at CHECK (closed_at IS NULL OR is_closed = true)
);

ALTER TABLE public.fiscal_years
  ALTER COLUMN created_at SET DEFAULT now(),
  ALTER COLUMN updated_at SET DEFAULT now();

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_fiscal_years_closed_at'
      AND conrelid = 'public.fiscal_years'::regclass
  ) THEN
    ALTER TABLE public.fiscal_years
      ADD CONSTRAINT chk_fiscal_years_closed_at
      CHECK (closed_at IS NULL OR is_closed = true);
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_fiscal_years_single_current
  ON public.fiscal_years (company_id)
  WHERE is_current = true;
CREATE INDEX IF NOT EXISTS idx_fiscal_years_company_dates
  ON public.fiscal_years (company_id, start_date DESC);

DROP TRIGGER IF EXISTS trg_fiscal_years_updated_at ON public.fiscal_years;
CREATE TRIGGER trg_fiscal_years_updated_at
  BEFORE UPDATE ON public.fiscal_years
  FOR EACH ROW EXECUTE FUNCTION public.erp_set_updated_at();

-- Prevent moving fiscal_years across companies, overlapping date ranges, or mutating closed years
CREATE OR REPLACE FUNCTION public.erp_validate_fiscal_year()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.is_closed = true THEN
      RAISE EXCEPTION 'Forbidden: closed fiscal year (%) cannot be deleted.', OLD.label_bs;
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF NEW.company_id IS DISTINCT FROM OLD.company_id THEN
      RAISE EXCEPTION 'Forbidden: fiscal_year (%) cannot be moved to a different company_id.', OLD.id;
    END IF;

    IF OLD.is_closed = true AND (
      NEW.label_bs IS DISTINCT FROM OLD.label_bs
      OR NEW.start_date IS DISTINCT FROM OLD.start_date
      OR NEW.end_date IS DISTINCT FROM OLD.end_date
    ) THEN
      RAISE EXCEPTION 'Forbidden: closed fiscal year (%) dates or label cannot be modified.', OLD.label_bs;
    END IF;
  END IF;

  IF NEW.is_closed = true AND NEW.closed_at IS NULL THEN
    NEW.closed_at := now();
  ELSIF NEW.is_closed = false THEN
    NEW.closed_at := NULL;
  END IF;

  -- Prevent overlapping fiscal years within the same company (no btree_gist extension required)
  IF EXISTS (
    SELECT 1
    FROM public.fiscal_years fy
    WHERE fy.company_id = NEW.company_id
      AND fy.id IS DISTINCT FROM NEW.id
      AND daterange(fy.start_date, fy.end_date, '[]') && daterange(NEW.start_date, NEW.end_date, '[]')
  ) THEN
    RAISE EXCEPTION 'Invalid fiscal year: date range (% to %) overlaps an existing fiscal year for company_id (%).',
      NEW.start_date, NEW.end_date, NEW.company_id;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_fiscal_years_immutable_company ON public.fiscal_years;
DROP TRIGGER IF EXISTS trg_fiscal_years_validate ON public.fiscal_years;
CREATE TRIGGER trg_fiscal_years_validate
  BEFORE INSERT OR UPDATE OR DELETE ON public.fiscal_years
  FOR EACH ROW EXECUTE FUNCTION public.erp_validate_fiscal_year();

-- Auto-bootstrap initial current fiscal_years record whenever a new company is created
CREATE OR REPLACE FUNCTION public.erp_bootstrap_company_fiscal_year()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
BEGIN
  INSERT INTO public.fiscal_years (company_id, label_bs, start_date, end_date, is_current, is_closed)
  VALUES (NEW.id, NEW.current_fiscal_year_bs, NEW.fiscal_start_date, NEW.fiscal_end_date, true, false)
  ON CONFLICT (company_id, label_bs) DO NOTHING;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_companies_bootstrap_fiscal_year ON public.companies;
CREATE TRIGGER trg_companies_bootstrap_fiscal_year
  AFTER INSERT ON public.companies
  FOR EACH ROW EXECUTE FUNCTION public.erp_bootstrap_company_fiscal_year();

-- Non-destructive backfill: ensure any pre-existing companies without a fiscal_years row get one
INSERT INTO public.fiscal_years (company_id, label_bs, start_date, end_date, is_current, is_closed)
SELECT c.id, c.current_fiscal_year_bs, c.fiscal_start_date, c.fiscal_end_date, true, false
FROM public.companies c
WHERE NOT EXISTS (
  SELECT 1 FROM public.fiscal_years fy WHERE fy.company_id = c.id
)
ON CONFLICT (company_id, label_bs) DO NOTHING;

-- ----------------------------------------------------------------------------
-- 3. BRANCHES (Head Office, Regional, Sales, Service, Warehouse)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.branches (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id               uuid NOT NULL REFERENCES public.companies(id) ON DELETE RESTRICT,
  code                     varchar(25) NOT NULL CHECK (btrim(code) <> ''),
  name                     varchar(150) NOT NULL CHECK (btrim(name) <> ''),
  branch_type              varchar(30) NOT NULL DEFAULT 'SALES_BRANCH'
                           CHECK (branch_type IN ('HEAD_OFFICE', 'REGIONAL_OFFICE', 'SALES_BRANCH', 'SERVICE_BRANCH', 'WAREHOUSE')),
  city                     varchar(100) NOT NULL DEFAULT '',
  address                  text NOT NULL DEFAULT '',
  phone                    varchar(50),
  is_head_office           boolean NOT NULL DEFAULT false,
  is_active                boolean NOT NULL DEFAULT true,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, code),
  -- Composite unique key enables native cross-table (company_id, branch_id) foreign keys
  CONSTRAINT uq_branches_company_id_id UNIQUE (company_id, id)
);

-- Non-destructive upgrade compatibility for pre-existing branches table
ALTER TABLE public.branches
  ADD COLUMN IF NOT EXISTS branch_type    varchar(30) NOT NULL DEFAULT 'SALES_BRANCH',
  ADD COLUMN IF NOT EXISTS city           varchar(100) NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS address        text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS phone          varchar(50),
  ADD COLUMN IF NOT EXISTS is_head_office boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS is_active      boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS created_at     timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS updated_at     timestamptz NOT NULL DEFAULT now();

ALTER TABLE public.branches
  ALTER COLUMN created_at SET DEFAULT now(),
  ALTER COLUMN updated_at SET DEFAULT now();

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'uq_branches_company_id_id'
      AND conrelid = 'public.branches'::regclass
  ) THEN
    ALTER TABLE public.branches
      ADD CONSTRAINT uq_branches_company_id_id UNIQUE (company_id, id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_branches_company ON public.branches (company_id, is_active);
CREATE UNIQUE INDEX IF NOT EXISTS uq_branches_single_head_office
  ON public.branches (company_id)
  WHERE is_head_office = true;

DROP TRIGGER IF EXISTS trg_branches_updated_at ON public.branches;
CREATE TRIGGER trg_branches_updated_at
  BEFORE UPDATE ON public.branches
  FOR EACH ROW EXECUTE FUNCTION public.erp_set_updated_at();

-- Prevent reassigning an existing branch to a different legal entity
CREATE OR REPLACE FUNCTION public.erp_prevent_branch_company_change()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
BEGIN
  IF NEW.company_id IS DISTINCT FROM OLD.company_id THEN
    RAISE EXCEPTION 'Forbidden: branch (%) cannot be moved to a different company_id.', OLD.id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_branches_immutable_company ON public.branches;
CREATE TRIGGER trg_branches_immutable_company
  BEFORE UPDATE OF company_id ON public.branches
  FOR EACH ROW EXECUTE FUNCTION public.erp_prevent_branch_company_change();

-- ----------------------------------------------------------------------------
-- 4. ROLES (Approved Global System Roles OR Company-Scoped Custom Roles)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.roles (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id               uuid REFERENCES public.companies(id) ON DELETE RESTRICT,
  code                     varchar(40) NOT NULL CHECK (btrim(code) <> ''),
  name                     varchar(100) NOT NULL CHECK (btrim(name) <> ''),
  description              text NOT NULL DEFAULT '',
  is_system                boolean NOT NULL DEFAULT false,
  is_active                boolean NOT NULL DEFAULT true,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  -- Global system roles MUST have company_id IS NULL; custom roles MUST belong to a company
  CONSTRAINT chk_roles_scope CHECK (
    (is_system = true AND company_id IS NULL)
    OR
    (is_system = false AND company_id IS NOT NULL)
  )
);

-- Non-destructive upgrade compatibility for pre-existing roles table
ALTER TABLE public.roles
  ADD COLUMN IF NOT EXISTS company_id  uuid REFERENCES public.companies(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS description text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS is_system   boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS is_active   boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS created_at  timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS updated_at  timestamptz NOT NULL DEFAULT now();

ALTER TABLE public.roles
  ALTER COLUMN created_at SET DEFAULT now(),
  ALTER COLUMN updated_at SET DEFAULT now();

DO $$
DECLARE
  v_invalid_count bigint;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_roles_scope'
      AND conrelid = 'public.roles'::regclass
  ) THEN
    ALTER TABLE public.roles
      ADD CONSTRAINT chk_roles_scope CHECK (
        (is_system = true AND company_id IS NULL)
        OR
        (is_system = false AND company_id IS NOT NULL)
      ) NOT VALID;

    SELECT count(*) INTO v_invalid_count
    FROM public.roles
    WHERE NOT ((is_system = true AND company_id IS NULL) OR (is_system = false AND company_id IS NOT NULL));

    IF v_invalid_count = 0 THEN
      ALTER TABLE public.roles VALIDATE CONSTRAINT chk_roles_scope;
    ELSE
      RAISE WARNING 'chk_roles_scope left NOT VALID: % legacy role rows violate (is_system, company_id) scope invariant.', v_invalid_count;
    END IF;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_roles_company_code
  ON public.roles (COALESCE(company_id, '00000000-0000-0000-0000-000000000000'::uuid), code);
CREATE INDEX IF NOT EXISTS idx_roles_company_active ON public.roles (company_id, is_active);

DROP TRIGGER IF EXISTS trg_roles_updated_at ON public.roles;
CREATE TRIGGER trg_roles_updated_at
  BEFORE UPDATE ON public.roles
  FOR EACH ROW EXECUTE FUNCTION public.erp_set_updated_at();

-- ----------------------------------------------------------------------------
-- 5. PERMISSIONS & ROLE_PERMISSIONS
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.permissions (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code                     varchar(80) NOT NULL UNIQUE CHECK (btrim(code) <> ''),
  module                   varchar(50) NOT NULL CHECK (btrim(module) <> ''),
  description              text NOT NULL DEFAULT '',
  created_at               timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.permissions
  ALTER COLUMN created_at SET DEFAULT now();

CREATE INDEX IF NOT EXISTS idx_permissions_module ON public.permissions (module);

CREATE TABLE IF NOT EXISTS public.role_permissions (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  role_id                  uuid NOT NULL REFERENCES public.roles(id) ON DELETE CASCADE,
  permission_id            uuid NOT NULL REFERENCES public.permissions(id) ON DELETE RESTRICT,
  created_at               timestamptz NOT NULL DEFAULT now(),
  UNIQUE (role_id, permission_id)
);

ALTER TABLE public.role_permissions
  ALTER COLUMN created_at SET DEFAULT now();

CREATE INDEX IF NOT EXISTS idx_role_permissions_role ON public.role_permissions (role_id);
CREATE INDEX IF NOT EXISTS idx_role_permissions_permission ON public.role_permissions (permission_id);

-- ----------------------------------------------------------------------------
-- 6. PROFILES (1:1 Extension of Supabase auth.users with Hardened Governance)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.profiles (
  id                       uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE RESTRICT,
  company_id               uuid REFERENCES public.companies(id) ON DELETE RESTRICT,
  default_branch_id        uuid REFERENCES public.branches(id) ON DELETE SET NULL,
  default_role_id          uuid REFERENCES public.roles(id) ON DELETE SET NULL,
  email                    varchar(200) NOT NULL UNIQUE CHECK (btrim(email) <> ''),
  full_name                varchar(150) NOT NULL CHECK (btrim(full_name) <> ''),
  phone                    varchar(50),
  preferred_ui_mode        varchar(20) NOT NULL DEFAULT 'advanced' CHECK (preferred_ui_mode IN ('simple', 'advanced')),
  preferred_calendar       varchar(10) NOT NULL DEFAULT 'BS' CHECK (preferred_calendar IN ('BS', 'AD')),
  is_super_admin           boolean NOT NULL DEFAULT false,
  is_active                boolean NOT NULL DEFAULT true,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);

-- Non-destructive upgrade compatibility for pre-existing profiles table
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS company_id         uuid REFERENCES public.companies(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS default_branch_id  uuid REFERENCES public.branches(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS default_role_id    uuid REFERENCES public.roles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS phone              varchar(50),
  ADD COLUMN IF NOT EXISTS preferred_ui_mode  varchar(20) NOT NULL DEFAULT 'advanced',
  ADD COLUMN IF NOT EXISTS preferred_calendar varchar(10) NOT NULL DEFAULT 'BS',
  ADD COLUMN IF NOT EXISTS is_super_admin     boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS is_active          boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS created_at         timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS updated_at         timestamptz NOT NULL DEFAULT now();

ALTER TABLE public.profiles
  ALTER COLUMN created_at SET DEFAULT now(),
  ALTER COLUMN updated_at SET DEFAULT now();

CREATE INDEX IF NOT EXISTS idx_profiles_company ON public.profiles (company_id, is_active);
CREATE UNIQUE INDEX IF NOT EXISTS uq_profiles_email_lower ON public.profiles (lower(email));
CREATE INDEX IF NOT EXISTS idx_profiles_default_branch ON public.profiles (default_branch_id) WHERE default_branch_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_profiles_default_role ON public.profiles (default_role_id) WHERE default_role_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_profiles_super_admin ON public.profiles (id) WHERE is_super_admin = true AND is_active = true;

DROP TRIGGER IF EXISTS trg_profiles_updated_at ON public.profiles;
CREATE TRIGGER trg_profiles_updated_at
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.erp_set_updated_at();

-- ----------------------------------------------------------------------------
-- 7. USER_COMPANY_ROLES (Strict Company/Branch/Role Tenant Isolation Binding)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.user_company_roles (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                  uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  company_id               uuid NOT NULL REFERENCES public.companies(id) ON DELETE RESTRICT,
  branch_id                uuid, -- NULL = access to all branches within company_id
  role_id                  uuid NOT NULL REFERENCES public.roles(id) ON DELETE RESTRICT,
  is_active                boolean NOT NULL DEFAULT true,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  -- Declarative composite FK (MATCH SIMPLE): allows NULL branch_id, enforces same company_id when non-NULL
  CONSTRAINT fk_ucr_branch_same_company
    FOREIGN KEY (company_id, branch_id)
    REFERENCES public.branches (company_id, id)
    ON DELETE RESTRICT
);

-- Non-destructive upgrade compatibility for pre-existing user_company_roles table
ALTER TABLE public.user_company_roles
  ADD COLUMN IF NOT EXISTS branch_id  uuid,
  ADD COLUMN IF NOT EXISTS is_active  boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE public.user_company_roles
  ALTER COLUMN created_at SET DEFAULT now(),
  ALTER COLUMN updated_at SET DEFAULT now();

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'fk_ucr_branch_same_company'
      AND conrelid = 'public.user_company_roles'::regclass
  ) THEN
    ALTER TABLE public.user_company_roles
      ADD CONSTRAINT fk_ucr_branch_same_company
      FOREIGN KEY (company_id, branch_id)
      REFERENCES public.branches (company_id, id)
      ON DELETE RESTRICT;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_user_company_branch_role
  ON public.user_company_roles (user_id, company_id, COALESCE(branch_id, '00000000-0000-0000-0000-000000000000'::uuid), role_id);
CREATE INDEX IF NOT EXISTS idx_ucr_lookup ON public.user_company_roles (user_id, company_id, is_active);
CREATE INDEX IF NOT EXISTS idx_ucr_company_active ON public.user_company_roles (company_id, is_active);
CREATE INDEX IF NOT EXISTS idx_ucr_company_branch ON public.user_company_roles (company_id, branch_id) WHERE branch_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ucr_role ON public.user_company_roles (role_id);

DROP TRIGGER IF EXISTS trg_ucr_updated_at ON public.user_company_roles;
CREATE TRIGGER trg_ucr_updated_at
  BEFORE UPDATE ON public.user_company_roles
  FOR EACH ROW EXECUTE FUNCTION public.erp_set_updated_at();

-- ----------------------------------------------------------------------------
-- 8. RLS AUTHORIZATION HELPER FUNCTIONS (Active Profile + Active Role Enforced)
--    SECURITY DEFINER prevents RLS recursion while enforcing active user/role
--    status across every tenant boundary. Signatures remain 100% compatible with 0004.
-- ----------------------------------------------------------------------------

-- Helper 1: Is current authenticated user an active platform Super Admin?
CREATE OR REPLACE FUNCTION public.erp_is_super_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.profiles p
    WHERE p.id = auth.uid()
      AND p.is_super_admin = true
      AND p.is_active = true
  );
$$;

-- Helper 2: Is current authenticated user an active profile?
CREATE OR REPLACE FUNCTION public.erp_is_active_user()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.profiles p
    WHERE p.id = auth.uid()
      AND p.is_active = true
  );
$$;

-- Helper 3: Does current authenticated user have active access to p_company_id?
CREATE OR REPLACE FUNCTION public.erp_has_company_access(p_company_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
  SELECT p_company_id IS NOT NULL AND (
    public.erp_is_super_admin()
    OR EXISTS (
      SELECT 1
      FROM public.user_company_roles ucr
      JOIN public.profiles p ON p.id = ucr.user_id
      JOIN public.roles r    ON r.id = ucr.role_id
      WHERE ucr.user_id = auth.uid()
        AND ucr.company_id = p_company_id
        AND ucr.is_active = true
        AND p.is_active = true
        AND r.is_active = true
    )
  );
$$;

-- Helper 4: Does current authenticated user have active access to p_branch_id within p_company_id?
-- If p_branch_id IS NULL, requires company-wide assignment (ucr.branch_id IS NULL) or Super Admin.
CREATE OR REPLACE FUNCTION public.erp_has_branch_access(p_company_id uuid, p_branch_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
  SELECT p_company_id IS NOT NULL AND (
    public.erp_is_super_admin()
    OR EXISTS (
      SELECT 1
      FROM public.user_company_roles ucr
      JOIN public.profiles p ON p.id = ucr.user_id
      JOIN public.roles r    ON r.id = ucr.role_id
      WHERE ucr.user_id = auth.uid()
        AND ucr.company_id = p_company_id
        AND ucr.is_active = true
        AND p.is_active = true
        AND r.is_active = true
        AND (
          ucr.branch_id IS NULL
          OR (p_branch_id IS NOT NULL AND ucr.branch_id = p_branch_id)
        )
    )
  );
$$;

-- Helper 5: Does current authenticated user hold p_permission_code in p_company_id?
CREATE OR REPLACE FUNCTION public.erp_has_permission(p_company_id uuid, p_permission_code varchar)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
  SELECT p_company_id IS NOT NULL AND p_permission_code IS NOT NULL AND (
    public.erp_is_super_admin()
    OR EXISTS (
      SELECT 1
      FROM public.user_company_roles ucr
      JOIN public.profiles p           ON p.id = ucr.user_id
      JOIN public.roles r              ON r.id = ucr.role_id
      JOIN public.role_permissions rp  ON rp.role_id = r.id
      JOIN public.permissions perm     ON perm.id = rp.permission_id
      WHERE ucr.user_id = auth.uid()
        AND ucr.company_id = p_company_id
        AND ucr.is_active = true
        AND p.is_active = true
        AND r.is_active = true
        AND perm.code = p_permission_code
    )
  );
$$;

-- Helper 6: Does current authenticated user hold p_permission_code scoped to p_branch_id (or company-wide when NULL)?
CREATE OR REPLACE FUNCTION public.erp_has_branch_permission(
  p_company_id      uuid,
  p_branch_id       uuid,
  p_permission_code varchar
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
  SELECT p_company_id IS NOT NULL AND p_permission_code IS NOT NULL AND (
    public.erp_is_super_admin()
    OR EXISTS (
      SELECT 1
      FROM public.user_company_roles ucr
      JOIN public.profiles p           ON p.id = ucr.user_id
      JOIN public.roles r              ON r.id = ucr.role_id
      JOIN public.role_permissions rp  ON rp.role_id = r.id
      JOIN public.permissions perm     ON perm.id = rp.permission_id
      WHERE ucr.user_id = auth.uid()
        AND ucr.company_id = p_company_id
        AND ucr.is_active = true
        AND p.is_active = true
        AND r.is_active = true
        AND perm.code = p_permission_code
        AND (
          ucr.branch_id IS NULL
          OR (p_branch_id IS NOT NULL AND ucr.branch_id = p_branch_id)
        )
    )
  );
$$;

-- Helper 7: Does current authenticated user share an active company with target profile p_target_user_id?
CREATE OR REPLACE FUNCTION public.erp_shares_company_with_user(p_target_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
  SELECT p_target_user_id IS NOT NULL AND (
    public.erp_is_super_admin()
    OR p_target_user_id = auth.uid()
    OR EXISTS (
      SELECT 1
      FROM public.user_company_roles target_ucr
      JOIN public.user_company_roles viewer_ucr
        ON viewer_ucr.company_id = target_ucr.company_id
      JOIN public.profiles viewer_p ON viewer_p.id = viewer_ucr.user_id
      JOIN public.roles viewer_r    ON viewer_r.id = viewer_ucr.role_id
      WHERE target_ucr.user_id = p_target_user_id
        AND target_ucr.is_active = true
        AND viewer_ucr.user_id = auth.uid()
        AND viewer_ucr.is_active = true
        AND viewer_p.is_active = true
        AND viewer_r.is_active = true
    )
  );
$$;

-- Helper 8: Company-safe fiscal year activation helper (keeps companies & fiscal_years synchronized)
CREATE OR REPLACE FUNCTION public.erp_activate_fiscal_year(
  p_company_id     uuid,
  p_fiscal_year_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_fy public.fiscal_years%ROWTYPE;
BEGIN
  IF NOT (
    public.erp_is_trusted_server_admin()
    OR public.erp_is_super_admin()
    OR public.erp_has_branch_permission(p_company_id, NULL, 'accounting.approve')
    OR public.erp_has_branch_permission(p_company_id, NULL, 'company.manage')
  ) THEN
    RAISE EXCEPTION 'Forbidden: insufficient permissions to activate fiscal year for company_id (%).', p_company_id
      USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_fy
  FROM public.fiscal_years
  WHERE id = p_fiscal_year_id
    AND company_id = p_company_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invalid fiscal year: (%) does not belong to company_id (%).', p_fiscal_year_id, p_company_id;
  END IF;

  UPDATE public.fiscal_years
  SET is_current = false
  WHERE company_id = p_company_id
    AND is_current = true
    AND id <> p_fiscal_year_id;

  UPDATE public.fiscal_years
  SET is_current = true
  WHERE id = p_fiscal_year_id;

  UPDATE public.companies
  SET
    current_fiscal_year_bs = v_fy.label_bs,
    fiscal_start_date      = v_fy.start_date,
    fiscal_end_date        = v_fy.end_date
  WHERE id = p_company_id;
END;
$$;

-- ----------------------------------------------------------------------------
-- 9. GOVERNANCE & ANTI-PRIVILEGE-ESCALATION TRIGGERS
-- ----------------------------------------------------------------------------

-- Guard 1: Protect profiles.is_super_admin AND prevent self-update privilege/tenant hijacking
CREATE OR REPLACE FUNCTION public.erp_protect_profile_governance()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_is_trusted_admin boolean := public.erp_is_trusted_server_admin();
  v_is_super_admin   boolean := false;
BEGIN
  IF NOT v_is_trusted_admin THEN
    v_is_super_admin := public.erp_is_super_admin();
  END IF;

  -- Strictly restrict profiles.is_super_admin to trusted server-side admin processes ONLY
  IF TG_OP = 'INSERT' THEN
    IF NEW.is_super_admin = true AND NOT v_is_trusted_admin THEN
      RAISE EXCEPTION 'Forbidden: profiles.is_super_admin can only be granted by a trusted server-side administrative process.'
        USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE governance
  IF NEW.is_super_admin IS DISTINCT FROM OLD.is_super_admin AND NOT v_is_trusted_admin THEN
    RAISE EXCEPTION 'Forbidden: profiles.is_super_admin can only be modified by a trusted server-side administrative process.'
      USING ERRCODE = '42501';
  END IF;

  -- Non-super-admin users updating their own profile cannot alter security-critical fields
  -- or switch default tenant/branch/role to ones they are not actively assigned to.
  IF NOT v_is_trusted_admin AND NOT v_is_super_admin THEN
    IF OLD.id IS DISTINCT FROM auth.uid() THEN
      RAISE EXCEPTION 'Forbidden: users may only update their own profile.'
        USING ERRCODE = '42501';
    END IF;

    IF NEW.id IS DISTINCT FROM OLD.id
       OR NEW.email IS DISTINCT FROM OLD.email
       OR NEW.is_active IS DISTINCT FROM OLD.is_active THEN
      RAISE EXCEPTION 'Forbidden: email and active status can only be modified by an administrator.'
        USING ERRCODE = '42501';
    END IF;

    IF NEW.company_id IS DISTINCT FROM OLD.company_id AND NEW.company_id IS NOT NULL THEN
      IF NOT public.erp_has_company_access(NEW.company_id) THEN
        RAISE EXCEPTION 'Tenant isolation violation: cannot set default company_id (%) without active company membership.', NEW.company_id
          USING ERRCODE = '42501';
      END IF;
    END IF;

    IF NEW.default_branch_id IS DISTINCT FROM OLD.default_branch_id AND NEW.default_branch_id IS NOT NULL THEN
      IF NOT public.erp_has_branch_access(NEW.company_id, NEW.default_branch_id) THEN
        RAISE EXCEPTION 'Tenant isolation violation: cannot set default_branch_id (%) without active branch access.', NEW.default_branch_id
          USING ERRCODE = '42501';
      END IF;
    END IF;

    IF NEW.default_role_id IS DISTINCT FROM OLD.default_role_id AND NEW.default_role_id IS NOT NULL THEN
      IF NOT EXISTS (
        SELECT 1
        FROM public.user_company_roles ucr
        JOIN public.roles r ON r.id = ucr.role_id
        WHERE ucr.user_id = auth.uid()
          AND ucr.company_id = NEW.company_id
          AND ucr.role_id = NEW.default_role_id
          AND ucr.is_active = true
          AND r.is_active = true
      ) THEN
        RAISE EXCEPTION 'Forbidden: cannot set default_role_id (%) to a role not actively assigned to you in company (%).',
          NEW.default_role_id, NEW.company_id
          USING ERRCODE = '42501';
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_profiles_protect_super_admin ON public.profiles;
DROP TRIGGER IF EXISTS trg_profiles_protect_governance ON public.profiles;
CREATE TRIGGER trg_profiles_protect_governance
  BEFORE INSERT OR UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.erp_protect_profile_governance();

-- Guard 2: Validate profiles.default_branch_id and default_role_id against selected company_id
CREATE OR REPLACE FUNCTION public.erp_validate_profile_defaults()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_branch_company uuid;
  v_role_company   uuid;
  v_role_is_system boolean;
  v_role_is_active boolean;
BEGIN
  IF NEW.default_branch_id IS NOT NULL THEN
    IF NEW.company_id IS NULL THEN
      RAISE EXCEPTION 'Invalid profile: default_branch_id cannot be set when company_id is NULL.';
    END IF;

    SELECT b.company_id INTO v_branch_company
    FROM public.branches b
    WHERE b.id = NEW.default_branch_id;

    IF v_branch_company IS NULL OR v_branch_company IS DISTINCT FROM NEW.company_id THEN
      RAISE EXCEPTION 'Invalid profile: default_branch_id (%) does not belong to company_id (%).',
        NEW.default_branch_id, NEW.company_id;
    END IF;
  END IF;

  IF NEW.default_role_id IS NOT NULL THEN
    SELECT r.company_id, r.is_system, r.is_active
      INTO v_role_company, v_role_is_system, v_role_is_active
    FROM public.roles r
    WHERE r.id = NEW.default_role_id;

    IF v_role_is_active IS NOT TRUE THEN
      RAISE EXCEPTION 'Invalid profile: default_role_id (%) does not exist or is inactive.', NEW.default_role_id;
    END IF;

    IF NOT (
      (v_role_is_system = true AND v_role_company IS NULL)
      OR (NEW.company_id IS NOT NULL AND v_role_company = NEW.company_id)
    ) THEN
      RAISE EXCEPTION 'Invalid profile: default_role_id (%) is neither an approved global system role nor scoped to company_id (%).',
        NEW.default_role_id, NEW.company_id;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_profiles_validate_defaults ON public.profiles;
CREATE TRIGGER trg_profiles_validate_defaults
  BEFORE INSERT OR UPDATE OF company_id, default_branch_id, default_role_id ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.erp_validate_profile_defaults();

-- Guard 3: Validate user_company_roles branch ownership, role scope, AND anti-privilege-escalation
CREATE OR REPLACE FUNCTION public.erp_validate_user_company_role()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_branch_company   uuid;
  v_role_company     uuid;
  v_role_code        varchar(40);
  v_role_is_system   boolean;
  v_role_is_active   boolean;
  v_is_trusted_admin boolean := public.erp_is_trusted_server_admin();
  v_is_super_admin   boolean := false;
BEGIN
  -- 1. Branch-to-company ownership check (reinforces composite FK with clear error)
  IF NEW.branch_id IS NOT NULL THEN
    SELECT b.company_id INTO v_branch_company
    FROM public.branches b
    WHERE b.id = NEW.branch_id;

    IF v_branch_company IS NULL OR v_branch_company IS DISTINCT FROM NEW.company_id THEN
      RAISE EXCEPTION 'Tenant isolation violation: branch_id (%) does not belong to company_id (%).',
        NEW.branch_id, NEW.company_id;
    END IF;
  END IF;

  -- 2. Role existence, active status, and scope validation
  SELECT r.company_id, r.code, r.is_system, r.is_active
    INTO v_role_company, v_role_code, v_role_is_system, v_role_is_active
  FROM public.roles r
  WHERE r.id = NEW.role_id;

  IF v_role_is_active IS NOT TRUE THEN
    RAISE EXCEPTION 'Invalid RBAC assignment: role_id (%) does not exist or is inactive.', NEW.role_id;
  END IF;

  IF NOT (
    (v_role_is_system = true AND v_role_company IS NULL)
    OR (v_role_company = NEW.company_id)
  ) THEN
    RAISE EXCEPTION 'Tenant isolation violation: role_id (%) is neither an approved global system role nor scoped to company_id (%).',
      NEW.role_id, NEW.company_id;
  END IF;

  -- 3. Anti-privilege-escalation for non-trusted/non-super-admin callers:
  --    (a) Cannot assign global SUPER_ADMIN role
  --    (b) Cannot assign a role carrying permissions the caller does not hold in NEW.company_id
  IF NOT v_is_trusted_admin THEN
    v_is_super_admin := public.erp_is_super_admin();
    IF NOT v_is_super_admin THEN
      IF v_role_is_system = true AND v_role_code = 'SUPER_ADMIN' THEN
        RAISE EXCEPTION 'Forbidden: only a Super Administrator can assign the SUPER_ADMIN role.'
          USING ERRCODE = '42501';
      END IF;

      IF EXISTS (
        SELECT 1
        FROM public.role_permissions rp
        JOIN public.permissions perm ON perm.id = rp.permission_id
        WHERE rp.role_id = NEW.role_id
          AND NOT public.erp_has_permission(NEW.company_id, perm.code)
      ) THEN
        RAISE EXCEPTION 'Privilege escalation blocked: cannot assign role (%) containing permissions you do not hold in company (%).',
          v_role_code, NEW.company_id
          USING ERRCODE = '42501';
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_ucr_validate_scope ON public.user_company_roles;
CREATE TRIGGER trg_ucr_validate_scope
  BEFORE INSERT OR UPDATE OF company_id, branch_id, role_id, is_active ON public.user_company_roles
  FOR EACH ROW EXECUTE FUNCTION public.erp_validate_user_company_role();

-- Guard 4: Prevent mutating role company_id or is_system once assigned to any user or profile
CREATE OR REPLACE FUNCTION public.erp_prevent_role_scope_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
BEGIN
  IF (NEW.company_id IS DISTINCT FROM OLD.company_id)
     OR (NEW.is_system IS DISTINCT FROM OLD.is_system) THEN
    IF EXISTS (SELECT 1 FROM public.user_company_roles ucr WHERE ucr.role_id = OLD.id)
       OR EXISTS (SELECT 1 FROM public.profiles p WHERE p.default_role_id = OLD.id) THEN
      RAISE EXCEPTION 'Forbidden: role (%) scope (company_id/is_system) cannot be changed while assigned to users.', OLD.id;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_roles_protect_assigned_scope ON public.roles;
CREATE TRIGGER trg_roles_protect_assigned_scope
  BEFORE UPDATE OF company_id, is_system ON public.roles
  FOR EACH ROW EXECUTE FUNCTION public.erp_prevent_role_scope_mutation();

-- Guard 5: Enforce role_permissions governance (block system role mutation & privilege escalation)
CREATE OR REPLACE FUNCTION public.erp_enforce_role_permission_governance()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_role_id          uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD.role_id ELSE NEW.role_id END;
  v_permission_id    uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD.permission_id ELSE NEW.permission_id END;
  v_role_company     uuid;
  v_role_is_system   boolean;
  v_perm_code        varchar(80);
  v_is_trusted_admin boolean := public.erp_is_trusted_server_admin();
BEGIN
  IF v_is_trusted_admin OR public.erp_is_super_admin() THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  SELECT r.company_id, r.is_system
    INTO v_role_company, v_role_is_system
  FROM public.roles r
  WHERE r.id = v_role_id;

  IF v_role_is_system = true OR v_role_company IS NULL THEN
    RAISE EXCEPTION 'Forbidden: only a Super Administrator can modify global system role permissions.'
      USING ERRCODE = '42501';
  END IF;

  IF NOT public.erp_has_branch_permission(v_role_company, NULL, 'company.manage') THEN
    RAISE EXCEPTION 'Forbidden: company.manage permission required to manage role permissions for company (%).', v_role_company
      USING ERRCODE = '42501';
  END IF;

  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    SELECT p.code INTO v_perm_code
    FROM public.permissions p
    WHERE p.id = v_permission_id;

    IF v_perm_code IS NULL OR NOT public.erp_has_permission(v_role_company, v_perm_code) THEN
      RAISE EXCEPTION 'Privilege escalation blocked: cannot grant permission (%) that you do not hold in company (%).',
        v_perm_code, v_role_company
        USING ERRCODE = '42501';
    END IF;
  END IF;

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

DROP TRIGGER IF EXISTS trg_role_permissions_governance ON public.role_permissions;
CREATE TRIGGER trg_role_permissions_governance
  BEFORE INSERT OR UPDATE OR DELETE ON public.role_permissions
  FOR EACH ROW EXECUTE FUNCTION public.erp_enforce_role_permission_governance();

-- ----------------------------------------------------------------------------
-- 10. COMPLETE SUPABASE ROW LEVEL SECURITY (RLS) & LEAST-PRIVILEGE GRANTS
--     Guarantees strict company + branch isolation on ALL tables in 0001.sql
--     from the moment Phase 1.1 Step 1 is applied (zero unprotected window).
-- ----------------------------------------------------------------------------

-- Revoke all direct table access from anon role (defense in depth)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON TABLE
      public.companies,
      public.fiscal_years,
      public.branches,
      public.roles,
      public.permissions,
      public.role_permissions,
      public.profiles,
      public.user_company_roles
    FROM anon;
  END IF;
END $$;

-- Lock down execute permissions on security-sensitive helper functions
REVOKE ALL ON FUNCTION public.erp_is_trusted_server_admin() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.erp_is_super_admin() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.erp_is_active_user() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.erp_has_company_access(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.erp_has_branch_access(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.erp_has_permission(uuid, varchar) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.erp_has_branch_permission(uuid, uuid, varchar) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.erp_shares_company_with_user(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.erp_activate_fiscal_year(uuid, uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.erp_is_trusted_server_admin() TO authenticated;
GRANT EXECUTE ON FUNCTION public.erp_is_super_admin() TO authenticated;
GRANT EXECUTE ON FUNCTION public.erp_is_active_user() TO authenticated;
GRANT EXECUTE ON FUNCTION public.erp_has_company_access(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.erp_has_branch_access(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.erp_has_permission(uuid, varchar) TO authenticated;
GRANT EXECUTE ON FUNCTION public.erp_has_branch_permission(uuid, uuid, varchar) TO authenticated;
GRANT EXECUTE ON FUNCTION public.erp_shares_company_with_user(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.erp_activate_fiscal_year(uuid, uuid) TO authenticated;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION public.erp_is_trusted_server_admin() TO service_role;
    GRANT EXECUTE ON FUNCTION public.erp_is_super_admin() TO service_role;
    GRANT EXECUTE ON FUNCTION public.erp_is_active_user() TO service_role;
    GRANT EXECUTE ON FUNCTION public.erp_has_company_access(uuid) TO service_role;
    GRANT EXECUTE ON FUNCTION public.erp_has_branch_access(uuid, uuid) TO service_role;
    GRANT EXECUTE ON FUNCTION public.erp_has_permission(uuid, varchar) TO service_role;
    GRANT EXECUTE ON FUNCTION public.erp_has_branch_permission(uuid, uuid, varchar) TO service_role;
    GRANT EXECUTE ON FUNCTION public.erp_shares_company_with_user(uuid) TO service_role;
    GRANT EXECUTE ON FUNCTION public.erp_activate_fiscal_year(uuid, uuid) TO service_role;
  END IF;
END $$;

-- Enable RLS across ALL 8 tables created in 0001.sql
ALTER TABLE public.companies          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fiscal_years       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.branches           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.roles              ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.permissions        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.role_permissions   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.profiles           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_company_roles ENABLE ROW LEVEL SECURITY;

-- 10.1 COMPANIES POLICIES
DROP POLICY IF EXISTS companies_select_authorized ON public.companies;
DROP POLICY IF EXISTS companies_manage_admin      ON public.companies;
DROP POLICY IF EXISTS companies_insert_admin      ON public.companies;
DROP POLICY IF EXISTS companies_update_admin      ON public.companies;
DROP POLICY IF EXISTS companies_delete_admin      ON public.companies;

CREATE POLICY companies_select_authorized ON public.companies
  FOR SELECT TO authenticated
  USING (public.erp_has_company_access(id));

CREATE POLICY companies_insert_admin ON public.companies
  FOR INSERT TO authenticated
  WITH CHECK (public.erp_is_super_admin());

CREATE POLICY companies_update_admin ON public.companies
  FOR UPDATE TO authenticated
  USING (public.erp_is_super_admin() OR public.erp_has_branch_permission(id, NULL, 'company.manage'))
  WITH CHECK (public.erp_is_super_admin() OR public.erp_has_branch_permission(id, NULL, 'company.manage'));

CREATE POLICY companies_delete_admin ON public.companies
  FOR DELETE TO authenticated
  USING (public.erp_is_super_admin());

-- 10.2 FISCAL_YEARS POLICIES
DROP POLICY IF EXISTS fiscal_years_select_authorized ON public.fiscal_years;
DROP POLICY IF EXISTS fiscal_years_insert_authorized ON public.fiscal_years;
DROP POLICY IF EXISTS fiscal_years_update_authorized ON public.fiscal_years;
DROP POLICY IF EXISTS fiscal_years_delete_admin      ON public.fiscal_years;

CREATE POLICY fiscal_years_select_authorized ON public.fiscal_years
  FOR SELECT TO authenticated
  USING (public.erp_has_company_access(company_id));

CREATE POLICY fiscal_years_insert_authorized ON public.fiscal_years
  FOR INSERT TO authenticated
  WITH CHECK (
    public.erp_is_super_admin()
    OR public.erp_has_branch_permission(company_id, NULL, 'company.manage')
    OR public.erp_has_branch_permission(company_id, NULL, 'accounting.approve')
  );

CREATE POLICY fiscal_years_update_authorized ON public.fiscal_years
  FOR UPDATE TO authenticated
  USING (
    public.erp_is_super_admin()
    OR public.erp_has_branch_permission(company_id, NULL, 'company.manage')
    OR public.erp_has_branch_permission(company_id, NULL, 'accounting.approve')
  )
  WITH CHECK (
    public.erp_is_super_admin()
    OR public.erp_has_branch_permission(company_id, NULL, 'company.manage')
    OR public.erp_has_branch_permission(company_id, NULL, 'accounting.approve')
  );

CREATE POLICY fiscal_years_delete_admin ON public.fiscal_years
  FOR DELETE TO authenticated
  USING (public.erp_is_super_admin() AND is_closed = false);

-- 10.3 BRANCHES POLICIES (Strict Branch-Level Read + Company-Admin Write)
DROP POLICY IF EXISTS branches_select_authorized ON public.branches;
DROP POLICY IF EXISTS branches_manage_admin      ON public.branches;
DROP POLICY IF EXISTS branches_insert_admin      ON public.branches;
DROP POLICY IF EXISTS branches_update_admin      ON public.branches;
DROP POLICY IF EXISTS branches_delete_admin      ON public.branches;

CREATE POLICY branches_select_authorized ON public.branches
  FOR SELECT TO authenticated
  USING (public.erp_has_branch_access(company_id, id));

CREATE POLICY branches_insert_admin ON public.branches
  FOR INSERT TO authenticated
  WITH CHECK (public.erp_is_super_admin() OR public.erp_has_branch_permission(company_id, NULL, 'company.manage'));

CREATE POLICY branches_update_admin ON public.branches
  FOR UPDATE TO authenticated
  USING (public.erp_is_super_admin() OR public.erp_has_branch_permission(company_id, NULL, 'company.manage'))
  WITH CHECK (public.erp_is_super_admin() OR public.erp_has_branch_permission(company_id, NULL, 'company.manage'));

CREATE POLICY branches_delete_admin ON public.branches
  FOR DELETE TO authenticated
  USING (public.erp_is_super_admin() OR public.erp_has_branch_permission(company_id, NULL, 'company.manage'));

-- 10.4 ROLES POLICIES (System Roles Read-Only to Tenants; Custom Roles Company-Isolated)
DROP POLICY IF EXISTS roles_select_visible ON public.roles;
DROP POLICY IF EXISTS roles_insert_admin   ON public.roles;
DROP POLICY IF EXISTS roles_update_admin   ON public.roles;
DROP POLICY IF EXISTS roles_delete_admin   ON public.roles;

CREATE POLICY roles_select_visible ON public.roles
  FOR SELECT TO authenticated
  USING (
    public.erp_is_super_admin()
    OR (is_system = true AND company_id IS NULL AND public.erp_is_active_user())
    OR (company_id IS NOT NULL AND public.erp_has_company_access(company_id))
  );

CREATE POLICY roles_insert_admin ON public.roles
  FOR INSERT TO authenticated
  WITH CHECK (
    public.erp_is_super_admin()
    OR (is_system = false AND company_id IS NOT NULL AND public.erp_has_branch_permission(company_id, NULL, 'company.manage'))
  );

CREATE POLICY roles_update_admin ON public.roles
  FOR UPDATE TO authenticated
  USING (
    public.erp_is_super_admin()
    OR (is_system = false AND company_id IS NOT NULL AND public.erp_has_branch_permission(company_id, NULL, 'company.manage'))
  )
  WITH CHECK (
    public.erp_is_super_admin()
    OR (is_system = false AND company_id IS NOT NULL AND public.erp_has_branch_permission(company_id, NULL, 'company.manage'))
  );

CREATE POLICY roles_delete_admin ON public.roles
  FOR DELETE TO authenticated
  USING (
    public.erp_is_super_admin()
    OR (is_system = false AND company_id IS NOT NULL AND public.erp_has_branch_permission(company_id, NULL, 'company.manage'))
  );

-- 10.5 PERMISSIONS POLICIES (Global Catalog: Read-Only for Active Users, Super Admin Write)
DROP POLICY IF EXISTS permissions_select_authenticated ON public.permissions;
DROP POLICY IF EXISTS permissions_insert_admin         ON public.permissions;
DROP POLICY IF EXISTS permissions_update_admin         ON public.permissions;
DROP POLICY IF EXISTS permissions_delete_admin         ON public.permissions;

CREATE POLICY permissions_select_authenticated ON public.permissions
  FOR SELECT TO authenticated
  USING (public.erp_is_active_user());

CREATE POLICY permissions_insert_admin ON public.permissions
  FOR INSERT TO authenticated
  WITH CHECK (public.erp_is_super_admin());

CREATE POLICY permissions_update_admin ON public.permissions
  FOR UPDATE TO authenticated
  USING (public.erp_is_super_admin())
  WITH CHECK (public.erp_is_super_admin());

CREATE POLICY permissions_delete_admin ON public.permissions
  FOR DELETE TO authenticated
  USING (public.erp_is_super_admin());

-- 10.6 ROLE_PERMISSIONS POLICIES (Tenant-Isolated for Custom Roles; No Cross-Tenant Leak)
DROP POLICY IF EXISTS role_permissions_select_authenticated ON public.role_permissions;
DROP POLICY IF EXISTS role_permissions_select_visible       ON public.role_permissions;
DROP POLICY IF EXISTS role_permissions_insert_admin         ON public.role_permissions;
DROP POLICY IF EXISTS role_permissions_update_admin         ON public.role_permissions;
DROP POLICY IF EXISTS role_permissions_delete_admin         ON public.role_permissions;

CREATE POLICY role_permissions_select_visible ON public.role_permissions
  FOR SELECT TO authenticated
  USING (
    public.erp_is_super_admin()
    OR EXISTS (
      SELECT 1
      FROM public.roles r
      WHERE r.id = role_id
        AND (
          (r.is_system = true AND r.company_id IS NULL AND public.erp_is_active_user())
          OR (r.company_id IS NOT NULL AND public.erp_has_company_access(r.company_id))
        )
    )
  );

CREATE POLICY role_permissions_insert_admin ON public.role_permissions
  FOR INSERT TO authenticated
  WITH CHECK (
    public.erp_is_super_admin()
    OR EXISTS (
      SELECT 1
      FROM public.roles r
      WHERE r.id = role_id
        AND r.is_system = false
        AND r.company_id IS NOT NULL
        AND public.erp_has_branch_permission(r.company_id, NULL, 'company.manage')
    )
  );

CREATE POLICY role_permissions_update_admin ON public.role_permissions
  FOR UPDATE TO authenticated
  USING (
    public.erp_is_super_admin()
    OR EXISTS (
      SELECT 1
      FROM public.roles r
      WHERE r.id = role_id
        AND r.is_system = false
        AND r.company_id IS NOT NULL
        AND public.erp_has_branch_permission(r.company_id, NULL, 'company.manage')
    )
  )
  WITH CHECK (
    public.erp_is_super_admin()
    OR EXISTS (
      SELECT 1
      FROM public.roles r
      WHERE r.id = role_id
        AND r.is_system = false
        AND r.company_id IS NOT NULL
        AND public.erp_has_branch_permission(r.company_id, NULL, 'company.manage')
    )
  );

CREATE POLICY role_permissions_delete_admin ON public.role_permissions
  FOR DELETE TO authenticated
  USING (
    public.erp_is_super_admin()
    OR EXISTS (
      SELECT 1
      FROM public.roles r
      WHERE r.id = role_id
        AND r.is_system = false
        AND r.company_id IS NOT NULL
        AND public.erp_has_branch_permission(r.company_id, NULL, 'company.manage')
    )
  );

-- 10.7 PROFILES POLICIES (Self + Shared-Company Read; Hardened Self/Super-Admin Update)
DROP POLICY IF EXISTS profiles_select_self_or_company ON public.profiles;
DROP POLICY IF EXISTS profiles_insert_admin           ON public.profiles;
DROP POLICY IF EXISTS profiles_update_self            ON public.profiles;
DROP POLICY IF EXISTS profiles_update_self_or_admin   ON public.profiles;
DROP POLICY IF EXISTS profiles_delete_admin           ON public.profiles;

CREATE POLICY profiles_select_self_or_company ON public.profiles
  FOR SELECT TO authenticated
  USING (
    id = auth.uid()
    OR public.erp_is_super_admin()
    OR public.erp_shares_company_with_user(id)
    OR (company_id IS NOT NULL AND public.erp_has_company_access(company_id))
  );

CREATE POLICY profiles_insert_admin ON public.profiles
  FOR INSERT TO authenticated
  WITH CHECK (public.erp_is_super_admin());

CREATE POLICY profiles_update_self_or_admin ON public.profiles
  FOR UPDATE TO authenticated
  USING (id = auth.uid() OR public.erp_is_super_admin())
  WITH CHECK (id = auth.uid() OR public.erp_is_super_admin());

CREATE POLICY profiles_delete_admin ON public.profiles
  FOR DELETE TO authenticated
  USING (public.erp_is_super_admin());

-- 10.8 USER_COMPANY_ROLES POLICIES (Strict Company & Branch Admin Isolation)
DROP POLICY IF EXISTS ucr_select_own_or_admin ON public.user_company_roles;
DROP POLICY IF EXISTS ucr_manage_admin        ON public.user_company_roles;
DROP POLICY IF EXISTS ucr_insert_admin        ON public.user_company_roles;
DROP POLICY IF EXISTS ucr_update_admin        ON public.user_company_roles;
DROP POLICY IF EXISTS ucr_delete_admin        ON public.user_company_roles;

CREATE POLICY ucr_select_own_or_admin ON public.user_company_roles
  FOR SELECT TO authenticated
  USING (
    user_id = auth.uid()
    OR public.erp_is_super_admin()
    OR public.erp_has_branch_permission(company_id, branch_id, 'company.manage')
  );

CREATE POLICY ucr_insert_admin ON public.user_company_roles
  FOR INSERT TO authenticated
  WITH CHECK (
    public.erp_is_super_admin()
    OR public.erp_has_branch_permission(company_id, NULL, 'company.manage')
  );

CREATE POLICY ucr_update_admin ON public.user_company_roles
  FOR UPDATE TO authenticated
  USING (
    public.erp_is_super_admin()
    OR public.erp_has_branch_permission(company_id, NULL, 'company.manage')
  )
  WITH CHECK (
    public.erp_is_super_admin()
    OR public.erp_has_branch_permission(company_id, NULL, 'company.manage')
  );

CREATE POLICY ucr_delete_admin ON public.user_company_roles
  FOR DELETE TO authenticated
  USING (
    public.erp_is_super_admin()
    OR public.erp_has_branch_permission(company_id, NULL, 'company.manage')
  );

-- ----------------------------------------------------------------------------
-- 11. IDEMPOTENT BASELINE SYSTEM ROLES, PERMISSIONS & DEFAULT ROLE-PERMISSION MATRIX
-- ----------------------------------------------------------------------------
INSERT INTO public.roles (company_id, code, name, description, is_system, is_active)
VALUES
  (NULL, 'SUPER_ADMIN',    'Super Administrator',      'Full access across all legal entities, branches, and governance settings.', true, true),
  (NULL, 'CFO_APPROVER',   'CFO / Finance Approver',   'Approves high-value journals, locks fiscal periods, views group consolidation.', true, true),
  (NULL, 'BRANCH_MANAGER', 'Branch Manager',           'Manages branch sales, service, inventory, and branch P&L.', true, true),
  (NULL, 'ACCOUNTANT',     'Enterprise Accountant',    'Posts vouchers, reconciles banks, manages AR/AP and tax filings.', true, true),
  (NULL, 'OPERATOR',       'Simple Mode Operator',     'Everyday billing, cash receipts, expenses, and stock lookups.', true, true)
ON CONFLICT DO NOTHING;

INSERT INTO public.permissions (code, module, description)
VALUES
  ('company.manage',       'org',        'Create and configure legal entities and branches'),
  ('accounting.read',      'accounting', 'View COA, General Ledger, and financial statements'),
  ('accounting.post',      'accounting', 'Create and post journal vouchers'),
  ('accounting.approve',   'accounting', 'Approve/reject pending vouchers and lock fiscal periods'),
  ('sales.manage',         'commercial', 'Create sales invoices, receipts, and manage customers'),
  ('purchases.manage',     'commercial', 'Create purchase bills, payments, and manage suppliers'),
  ('inventory.manage',     'inventory',  'Manage products, warehouses, stock transfers, and adjustments'),
  ('reports.consolidated', 'reports',    'View multi-company consolidated statements and eliminations'),
  ('audit.read',           'security',   'Inspect immutable audit logs and export tenant archives')
ON CONFLICT (code) DO NOTHING;

INSERT INTO public.role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM public.roles r
JOIN public.permissions p ON (
  (r.code = 'SUPER_ADMIN')
  OR (r.code = 'CFO_APPROVER'   AND p.code IN ('company.manage', 'accounting.read', 'accounting.post', 'accounting.approve', 'sales.manage', 'purchases.manage', 'inventory.manage', 'reports.consolidated', 'audit.read'))
  OR (r.code = 'BRANCH_MANAGER' AND p.code IN ('accounting.read', 'sales.manage', 'purchases.manage', 'inventory.manage'))
  OR (r.code = 'ACCOUNTANT'     AND p.code IN ('accounting.read', 'accounting.post', 'sales.manage', 'purchases.manage', 'audit.read'))
  OR (r.code = 'OPERATOR'       AND p.code IN ('sales.manage', 'purchases.manage', 'inventory.manage'))
)
WHERE r.is_system = true AND r.company_id IS NULL
ON CONFLICT (role_id, permission_id) DO NOTHING;
