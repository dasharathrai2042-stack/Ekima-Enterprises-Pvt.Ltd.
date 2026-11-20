-- ============================================================================
-- PHASE 1.1 MIGRATION 0004: Row Level Security (RLS) & Company Isolation
-- Guarantees database-level tenant isolation using auth.uid() + company_id.
-- Note: Never expose SUPABASE_SERVICE_ROLE_KEY in frontend code; browser and
-- user-scoped API calls run under authenticated JWT with RLS enforced.
-- ============================================================================

-- Helper 1: Is current authenticated user an active platform Super Admin?
CREATE OR REPLACE FUNCTION public.erp_is_super_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.profiles p
    WHERE p.id = auth.uid()
      AND p.is_super_admin = true
      AND p.is_active = true
  );
$$;

-- Helper 2: Does current authenticated user belong to company p_company_id?
CREATE OR REPLACE FUNCTION public.erp_has_company_access(p_company_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.erp_is_super_admin() OR EXISTS (
    SELECT 1
    FROM public.user_company_roles ucr
    WHERE ucr.user_id = auth.uid()
      AND ucr.company_id = p_company_id
      AND ucr.is_active = true
  );
$$;

-- Helper 3: Does current authenticated user have access to specific branch (or all branches in company)?
CREATE OR REPLACE FUNCTION public.erp_has_branch_access(p_company_id uuid, p_branch_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.erp_is_super_admin() OR EXISTS (
    SELECT 1
    FROM public.user_company_roles ucr
    WHERE ucr.user_id = auth.uid()
      AND ucr.company_id = p_company_id
      AND ucr.is_active = true
      AND (ucr.branch_id IS NULL OR ucr.branch_id = p_branch_id)
  );
$$;

-- Helper 4: Does current user hold a specific permission code in company p_company_id?
CREATE OR REPLACE FUNCTION public.erp_has_permission(p_company_id uuid, p_permission_code varchar)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.erp_is_super_admin() OR EXISTS (
    SELECT 1
    FROM public.user_company_roles ucr
    JOIN public.role_permissions rp ON rp.role_id = ucr.role_id
    JOIN public.permissions perm ON perm.id = rp.permission_id
    WHERE ucr.user_id = auth.uid()
      AND ucr.company_id = p_company_id
      AND ucr.is_active = true
      AND perm.code = p_permission_code
  );
$$;

-- ============================================================================
-- ENABLE RLS ACROSS ALL PHASE 1.1 TABLES
-- ============================================================================
ALTER TABLE public.companies           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.branches            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.roles               ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.permissions         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.role_permissions    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.profiles            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_company_roles  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.accounts            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.journal_entries     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.journal_entry_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.customers           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.suppliers           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.products            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.warehouses          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stock_movements     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.invoices            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.invoice_items       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payments            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.receipts            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_logs          ENABLE ROW LEVEL SECURITY;

-- ============================================================================
-- 1. COMPANIES & BRANCHES POLICIES
-- ============================================================================
DROP POLICY IF EXISTS companies_select_authorized ON public.companies;
CREATE POLICY companies_select_authorized ON public.companies
  FOR SELECT TO authenticated
  USING (public.erp_has_company_access(id));

DROP POLICY IF EXISTS companies_manage_admin ON public.companies;
CREATE POLICY companies_manage_admin ON public.companies
  FOR ALL TO authenticated
  USING (public.erp_is_super_admin() OR public.erp_has_permission(id, 'company.manage'))
  WITH CHECK (public.erp_is_super_admin() OR public.erp_has_permission(id, 'company.manage'));

DROP POLICY IF EXISTS branches_select_authorized ON public.branches;
CREATE POLICY branches_select_authorized ON public.branches
  FOR SELECT TO authenticated
  USING (public.erp_has_branch_access(company_id, id));

DROP POLICY IF EXISTS branches_manage_admin ON public.branches;
CREATE POLICY branches_manage_admin ON public.branches
  FOR ALL TO authenticated
  USING (public.erp_has_permission(company_id, 'company.manage'))
  WITH CHECK (public.erp_has_permission(company_id, 'company.manage'));

-- ============================================================================
-- 2. PROFILES, ROLES & PERMISSIONS POLICIES
-- ============================================================================
DROP POLICY IF EXISTS profiles_select_self_or_company ON public.profiles;
CREATE POLICY profiles_select_self_or_company ON public.profiles
  FOR SELECT TO authenticated
  USING (id = auth.uid() OR (company_id IS NOT NULL AND public.erp_has_company_access(company_id)));

DROP POLICY IF EXISTS profiles_update_self ON public.profiles;
CREATE POLICY profiles_update_self ON public.profiles
  FOR UPDATE TO authenticated
  USING (id = auth.uid() OR public.erp_is_super_admin())
  WITH CHECK (id = auth.uid() OR public.erp_is_super_admin());

DROP POLICY IF EXISTS roles_select_visible ON public.roles;
CREATE POLICY roles_select_visible ON public.roles
  FOR SELECT TO authenticated
  USING (company_id IS NULL OR public.erp_has_company_access(company_id));

DROP POLICY IF EXISTS permissions_select_authenticated ON public.permissions;
CREATE POLICY permissions_select_authenticated ON public.permissions
  FOR SELECT TO authenticated
  USING (true);

DROP POLICY IF EXISTS role_permissions_select_authenticated ON public.role_permissions;
CREATE POLICY role_permissions_select_authenticated ON public.role_permissions
  FOR SELECT TO authenticated
  USING (true);

DROP POLICY IF EXISTS ucr_select_own_or_admin ON public.user_company_roles;
CREATE POLICY ucr_select_own_or_admin ON public.user_company_roles
  FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR public.erp_has_permission(company_id, 'company.manage'));

DROP POLICY IF EXISTS ucr_manage_admin ON public.user_company_roles;
CREATE POLICY ucr_manage_admin ON public.user_company_roles
  FOR ALL TO authenticated
  USING (public.erp_has_permission(company_id, 'company.manage'))
  WITH CHECK (public.erp_has_permission(company_id, 'company.manage'));

-- ============================================================================
-- 3. ACCOUNTING POLICIES (Company Isolation + Segregation of Duties)
-- ============================================================================
DROP POLICY IF EXISTS accounts_company_isolation ON public.accounts;
CREATE POLICY accounts_company_isolation ON public.accounts
  FOR ALL TO authenticated
  USING (public.erp_has_company_access(company_id))
  WITH CHECK (public.erp_has_company_access(company_id));

DROP POLICY IF EXISTS je_select_company ON public.journal_entries;
CREATE POLICY je_select_company ON public.journal_entries
  FOR SELECT TO authenticated
  USING (public.erp_has_company_access(company_id));

DROP POLICY IF EXISTS je_insert_company ON public.journal_entries;
CREATE POLICY je_insert_company ON public.journal_entries
  FOR INSERT TO authenticated
  WITH CHECK (public.erp_has_company_access(company_id));

-- Segregation of Duties: approving a pending voucher requires approver permission & non-self approval (unless Super Admin)
DROP POLICY IF EXISTS je_update_company_sod ON public.journal_entries;
CREATE POLICY je_update_company_sod ON public.journal_entries
  FOR UPDATE TO authenticated
  USING (public.erp_has_company_access(company_id))
  WITH CHECK (
    public.erp_has_company_access(company_id)
    AND (
      status <> 'POSTED'
      OR public.erp_is_super_admin()
      OR (approved_by = auth.uid() AND created_by IS DISTINCT FROM auth.uid() AND public.erp_has_permission(company_id, 'accounting.approve'))
    )
  );

DROP POLICY IF EXISTS jel_company_branch_isolation ON public.journal_entry_lines;
CREATE POLICY jel_company_branch_isolation ON public.journal_entry_lines
  FOR ALL TO authenticated
  USING (public.erp_has_branch_access(company_id, branch_id))
  WITH CHECK (public.erp_has_branch_access(company_id, branch_id));

-- ============================================================================
-- 4. COMMERCIAL & INVENTORY POLICIES (Strict Company & Branch Isolation)
-- ============================================================================
DROP POLICY IF EXISTS customers_company_isolation ON public.customers;
CREATE POLICY customers_company_isolation ON public.customers
  FOR ALL TO authenticated
  USING (public.erp_has_company_access(company_id))
  WITH CHECK (public.erp_has_company_access(company_id));

DROP POLICY IF EXISTS suppliers_company_isolation ON public.suppliers;
CREATE POLICY suppliers_company_isolation ON public.suppliers
  FOR ALL TO authenticated
  USING (public.erp_has_company_access(company_id))
  WITH CHECK (public.erp_has_company_access(company_id));

DROP POLICY IF EXISTS products_company_isolation ON public.products;
CREATE POLICY products_company_isolation ON public.products
  FOR ALL TO authenticated
  USING (public.erp_has_company_access(company_id))
  WITH CHECK (public.erp_has_company_access(company_id));

DROP POLICY IF EXISTS warehouses_branch_isolation ON public.warehouses;
CREATE POLICY warehouses_branch_isolation ON public.warehouses
  FOR ALL TO authenticated
  USING (public.erp_has_branch_access(company_id, branch_id))
  WITH CHECK (public.erp_has_branch_access(company_id, branch_id));

DROP POLICY IF EXISTS stock_movements_branch_isolation ON public.stock_movements;
CREATE POLICY stock_movements_branch_isolation ON public.stock_movements
  FOR ALL TO authenticated
  USING (public.erp_has_branch_access(company_id, branch_id))
  WITH CHECK (public.erp_has_branch_access(company_id, branch_id));

DROP POLICY IF EXISTS invoices_branch_isolation ON public.invoices;
CREATE POLICY invoices_branch_isolation ON public.invoices
  FOR ALL TO authenticated
  USING (public.erp_has_branch_access(company_id, branch_id))
  WITH CHECK (public.erp_has_branch_access(company_id, branch_id));

DROP POLICY IF EXISTS invoice_items_company_isolation ON public.invoice_items;
CREATE POLICY invoice_items_company_isolation ON public.invoice_items
  FOR ALL TO authenticated
  USING (public.erp_has_company_access(company_id))
  WITH CHECK (public.erp_has_company_access(company_id));

DROP POLICY IF EXISTS payments_branch_isolation ON public.payments;
CREATE POLICY payments_branch_isolation ON public.payments
  FOR ALL TO authenticated
  USING (public.erp_has_branch_access(company_id, branch_id))
  WITH CHECK (public.erp_has_branch_access(company_id, branch_id));

DROP POLICY IF EXISTS receipts_branch_isolation ON public.receipts;
CREATE POLICY receipts_branch_isolation ON public.receipts
  FOR ALL TO authenticated
  USING (public.erp_has_branch_access(company_id, branch_id))
  WITH CHECK (public.erp_has_branch_access(company_id, branch_id));

-- ============================================================================
-- 5. IMMUTABLE AUDIT LOGS POLICY (Append-Only: SELECT + INSERT, NO UPDATE/DELETE)
-- ============================================================================
DROP POLICY IF EXISTS audit_logs_select_company ON public.audit_logs;
CREATE POLICY audit_logs_select_company ON public.audit_logs
  FOR SELECT TO authenticated
  USING (company_id IS NULL AND public.erp_is_super_admin() OR (company_id IS NOT NULL AND public.erp_has_company_access(company_id)));

DROP POLICY IF EXISTS audit_logs_insert_authenticated ON public.audit_logs;
CREATE POLICY audit_logs_insert_authenticated ON public.audit_logs
  FOR INSERT TO authenticated
  WITH CHECK (company_id IS NULL OR public.erp_has_company_access(company_id));
