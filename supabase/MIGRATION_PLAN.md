# Phase 1.1 — Supabase PostgreSQL Database Foundation Migration Plan

**Status:** STAGED ONLY — **Not applied.** Do not apply until your target Supabase PostgreSQL connection is verified and you explicitly approve execution.  
**Preservation Guarantee:** Zero existing UI components, dashboards, routes, server modules, or local SQLite records (`/data/nextgen_erp.sqlite`) were modified or deleted.

---

## 1. Execution Order & Non-Destructive Guarantee

All 4 SQL migration scripts are **additive and idempotent** (`CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`, `CREATE OR REPLACE FUNCTION`, `ON CONFLICT DO NOTHING`, and `DROP TRIGGER/POLICY IF EXISTS` only for newly introduced ERP objects). No `DROP TABLE`, `TRUNCATE`, or destructive `ALTER COLUMN` statements exist.

| Order | Migration File | Scope & Objects Created |
| :--- | :--- | :--- |
| **1** | `supabase/migrations/202611190001_phase1_core_org_rbac.sql` | `pgcrypto` extension, `erp_set_updated_at()` trigger function, `companies`, `branches`, `roles`, `permissions`, `role_permissions`, `profiles`, `user_company_roles`, plus idempotent baseline system roles and permissions. |
| **2** | `supabase/migrations/202611190002_phase1_accounting_ledger.sql` | `accounts`, `journal_entries`, `journal_entry_lines`, cross-company integrity trigger (`trg_validate_journal_line_company`), deferred double-entry balance constraint triggers (`trg_je_lines_balance_check`, `trg_je_header_balance_check`), and `seed_nepal_standard_coa(company_id)` helper. |
| **3** | `supabase/migrations/202611190003_phase1_commercial_inventory_audit.sql` | `customers`, `suppliers`, `products`, `warehouses`, `stock_movements`, `invoices`, `invoice_items`, `payments`, `receipts`, `audit_logs` with composite indexes and CHECK constraints. |
| **4** | `supabase/migrations/202611190004_phase1_rls_security.sql` | `SECURITY DEFINER` RLS helper functions (`erp_is_super_admin`, `erp_has_company_access`, `erp_has_branch_access`, `erp_has_permission`), `ENABLE ROW LEVEL SECURITY` across all 20 tables, company/branch isolation policies, Segregation of Duties approval policy, and append-only `audit_logs` policies. |

---

## 2. Nepal-Friendly Accounting & Bikram Sambat Design

- **Currency & Monetary Precision:** Defaults to `NPR` (`currency_code varchar(3) DEFAULT 'NPR'`). All monetary columns use exact `numeric(18, 2)` and quantities/unit costs use `numeric(18, 4)` to prevent floating-point drift.
- **Nepal VAT (13%) & PAN/VAT Compliance:**
  - `companies`: `tax_id_label = 'VAT/PAN'`, `pan_vat_number`, `vat_registered`, `default_vat_rate = 13.00`.
  - `accounts`: `is_vat_account` flag with standard `1400 Input VAT Receivable (13%)`, `2100 Output VAT Payable (13%)`, and `2200 TDS & Statutory Tax Payable` in `seed_nepal_standard_coa()`.
  - `invoices` & `invoice_items`: `subtotal`, `discount_amount`, `taxable_amount`, `vat_rate`, `vat_amount`, `total_amount`.
- **Dual AD + Bikram Sambat (BS) Compatibility:**
  - Canonical Gregorian `date` columns (`entry_date`, `invoice_date`, `due_date`, `payment_date`, `receipt_date`, `movement_date`) power exact PostgreSQL range queries, aging buckets, and sorting.
  - Dedicated BS display fields (`entry_date_bs`, `invoice_date_bs`, `payment_date_bs`, `receipt_date_bs`, `movement_date_bs`, `fiscal_year_bs` defaulting to `'2082/83'`, and `profiles.preferred_calendar` `'BS' | 'AD'`) preserve authentic Nepal fiscal year reporting (Shrawan–Ashadh) and printable BS voucher dates.

---

## 3. Double-Entry Bookkeeping & Tenant Isolation Guarantees

1. **Line-Level Check Constraint:** Every row in `journal_entry_lines` must satisfy `(debit > 0 AND credit = 0) OR (credit > 0 AND debit = 0)`.
2. **Cross-Company Guard Trigger:** `trg_validate_journal_line_company` rejects any line whose `company_id` does not match its parent `journal_entries`, `accounts`, and `branches` records.
3. **Deferred Balance Constraint Trigger:** `trg_je_lines_balance_check` and `trg_je_header_balance_check` (`DEFERRABLE INITIALLY DEFERRED`) verify at transaction `COMMIT` time that every `POSTED` or `PENDING_APPROVAL` journal has at least 2 lines and `SUM(debit) = SUM(credit) > 0`, while keeping header `total_debit` / `total_credit` synchronized.
4. **Database-Level Row Level Security (RLS):**
   - Enabled on every table in `public`.
   - Company-level isolation via `erp_has_company_access(company_id)`.
   - Branch-level isolation on transactional tables (`branches`, `warehouses`, `stock_movements`, `invoices`, `payments`, `receipts`, `journal_entry_lines`) via `erp_has_branch_access(company_id, branch_id)`.
   - **Segregation of Duties (SoD):** Updating a `journal_entries` record to `POSTED` requires `accounting.approve` permission and `created_by IS DISTINCT FROM auth.uid()` (unless `is_super_admin = true`).
   - **Immutable Audit Logs:** `audit_logs` permits only `SELECT` and `INSERT`; no `UPDATE` or `DELETE` policy exists.

---

## 4. Security Boundary for Supabase Keys

- **Frontend (`VITE_*` only):** May only receive `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`. All client calls run under the signed-in user's JWT with RLS enforced.
- **Backend (`server.ts` / `src/server/*` only):** `SUPABASE_SERVICE_ROLE_KEY` and direct PostgreSQL connection credentials must remain strictly server-side environment secrets and must **never** be prefixed with `VITE_` or imported into `src/components/*` or `src/lib/*`.

---

## 5. Pre-Application Verification Checklist (Before Running Migrations)

1. Confirm target Supabase project ref and PostgreSQL connection string (`supabase status` or `psql` connectivity test).
2. Confirm you are targeting the intended **staging or production** Supabase database (and take a manual Supabase snapshot if existing tables are present).
3. Apply migrations in exact numeric order (`0001` → `0002` → `0003` → `0004`) via Supabase CLI (`supabase db push`) or Supabase SQL Editor.
4. Run post-migration verification queries:
   - Verify all 20 tables exist in `information_schema.tables`.
   - Verify `rowsecurity = true` on all 20 tables in `pg_tables`.
   - Verify an unbalanced `POSTED` journal insert raises an exception inside a rolled-back test transaction.
   - Verify an authenticated user assigned only to Company A receives 0 rows from Company B.
