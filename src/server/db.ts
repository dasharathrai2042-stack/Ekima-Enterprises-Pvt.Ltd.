import fs from 'fs';
import path from 'path';
import { DatabaseSync } from 'node:sqlite';

const DATA_DIR = path.resolve(process.cwd(), 'data');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

export const DB_FILE_PATH = path.join(DATA_DIR, 'nextgen_erp.sqlite');
export const BACKUP_DIR = path.join(DATA_DIR, 'backups');
if (!fs.existsSync(BACKUP_DIR)) {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
}

export const db = new DatabaseSync(DB_FILE_PATH);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');
db.exec('PRAGMA busy_timeout = 5000;');
db.exec('PRAGMA synchronous = NORMAL;');

export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

export function withTransaction<T>(fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // ignore rollback error if transaction already closed
    }
    throw err;
  }
}

export function initSchema(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      full_name TEXT NOT NULL,
      role TEXT NOT NULL,
      default_mode TEXT NOT NULL DEFAULT 'advanced',
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS companies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL UNIQUE,
      legal_name TEXT NOT NULL,
      tax_id_label TEXT NOT NULL DEFAULT 'PAN/VAT',
      pan_vat_number TEXT NOT NULL,
      vat_rate REAL NOT NULL DEFAULT 13.0,
      currency TEXT NOT NULL DEFAULT 'NPR',
      fiscal_year_label TEXT NOT NULL DEFAULT 'FY 2082/83',
      fiscal_start_date TEXT NOT NULL DEFAULT '2025-07-16',
      fiscal_end_date TEXT NOT NULL DEFAULT '2026-07-15',
      invoice_prefix TEXT NOT NULL DEFAULT 'INV',
      next_invoice_seq INTEGER NOT NULL DEFAULT 1001,
      purchase_prefix TEXT NOT NULL DEFAULT 'PUR',
      next_purchase_seq INTEGER NOT NULL DEFAULT 1001,
      journal_prefix TEXT NOT NULL DEFAULT 'JV',
      next_journal_seq INTEGER NOT NULL DEFAULT 1001,
      address TEXT NOT NULL DEFAULT '',
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS branches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      code TEXT NOT NULL,
      name TEXT NOT NULL,
      branch_type TEXT NOT NULL,
      city TEXT NOT NULL DEFAULT '',
      is_active INTEGER NOT NULL DEFAULT 1,
      UNIQUE(company_id, code)
    );
    CREATE INDEX IF NOT EXISTS idx_branches_company ON branches(company_id);

    CREATE TABLE IF NOT EXISTS user_permissions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      branch_id INTEGER REFERENCES branches(id) ON DELETE CASCADE,
      UNIQUE(user_id, company_id, branch_id)
    );
    CREATE INDEX IF NOT EXISTS idx_user_perms_user ON user_permissions(user_id, company_id);

    CREATE TABLE IF NOT EXISTS cost_profit_centers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      code TEXT NOT NULL,
      name TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('COST_CENTER', 'PROFIT_CENTER')),
      department TEXT NOT NULL DEFAULT 'Operations',
      UNIQUE(company_id, code)
    );
    CREATE INDEX IF NOT EXISTS idx_centers_company ON cost_profit_centers(company_id);

    CREATE TABLE IF NOT EXISTS accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      code TEXT NOT NULL,
      name TEXT NOT NULL,
      account_type TEXT NOT NULL CHECK(account_type IN ('ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE')),
      sub_type TEXT NOT NULL DEFAULT 'GENERAL',
      is_system INTEGER NOT NULL DEFAULT 0,
      is_intercompany INTEGER NOT NULL DEFAULT 0,
      is_bank_or_cash INTEGER NOT NULL DEFAULT 0,
      UNIQUE(company_id, code)
    );
    CREATE INDEX IF NOT EXISTS idx_accounts_company_type ON accounts(company_id, account_type);

    CREATE TABLE IF NOT EXISTS fiscal_period_locks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      period_name TEXT NOT NULL,
      start_date TEXT NOT NULL,
      end_date TEXT NOT NULL,
      is_locked INTEGER NOT NULL DEFAULT 0,
      locked_by_name TEXT,
      locked_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_period_locks_company ON fiscal_period_locks(company_id, start_date, end_date);

    CREATE TABLE IF NOT EXISTS parties (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      code TEXT NOT NULL,
      name TEXT NOT NULL,
      party_type TEXT NOT NULL CHECK(party_type IN ('CUSTOMER', 'SUPPLIER', 'BOTH')),
      pan_vat TEXT NOT NULL DEFAULT '',
      phone TEXT NOT NULL DEFAULT '',
      email TEXT NOT NULL DEFAULT '',
      credit_limit REAL NOT NULL DEFAULT 0,
      is_intercompany INTEGER NOT NULL DEFAULT 0,
      UNIQUE(company_id, code)
    );
    CREATE INDEX IF NOT EXISTS idx_parties_company ON parties(company_id, party_type);

    CREATE TABLE IF NOT EXISTS warehouses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      branch_id INTEGER NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
      code TEXT NOT NULL,
      name TEXT NOT NULL,
      UNIQUE(company_id, code)
    );
    CREATE INDEX IF NOT EXISTS idx_warehouses_company ON warehouses(company_id, branch_id);

    CREATE TABLE IF NOT EXISTS stock_locations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      warehouse_id INTEGER NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
      code TEXT NOT NULL,
      name TEXT NOT NULL,
      UNIQUE(warehouse_id, code)
    );

    CREATE TABLE IF NOT EXISTS inventory_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      sku TEXT NOT NULL,
      name TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'General',
      unit TEXT NOT NULL DEFAULT 'PCS',
      valuation_method TEXT NOT NULL CHECK(valuation_method IN ('FIFO', 'WEIGHTED_AVERAGE')) DEFAULT 'FIFO',
      tracking_type TEXT NOT NULL CHECK(tracking_type IN ('NONE', 'BATCH', 'SERIAL', 'VIN_ENGINE')) DEFAULT 'NONE',
      standard_sale_price REAL NOT NULL DEFAULT 0,
      standard_cost REAL NOT NULL DEFAULT 0,
      reorder_level REAL NOT NULL DEFAULT 5,
      reorder_qty REAL NOT NULL DEFAULT 10,
      UNIQUE(company_id, sku)
    );
    CREATE INDEX IF NOT EXISTS idx_items_company ON inventory_items(company_id);

    CREATE TABLE IF NOT EXISTS stock_lots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      item_id INTEGER NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
      warehouse_id INTEGER NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
      location_id INTEGER REFERENCES stock_locations(id) ON DELETE SET NULL,
      branch_id INTEGER NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
      batch_number TEXT,
      serial_number TEXT,
      vin_number TEXT,
      engine_number TEXT,
      expiry_date TEXT,
      qty_initial REAL NOT NULL,
      qty_remaining REAL NOT NULL,
      unit_cost REAL NOT NULL,
      received_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_lots_fifo ON stock_lots(company_id, item_id, warehouse_id, received_at);
    CREATE INDEX IF NOT EXISTS idx_lots_tracking ON stock_lots(company_id, vin_number, serial_number, batch_number);

    CREATE TABLE IF NOT EXISTS stock_movements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      item_id INTEGER NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
      warehouse_id INTEGER NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
      location_id INTEGER REFERENCES stock_locations(id) ON DELETE SET NULL,
      branch_id INTEGER NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
      movement_type TEXT NOT NULL,
      qty_change REAL NOT NULL,
      unit_cost REAL NOT NULL,
      total_cost REAL NOT NULL,
      reference_type TEXT NOT NULL,
      reference_id INTEGER,
      notes TEXT NOT NULL DEFAULT '',
      created_by INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_stock_moves_company ON stock_movements(company_id, created_at);

    CREATE TABLE IF NOT EXISTS journal_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      entry_number TEXT NOT NULL,
      entry_date TEXT NOT NULL,
      reference_type TEXT NOT NULL DEFAULT 'MANUAL',
      reference_id INTEGER,
      description TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('DRAFT', 'PENDING_APPROVAL', 'POSTED', 'REJECTED')) DEFAULT 'POSTED',
      is_intercompany INTEGER NOT NULL DEFAULT 0,
      is_elimination INTEGER NOT NULL DEFAULT 0,
      total_amount REAL NOT NULL DEFAULT 0,
      created_by INTEGER NOT NULL REFERENCES users(id),
      approved_by INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(company_id, entry_number)
    );
    CREATE INDEX IF NOT EXISTS idx_je_company_date ON journal_entries(company_id, entry_date, status);

    CREATE TABLE IF NOT EXISTS journal_lines (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      journal_entry_id INTEGER NOT NULL REFERENCES journal_entries(id) ON DELETE CASCADE,
      company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
      branch_id INTEGER NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
      cost_center_id INTEGER REFERENCES cost_profit_centers(id) ON DELETE SET NULL,
      profit_center_id INTEGER REFERENCES cost_profit_centers(id) ON DELETE SET NULL,
      party_id INTEGER REFERENCES parties(id) ON DELETE SET NULL,
      debit REAL NOT NULL DEFAULT 0,
      credit REAL NOT NULL DEFAULT 0,
      memo TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_jl_company_account ON journal_lines(company_id, account_id, branch_id);
    CREATE INDEX IF NOT EXISTS idx_jl_entry ON journal_lines(journal_entry_id);

    CREATE TABLE IF NOT EXISTS invoices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      branch_id INTEGER NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
      invoice_type TEXT NOT NULL CHECK(invoice_type IN ('SALES', 'PURCHASE')),
      invoice_number TEXT NOT NULL,
      invoice_date TEXT NOT NULL,
      due_date TEXT NOT NULL,
      party_id INTEGER NOT NULL REFERENCES parties(id) ON DELETE RESTRICT,
      subtotal REAL NOT NULL,
      vat_amount REAL NOT NULL,
      total_amount REAL NOT NULL,
      paid_amount REAL NOT NULL DEFAULT 0,
      status TEXT NOT NULL CHECK(status IN ('OPEN', 'PARTIAL', 'PAID')) DEFAULT 'OPEN',
      is_intercompany INTEGER NOT NULL DEFAULT 0,
      notes TEXT NOT NULL DEFAULT '',
      journal_entry_id INTEGER REFERENCES journal_entries(id),
      created_by INTEGER NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(company_id, invoice_number)
    );
    CREATE INDEX IF NOT EXISTS idx_invoices_company ON invoices(company_id, invoice_type, invoice_date);

    CREATE TABLE IF NOT EXISTS invoice_lines (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
      item_id INTEGER REFERENCES inventory_items(id) ON DELETE SET NULL,
      warehouse_id INTEGER REFERENCES warehouses(id) ON DELETE SET NULL,
      description TEXT NOT NULL,
      qty REAL NOT NULL,
      unit_price REAL NOT NULL,
      line_total REAL NOT NULL,
      cogs_amount REAL NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_inv_lines_invoice ON invoice_lines(invoice_id);

    CREATE TABLE IF NOT EXISTS payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      branch_id INTEGER NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
      payment_type TEXT NOT NULL CHECK(payment_type IN ('RECEIPT', 'PAYMENT')),
      payment_date TEXT NOT NULL,
      party_id INTEGER NOT NULL REFERENCES parties(id) ON DELETE RESTRICT,
      invoice_id INTEGER REFERENCES invoices(id) ON DELETE SET NULL,
      bank_account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
      amount REAL NOT NULL,
      method TEXT NOT NULL DEFAULT 'BANK_TRANSFER',
      reference TEXT NOT NULL DEFAULT '',
      journal_entry_id INTEGER REFERENCES journal_entries(id),
      created_by INTEGER NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_payments_company ON payments(company_id, payment_date);

    CREATE TABLE IF NOT EXISTS bank_statement_lines (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      bank_account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      statement_date TEXT NOT NULL,
      description TEXT NOT NULL,
      reference TEXT NOT NULL DEFAULT '',
      amount REAL NOT NULL,
      is_reconciled INTEGER NOT NULL DEFAULT 0,
      matched_journal_entry_id INTEGER REFERENCES journal_entries(id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS idx_bank_stmt_company ON bank_statement_lines(company_id, bank_account_id);

    CREATE TABLE IF NOT EXISTS budgets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      branch_id INTEGER REFERENCES branches(id) ON DELETE CASCADE,
      cost_center_id INTEGER REFERENCES cost_profit_centers(id) ON DELETE SET NULL,
      account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      fiscal_year_label TEXT NOT NULL DEFAULT 'FY 2082/83',
      budget_amount REAL NOT NULL,
      UNIQUE(company_id, branch_id, cost_center_id, account_id, fiscal_year_label)
    );

    CREATE TABLE IF NOT EXISTS audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id INTEGER,
      branch_id INTEGER,
      user_id INTEGER,
      user_name TEXT NOT NULL,
      user_role TEXT NOT NULL,
      action TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      summary TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_audit_company ON audit_logs(company_id, created_at);

    CREATE TABLE IF NOT EXISTS idempotency_keys (
      key TEXT PRIMARY KEY,
      endpoint TEXT NOT NULL,
      company_id INTEGER,
      response_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

export function writeAuditLog(params: {
  companyId?: number | null;
  branchId?: number | null;
  userId?: number | null;
  userName: string;
  userRole: string;
  action: string;
  entityType: string;
  entityId: string | number;
  summary: string;
}): void {
  db.prepare(
    `INSERT INTO audit_logs (company_id, branch_id, user_id, user_name, user_role, action, entity_type, entity_id, summary)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    params.companyId ?? null,
    params.branchId ?? null,
    params.userId ?? null,
    params.userName,
    params.userRole,
    params.action,
    params.entityType,
    String(params.entityId),
    params.summary
  );
}

export function getIdempotentResponse(key: string | undefined): any | null {
  if (!key) return null;
  const row = db
    .prepare('SELECT response_json FROM idempotency_keys WHERE key = ?')
    .get(key) as { response_json: string } | undefined;
  if (!row) return null;
  try {
    return JSON.parse(row.response_json);
  } catch {
    return null;
  }
}

export function saveIdempotentResponse(
  key: string | undefined,
  endpoint: string,
  companyId: number | null,
  payload: unknown
): void {
  if (!key) return;
  db.prepare(
    `INSERT OR REPLACE INTO idempotency_keys (key, endpoint, company_id, response_json)
     VALUES (?, ?, ?, ?)`
  ).run(key, endpoint, companyId, JSON.stringify(payload));
}

export function createDatabaseBackup(): { fileName: string; sizeBytes: number; createdAt: string } {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const fileName = `nextgen_erp_backup_${stamp}.sqlite`;
  const targetPath = path.join(BACKUP_DIR, fileName);
  db.exec(`VACUUM INTO '${targetPath.replace(/'/g, "''")}'`);
  const stat = fs.statSync(targetPath);
  return {
    fileName,
    sizeBytes: stat.size,
    createdAt: new Date().toISOString(),
  };
}

export function listDatabaseBackups(): Array<{ fileName: string; sizeBytes: number; createdAt: string }> {
  if (!fs.existsSync(BACKUP_DIR)) return [];
  return fs
    .readdirSync(BACKUP_DIR)
    .filter((f) => f.endsWith('.sqlite'))
    .map((fileName) => {
      const stat = fs.statSync(path.join(BACKUP_DIR, fileName));
      return {
        fileName,
        sizeBytes: stat.size,
        createdAt: stat.mtime.toISOString(),
      };
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
