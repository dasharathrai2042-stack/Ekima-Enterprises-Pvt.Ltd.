import { Router } from 'express';
import {
  db,
  getIdempotentResponse,
  round2,
  saveIdempotentResponse,
  withTransaction,
  writeAuditLog,
} from './db.ts';
import { assertBranchAccess, assertCompanyAccess, requireAuth, type AuthedRequest } from './auth.ts';
import {
  computeFinancialStatements,
  createInvoiceInTx,
  postJournalEntryInTx,
  recordPaymentInTx,
} from './accounting.ts';

export const financeRouter = Router();

function sendError(res: any, err: any) {
  res.status(err?.statusCode || 400).json({ error: err?.message || 'Accounting request failed.' });
}

// Chart of Accounts with live balances
financeRouter.get('/companies/:companyId/accounts', requireAuth, (req: AuthedRequest, res) => {
  try {
    const companyId = Number(req.params.companyId);
    assertCompanyAccess(req.user!, companyId);

    const rows = db
      .prepare(
        `SELECT a.id, a.company_id AS companyId, a.code, a.name, a.account_type AS accountType,
                a.sub_type AS subType, a.is_system AS isSystem, a.is_intercompany AS isIntercompany,
                a.is_bank_or_cash AS isBankOrCash,
                COALESCE(SUM(CASE WHEN je.status = 'POSTED' AND je.is_elimination = 0 THEN jl.debit ELSE 0 END), 0) AS totalDebit,
                COALESCE(SUM(CASE WHEN je.status = 'POSTED' AND je.is_elimination = 0 THEN jl.credit ELSE 0 END), 0) AS totalCredit
         FROM accounts a
         LEFT JOIN journal_lines jl ON jl.account_id = a.id
         LEFT JOIN journal_entries je ON je.id = jl.journal_entry_id
         WHERE a.company_id = ?
         GROUP BY a.id
         ORDER BY a.code ASC`
      )
      .all(companyId) as Array<any>;

    const formatted = rows.map((r) => {
      const isDebitNormal = r.accountType === 'ASSET' || r.accountType === 'EXPENSE';
      return {
        ...r,
        balance: isDebitNormal ? round2(r.totalDebit - r.totalCredit) : round2(r.totalCredit - r.totalDebit),
      };
    });
    res.json(formatted);
  } catch (err) {
    sendError(res, err);
  }
});

financeRouter.post('/companies/:companyId/accounts', requireAuth, (req: AuthedRequest, res) => {
  try {
    const companyId = Number(req.params.companyId);
    const user = req.user!;
    assertCompanyAccess(user, companyId);
    const { code, name, accountType, subType = 'GENERAL', isIntercompany = false, isBankOrCash = false } = req.body || {};
    if (!code || !name || !accountType) {
      res.status(400).json({ error: 'Account code, name, and account type are required.' });
      return;
    }
    const r = db
      .prepare(
        `INSERT INTO accounts (company_id, code, name, account_type, sub_type, is_intercompany, is_bank_or_cash)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(companyId, String(code).trim(), String(name).trim(), accountType, subType, isIntercompany ? 1 : 0, isBankOrCash ? 1 : 0);

    writeAuditLog({
      companyId,
      userId: user.id,
      userName: user.fullName,
      userRole: user.role,
      action: 'ACCOUNT_CREATED',
      entityType: 'account',
      entityId: code,
      summary: `Added COA ledger ${code} - ${name} (${accountType})`,
    });
    res.status(201).json({ id: Number(r.lastInsertRowid), code, name, accountType });
  } catch (err) {
    sendError(res, err);
  }
});

// Fiscal Period Locks
financeRouter.get('/companies/:companyId/period-locks', requireAuth, (req: AuthedRequest, res) => {
  try {
    const companyId = Number(req.params.companyId);
    assertCompanyAccess(req.user!, companyId);
    const rows = db
      .prepare(
        `SELECT id, company_id AS companyId, period_name AS periodName, start_date AS startDate,
                end_date AS endDate, is_locked AS isLocked, locked_by_name AS lockedByName, locked_at AS lockedAt
         FROM fiscal_period_locks WHERE company_id = ? ORDER BY start_date ASC`
      )
      .all(companyId);
    res.json(rows);
  } catch (err) {
    sendError(res, err);
  }
});

financeRouter.post('/companies/:companyId/period-locks/:lockId/toggle', requireAuth, (req: AuthedRequest, res) => {
  try {
    const companyId = Number(req.params.companyId);
    const lockId = Number(req.params.lockId);
    const user = req.user!;
    assertCompanyAccess(user, companyId);
    if (user.role !== 'SUPER_ADMIN' && user.role !== 'CFO_APPROVER') {
      res.status(403).json({ error: 'Only Super Admin or CFO Approver can lock/unlock financial periods.' });
      return;
    }
    const existing = db
      .prepare('SELECT id, period_name, is_locked FROM fiscal_period_locks WHERE id = ? AND company_id = ?')
      .get(lockId, companyId) as { id: number; period_name: string; is_locked: number } | undefined;
    if (!existing) {
      res.status(404).json({ error: 'Period lock record not found.' });
      return;
    }
    const nextLocked = existing.is_locked ? 0 : 1;
    db.prepare(
      `UPDATE fiscal_period_locks SET is_locked = ?, locked_by_name = ?, locked_at = ? WHERE id = ?`
    ).run(nextLocked, nextLocked ? user.fullName : null, nextLocked ? new Date().toISOString() : null, lockId);

    writeAuditLog({
      companyId,
      userId: user.id,
      userName: user.fullName,
      userRole: user.role,
      action: nextLocked ? 'PERIOD_LOCKED' : 'PERIOD_UNLOCKED',
      entityType: 'fiscal_period',
      entityId: existing.period_name,
      summary: `${nextLocked ? 'Locked' : 'Unlocked'} accounting period ${existing.period_name}`,
    });
    res.json({ id: lockId, isLocked: nextLocked });
  } catch (err) {
    sendError(res, err);
  }
});

// Journal Entries (with pagination, lines, and approval workflow)
financeRouter.get('/companies/:companyId/journals', requireAuth, (req: AuthedRequest, res) => {
  try {
    const companyId = Number(req.params.companyId);
    assertCompanyAccess(req.user!, companyId);
    const status = req.query.status ? String(req.query.status) : null;
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const offset = Math.max(Number(req.query.offset) || 0, 0);

    const where = ['je.company_id = ?'];
    const args: any[] = [companyId];
    if (status) {
      where.push('je.status = ?');
      args.push(status);
    }

    const entries = db
      .prepare(
        `SELECT je.id, je.company_id AS companyId, je.entry_number AS entryNumber, je.entry_date AS entryDate,
                je.reference_type AS referenceType, je.reference_id AS referenceId, je.description,
                je.status, je.is_intercompany AS isIntercompany, je.is_elimination AS isElimination,
                je.total_amount AS totalAmount, je.created_by AS createdBy, u1.full_name AS createdByName,
                je.approved_by AS approvedBy, u2.full_name AS approvedByName, je.created_at AS createdAt
         FROM journal_entries je
         JOIN users u1 ON u1.id = je.created_by
         LEFT JOIN users u2 ON u2.id = je.approved_by
         WHERE ${where.join(' AND ')}
         ORDER BY je.entry_date DESC, je.id DESC
         LIMIT ? OFFSET ?`
      )
      .all(...args, limit, offset) as Array<any>;

    const lineStmt = db.prepare(
      `SELECT jl.id, jl.account_id AS accountId, a.code AS accountCode, a.name AS accountName, a.account_type AS accountType,
              jl.branch_id AS branchId, b.name AS branchName,
              cc.name AS costCenterName, pc.name AS profitCenterName,
              jl.debit, jl.credit, jl.memo
       FROM journal_lines jl
       JOIN accounts a ON a.id = jl.account_id
       JOIN branches b ON b.id = jl.branch_id
       LEFT JOIN cost_profit_centers cc ON cc.id = jl.cost_center_id
       LEFT JOIN cost_profit_centers pc ON pc.id = jl.profit_center_id
       WHERE jl.journal_entry_id = ?
       ORDER BY jl.id ASC`
    );

    res.json(entries.map((e) => ({ ...e, lines: lineStmt.all(e.id) })));
  } catch (err) {
    sendError(res, err);
  }
});

financeRouter.post('/companies/:companyId/journals', requireAuth, (req: AuthedRequest, res) => {
  try {
    const companyId = Number(req.params.companyId);
    const user = req.user!;
    assertCompanyAccess(user, companyId);

    const idemKey = req.header('Idempotency-Key');
    const cached = getIdempotentResponse(idemKey);
    if (cached) {
      res.json(cached);
      return;
    }

    const { entryDate, description, lines, isIntercompany = false, isElimination = false, referenceType = 'MANUAL' } = req.body || {};
    if (!entryDate || !description || !Array.isArray(lines)) {
      res.status(400).json({ error: 'Entry date, description, and journal lines are required.' });
      return;
    }

    const created = withTransaction(() => {
      const je = postJournalEntryInTx({
        companyId,
        entryDate,
        referenceType: isElimination ? 'ELIMINATION' : referenceType,
        description: String(description).trim(),
        lines: lines.map((l: any) => ({
          accountId: Number(l.accountId),
          branchId: Number(l.branchId),
          costCenterId: l.costCenterId ? Number(l.costCenterId) : null,
          profitCenterId: l.profitCenterId ? Number(l.profitCenterId) : null,
          debit: Number(l.debit) || 0,
          credit: Number(l.credit) || 0,
          memo: l.memo || '',
        })),
        createdBy: user.id,
        createdByName: user.fullName,
        createdByRole: user.role,
        isIntercompany: Boolean(isIntercompany),
        isElimination: Boolean(isElimination),
      });
      saveIdempotentResponse(idemKey, 'POST /journals', companyId, je);
      return je;
    });

    res.status(201).json(created);
  } catch (err) {
    sendError(res, err);
  }
});

// Approve or Reject Pending Journal Entry (enforces Segregation of Duties!)
financeRouter.post('/companies/:companyId/journals/:jeId/decision', requireAuth, (req: AuthedRequest, res) => {
  try {
    const companyId = Number(req.params.companyId);
    const jeId = Number(req.params.jeId);
    const user = req.user!;
    assertCompanyAccess(user, companyId);

    if (user.role !== 'SUPER_ADMIN' && user.role !== 'CFO_APPROVER') {
      res.status(403).json({ error: 'Only CFO Approver or Super Admin can approve or reject journal vouchers.' });
      return;
    }

    const decision = String(req.body?.decision || '').toUpperCase();
    if (decision !== 'APPROVE' && decision !== 'REJECT') {
      res.status(400).json({ error: 'Decision must be APPROVE or REJECT.' });
      return;
    }

    const je = db
      .prepare('SELECT id, entry_number, status, created_by, total_amount FROM journal_entries WHERE id = ? AND company_id = ?')
      .get(jeId, companyId) as
      | { id: number; entry_number: string; status: string; created_by: number; total_amount: number }
      | undefined;

    if (!je) {
      res.status(404).json({ error: 'Journal entry not found.' });
      return;
    }
    if (je.status !== 'PENDING_APPROVAL') {
      res.status(400).json({ error: `Journal ${je.entry_number} is already ${je.status}.` });
      return;
    }
    // Segregation of Duties: creator cannot self-approve
    if (je.created_by === user.id && decision === 'APPROVE') {
      res.status(403).json({
        error: 'Segregation of Duties violation: You cannot approve a journal voucher that you created. Switch to CFO Approver or Super Admin.',
      });
      return;
    }

    const nextStatus = decision === 'APPROVE' ? 'POSTED' : 'REJECTED';
    db.prepare('UPDATE journal_entries SET status = ?, approved_by = ? WHERE id = ?').run(nextStatus, user.id, jeId);

    writeAuditLog({
      companyId,
      userId: user.id,
      userName: user.fullName,
      userRole: user.role,
      action: decision === 'APPROVE' ? 'JOURNAL_APPROVED' : 'JOURNAL_REJECTED',
      entityType: 'journal_entry',
      entityId: je.entry_number,
      summary: `${decision === 'APPROVE' ? 'Approved & posted' : 'Rejected'} ${je.entry_number} (NPR ${je.total_amount.toFixed(2)})`,
    });

    res.json({ id: jeId, entryNumber: je.entry_number, status: nextStatus });
  } catch (err) {
    sendError(res, err);
  }
});

// Inter-Branch Expense Allocation (splits an expense across multiple branches by % into a balanced double-entry JE)
financeRouter.post('/companies/:companyId/allocate-expense', requireAuth, (req: AuthedRequest, res) => {
  try {
    const companyId = Number(req.params.companyId);
    const user = req.user!;
    assertCompanyAccess(user, companyId);

    const { entryDate, expenseAccountId, paidFromAccountId, sourceBranchId, totalAmount, description, splits } = req.body || {};
    if (!entryDate || !expenseAccountId || !paidFromAccountId || !sourceBranchId || !totalAmount || !Array.isArray(splits) || splits.length < 2) {
      res.status(400).json({ error: 'Provide date, expense account, payment account, amount, and at least 2 branch splits.' });
      return;
    }
    const pctSum = round2(splits.reduce((s: number, x: any) => s + Number(x.percent || 0), 0));
    if (Math.abs(pctSum - 100) >= 0.05) {
      res.status(400).json({ error: `Branch allocation percentages must total 100% (currently ${pctSum}%).` });
      return;
    }

    const total = round2(Number(totalAmount));
    const lines: any[] = [];
    let allocated = 0;

    splits.forEach((sp: any, idx: number) => {
      const amt = idx === splits.length - 1 ? round2(total - allocated) : round2((total * Number(sp.percent)) / 100);
      allocated = round2(allocated + amt);
      lines.push({
        accountId: Number(expenseAccountId),
        branchId: Number(sp.branchId),
        debit: amt,
        credit: 0,
        memo: `Allocated ${sp.percent}% share`,
      });
    });

    lines.push({
      accountId: Number(paidFromAccountId),
      branchId: Number(sourceBranchId),
      debit: 0,
      credit: total,
      memo: `Central payment for inter-branch allocation`,
    });

    const je = withTransaction(() =>
      postJournalEntryInTx({
        companyId,
        entryDate,
        referenceType: 'BRANCH_ALLOCATION',
        description: description || `Inter-branch expense allocation (${total.toFixed(2)})`,
        lines,
        createdBy: user.id,
        createdByName: user.fullName,
        createdByRole: user.role,
        forceStatus: 'POSTED',
      })
    );

    res.status(201).json(je);
  } catch (err) {
    sendError(res, err);
  }
});

// General Ledger (account ledger with running balance)
financeRouter.get('/companies/:companyId/general-ledger', requireAuth, (req: AuthedRequest, res) => {
  try {
    const companyId = Number(req.params.companyId);
    assertCompanyAccess(req.user!, companyId);
    const accountId = req.query.accountId ? Number(req.query.accountId) : null;
    const branchId = req.query.branchId ? Number(req.query.branchId) : null;

    const where = [`je.company_id = ?`, `je.status = 'POSTED'`, `je.is_elimination = 0`];
    const args: any[] = [companyId];
    if (accountId) {
      where.push('jl.account_id = ?');
      args.push(accountId);
    }
    if (branchId) {
      where.push('jl.branch_id = ?');
      args.push(branchId);
    }

    const rows = db
      .prepare(
        `SELECT jl.id, je.entry_date AS entryDate, je.entry_number AS entryNumber, je.reference_type AS referenceType,
                je.description, a.code AS accountCode, a.name AS accountName, a.account_type AS accountType,
                b.name AS branchName, jl.debit, jl.credit, jl.memo
         FROM journal_lines jl
         JOIN journal_entries je ON je.id = jl.journal_entry_id
         JOIN accounts a ON a.id = jl.account_id
         JOIN branches b ON b.id = jl.branch_id
         WHERE ${where.join(' AND ')}
         ORDER BY je.entry_date ASC, je.id ASC, jl.id ASC
         LIMIT 300`
      )
      .all(...args) as Array<any>;

    let running = 0;
    const withRunning = rows.map((r) => {
      running = round2(running + (r.debit - r.credit));
      return { ...r, runningBalance: running };
    });

    res.json(withRunning);
  } catch (err) {
    sendError(res, err);
  }
});

// Invoices (Sales & Purchases)
financeRouter.get('/companies/:companyId/invoices', requireAuth, (req: AuthedRequest, res) => {
  try {
    const companyId = Number(req.params.companyId);
    assertCompanyAccess(req.user!, companyId);
    const type = req.query.type ? String(req.query.type).toUpperCase() : null;
    const branchId = req.query.branchId ? Number(req.query.branchId) : null;

    const where = ['i.company_id = ?'];
    const args: any[] = [companyId];
    if (type === 'SALES' || type === 'PURCHASE') {
      where.push('i.invoice_type = ?');
      args.push(type);
    }
    if (branchId) {
      where.push('i.branch_id = ?');
      args.push(branchId);
    }

    const rows = db
      .prepare(
        `SELECT i.id, i.company_id AS companyId, i.branch_id AS branchId, b.name AS branchName,
                i.invoice_type AS invoiceType, i.invoice_number AS invoiceNumber,
                i.invoice_date AS invoiceDate, i.due_date AS dueDate,
                i.party_id AS partyId, p.name AS partyName,
                i.subtotal, i.vat_amount AS vatAmount, i.total_amount AS totalAmount,
                i.paid_amount AS paidAmount, ROUND(i.total_amount - i.paid_amount, 2) AS balanceDue,
                i.status, i.is_intercompany AS isIntercompany, i.notes, u.full_name AS createdByName
         FROM invoices i
         JOIN parties p ON p.id = i.party_id
         JOIN branches b ON b.id = i.branch_id
         JOIN users u ON u.id = i.created_by
         WHERE ${where.join(' AND ')}
         ORDER BY i.invoice_date DESC, i.id DESC
         LIMIT 150`
      )
      .all(...args);
    res.json(rows);
  } catch (err) {
    sendError(res, err);
  }
});

financeRouter.post('/companies/:companyId/invoices', requireAuth, (req: AuthedRequest, res) => {
  try {
    const companyId = Number(req.params.companyId);
    const user = req.user!;
    assertCompanyAccess(user, companyId);

    const idemKey = req.header('Idempotency-Key');
    const cached = getIdempotentResponse(idemKey);
    if (cached) {
      res.json(cached);
      return;
    }

    const body = req.body || {};
    const branchId = Number(body.branchId);
    assertBranchAccess(user, branchId);

    const created = withTransaction(() => {
      const inv = createInvoiceInTx({
        companyId,
        branchId,
        invoiceType: body.invoiceType === 'PURCHASE' ? 'PURCHASE' : 'SALES',
        invoiceDate: body.invoiceDate || new Date().toISOString().slice(0, 10),
        dueDate: body.dueDate || body.invoiceDate || new Date().toISOString().slice(0, 10),
        partyId: Number(body.partyId),
        applyVat: body.applyVat !== false,
        notes: body.notes || '',
        paidImmediately: Boolean(body.paidImmediately),
        bankAccountId: body.bankAccountId ? Number(body.bankAccountId) : null,
        costCenterId: body.costCenterId ? Number(body.costCenterId) : null,
        profitCenterId: body.profitCenterId ? Number(body.profitCenterId) : null,
        lines: body.lines || [],
        userId: user.id,
        userName: user.fullName,
        userRole: user.role,
      });
      saveIdempotentResponse(idemKey, 'POST /invoices', companyId, inv);
      return inv;
    });

    res.status(201).json(created);
  } catch (err) {
    sendError(res, err);
  }
});

// Payments (Receipts & Disbursements)
financeRouter.get('/companies/:companyId/payments', requireAuth, (req: AuthedRequest, res) => {
  try {
    const companyId = Number(req.params.companyId);
    assertCompanyAccess(req.user!, companyId);
    const rows = db
      .prepare(
        `SELECT pay.id, pay.payment_type AS paymentType, pay.payment_date AS paymentDate,
                pay.amount, pay.method, pay.reference, p.name AS partyName,
                b.name AS branchName, a.name AS bankAccountName, i.invoice_number AS invoiceNumber
         FROM payments pay
         JOIN parties p ON p.id = pay.party_id
         JOIN branches b ON b.id = pay.branch_id
         JOIN accounts a ON a.id = pay.bank_account_id
         LEFT JOIN invoices i ON i.id = pay.invoice_id
         WHERE pay.company_id = ?
         ORDER BY pay.payment_date DESC, pay.id DESC LIMIT 100`
      )
      .all(companyId);
    res.json(rows);
  } catch (err) {
    sendError(res, err);
  }
});

financeRouter.post('/companies/:companyId/payments', requireAuth, (req: AuthedRequest, res) => {
  try {
    const companyId = Number(req.params.companyId);
    const user = req.user!;
    assertCompanyAccess(user, companyId);

    const idemKey = req.header('Idempotency-Key');
    const cached = getIdempotentResponse(idemKey);
    if (cached) {
      res.json(cached);
      return;
    }

    const body = req.body || {};
    const branchId = Number(body.branchId);
    assertBranchAccess(user, branchId);

    const created = withTransaction(() => {
      const pay = recordPaymentInTx({
        companyId,
        branchId,
        paymentType: body.paymentType === 'PAYMENT' ? 'PAYMENT' : 'RECEIPT',
        paymentDate: body.paymentDate || new Date().toISOString().slice(0, 10),
        partyId: Number(body.partyId),
        invoiceId: body.invoiceId ? Number(body.invoiceId) : null,
        bankAccountId: Number(body.bankAccountId),
        amount: Number(body.amount),
        method: body.method || 'BANK_TRANSFER',
        reference: body.reference || '',
        userId: user.id,
        userName: user.fullName,
        userRole: user.role,
      });
      saveIdempotentResponse(idemKey, 'POST /payments', companyId, pay);
      return pay;
    });

    res.status(201).json(created);
  } catch (err) {
    sendError(res, err);
  }
});

// Simple Mode Quick Expense (directly posts double-entry Dr Expense / Cr Cash or Bank)
financeRouter.post('/companies/:companyId/quick-expense', requireAuth, (req: AuthedRequest, res) => {
  try {
    const companyId = Number(req.params.companyId);
    const user = req.user!;
    assertCompanyAccess(user, companyId);
    const { branchId, expenseAccountId, bankAccountId, amount, entryDate, description } = req.body || {};
    assertBranchAccess(user, Number(branchId));

    const amt = round2(Number(amount));
    if (amt <= 0) {
      res.status(400).json({ error: 'Expense amount must be positive.' });
      return;
    }

    const je = withTransaction(() =>
      postJournalEntryInTx({
        companyId,
        entryDate: entryDate || new Date().toISOString().slice(0, 10),
        referenceType: 'EXPENSE',
        description: description || 'Operating Expense',
        lines: [
          { accountId: Number(expenseAccountId), branchId: Number(branchId), debit: amt, credit: 0, memo: description || 'Expense' },
          { accountId: Number(bankAccountId), branchId: Number(branchId), debit: 0, credit: amt, memo: 'Cash/Bank payout' },
        ],
        createdBy: user.id,
        createdByName: user.fullName,
        createdByRole: user.role,
        forceStatus: 'POSTED',
      })
    );
    res.status(201).json(je);
  } catch (err) {
    sendError(res, err);
  }
});

// Bank Reconciliation
financeRouter.get('/companies/:companyId/bank-reconciliation', requireAuth, (req: AuthedRequest, res) => {
  try {
    const companyId = Number(req.params.companyId);
    assertCompanyAccess(req.user!, companyId);
    const bankAccountId = req.query.bankAccountId ? Number(req.query.bankAccountId) : null;

    const bankAccounts = db
      .prepare(
        `SELECT a.id, a.code, a.name,
                COALESCE(SUM(CASE WHEN je.status = 'POSTED' THEN jl.debit - jl.credit ELSE 0 END), 0) AS bookBalance
         FROM accounts a
         LEFT JOIN journal_lines jl ON jl.account_id = a.id
         LEFT JOIN journal_entries je ON je.id = jl.journal_entry_id
         WHERE a.company_id = ? AND a.is_bank_or_cash = 1
         GROUP BY a.id ORDER BY a.code ASC`
      )
      .all(companyId) as Array<any>;

    const activeBankId = bankAccountId || bankAccounts.find((b) => b.code === '1010')?.id || bankAccounts[0]?.id;

    const statements = activeBankId
      ? db
          .prepare(
            `SELECT id, company_id AS companyId, bank_account_id AS bankAccountId, statement_date AS statementDate,
                    description, reference, amount, is_reconciled AS isReconciled, matched_journal_entry_id AS matchedJournalEntryId
             FROM bank_statement_lines
             WHERE company_id = ? AND bank_account_id = ?
             ORDER BY statement_date DESC, id DESC`
          )
          .all(companyId, activeBankId)
      : [];

    res.json({ bankAccounts, activeBankId, statements });
  } catch (err) {
    sendError(res, err);
  }
});

financeRouter.post('/companies/:companyId/bank-reconciliation/lines', requireAuth, (req: AuthedRequest, res) => {
  try {
    const companyId = Number(req.params.companyId);
    assertCompanyAccess(req.user!, companyId);
    const { bankAccountId, statementDate, description, reference = '', amount } = req.body || {};
    if (!bankAccountId || !statementDate || !description || amount === undefined) {
      res.status(400).json({ error: 'Bank account, date, description, and amount are required.' });
      return;
    }
    const r = db
      .prepare(
        `INSERT INTO bank_statement_lines (company_id, bank_account_id, statement_date, description, reference, amount, is_reconciled)
         VALUES (?, ?, ?, ?, ?, ?, 0)`
      )
      .run(companyId, Number(bankAccountId), statementDate, String(description).trim(), String(reference).trim(), Number(amount));
    res.status(201).json({ id: Number(r.lastInsertRowid) });
  } catch (err) {
    sendError(res, err);
  }
});

financeRouter.post('/companies/:companyId/bank-reconciliation/:lineId/toggle', requireAuth, (req: AuthedRequest, res) => {
  try {
    const companyId = Number(req.params.companyId);
    const lineId = Number(req.params.lineId);
    assertCompanyAccess(req.user!, companyId);
    const row = db
      .prepare('SELECT id, is_reconciled FROM bank_statement_lines WHERE id = ? AND company_id = ?')
      .get(lineId, companyId) as { id: number; is_reconciled: number } | undefined;
    if (!row) {
      res.status(404).json({ error: 'Statement line not found.' });
      return;
    }
    const nextVal = row.is_reconciled ? 0 : 1;
    db.prepare('UPDATE bank_statement_lines SET is_reconciled = ? WHERE id = ?').run(nextVal, lineId);
    res.json({ id: lineId, isReconciled: nextVal });
  } catch (err) {
    sendError(res, err);
  }
});

// Budgets & Budget vs Actual
financeRouter.get('/companies/:companyId/budgets', requireAuth, (req: AuthedRequest, res) => {
  try {
    const companyId = Number(req.params.companyId);
    assertCompanyAccess(req.user!, companyId);
    const rows = db
      .prepare(
        `SELECT b.id, b.company_id AS companyId, b.branch_id AS branchId, br.name AS branchName,
                b.cost_center_id AS costCenterId, cc.name AS costCenterName,
                b.account_id AS accountId, a.code AS accountCode, a.name AS accountName, a.account_type AS accountType,
                b.fiscal_year_label AS fiscalYearLabel, b.budget_amount AS budgetAmount
         FROM budgets b
         JOIN accounts a ON a.id = b.account_id
         LEFT JOIN branches br ON br.id = b.branch_id
         LEFT JOIN cost_profit_centers cc ON cc.id = b.cost_center_id
         WHERE b.company_id = ?
         ORDER BY a.code ASC`
      )
      .all(companyId) as Array<any>;

    const enriched = rows.map((row) => {
      const actualAgg = db
        .prepare(
          `SELECT COALESCE(SUM(jl.debit), 0) AS dr, COALESCE(SUM(jl.credit), 0) AS cr
           FROM journal_lines jl
           JOIN journal_entries je ON je.id = jl.journal_entry_id
           WHERE je.company_id = ? AND je.status = 'POSTED' AND je.is_elimination = 0 AND jl.account_id = ?
             AND (? IS NULL OR jl.branch_id = ?)`
        )
        .get(companyId, row.accountId, row.branchId, row.branchId) as { dr: number; cr: number };

      const actualAmount =
        row.accountType === 'REVENUE' ? round2(actualAgg.cr - actualAgg.dr) : round2(actualAgg.dr - actualAgg.cr);
      const variance = round2(row.budgetAmount - actualAmount);
      const utilizationPct = row.budgetAmount > 0 ? round2((actualAmount / row.budgetAmount) * 100) : 0;
      return { ...row, actualAmount, variance, utilizationPct };
    });

    res.json(enriched);
  } catch (err) {
    sendError(res, err);
  }
});

financeRouter.post('/companies/:companyId/budgets', requireAuth, (req: AuthedRequest, res) => {
  try {
    const companyId = Number(req.params.companyId);
    assertCompanyAccess(req.user!, companyId);
    const { accountId, branchId = null, costCenterId = null, fiscalYearLabel = 'FY 2082/83', budgetAmount } = req.body || {};
    if (!accountId || !budgetAmount) {
      res.status(400).json({ error: 'Account and budget amount are required.' });
      return;
    }
    db.prepare(
      `INSERT INTO budgets (company_id, branch_id, cost_center_id, account_id, fiscal_year_label, budget_amount)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(company_id, branch_id, cost_center_id, account_id, fiscal_year_label)
       DO UPDATE SET budget_amount = excluded.budget_amount`
    ).run(companyId, branchId ? Number(branchId) : null, costCenterId ? Number(costCenterId) : null, Number(accountId), fiscalYearLabel, Number(budgetAmount));
    res.status(201).json({ ok: true });
  } catch (err) {
    sendError(res, err);
  }
});

// Financial Reports: Company / Branch / Department / Consolidated
financeRouter.get('/companies/:companyId/reports/financials', requireAuth, (req: AuthedRequest, res) => {
  try {
    const companyId = Number(req.params.companyId);
    assertCompanyAccess(req.user!, companyId);
    const branchId = req.query.branchId ? Number(req.query.branchId) : null;
    const costCenterId = req.query.costCenterId ? Number(req.query.costCenterId) : null;

    const comp = db.prepare('SELECT legal_name, currency FROM companies WHERE id = ?').get(companyId) as {
      legal_name: string;
      currency: string;
    };
    let scopeLabel = comp.legal_name;
    if (branchId) {
      const b = db.prepare('SELECT name FROM branches WHERE id = ?').get(branchId) as { name: string } | undefined;
      if (b) scopeLabel += ` · ${b.name}`;
    }

    const statements = computeFinancialStatements({
      companyIds: [companyId],
      branchId,
      costCenterId,
      includeEliminations: false,
      scopeLabel,
      currency: comp.currency,
    });
    res.json(statements);
  } catch (err) {
    sendError(res, err);
  }
});

// Group Consolidated Financial Statements across all authorized companies (with optional inter-company eliminations)
financeRouter.get('/reports/consolidated', requireAuth, (req: AuthedRequest, res) => {
  try {
    const user = req.user!;
    const includeEliminations = req.query.eliminations !== 'false';
    const companyIds = user.allowedCompanyIds;

    const companies = db
      .prepare(`SELECT id, code, legal_name AS legalName, currency FROM companies WHERE id IN (${companyIds.map(() => '?').join(',')})`)
      .all(...companyIds) as Array<{ id: number; code: string; legalName: string; currency: string }>;

    const consolidated = computeFinancialStatements({
      companyIds,
      includeEliminations,
      scopeLabel: `Group Consolidated (${companies.map((c) => c.code).join(' + ')})${includeEliminations ? ' · Net of Eliminations' : ' · Pre-Elimination'}`,
      currency: companies[0]?.currency || 'NPR',
    });

    const entityBreakdown = companies.map((c) => {
      const st = computeFinancialStatements({
        companyIds: [c.id],
        includeEliminations: false,
        scopeLabel: c.legalName,
        currency: c.currency,
      });
      return {
        companyId: c.id,
        code: c.code,
        legalName: c.legalName,
        revenue: st.profitAndLoss.totalRevenue,
        grossProfit: st.profitAndLoss.grossProfit,
        netIncome: st.profitAndLoss.netIncome,
        totalAssets: st.balanceSheet.totalAssets,
        totalLiabilities: st.balanceSheet.totalLiabilities,
        endingCash: st.cashFlow.endingCashBalance,
      };
    });

    res.json({ consolidated, entityBreakdown, includeEliminations });
  } catch (err) {
    sendError(res, err);
  }
});

// Enterprise Analytics: Branch Comparison, Product Profitability, Customer Profitability, Department, User Activity, Cash Flow Forecast
financeRouter.get('/companies/:companyId/reports/analytics', requireAuth, (req: AuthedRequest, res) => {
  try {
    const companyId = Number(req.params.companyId);
    assertCompanyAccess(req.user!, companyId);

    const branches = db
      .prepare('SELECT id, code, name, branch_type AS branchType, city FROM branches WHERE company_id = ?')
      .all(companyId) as Array<{ id: number; code: string; name: string; branchType: string; city: string }>;

    const branchComparison = branches.map((b) => {
      const st = computeFinancialStatements({
        companyIds: [companyId],
        branchId: b.id,
        scopeLabel: b.name,
      });
      const stockAgg = db
        .prepare('SELECT COALESCE(SUM(qty_remaining * unit_cost), 0) AS val FROM stock_lots WHERE company_id = ? AND branch_id = ? AND qty_remaining > 0')
        .get(companyId, b.id) as { val: number };
      return {
        branchId: b.id,
        code: b.code,
        name: b.name,
        branchType: b.branchType,
        city: b.city,
        revenue: st.profitAndLoss.totalRevenue,
        cogs: st.profitAndLoss.totalCogs,
        expenses: st.profitAndLoss.totalOperatingExpenses,
        netProfit: st.profitAndLoss.netIncome,
        inventoryValue: round2(stockAgg.val || 0),
      };
    });

    const productProfitability = db
      .prepare(
        `SELECT i.sku, i.name, i.category, i.valuation_method AS valuationMethod,
                COALESCE(SUM(il.qty), 0) AS unitsSold,
                COALESCE(SUM(il.line_total), 0) AS revenue,
                COALESCE(SUM(il.cogs_amount), 0) AS cogs
         FROM invoice_lines il
         JOIN invoices inv ON inv.id = il.invoice_id
         JOIN inventory_items i ON i.id = il.item_id
         WHERE inv.company_id = ? AND inv.invoice_type = 'SALES'
         GROUP BY i.id
         ORDER BY revenue DESC`
      )
      .all(companyId)
      .map((r: any) => {
        const profit = round2(r.revenue - r.cogs);
        const marginPct = r.revenue > 0 ? round2((profit / r.revenue) * 100) : 0;
        return { ...r, revenue: round2(r.revenue), cogs: round2(r.cogs), grossProfit: profit, marginPct };
      });

    const customerProfitability = db
      .prepare(
        `SELECT p.code, p.name, COUNT(DISTINCT inv.id) AS invoiceCount,
                COALESCE(SUM(inv.subtotal), 0) AS revenue,
                COALESCE(SUM(il.cogs_amount), 0) AS cogs,
                COALESCE(SUM(inv.total_amount - inv.paid_amount), 0) AS outstandingAr
         FROM invoices inv
         JOIN parties p ON p.id = inv.party_id
         LEFT JOIN invoice_lines il ON il.invoice_id = inv.id
         WHERE inv.company_id = ? AND inv.invoice_type = 'SALES'
         GROUP BY p.id
         ORDER BY revenue DESC`
      )
      .all(companyId)
      .map((r: any) => {
        const profit = round2(r.revenue - r.cogs);
        return {
          ...r,
          revenue: round2(r.revenue),
          cogs: round2(r.cogs),
          grossProfit: profit,
          marginPct: r.revenue > 0 ? round2((profit / r.revenue) * 100) : 0,
        };
      });

    const userActivity = db
      .prepare(
        `SELECT u.full_name AS fullName, u.role,
                COUNT(DISTINCT je.id) AS journalsPosted,
                COALESCE(SUM(je.total_amount), 0) AS totalVolume
         FROM users u
         LEFT JOIN journal_entries je ON je.created_by = u.id AND je.company_id = ?
         GROUP BY u.id
         HAVING journalsPosted > 0
         ORDER BY totalVolume DESC`
      )
      .all(companyId);

    const departmentSummary = db
      .prepare(
        `SELECT c.code, c.name, c.kind, c.department,
                COALESCE(SUM(jl.debit), 0) AS totalDebit,
                COALESCE(SUM(jl.credit), 0) AS totalCredit
         FROM cost_profit_centers c
         LEFT JOIN journal_lines jl ON (jl.cost_center_id = c.id OR jl.profit_center_id = c.id)
         LEFT JOIN journal_entries je ON je.id = jl.journal_entry_id AND je.status = 'POSTED'
         WHERE c.company_id = ?
         GROUP BY c.id
         ORDER BY c.kind ASC, c.code ASC`
      )
      .all(companyId);

    // 4-Month Cash Flow Forecast based on current cash, open AR, open AP, and avg monthly burn
    const financials = computeFinancialStatements({ companyIds: [companyId], scopeLabel: 'Forecast' });
    const arOpen = (db
      .prepare(`SELECT COALESCE(SUM(total_amount - paid_amount), 0) AS val FROM invoices WHERE company_id = ? AND invoice_type = 'SALES' AND status != 'PAID'`)
      .get(companyId) as { val: number }).val;
    const apOpen = (db
      .prepare(`SELECT COALESCE(SUM(total_amount - paid_amount), 0) AS val FROM invoices WHERE company_id = ? AND invoice_type = 'PURCHASE' AND status != 'PAID'`)
      .get(companyId) as { val: number }).val;

    const monthlyRunRateRev = Math.max(round2(financials.profitAndLoss.totalRevenue / 2), 450000);
    const monthlyRunRateExp = Math.max(round2(financials.profitAndLoss.totalOperatingExpenses), 350000);
    let projectedCash = financials.cashFlow.endingCashBalance;

    const cashFlowForecast = [
      { period: 'Current', inflow: 0, outflow: 0, projectedCash: round2(projectedCash) },
      ...['Month +1', 'Month +2', 'Month +3', 'Month +4'].map((label, idx) => {
        const inflow = round2(monthlyRunRateRev * (0.85 + idx * 0.05) + (idx === 0 ? arOpen * 0.65 : idx === 1 ? arOpen * 0.35 : 0));
        const outflow = round2(monthlyRunRateExp + monthlyRunRateRev * 0.55 + (idx === 0 ? apOpen * 0.7 : idx === 1 ? apOpen * 0.3 : 0));
        projectedCash = round2(projectedCash + inflow - outflow);
        return { period: label, inflow, outflow, projectedCash };
      }),
    ];

    res.json({
      branchComparison,
      productProfitability,
      customerProfitability,
      userActivity,
      departmentSummary,
      cashFlowForecast,
    });
  } catch (err) {
    sendError(res, err);
  }
});
