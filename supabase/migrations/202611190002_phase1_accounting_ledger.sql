-- ============================================================================
-- PHASE 1.1 MIGRATION 0002: Double-Entry Accounting & General Ledger Foundation
-- Tables: accounts, journal_entries, journal_entry_lines
-- Includes: Deferred double-entry balance trigger + cross-company FK integrity
-- ============================================================================

-- 6. ACCOUNTS (Independent Chart of Accounts per Company)
CREATE TABLE IF NOT EXISTS public.accounts (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id            uuid NOT NULL REFERENCES public.companies(id) ON DELETE RESTRICT,
  parent_account_id     uuid REFERENCES public.accounts(id) ON DELETE SET NULL,
  code                  varchar(30) NOT NULL,
  name                  varchar(160) NOT NULL,
  account_type          varchar(20) NOT NULL
                        CHECK (account_type IN ('ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE')),
  sub_type              varchar(40) NOT NULL DEFAULT 'GENERAL',
  currency_code         varchar(3) NOT NULL DEFAULT 'NPR',
  is_system             boolean NOT NULL DEFAULT false,
  is_intercompany       boolean NOT NULL DEFAULT false,
  is_bank_or_cash       boolean NOT NULL DEFAULT false,
  is_vat_account        boolean NOT NULL DEFAULT false,
  is_active             boolean NOT NULL DEFAULT true,
  created_at            timestamptz NOT NULL DEFAULT timezone('utc', now()),
  updated_at            timestamptz NOT NULL DEFAULT timezone('utc', now()),
  UNIQUE (company_id, code)
);

CREATE INDEX IF NOT EXISTS idx_accounts_company_type ON public.accounts (company_id, account_type, is_active);
CREATE INDEX IF NOT EXISTS idx_accounts_company_bank ON public.accounts (company_id) WHERE is_bank_or_cash = true;

DROP TRIGGER IF EXISTS trg_accounts_updated_at ON public.accounts;
CREATE TRIGGER trg_accounts_updated_at
  BEFORE UPDATE ON public.accounts
  FOR EACH ROW EXECUTE FUNCTION public.erp_set_updated_at();

-- 7. JOURNAL_ENTRIES (Double-Entry Voucher Header with BS Date & Approval Controls)
CREATE TABLE IF NOT EXISTS public.journal_entries (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id            uuid NOT NULL REFERENCES public.companies(id) ON DELETE RESTRICT,
  branch_id             uuid REFERENCES public.branches(id) ON DELETE RESTRICT,
  entry_number          varchar(40) NOT NULL,
  entry_date            date NOT NULL,
  entry_date_bs         varchar(15), -- Nepal Bikram Sambat display string e.g. '2082-11-15'
  fiscal_year_bs        varchar(20) NOT NULL DEFAULT '2082/83',
  reference_type        varchar(40) NOT NULL DEFAULT 'MANUAL',
  reference_id          uuid,
  description           text NOT NULL,
  status                varchar(25) NOT NULL DEFAULT 'DRAFT'
                        CHECK (status IN ('DRAFT', 'PENDING_APPROVAL', 'POSTED', 'REJECTED', 'REVERSED')),
  is_intercompany       boolean NOT NULL DEFAULT false,
  is_elimination        boolean NOT NULL DEFAULT false,
  currency_code         varchar(3) NOT NULL DEFAULT 'NPR',
  total_debit           numeric(18, 2) NOT NULL DEFAULT 0.00 CHECK (total_debit >= 0),
  total_credit          numeric(18, 2) NOT NULL DEFAULT 0.00 CHECK (total_credit >= 0),
  created_by            uuid REFERENCES public.profiles(id) ON DELETE RESTRICT,
  approved_by           uuid REFERENCES public.profiles(id) ON DELETE RESTRICT,
  approved_at           timestamptz,
  created_at            timestamptz NOT NULL DEFAULT timezone('utc', now()),
  updated_at            timestamptz NOT NULL DEFAULT timezone('utc', now()),
  UNIQUE (company_id, entry_number)
);

CREATE INDEX IF NOT EXISTS idx_je_company_date_status ON public.journal_entries (company_id, entry_date DESC, status);
CREATE INDEX IF NOT EXISTS idx_je_company_fy_bs ON public.journal_entries (company_id, fiscal_year_bs);
CREATE INDEX IF NOT EXISTS idx_je_reference ON public.journal_entries (company_id, reference_type, reference_id);

DROP TRIGGER IF EXISTS trg_je_updated_at ON public.journal_entries;
CREATE TRIGGER trg_je_updated_at
  BEFORE UPDATE ON public.journal_entries
  FOR EACH ROW EXECUTE FUNCTION public.erp_set_updated_at();

-- 8. JOURNAL_ENTRY_LINES (Balanced Double-Entry Ledger Lines)
CREATE TABLE IF NOT EXISTS public.journal_entry_lines (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id            uuid NOT NULL REFERENCES public.companies(id) ON DELETE RESTRICT,
  journal_entry_id      uuid NOT NULL REFERENCES public.journal_entries(id) ON DELETE CASCADE,
  account_id            uuid NOT NULL REFERENCES public.accounts(id) ON DELETE RESTRICT,
  branch_id             uuid NOT NULL REFERENCES public.branches(id) ON DELETE RESTRICT,
  party_type            varchar(20) CHECK (party_type IN ('CUSTOMER', 'SUPPLIER') OR party_type IS NULL),
  party_id              uuid,
  debit                 numeric(18, 2) NOT NULL DEFAULT 0.00 CHECK (debit >= 0),
  credit                numeric(18, 2) NOT NULL DEFAULT 0.00 CHECK (credit >= 0),
  memo                  text NOT NULL DEFAULT '',
  created_at            timestamptz NOT NULL DEFAULT timezone('utc', now()),
  CHECK ((debit > 0 AND credit = 0) OR (credit > 0 AND debit = 0))
);

CREATE INDEX IF NOT EXISTS idx_jel_company_account_branch ON public.journal_entry_lines (company_id, account_id, branch_id);
CREATE INDEX IF NOT EXISTS idx_jel_entry ON public.journal_entry_lines (journal_entry_id);

-- ============================================================================
-- DATABASE-LEVEL DOUBLE-ENTRY & TENANT ISOLATION TRIGGERS
-- ============================================================================

-- Ensure every journal_entry_line references an account, branch, and header from the SAME company_id
CREATE OR REPLACE FUNCTION public.erp_validate_journal_line_company()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_je_company uuid;
  v_acct_company uuid;
  v_branch_company uuid;
BEGIN
  SELECT company_id INTO v_je_company FROM public.journal_entries WHERE id = NEW.journal_entry_id;
  SELECT company_id INTO v_acct_company FROM public.accounts WHERE id = NEW.account_id;
  SELECT company_id INTO v_branch_company FROM public.branches WHERE id = NEW.branch_id;

  IF v_je_company IS DISTINCT FROM NEW.company_id
     OR v_acct_company IS DISTINCT FROM NEW.company_id
     OR v_branch_company IS DISTINCT FROM NEW.company_id THEN
    RAISE EXCEPTION 'Tenant isolation violation: journal_entry_lines company_id (%) must match journal_entry, account, and branch.', NEW.company_id;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_validate_journal_line_company ON public.journal_entry_lines;
CREATE TRIGGER trg_validate_journal_line_company
  BEFORE INSERT OR UPDATE ON public.journal_entry_lines
  FOR EACH ROW EXECUTE FUNCTION public.erp_validate_journal_line_company();

-- Deferred constraint trigger enforcing SUM(debit) == SUM(credit) for POSTED & PENDING_APPROVAL entries
CREATE OR REPLACE FUNCTION public.erp_enforce_balanced_journal_entry()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_je_id uuid;
  v_status varchar(25);
  v_sum_debit numeric(18, 2);
  v_sum_credit numeric(18, 2);
  v_line_count integer;
BEGIN
  IF TG_TABLE_NAME = 'journal_entries' THEN
    v_je_id := NEW.id;
  ELSE
    v_je_id := COALESCE(NEW.journal_entry_id, OLD.journal_entry_id);
  END IF;

  SELECT status INTO v_status FROM public.journal_entries WHERE id = v_je_id;
  IF v_status IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT COALESCE(SUM(debit), 0.00), COALESCE(SUM(credit), 0.00), COUNT(*)
    INTO v_sum_debit, v_sum_credit, v_line_count
  FROM public.journal_entry_lines
  WHERE journal_entry_id = v_je_id;

  -- Keep header totals synchronized
  UPDATE public.journal_entries
     SET total_debit = v_sum_debit,
         total_credit = v_sum_credit
   WHERE id = v_je_id
     AND (total_debit IS DISTINCT FROM v_sum_debit OR total_credit IS DISTINCT FROM v_sum_credit);

  IF v_status IN ('POSTED', 'PENDING_APPROVAL') THEN
    IF v_line_count < 2 THEN
      RAISE EXCEPTION 'Double-entry violation on journal %: at least 2 lines are required.', v_je_id;
    END IF;
    IF v_sum_debit <> v_sum_credit OR v_sum_debit <= 0 THEN
      RAISE EXCEPTION 'Unbalanced double-entry journal %: total debit (%) != total credit (%).', v_je_id, v_sum_debit, v_sum_credit;
    END IF;
  END IF;

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_je_lines_balance_check ON public.journal_entry_lines;
CREATE CONSTRAINT TRIGGER trg_je_lines_balance_check
  AFTER INSERT OR UPDATE OR DELETE ON public.journal_entry_lines
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.erp_enforce_balanced_journal_entry();

DROP TRIGGER IF EXISTS trg_je_header_balance_check ON public.journal_entries;
CREATE CONSTRAINT TRIGGER trg_je_header_balance_check
  AFTER INSERT OR UPDATE OF status ON public.journal_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.erp_enforce_balanced_journal_entry();

-- Helper function to provision Nepal-standard Chart of Accounts (NPR + 13% VAT ledgers) for any new company
CREATE OR REPLACE FUNCTION public.seed_nepal_standard_coa(p_company_id uuid)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO public.accounts (company_id, code, name, account_type, sub_type, currency_code, is_system, is_intercompany, is_bank_or_cash, is_vat_account)
  VALUES
    (p_company_id, '1000', 'Cash on Hand',                        'ASSET',     'CASH',          'NPR', true,  false, true,  false),
    (p_company_id, '1010', 'Operating Bank Account',              'ASSET',     'BANK',          'NPR', true,  false, true,  false),
    (p_company_id, '1200', 'Accounts Receivable',                 'ASSET',     'RECEIVABLE',    'NPR', true,  false, false, false),
    (p_company_id, '1300', 'Inventory Asset',                     'ASSET',     'INVENTORY',     'NPR', true,  false, false, false),
    (p_company_id, '1400', 'Input VAT Receivable (13%)',          'ASSET',     'TAX_ASSET',     'NPR', true,  false, false, true),
    (p_company_id, '1500', 'Property, Plant & Equipment',         'ASSET',     'FIXED_ASSET',   'NPR', false, false, false, false),
    (p_company_id, '1900', 'Inter-Company Due From',              'ASSET',     'INTERCOMPANY',  'NPR', true,  true,  false, false),
    (p_company_id, '2000', 'Accounts Payable',                    'LIABILITY', 'PAYABLE',       'NPR', true,  false, false, false),
    (p_company_id, '2100', 'Output VAT Payable (13%)',            'LIABILITY', 'TAX_LIABILITY', 'NPR', true,  false, false, true),
    (p_company_id, '2200', 'TDS & Statutory Tax Payable',         'LIABILITY', 'TAX_LIABILITY', 'NPR', false, false, false, false),
    (p_company_id, '2500', 'Long-Term Bank Loan',                 'LIABILITY', 'LONG_TERM',     'NPR', false, false, false, false),
    (p_company_id, '2900', 'Inter-Company Due To',                'LIABILITY', 'INTERCOMPANY',  'NPR', true,  true,  false, false),
    (p_company_id, '3000', 'Paid-Up Share Capital',               'EQUITY',    'CAPITAL',       'NPR', true,  false, false, false),
    (p_company_id, '3200', 'Retained Earnings',                   'EQUITY',    'RETAINED',      'NPR', true,  false, false, false),
    (p_company_id, '4000', 'Sales Revenue',                       'REVENUE',   'OPERATING',     'NPR', true,  false, false, false),
    (p_company_id, '4100', 'Service & Workshop Revenue',          'REVENUE',   'OPERATING',     'NPR', false, false, false, false),
    (p_company_id, '5000', 'Cost of Goods Sold (COGS)',           'EXPENSE',   'COGS',          'NPR', true,  false, false, false),
    (p_company_id, '6000', 'Salaries & Staff Benefits',           'EXPENSE',   'OPERATING',     'NPR', false, false, false, false),
    (p_company_id, '6100', 'Branch Rent & Utilities',             'EXPENSE',   'OPERATING',     'NPR', false, false, false, false),
    (p_company_id, '6200', 'General & Administrative Expense',    'EXPENSE',   'OPERATING',     'NPR', true,  false, false, false)
  ON CONFLICT (company_id, code) DO NOTHING;
END;
$$;
