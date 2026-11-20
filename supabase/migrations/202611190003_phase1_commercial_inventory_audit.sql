-- ============================================================================
-- PHASE 1.1 MIGRATION 0003: Commercial, Inventory, Treasury & Audit Tables
-- Tables: customers, suppliers, products, warehouses, stock_movements,
--         invoices, invoice_items, payments, receipts, audit_logs
-- ============================================================================

-- 9. CUSTOMERS (Company-Isolated AR Master)
CREATE TABLE IF NOT EXISTS public.customers (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id            uuid NOT NULL REFERENCES public.companies(id) ON DELETE RESTRICT,
  branch_id             uuid REFERENCES public.branches(id) ON DELETE SET NULL,
  code                  varchar(40) NOT NULL,
  name                  varchar(200) NOT NULL,
  pan_vat_number        varchar(50) NOT NULL DEFAULT '',
  phone                 varchar(50) NOT NULL DEFAULT '',
  email                 varchar(150) NOT NULL DEFAULT '',
  address               text NOT NULL DEFAULT '',
  credit_limit          numeric(18, 2) NOT NULL DEFAULT 0.00 CHECK (credit_limit >= 0),
  payment_terms_days    integer NOT NULL DEFAULT 30 CHECK (payment_terms_days >= 0),
  is_intercompany       boolean NOT NULL DEFAULT false,
  is_active             boolean NOT NULL DEFAULT true,
  created_at            timestamptz NOT NULL DEFAULT timezone('utc', now()),
  updated_at            timestamptz NOT NULL DEFAULT timezone('utc', now()),
  UNIQUE (company_id, code)
);

CREATE INDEX IF NOT EXISTS idx_customers_company ON public.customers (company_id, is_active);
CREATE INDEX IF NOT EXISTS idx_customers_pan ON public.customers (company_id, pan_vat_number) WHERE pan_vat_number <> '';

DROP TRIGGER IF EXISTS trg_customers_updated_at ON public.customers;
CREATE TRIGGER trg_customers_updated_at
  BEFORE UPDATE ON public.customers
  FOR EACH ROW EXECUTE FUNCTION public.erp_set_updated_at();

-- 10. SUPPLIERS (Company-Isolated AP Master)
CREATE TABLE IF NOT EXISTS public.suppliers (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id            uuid NOT NULL REFERENCES public.companies(id) ON DELETE RESTRICT,
  branch_id             uuid REFERENCES public.branches(id) ON DELETE SET NULL,
  code                  varchar(40) NOT NULL,
  name                  varchar(200) NOT NULL,
  pan_vat_number        varchar(50) NOT NULL DEFAULT '',
  phone                 varchar(50) NOT NULL DEFAULT '',
  email                 varchar(150) NOT NULL DEFAULT '',
  address               text NOT NULL DEFAULT '',
  credit_limit          numeric(18, 2) NOT NULL DEFAULT 0.00 CHECK (credit_limit >= 0),
  payment_terms_days    integer NOT NULL DEFAULT 30 CHECK (payment_terms_days >= 0),
  is_intercompany       boolean NOT NULL DEFAULT false,
  is_active             boolean NOT NULL DEFAULT true,
  created_at            timestamptz NOT NULL DEFAULT timezone('utc', now()),
  updated_at            timestamptz NOT NULL DEFAULT timezone('utc', now()),
  UNIQUE (company_id, code)
);

CREATE INDEX IF NOT EXISTS idx_suppliers_company ON public.suppliers (company_id, is_active);

DROP TRIGGER IF EXISTS trg_suppliers_updated_at ON public.suppliers;
CREATE TRIGGER trg_suppliers_updated_at
  BEFORE UPDATE ON public.suppliers
  FOR EACH ROW EXECUTE FUNCTION public.erp_set_updated_at();

-- 11. PRODUCTS (Vehicles, Spare Parts, Goods & Services with FIFO/WA & Lot Tracking)
CREATE TABLE IF NOT EXISTS public.products (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id            uuid NOT NULL REFERENCES public.companies(id) ON DELETE RESTRICT,
  sku                   varchar(60) NOT NULL,
  name                  varchar(200) NOT NULL,
  category              varchar(80) NOT NULL DEFAULT 'General',
  product_type          varchar(20) NOT NULL DEFAULT 'INVENTORY'
                        CHECK (product_type IN ('INVENTORY', 'VEHICLE', 'SPARE_PART', 'SERVICE')),
  unit                  varchar(20) NOT NULL DEFAULT 'PCS',
  valuation_method      varchar(20) NOT NULL DEFAULT 'FIFO'
                        CHECK (valuation_method IN ('FIFO', 'WEIGHTED_AVERAGE')),
  tracking_type         varchar(20) NOT NULL DEFAULT 'NONE'
                        CHECK (tracking_type IN ('NONE', 'BATCH', 'SERIAL', 'VIN_ENGINE')),
  is_vat_applicable     boolean NOT NULL DEFAULT true,
  vat_rate              numeric(5, 2) NOT NULL DEFAULT 13.00 CHECK (vat_rate >= 0 AND vat_rate <= 100),
  standard_sale_price   numeric(18, 2) NOT NULL DEFAULT 0.00 CHECK (standard_sale_price >= 0),
  standard_cost         numeric(18, 4) NOT NULL DEFAULT 0.0000 CHECK (standard_cost >= 0),
  reorder_level         numeric(18, 4) NOT NULL DEFAULT 5.0000 CHECK (reorder_level >= 0),
  reorder_qty           numeric(18, 4) NOT NULL DEFAULT 10.0000 CHECK (reorder_qty >= 0),
  is_active             boolean NOT NULL DEFAULT true,
  created_at            timestamptz NOT NULL DEFAULT timezone('utc', now()),
  updated_at            timestamptz NOT NULL DEFAULT timezone('utc', now()),
  UNIQUE (company_id, sku)
);

CREATE INDEX IF NOT EXISTS idx_products_company ON public.products (company_id, is_active);
CREATE INDEX IF NOT EXISTS idx_products_type ON public.products (company_id, product_type, tracking_type);

DROP TRIGGER IF EXISTS trg_products_updated_at ON public.products;
CREATE TRIGGER trg_products_updated_at
  BEFORE UPDATE ON public.products
  FOR EACH ROW EXECUTE FUNCTION public.erp_set_updated_at();

-- 12. WAREHOUSES (Branch-Linked Stock Facilities)
CREATE TABLE IF NOT EXISTS public.warehouses (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id            uuid NOT NULL REFERENCES public.companies(id) ON DELETE RESTRICT,
  branch_id             uuid NOT NULL REFERENCES public.branches(id) ON DELETE RESTRICT,
  code                  varchar(30) NOT NULL,
  name                  varchar(150) NOT NULL,
  location_note         text NOT NULL DEFAULT '',
  is_active             boolean NOT NULL DEFAULT true,
  created_at            timestamptz NOT NULL DEFAULT timezone('utc', now()),
  updated_at            timestamptz NOT NULL DEFAULT timezone('utc', now()),
  UNIQUE (company_id, code)
);

CREATE INDEX IF NOT EXISTS idx_warehouses_company_branch ON public.warehouses (company_id, branch_id);

DROP TRIGGER IF EXISTS trg_warehouses_updated_at ON public.warehouses;
CREATE TRIGGER trg_warehouses_updated_at
  BEFORE UPDATE ON public.warehouses
  FOR EACH ROW EXECUTE FUNCTION public.erp_set_updated_at();

-- 13. STOCK_MOVEMENTS (Immutable Inventory Ledger with VIN/Engine/Serial/Batch Traceability)
CREATE TABLE IF NOT EXISTS public.stock_movements (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id            uuid NOT NULL REFERENCES public.companies(id) ON DELETE RESTRICT,
  branch_id             uuid NOT NULL REFERENCES public.branches(id) ON DELETE RESTRICT,
  warehouse_id          uuid NOT NULL REFERENCES public.warehouses(id) ON DELETE RESTRICT,
  product_id            uuid NOT NULL REFERENCES public.products(id) ON DELETE RESTRICT,
  movement_type         varchar(30) NOT NULL
                        CHECK (movement_type IN ('OPENING', 'PURCHASE_IN', 'SALE_OUT', 'TRANSFER_IN', 'TRANSFER_OUT', 'ADJUSTMENT_IN', 'ADJUSTMENT_OUT', 'SERVICE_ISSUE')),
  movement_date         date NOT NULL DEFAULT CURRENT_DATE,
  movement_date_bs      varchar(15),
  qty_change            numeric(18, 4) NOT NULL CHECK (qty_change <> 0),
  unit_cost             numeric(18, 4) NOT NULL DEFAULT 0.0000 CHECK (unit_cost >= 0),
  total_cost            numeric(18, 2) NOT NULL DEFAULT 0.00 CHECK (total_cost >= 0),
  batch_number          varchar(80),
  serial_number         varchar(100),
  vin_number            varchar(100),
  engine_number         varchar(100),
  expiry_date           date,
  reference_type        varchar(40) NOT NULL DEFAULT 'MANUAL',
  reference_id          uuid,
  notes                 text NOT NULL DEFAULT '',
  created_by            uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at            timestamptz NOT NULL DEFAULT timezone('utc', now())
);

CREATE INDEX IF NOT EXISTS idx_stock_moves_company_prod ON public.stock_movements (company_id, product_id, warehouse_id, movement_date DESC);
CREATE INDEX IF NOT EXISTS idx_stock_moves_tracking ON public.stock_movements (company_id, vin_number, serial_number, batch_number);

-- 14. INVOICES (Sales, Purchase, Service, Credit/Debit Notes with Nepal VAT & BS Dates)
CREATE TABLE IF NOT EXISTS public.invoices (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id            uuid NOT NULL REFERENCES public.companies(id) ON DELETE RESTRICT,
  branch_id             uuid NOT NULL REFERENCES public.branches(id) ON DELETE RESTRICT,
  invoice_type          varchar(20) NOT NULL
                        CHECK (invoice_type IN ('SALES', 'PURCHASE', 'SERVICE', 'CREDIT_NOTE', 'DEBIT_NOTE')),
  invoice_number        varchar(40) NOT NULL,
  invoice_date          date NOT NULL,
  invoice_date_bs       varchar(15), -- Nepal Bikram Sambat e.g. '2082-11-15'
  due_date              date NOT NULL,
  fiscal_year_bs        varchar(20) NOT NULL DEFAULT '2082/83',
  customer_id           uuid REFERENCES public.customers(id) ON DELETE RESTRICT,
  supplier_id           uuid REFERENCES public.suppliers(id) ON DELETE RESTRICT,
  currency_code         varchar(3) NOT NULL DEFAULT 'NPR',
  subtotal              numeric(18, 2) NOT NULL DEFAULT 0.00 CHECK (subtotal >= 0),
  discount_amount       numeric(18, 2) NOT NULL DEFAULT 0.00 CHECK (discount_amount >= 0),
  taxable_amount        numeric(18, 2) NOT NULL DEFAULT 0.00 CHECK (taxable_amount >= 0),
  vat_rate              numeric(5, 2) NOT NULL DEFAULT 13.00 CHECK (vat_rate >= 0 AND vat_rate <= 100),
  vat_amount            numeric(18, 2) NOT NULL DEFAULT 0.00 CHECK (vat_amount >= 0),
  total_amount          numeric(18, 2) NOT NULL DEFAULT 0.00 CHECK (total_amount >= 0),
  paid_amount           numeric(18, 2) NOT NULL DEFAULT 0.00 CHECK (paid_amount >= 0),
  status                varchar(20) NOT NULL DEFAULT 'OPEN'
                        CHECK (status IN ('DRAFT', 'OPEN', 'PARTIAL', 'PAID', 'CANCELLED')),
  is_intercompany       boolean NOT NULL DEFAULT false,
  notes                 text NOT NULL DEFAULT '',
  journal_entry_id      uuid REFERENCES public.journal_entries(id) ON DELETE SET NULL,
  created_by            uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at            timestamptz NOT NULL DEFAULT timezone('utc', now()),
  updated_at            timestamptz NOT NULL DEFAULT timezone('utc', now()),
  UNIQUE (company_id, invoice_number),
  CHECK (
    (invoice_type IN ('SALES', 'SERVICE', 'CREDIT_NOTE') AND customer_id IS NOT NULL)
    OR
    (invoice_type IN ('PURCHASE', 'DEBIT_NOTE') AND supplier_id IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_invoices_company_type_date ON public.invoices (company_id, invoice_type, invoice_date DESC);
CREATE INDEX IF NOT EXISTS idx_invoices_company_customer ON public.invoices (company_id, customer_id) WHERE customer_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_invoices_company_supplier ON public.invoices (company_id, supplier_id) WHERE supplier_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_invoices_company_status ON public.invoices (company_id, status);

DROP TRIGGER IF EXISTS trg_invoices_updated_at ON public.invoices;
CREATE TRIGGER trg_invoices_updated_at
  BEFORE UPDATE ON public.invoices
  FOR EACH ROW EXECUTE FUNCTION public.erp_set_updated_at();

-- 15. INVOICE_ITEMS (Multi-Line Invoice & Bill Detail Rows)
CREATE TABLE IF NOT EXISTS public.invoice_items (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id            uuid NOT NULL REFERENCES public.companies(id) ON DELETE RESTRICT,
  invoice_id            uuid NOT NULL REFERENCES public.invoices(id) ON DELETE CASCADE,
  product_id            uuid REFERENCES public.products(id) ON DELETE RESTRICT,
  warehouse_id          uuid REFERENCES public.warehouses(id) ON DELETE RESTRICT,
  description           text NOT NULL,
  qty                   numeric(18, 4) NOT NULL CHECK (qty > 0),
  unit_price            numeric(18, 2) NOT NULL CHECK (unit_price >= 0),
  discount_amount       numeric(18, 2) NOT NULL DEFAULT 0.00 CHECK (discount_amount >= 0),
  vat_rate              numeric(5, 2) NOT NULL DEFAULT 13.00 CHECK (vat_rate >= 0),
  vat_amount            numeric(18, 2) NOT NULL DEFAULT 0.00 CHECK (vat_amount >= 0),
  line_total            numeric(18, 2) NOT NULL CHECK (line_total >= 0),
  cogs_amount           numeric(18, 2) NOT NULL DEFAULT 0.00 CHECK (cogs_amount >= 0),
  vin_number            varchar(100),
  engine_number         varchar(100),
  serial_number         varchar(100),
  batch_number          varchar(80),
  created_at            timestamptz NOT NULL DEFAULT timezone('utc', now())
);

CREATE INDEX IF NOT EXISTS idx_invoice_items_invoice ON public.invoice_items (invoice_id);
CREATE INDEX IF NOT EXISTS idx_invoice_items_company_prod ON public.invoice_items (company_id, product_id);

-- 16. PAYMENTS (Outgoing Supplier Settlements & Disbursements)
CREATE TABLE IF NOT EXISTS public.payments (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id            uuid NOT NULL REFERENCES public.companies(id) ON DELETE RESTRICT,
  branch_id             uuid NOT NULL REFERENCES public.branches(id) ON DELETE RESTRICT,
  payment_number        varchar(40) NOT NULL,
  payment_date          date NOT NULL,
  payment_date_bs       varchar(15),
  fiscal_year_bs        varchar(20) NOT NULL DEFAULT '2082/83',
  supplier_id           uuid REFERENCES public.suppliers(id) ON DELETE RESTRICT,
  invoice_id            uuid REFERENCES public.invoices(id) ON DELETE SET NULL,
  bank_account_id       uuid NOT NULL REFERENCES public.accounts(id) ON DELETE RESTRICT,
  currency_code         varchar(3) NOT NULL DEFAULT 'NPR',
  amount                numeric(18, 2) NOT NULL CHECK (amount > 0),
  payment_method        varchar(30) NOT NULL DEFAULT 'BANK_TRANSFER',
  reference_no          varchar(100) NOT NULL DEFAULT '',
  notes                 text NOT NULL DEFAULT '',
  journal_entry_id      uuid REFERENCES public.journal_entries(id) ON DELETE SET NULL,
  created_by            uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at            timestamptz NOT NULL DEFAULT timezone('utc', now()),
  updated_at            timestamptz NOT NULL DEFAULT timezone('utc', now()),
  UNIQUE (company_id, payment_number)
);

CREATE INDEX IF NOT EXISTS idx_payments_company_date ON public.payments (company_id, payment_date DESC);
CREATE INDEX IF NOT EXISTS idx_payments_supplier ON public.payments (company_id, supplier_id);

DROP TRIGGER IF EXISTS trg_payments_updated_at ON public.payments;
CREATE TRIGGER trg_payments_updated_at
  BEFORE UPDATE ON public.payments
  FOR EACH ROW EXECUTE FUNCTION public.erp_set_updated_at();

-- 17. RECEIPTS (Incoming Customer Cash/Bank Receipts)
CREATE TABLE IF NOT EXISTS public.receipts (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id            uuid NOT NULL REFERENCES public.companies(id) ON DELETE RESTRICT,
  branch_id             uuid NOT NULL REFERENCES public.branches(id) ON DELETE RESTRICT,
  receipt_number        varchar(40) NOT NULL,
  receipt_date          date NOT NULL,
  receipt_date_bs       varchar(15),
  fiscal_year_bs        varchar(20) NOT NULL DEFAULT '2082/83',
  customer_id           uuid NOT NULL REFERENCES public.customers(id) ON DELETE RESTRICT,
  invoice_id            uuid REFERENCES public.invoices(id) ON DELETE SET NULL,
  bank_account_id       uuid NOT NULL REFERENCES public.accounts(id) ON DELETE RESTRICT,
  currency_code         varchar(3) NOT NULL DEFAULT 'NPR',
  amount                numeric(18, 2) NOT NULL CHECK (amount > 0),
  payment_method        varchar(30) NOT NULL DEFAULT 'BANK_TRANSFER',
  reference_no          varchar(100) NOT NULL DEFAULT '',
  notes                 text NOT NULL DEFAULT '',
  journal_entry_id      uuid REFERENCES public.journal_entries(id) ON DELETE SET NULL,
  created_by            uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at            timestamptz NOT NULL DEFAULT timezone('utc', now()),
  updated_at            timestamptz NOT NULL DEFAULT timezone('utc', now()),
  UNIQUE (company_id, receipt_number)
);

CREATE INDEX IF NOT EXISTS idx_receipts_company_date ON public.receipts (company_id, receipt_date DESC);
CREATE INDEX IF NOT EXISTS idx_receipts_customer ON public.receipts (company_id, customer_id);

DROP TRIGGER IF EXISTS trg_receipts_updated_at ON public.receipts;
CREATE TRIGGER trg_receipts_updated_at
  BEFORE UPDATE ON public.receipts
  FOR EACH ROW EXECUTE FUNCTION public.erp_set_updated_at();

-- 18. AUDIT_LOGS (Append-Only Immutable Compliance & Governance Trail)
CREATE TABLE IF NOT EXISTS public.audit_logs (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id            uuid REFERENCES public.companies(id) ON DELETE RESTRICT,
  branch_id             uuid REFERENCES public.branches(id) ON DELETE SET NULL,
  user_id               uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  user_email            varchar(200),
  user_role             varchar(40),
  action                varchar(60) NOT NULL,
  entity_type           varchar(60) NOT NULL,
  entity_id             varchar(100) NOT NULL,
  summary               text NOT NULL DEFAULT '',
  old_data              jsonb,
  new_data              jsonb,
  ip_address            inet,
  created_at            timestamptz NOT NULL DEFAULT timezone('utc', now())
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_company_time ON public.audit_logs (company_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_entity ON public.audit_logs (company_id, entity_type, entity_id);
