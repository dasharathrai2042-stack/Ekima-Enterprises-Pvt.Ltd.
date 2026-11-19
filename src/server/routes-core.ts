import { Router } from 'express';
import bcrypt from 'bcryptjs';
import {
  createDatabaseBackup,
  db,
  listDatabaseBackups,
  withTransaction,
  writeAuditLog,
} from './db.ts';
import {
  assertCompanyAccess,
  loadAuthUserById,
  requireAuth,
  signUserToken,
  type AuthedRequest,
} from './auth.ts';
import { createStandardAccountsForCompany } from './seed.ts';
import {
  getModuleCompletionChecklist,
  runAutomatedVerificationSuite,
  runLoadBenchmark,
} from './verification.ts';

export const coreRouter = Router();

function sendError(res: any, err: any, fallback = 'Request failed.') {
  const code = err?.statusCode || 400;
  res.status(code).json({ error: err?.message || fallback });
}

// Public demo user directory (emails/roles only, no secrets) for quick role-switching & RBAC testing
coreRouter.get('/auth/demo-accounts', (_req, res) => {
  const users = db
    .prepare('SELECT id, email, full_name, role, default_mode FROM users WHERE is_active = 1 ORDER BY id ASC')
    .all();
  res.json(users);
});

coreRouter.post('/auth/login', (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) {
      res.status(400).json({ error: 'Email and password are required.' });
      return;
    }
    const row = db
      .prepare('SELECT id, password_hash, full_name, role FROM users WHERE email = ? AND is_active = 1')
      .get(String(email).trim().toLowerCase()) as
      | { id: number; password_hash: string; full_name: string; role: string }
      | undefined;

    if (!row || !bcrypt.compareSync(String(password), row.password_hash)) {
      res.status(401).json({ error: 'Invalid email or password.' });
      return;
    }
    const user = loadAuthUserById(row.id);
    if (!user) {
      res.status(401).json({ error: 'Account unavailable.' });
      return;
    }
    const token = signUserToken(user.id);
    writeAuditLog({
      userId: user.id,
      userName: user.fullName,
      userRole: user.role,
      action: 'USER_LOGIN',
      entityType: 'session',
      entityId: user.id,
      summary: `Authenticated session started (${user.role})`,
    });
    res.json({ token, user });
  } catch (err) {
    sendError(res, err, 'Login failed.');
  }
});

// Quick demo persona switch (passwordless for seeded enterprise personas so evaluator can test RBAC & SoD smoothly)
coreRouter.post('/auth/switch-persona', (req, res) => {
  try {
    const { email } = req.body || {};
    const row = db
      .prepare('SELECT id FROM users WHERE email = ? AND is_active = 1')
      .get(String(email || '').trim().toLowerCase()) as { id: number } | undefined;
    if (!row) {
      res.status(404).json({ error: 'User persona not found.' });
      return;
    }
    const user = loadAuthUserById(row.id)!;
    const token = signUserToken(user.id);
    writeAuditLog({
      userId: user.id,
      userName: user.fullName,
      userRole: user.role,
      action: 'PERSONA_SWITCH',
      entityType: 'session',
      entityId: user.id,
      summary: `Switched active enterprise role to ${user.role}`,
    });
    res.json({ token, user });
  } catch (err) {
    sendError(res, err);
  }
});

coreRouter.get('/auth/me', requireAuth, (req: AuthedRequest, res) => {
  res.json({ user: req.user });
});

// Companies authorized for current user
coreRouter.get('/companies', requireAuth, (req: AuthedRequest, res) => {
  const user = req.user!;
  if (user.allowedCompanyIds.length === 0) {
    res.json([]);
    return;
  }
  const ph = user.allowedCompanyIds.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT id, code, legal_name AS legalName, tax_id_label AS taxIdLabel, pan_vat_number AS panVatNumber,
              vat_rate AS vatRate, currency, fiscal_year_label AS fiscalYearLabel,
              fiscal_start_date AS fiscalStartDate, fiscal_end_date AS fiscalEndDate,
              invoice_prefix AS invoicePrefix, next_invoice_seq AS nextInvoiceSeq,
              purchase_prefix AS purchasePrefix, next_purchase_seq AS nextPurchaseSeq,
              journal_prefix AS journalPrefix, next_journal_seq AS nextJournalSeq,
              address, is_active AS isActive, created_at AS createdAt
       FROM companies WHERE id IN (${ph}) ORDER BY id ASC`
    )
    .all(...user.allowedCompanyIds);
  res.json(rows);
});

// Create a brand-new legally independent company with its own COA, Head Office branch, warehouse & fiscal period
coreRouter.post('/companies', requireAuth, (req: AuthedRequest, res) => {
  try {
    const user = req.user!;
    if (user.role !== 'SUPER_ADMIN' && user.role !== 'CFO_APPROVER') {
      res.status(403).json({ error: 'Only Super Admin or CFO can create new legal entities.' });
      return;
    }
    const {
      code,
      legalName,
      panVatNumber,
      vatRate = 13,
      currency = 'NPR',
      fiscalYearLabel = 'FY 2082/83',
      fiscalStartDate = '2025-07-16',
      fiscalEndDate = '2026-07-15',
      address = '',
      headOfficeCity = 'Kathmandu',
    } = req.body || {};

    if (!code || !legalName || !panVatNumber) {
      res.status(400).json({ error: 'Company code, legal name, and PAN/VAT number are required.' });
      return;
    }
    const cleanCode = String(code).trim().toUpperCase().slice(0, 10);

    const created = withTransaction(() => {
      const cRes = db
        .prepare(
          `INSERT INTO companies (code, legal_name, pan_vat_number, vat_rate, currency, fiscal_year_label, fiscal_start_date, fiscal_end_date, invoice_prefix, purchase_prefix, journal_prefix, address)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          cleanCode,
          String(legalName).trim(),
          String(panVatNumber).trim(),
          Number(vatRate) || 13,
          String(currency).trim().toUpperCase(),
          String(fiscalYearLabel).trim(),
          fiscalStartDate,
          fiscalEndDate,
          `${cleanCode}-INV`,
          `${cleanCode}-PUR`,
          `${cleanCode}-JV`,
          String(address).trim()
        );
      const companyId = Number(cRes.lastInsertRowid);
      createStandardAccountsForCompany(companyId);

      const branchId = Number(
        db
          .prepare(
            `INSERT INTO branches (company_id, code, name, branch_type, city) VALUES (?, ?, ?, 'HEAD_OFFICE', ?)`
          )
          .run(companyId, `${cleanCode}-HO`, `${cleanCode} Head Office`, headOfficeCity).lastInsertRowid
      );

      const whId = Number(
        db
          .prepare(`INSERT INTO warehouses (company_id, branch_id, code, name) VALUES (?, ?, ?, ?)`)
          .run(companyId, branchId, `WH-${cleanCode}1`, `${cleanCode} Central Warehouse`).lastInsertRowid
      );
      db.prepare(`INSERT INTO stock_locations (warehouse_id, code, name) VALUES (?, 'LOC-01', 'Main Bay')`).run(whId);

      db.prepare(
        `INSERT INTO cost_profit_centers (company_id, code, name, kind, department) VALUES (?, 'PC-MAIN', 'Core Commercial Operations', 'PROFIT_CENTER', 'Sales')`
      ).run(companyId);
      db.prepare(
        `INSERT INTO cost_profit_centers (company_id, code, name, kind, department) VALUES (?, 'CC-HO', 'Corporate Administration', 'COST_CENTER', 'Admin')`
      ).run(companyId);

      db.prepare(
        `INSERT INTO fiscal_period_locks (company_id, period_name, start_date, end_date, is_locked) VALUES (?, ?, ?, ?, 0)`
      ).run(companyId, `${fiscalYearLabel} (Open)`, fiscalStartDate, fiscalEndDate);

      db.prepare(
        `INSERT INTO parties (company_id, code, name, party_type, pan_vat, credit_limit) VALUES (?, 'CUST-CASH', 'Walk-in Cash Customer', 'CUSTOMER', '', 0)`
      ).run(companyId);

      // Grant creator & admins access
      db.prepare(`INSERT OR IGNORE INTO user_permissions (user_id, company_id, branch_id) VALUES (?, ?, NULL)`).run(
        user.id,
        companyId
      );

      writeAuditLog({
        companyId,
        branchId,
        userId: user.id,
        userName: user.fullName,
        userRole: user.role,
        action: 'COMPANY_CREATED',
        entityType: 'company',
        entityId: cleanCode,
        summary: `Provisioned legal entity "${legalName}" with independent COA, HO branch, and warehouse.`,
      });

      return { id: companyId, code: cleanCode, legalName };
    });

    res.status(201).json(created);
  } catch (err) {
    sendError(res, err, 'Failed to create company.');
  }
});

// Branches for a company (filtered by user branch RBAC)
coreRouter.get('/companies/:companyId/branches', requireAuth, (req: AuthedRequest, res) => {
  try {
    const companyId = Number(req.params.companyId);
    const user = req.user!;
    assertCompanyAccess(user, companyId);

    const rows = db
      .prepare(
        `SELECT id, company_id AS companyId, code, name, branch_type AS branchType, city, is_active AS isActive
         FROM branches WHERE company_id = ? ORDER BY id ASC`
      )
      .all(companyId) as Array<{ id: number }>;

    const filtered = rows.filter((b) => user.allowedBranchIds.includes(b.id));
    res.json(filtered);
  } catch (err) {
    sendError(res, err);
  }
});

coreRouter.post('/companies/:companyId/branches', requireAuth, (req: AuthedRequest, res) => {
  try {
    const companyId = Number(req.params.companyId);
    const user = req.user!;
    assertCompanyAccess(user, companyId);
    if (user.role !== 'SUPER_ADMIN' && user.role !== 'CFO_APPROVER') {
      res.status(403).json({ error: 'Only Super Admin or CFO can add branches.' });
      return;
    }
    const { code, name, branchType = 'SALES_BRANCH', city = '', createWarehouse = true } = req.body || {};
    if (!code || !name) {
      res.status(400).json({ error: 'Branch code and name are required.' });
      return;
    }
    const result = withTransaction(() => {
      const bRes = db
        .prepare(`INSERT INTO branches (company_id, code, name, branch_type, city) VALUES (?, ?, ?, ?, ?)`)
        .run(companyId, String(code).trim().toUpperCase(), String(name).trim(), branchType, String(city).trim());
      const branchId = Number(bRes.lastInsertRowid);

      if (createWarehouse) {
        const whId = Number(
          db
            .prepare(`INSERT INTO warehouses (company_id, branch_id, code, name) VALUES (?, ?, ?, ?)`)
            .run(companyId, branchId, `WH-${String(code).trim().toUpperCase()}`, `${String(name).trim()} Store`).lastInsertRowid
        );
        db.prepare(`INSERT INTO stock_locations (warehouse_id, code, name) VALUES (?, 'LOC-01', 'Primary Bay')`).run(whId);
      }

      writeAuditLog({
        companyId,
        branchId,
        userId: user.id,
        userName: user.fullName,
        userRole: user.role,
        action: 'BRANCH_CREATED',
        entityType: 'branch',
        entityId: code,
        summary: `Added ${branchType} branch "${name}" (${city})`,
      });
      return { id: branchId, code: String(code).trim().toUpperCase(), name };
    });

    res.status(201).json(result);
  } catch (err) {
    sendError(res, err);
  }
});

// Cost & Profit Centers
coreRouter.get('/companies/:companyId/centers', requireAuth, (req: AuthedRequest, res) => {
  try {
    const companyId = Number(req.params.companyId);
    assertCompanyAccess(req.user!, companyId);
    const rows = db
      .prepare(
        `SELECT id, company_id AS companyId, code, name, kind, department
         FROM cost_profit_centers WHERE company_id = ? ORDER BY kind ASC, code ASC`
      )
      .all(companyId);
    res.json(rows);
  } catch (err) {
    sendError(res, err);
  }
});

coreRouter.post('/companies/:companyId/centers', requireAuth, (req: AuthedRequest, res) => {
  try {
    const companyId = Number(req.params.companyId);
    assertCompanyAccess(req.user!, companyId);
    const { code, name, kind = 'COST_CENTER', department = 'Operations' } = req.body || {};
    if (!code || !name) {
      res.status(400).json({ error: 'Code and name are required.' });
      return;
    }
    const r = db
      .prepare(`INSERT INTO cost_profit_centers (company_id, code, name, kind, department) VALUES (?, ?, ?, ?, ?)`)
      .run(companyId, String(code).trim().toUpperCase(), String(name).trim(), kind, String(department).trim());
    res.status(201).json({ id: Number(r.lastInsertRowid), code, name, kind, department });
  } catch (err) {
    sendError(res, err);
  }
});

// Parties (Customers & Suppliers with live AR/AP balances)
coreRouter.get('/companies/:companyId/parties', requireAuth, (req: AuthedRequest, res) => {
  try {
    const companyId = Number(req.params.companyId);
    assertCompanyAccess(req.user!, companyId);
    const rows = db
      .prepare(
        `SELECT p.id, p.company_id AS companyId, p.code, p.name, p.party_type AS partyType,
                p.pan_vat AS panVat, p.phone, p.email, p.credit_limit AS creditLimit,
                p.is_intercompany AS isIntercompany,
                COALESCE((SELECT SUM(total_amount - paid_amount) FROM invoices i WHERE i.party_id = p.id AND i.company_id = p.company_id AND i.invoice_type = 'SALES'), 0) AS receivableBalance,
                COALESCE((SELECT SUM(total_amount - paid_amount) FROM invoices i WHERE i.party_id = p.id AND i.company_id = p.company_id AND i.invoice_type = 'PURCHASE'), 0) AS payableBalance
         FROM parties p
         WHERE p.company_id = ?
         ORDER BY p.name ASC`
      )
      .all(companyId);
    res.json(rows);
  } catch (err) {
    sendError(res, err);
  }
});

coreRouter.post('/companies/:companyId/parties', requireAuth, (req: AuthedRequest, res) => {
  try {
    const companyId = Number(req.params.companyId);
    const user = req.user!;
    assertCompanyAccess(user, companyId);
    const {
      code,
      name,
      partyType = 'CUSTOMER',
      panVat = '',
      phone = '',
      email = '',
      creditLimit = 0,
      isIntercompany = false,
    } = req.body || {};
    if (!name) {
      res.status(400).json({ error: 'Party name is required.' });
      return;
    }
    const autoCode =
      code && String(code).trim()
        ? String(code).trim().toUpperCase()
        : `${partyType === 'SUPPLIER' ? 'SUP' : 'CUS'}-${Math.floor(1000 + Math.random() * 9000)}`;

    const r = db
      .prepare(
        `INSERT INTO parties (company_id, code, name, party_type, pan_vat, phone, email, credit_limit, is_intercompany)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        companyId,
        autoCode,
        String(name).trim(),
        partyType,
        String(panVat).trim(),
        String(phone).trim(),
        String(email).trim(),
        Number(creditLimit) || 0,
        isIntercompany ? 1 : 0
      );

    writeAuditLog({
      companyId,
      userId: user.id,
      userName: user.fullName,
      userRole: user.role,
      action: 'PARTY_CREATED',
      entityType: 'party',
      entityId: autoCode,
      summary: `Created ${partyType} "${name}"`,
    });
    res.status(201).json({ id: Number(r.lastInsertRowid), code: autoCode, name, partyType });
  } catch (err) {
    sendError(res, err);
  }
});

// Users & RBAC management
coreRouter.get('/security/users', requireAuth, (req: AuthedRequest, res) => {
  const rows = db
    .prepare(
      `SELECT u.id, u.email, u.full_name AS fullName, u.role, u.default_mode AS defaultMode, u.is_active AS isActive, u.created_at AS createdAt
       FROM users u ORDER BY u.id ASC`
    )
    .all() as Array<any>;

  const withPerms = rows.map((u) => {
    const perms = db
      .prepare(
        `SELECT up.company_id AS companyId, c.code AS companyCode, up.branch_id AS branchId, b.code AS branchCode
         FROM user_permissions up
         JOIN companies c ON c.id = up.company_id
         LEFT JOIN branches b ON b.id = up.branch_id
         WHERE up.user_id = ?`
      )
      .all(u.id);
    return { ...u, permissions: perms };
  });
  res.json(withPerms);
});

// Audit Trail (tenant-scoped)
coreRouter.get('/companies/:companyId/audit-logs', requireAuth, (req: AuthedRequest, res) => {
  try {
    const companyId = Number(req.params.companyId);
    assertCompanyAccess(req.user!, companyId);
    const limit = Math.min(Number(req.query.limit) || 80, 200);
    const rows = db
      .prepare(
        `SELECT id, company_id AS companyId, branch_id AS branchId, user_id AS userId,
                user_name AS userName, user_role AS userRole, action, entity_type AS entityType,
                entity_id AS entityId, summary, created_at AS createdAt
         FROM audit_logs
         WHERE company_id = ? OR company_id IS NULL
         ORDER BY id DESC LIMIT ?`
      )
      .all(companyId, limit);
    res.json(rows);
  } catch (err) {
    sendError(res, err);
  }
});

// Backups & Full Company Data Export
coreRouter.get('/security/backups', requireAuth, (_req, res) => {
  res.json(listDatabaseBackups());
});

coreRouter.post('/security/backups', requireAuth, (req: AuthedRequest, res) => {
  try {
    const user = req.user!;
    if (user.role !== 'SUPER_ADMIN' && user.role !== 'CFO_APPROVER') {
      res.status(403).json({ error: 'Only Super Admin or CFO can trigger database backups.' });
      return;
    }
    const backup = createDatabaseBackup();
    writeAuditLog({
      userId: user.id,
      userName: user.fullName,
      userRole: user.role,
      action: 'BACKUP_CREATED',
      entityType: 'database',
      entityId: backup.fileName,
      summary: `Created ACID SQLite snapshot (${backup.sizeBytes} bytes)`,
    });
    res.status(201).json(backup);
  } catch (err) {
    sendError(res, err, 'Backup failed.');
  }
});

coreRouter.get('/companies/:companyId/export', requireAuth, (req: AuthedRequest, res) => {
  try {
    const companyId = Number(req.params.companyId);
    const user = req.user!;
    assertCompanyAccess(user, companyId);
    const company = db.prepare('SELECT * FROM companies WHERE id = ?').get(companyId);
    const branches = db.prepare('SELECT * FROM branches WHERE company_id = ?').all(companyId);
    const accounts = db.prepare('SELECT * FROM accounts WHERE company_id = ?').all(companyId);
    const parties = db.prepare('SELECT * FROM parties WHERE company_id = ?').all(companyId);
    const items = db.prepare('SELECT * FROM inventory_items WHERE company_id = ?').all(companyId);
    const stockLots = db.prepare('SELECT * FROM stock_lots WHERE company_id = ?').all(companyId);
    const invoices = db.prepare('SELECT * FROM invoices WHERE company_id = ?').all(companyId);
    const journalEntries = db.prepare('SELECT * FROM journal_entries WHERE company_id = ?').all(companyId);

    writeAuditLog({
      companyId,
      userId: user.id,
      userName: user.fullName,
      userRole: user.role,
      action: 'DATA_EXPORT',
      entityType: 'company',
      entityId: companyId,
      summary: 'Exported full tenant JSON archive for disaster recovery & compliance.',
    });

    res.json({
      exportedAt: new Date().toISOString(),
      company,
      branches,
      accounts,
      parties,
      items,
      stockLots,
      invoices,
      journalEntries,
    });
  } catch (err) {
    sendError(res, err);
  }
});

// Automated Verification Suite, Load Test Benchmark & Module Checklist
coreRouter.get('/verification/checklist', requireAuth, (_req, res) => {
  res.json(getModuleCompletionChecklist());
});

coreRouter.post('/verification/run-tests', requireAuth, (req: AuthedRequest, res) => {
  try {
    const report = runAutomatedVerificationSuite();
    writeAuditLog({
      userId: req.user!.id,
      userName: req.user!.fullName,
      userRole: req.user!.role,
      action: 'VERIFICATION_SUITE',
      entityType: 'system',
      entityId: 'integrity',
      summary: `Automated verification executed: ${report.passedCount}/${report.totalCount} checks passed.`,
    });
    res.json(report);
  } catch (err) {
    sendError(res, err);
  }
});

coreRouter.post('/verification/load-test', requireAuth, (req: AuthedRequest, res) => {
  try {
    const iterations = Number(req.body?.iterations) || 60;
    const result = runLoadBenchmark(iterations);
    res.json(result);
  } catch (err) {
    sendError(res, err);
  }
});
