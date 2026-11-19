import { db, round2, writeAuditLog } from './db.ts';
import { issueStockInTx, receiveStockInTx } from './inventory.ts';
import type { JournalLineInput, JournalStatus, UserRole } from '../shared/types.ts';

export const APPROVAL_THRESHOLD = 500000;

export function ensurePeriodOpen(companyId: number, entryDate: string): void {
  const locked = db
    .prepare(
      `SELECT period_name FROM fiscal_period_locks
       WHERE company_id = ? AND is_locked = 1 AND ? BETWEEN start_date AND end_date
       LIMIT 1`
    )
    .get(companyId, entryDate) as { period_name: string } | undefined;

  if (locked) {
    const err = new Error(
      `Financial period "${locked.period_name}" is locked for posting on ${entryDate}.`
    ) as Error & { statusCode?: number };
    err.statusCode = 423;
    throw err;
  }
}

export function nextCompanySequence(
  companyId: number,
  kind: 'invoice' | 'purchase' | 'journal'
): string {
  const colPrefix =
    kind === 'invoice' ? 'invoice_prefix' : kind === 'purchase' ? 'purchase_prefix' : 'journal_prefix';
  const colSeq =
    kind === 'invoice'
      ? 'next_invoice_seq'
      : kind === 'purchase'
        ? 'next_purchase_seq'
        : 'next_journal_seq';

  const row = db
    .prepare(`SELECT ${colPrefix} AS prefix, ${colSeq} AS seq FROM companies WHERE id = ?`)
    .get(companyId) as { prefix: string; seq: number } | undefined;

  if (!row) throw new Error('Company not found.');
  db.prepare(`UPDATE companies SET ${colSeq} = ${colSeq} + 1 WHERE id = ?`).run(companyId);
  return `${row.prefix}-${String(row.seq).padStart(4, '0')}`;
}

export function getAccountByCode(companyId: number, code: string): { id: number; name: string } {
  const row = db
    .prepare('SELECT id, name FROM accounts WHERE company_id = ? AND code = ?')
    .get(companyId, code) as { id: number; name: string } | undefined;
  if (!row) {
    throw new Error(`Required system account ${code} not found for company #${companyId}.`);
  }
  return row;
}

export function postJournalEntryInTx(params: {
  companyId: number;
  entryDate: string;
  referenceType: string;
  referenceId?: number | null;
  description: string;
  lines: JournalLineInput[];
  createdBy: number;
  createdByName: string;
  createdByRole: UserRole;
  isIntercompany?: boolean;
  isElimination?: boolean;
  forceStatus?: JournalStatus;
  skipPeriodCheck?: boolean;
}): { id: number; entryNumber: string; status: JournalStatus; totalAmount: number } {
  if (!params.lines || params.lines.length < 2) {
    throw new Error('Double-entry journal requires at least two lines.');
  }

  if (!params.skipPeriodCheck) {
    ensurePeriodOpen(params.companyId, params.entryDate);
  }

  let totalDebit = 0;
  let totalCredit = 0;

  for (const line of params.lines) {
    if (line.debit < 0 || line.credit < 0) {
      throw new Error('Journal debit and credit amounts must be non-negative.');
    }
    if (line.debit === 0 && line.credit === 0) {
      throw new Error('Each journal line must have a non-zero debit or credit.');
    }
    const acct = db
      .prepare('SELECT id FROM accounts WHERE id = ? AND company_id = ?')
      .get(line.accountId, params.companyId);
    if (!acct) {
      throw new Error(`Account #${line.accountId} does not belong to company #${params.companyId}.`);
    }
    const br = db
      .prepare('SELECT id FROM branches WHERE id = ? AND company_id = ?')
      .get(line.branchId, params.companyId);
    if (!br) {
      throw new Error(`Branch #${line.branchId} does not belong to company #${params.companyId}.`);
    }
    totalDebit = round2(totalDebit + line.debit);
    totalCredit = round2(totalCredit + line.credit);
  }

  if (Math.abs(totalDebit - totalCredit) >= 0.005) {
    throw new Error(
      `Unbalanced double-entry journal: total debits (${totalDebit.toFixed(2)}) != total credits (${totalCredit.toFixed(2)}).`
    );
  }

  // Approval hierarchy: manual high-value journals created by non-approvers wait for approval
  let status: JournalStatus = params.forceStatus || 'POSTED';
  let approvedBy: number | null = params.createdBy;
  if (
    !params.forceStatus &&
    params.referenceType === 'MANUAL' &&
    totalDebit >= APPROVAL_THRESHOLD &&
    params.createdByRole !== 'SUPER_ADMIN' &&
    params.createdByRole !== 'CFO_APPROVER'
  ) {
    status = 'PENDING_APPROVAL';
    approvedBy = null;
  }

  const entryNumber = nextCompanySequence(params.companyId, 'journal');
  const jeRes = db
    .prepare(
      `INSERT INTO journal_entries
       (company_id, entry_number, entry_date, reference_type, reference_id, description, status, is_intercompany, is_elimination, total_amount, created_by, approved_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      params.companyId,
      entryNumber,
      params.entryDate,
      params.referenceType,
      params.referenceId ?? null,
      params.description,
      status,
      params.isIntercompany ? 1 : 0,
      params.isElimination ? 1 : 0,
      totalDebit,
      params.createdBy,
      approvedBy
    );

  const jeId = Number(jeRes.lastInsertRowid);
  const insertLine = db.prepare(
    `INSERT INTO journal_lines
     (journal_entry_id, company_id, account_id, branch_id, cost_center_id, profit_center_id, party_id, debit, credit, memo)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  for (const line of params.lines) {
    insertLine.run(
      jeId,
      params.companyId,
      line.accountId,
      line.branchId,
      line.costCenterId ?? null,
      line.profitCenterId ?? null,
      line.partyId ?? null,
      round2(line.debit),
      round2(line.credit),
      line.memo || ''
    );
  }

  writeAuditLog({
    companyId: params.companyId,
    branchId: params.lines[0]?.branchId ?? null,
    userId: params.createdBy,
    userName: params.createdByName,
    userRole: params.createdByRole,
    action: status === 'PENDING_APPROVAL' ? 'JOURNAL_SUBMITTED' : 'JOURNAL_POSTED',
    entityType: 'journal_entry',
    entityId: entryNumber,
    summary: `${params.description} (${totalDebit.toFixed(2)}) [${status}]`,
  });

  return { id: jeId, entryNumber, status, totalAmount: totalDebit };
}

export function createInvoiceInTx(params: {
  companyId: number;
  branchId: number;
  invoiceType: 'SALES' | 'PURCHASE';
  invoiceDate: string;
  dueDate: string;
  partyId: number;
  applyVat: boolean;
  notes?: string;
  paidImmediately?: boolean;
  bankAccountId?: number | null;
  costCenterId?: number | null;
  profitCenterId?: number | null;
  lines: Array<{
    itemId?: number | null;
    warehouseId?: number | null;
    description: string;
    qty: number;
    unitPrice: number;
    batchNumber?: string | null;
    serialNumber?: string | null;
    vinNumber?: string | null;
    engineNumber?: string | null;
    expiryDate?: string | null;
  }>;
  userId: number;
  userName: string;
  userRole: UserRole;
  skipPeriodCheck?: boolean;
}): { invoiceId: number; invoiceNumber: string; totalAmount: number; journalEntryId: number } {
  if (!params.lines || params.lines.length === 0) {
    throw new Error('Invoice must contain at least one line item.');
  }

  if (!params.skipPeriodCheck) {
    ensurePeriodOpen(params.companyId, params.invoiceDate);
  }

  const company = db
    .prepare('SELECT id, vat_rate FROM companies WHERE id = ?')
    .get(params.companyId) as { id: number; vat_rate: number } | undefined;
  if (!company) throw new Error('Company not found.');

  const party = db
    .prepare('SELECT id, name, is_intercompany FROM parties WHERE id = ? AND company_id = ?')
    .get(params.partyId, params.companyId) as
    | { id: number; name: string; is_intercompany: number }
    | undefined;
  if (!party) throw new Error('Customer/Supplier not found for this company.');

  let subtotal = 0;
  for (const l of params.lines) {
    if (l.qty <= 0 || l.unitPrice < 0) {
      throw new Error('Line quantity must be positive and unit price non-negative.');
    }
    subtotal = round2(subtotal + l.qty * l.unitPrice);
  }

  const vatAmount = params.applyVat ? round2((subtotal * company.vat_rate) / 100) : 0;
  const totalAmount = round2(subtotal + vatAmount);
  const invoiceNumber = nextCompanySequence(
    params.companyId,
    params.invoiceType === 'SALES' ? 'invoice' : 'purchase'
  );

  const invRes = db
    .prepare(
      `INSERT INTO invoices
       (company_id, branch_id, invoice_type, invoice_number, invoice_date, due_date, party_id, subtotal, vat_amount, total_amount, paid_amount, status, is_intercompany, notes, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'OPEN', ?, ?, ?)`
    )
    .run(
      params.companyId,
      params.branchId,
      params.invoiceType,
      invoiceNumber,
      params.invoiceDate,
      params.dueDate || params.invoiceDate,
      params.partyId,
      subtotal,
      vatAmount,
      totalAmount,
      party.is_intercompany,
      params.notes || '',
      params.userId
    );

  const invoiceId = Number(invRes.lastInsertRowid);
  let totalCogs = 0;

  for (const line of params.lines) {
    const lineTotal = round2(line.qty * line.unitPrice);
    let cogsAmount = 0;

    if (line.itemId && line.warehouseId) {
      if (params.invoiceType === 'SALES') {
        const issued = issueStockInTx({
          companyId: params.companyId,
          itemId: line.itemId,
          warehouseId: line.warehouseId,
          qty: line.qty,
          referenceType: 'SALES_INVOICE',
          referenceId: invoiceId,
          notes: `Sold via ${invoiceNumber}`,
          userId: params.userId,
        });
        cogsAmount = issued.totalCost;
        totalCogs = round2(totalCogs + cogsAmount);
      } else {
        receiveStockInTx({
          companyId: params.companyId,
          itemId: line.itemId,
          warehouseId: line.warehouseId,
          qty: line.qty,
          unitCost: line.unitPrice,
          batchNumber: line.batchNumber,
          serialNumber: line.serialNumber,
          vinNumber: line.vinNumber,
          engineNumber: line.engineNumber,
          expiryDate: line.expiryDate,
          referenceType: 'PURCHASE_BILL',
          referenceId: invoiceId,
          notes: `Purchased via ${invoiceNumber}`,
          userId: params.userId,
          receivedAt: `${params.invoiceDate}T09:00:00.000Z`,
        });
      }
    }

    db.prepare(
      `INSERT INTO invoice_lines (invoice_id, item_id, warehouse_id, description, qty, unit_price, line_total, cogs_amount)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      invoiceId,
      line.itemId ?? null,
      line.warehouseId ?? null,
      line.description,
      line.qty,
      line.unitPrice,
      lineTotal,
      cogsAmount
    );
  }

  // Build double-entry journal lines
  const jeLines: JournalLineInput[] = [];
  if (params.invoiceType === 'SALES') {
    const arAcct = party.is_intercompany
      ? getAccountByCode(params.companyId, '1900')
      : getAccountByCode(params.companyId, '1200');
    const revAcct = getAccountByCode(params.companyId, '4000');
    const vatPayable = getAccountByCode(params.companyId, '2100');

    jeLines.push({
      accountId: arAcct.id,
      branchId: params.branchId,
      profitCenterId: params.profitCenterId ?? null,
      partyId: params.partyId,
      debit: totalAmount,
      credit: 0,
      memo: `Receivable for ${invoiceNumber} - ${party.name}`,
    });
    jeLines.push({
      accountId: revAcct.id,
      branchId: params.branchId,
      profitCenterId: params.profitCenterId ?? null,
      partyId: params.partyId,
      debit: 0,
      credit: subtotal,
      memo: `Sales revenue ${invoiceNumber}`,
    });
    if (vatAmount > 0) {
      jeLines.push({
        accountId: vatPayable.id,
        branchId: params.branchId,
        partyId: params.partyId,
        debit: 0,
        credit: vatAmount,
        memo: `Output VAT ${company.vat_rate}% on ${invoiceNumber}`,
      });
    }
    if (totalCogs > 0) {
      const cogsAcct = getAccountByCode(params.companyId, '5000');
      const invAcct = getAccountByCode(params.companyId, '1300');
      jeLines.push({
        accountId: cogsAcct.id,
        branchId: params.branchId,
        profitCenterId: params.profitCenterId ?? null,
        debit: totalCogs,
        credit: 0,
        memo: `COGS for ${invoiceNumber}`,
      });
      jeLines.push({
        accountId: invAcct.id,
        branchId: params.branchId,
        debit: 0,
        credit: totalCogs,
        memo: `Inventory reduction for ${invoiceNumber}`,
      });
    }
  } else {
    // PURCHASE
    const apAcct = party.is_intercompany
      ? getAccountByCode(params.companyId, '2900')
      : getAccountByCode(params.companyId, '2000');
    const hasStockLines = params.lines.some((l) => Boolean(l.itemId && l.warehouseId));
    const debitAcct = hasStockLines
      ? getAccountByCode(params.companyId, '1300')
      : getAccountByCode(params.companyId, '6200');
    const vatInput = getAccountByCode(params.companyId, '1400');

    jeLines.push({
      accountId: debitAcct.id,
      branchId: params.branchId,
      costCenterId: params.costCenterId ?? null,
      partyId: params.partyId,
      debit: subtotal,
      credit: 0,
      memo: `Purchase ${invoiceNumber} from ${party.name}`,
    });
    if (vatAmount > 0) {
      jeLines.push({
        accountId: vatInput.id,
        branchId: params.branchId,
        partyId: params.partyId,
        debit: vatAmount,
        credit: 0,
        memo: `Input VAT ${company.vat_rate}% on ${invoiceNumber}`,
      });
    }
    jeLines.push({
      accountId: apAcct.id,
      branchId: params.branchId,
      costCenterId: params.costCenterId ?? null,
      partyId: params.partyId,
      debit: 0,
      credit: totalAmount,
      memo: `Payable for ${invoiceNumber} - ${party.name}`,
    });
  }

  const je = postJournalEntryInTx({
    companyId: params.companyId,
    entryDate: params.invoiceDate,
    referenceType: params.invoiceType === 'SALES' ? 'SALES_INVOICE' : 'PURCHASE_BILL',
    referenceId: invoiceId,
    description: `${params.invoiceType === 'SALES' ? 'Sales Invoice' : 'Purchase Bill'} ${invoiceNumber} (${party.name})`,
    lines: jeLines,
    createdBy: params.userId,
    createdByName: params.userName,
    createdByRole: params.userRole,
    isIntercompany: Boolean(party.is_intercompany),
    forceStatus: 'POSTED',
    skipPeriodCheck: params.skipPeriodCheck,
  });

  db.prepare('UPDATE invoices SET journal_entry_id = ? WHERE id = ?').run(je.id, invoiceId);

  // Optional immediate settlement (useful for Simple Mode cash sales/purchases)
  if (params.paidImmediately) {
    const bankAcctId =
      params.bankAccountId || getAccountByCode(params.companyId, '1000').id;
    recordPaymentInTx({
      companyId: params.companyId,
      branchId: params.branchId,
      paymentType: params.invoiceType === 'SALES' ? 'RECEIPT' : 'PAYMENT',
      paymentDate: params.invoiceDate,
      partyId: params.partyId,
      invoiceId,
      bankAccountId: bankAcctId,
      amount: totalAmount,
      method: 'CASH_OR_BANK',
      reference: `Auto-settled ${invoiceNumber}`,
      userId: params.userId,
      userName: params.userName,
      userRole: params.userRole,
      skipPeriodCheck: params.skipPeriodCheck,
    });
  }

  return { invoiceId, invoiceNumber, totalAmount, journalEntryId: je.id };
}

export function recordPaymentInTx(params: {
  companyId: number;
  branchId: number;
  paymentType: 'RECEIPT' | 'PAYMENT';
  paymentDate: string;
  partyId: number;
  invoiceId?: number | null;
  bankAccountId: number;
  amount: number;
  method?: string;
  reference?: string;
  userId: number;
  userName: string;
  userRole: UserRole;
  skipPeriodCheck?: boolean;
}): { paymentId: number; journalEntryId: number } {
  if (params.amount <= 0) {
    throw new Error('Payment amount must be greater than zero.');
  }
  if (!params.skipPeriodCheck) {
    ensurePeriodOpen(params.companyId, params.paymentDate);
  }

  const party = db
    .prepare('SELECT id, name, is_intercompany FROM parties WHERE id = ? AND company_id = ?')
    .get(params.partyId, params.companyId) as
    | { id: number; name: string; is_intercompany: number }
    | undefined;
  if (!party) throw new Error('Party not found for this company.');

  const payRes = db
    .prepare(
      `INSERT INTO payments
       (company_id, branch_id, payment_type, payment_date, party_id, invoice_id, bank_account_id, amount, method, reference, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      params.companyId,
      params.branchId,
      params.paymentType,
      params.paymentDate,
      params.partyId,
      params.invoiceId ?? null,
      params.bankAccountId,
      round2(params.amount),
      params.method || 'BANK_TRANSFER',
      params.reference || '',
      params.userId
    );
  const paymentId = Number(payRes.lastInsertRowid);

  if (params.invoiceId) {
    const inv = db
      .prepare('SELECT id, total_amount, paid_amount FROM invoices WHERE id = ? AND company_id = ?')
      .get(params.invoiceId, params.companyId) as
      | { id: number; total_amount: number; paid_amount: number }
      | undefined;
    if (inv) {
      const nextPaid = round2(inv.paid_amount + params.amount);
      const nextStatus =
        nextPaid + 0.005 >= inv.total_amount ? 'PAID' : nextPaid > 0 ? 'PARTIAL' : 'OPEN';
      db.prepare('UPDATE invoices SET paid_amount = ?, status = ? WHERE id = ?').run(
        Math.min(nextPaid, inv.total_amount),
        nextStatus,
        inv.id
      );
    }
  }

  const arOrApAcct =
    params.paymentType === 'RECEIPT'
      ? getAccountByCode(params.companyId, party.is_intercompany ? '1900' : '1200')
      : getAccountByCode(params.companyId, party.is_intercompany ? '2900' : '2000');

  const lines: JournalLineInput[] =
    params.paymentType === 'RECEIPT'
      ? [
          {
            accountId: params.bankAccountId,
            branchId: params.branchId,
            partyId: params.partyId,
            debit: round2(params.amount),
            credit: 0,
            memo: `Receipt from ${party.name}`,
          },
          {
            accountId: arOrApAcct.id,
            branchId: params.branchId,
            partyId: params.partyId,
            debit: 0,
            credit: round2(params.amount),
            memo: `AR settlement - ${party.name}`,
          },
        ]
      : [
          {
            accountId: arOrApAcct.id,
            branchId: params.branchId,
            partyId: params.partyId,
            debit: round2(params.amount),
            credit: 0,
            memo: `AP settlement - ${party.name}`,
          },
          {
            accountId: params.bankAccountId,
            branchId: params.branchId,
            partyId: params.partyId,
            debit: 0,
            credit: round2(params.amount),
            memo: `Payment to ${party.name}`,
          },
        ];

  const je = postJournalEntryInTx({
    companyId: params.companyId,
    entryDate: params.paymentDate,
    referenceType: params.paymentType === 'RECEIPT' ? 'PAYMENT_IN' : 'PAYMENT_OUT',
    referenceId: paymentId,
    description: `${params.paymentType === 'RECEIPT' ? 'Payment Received from' : 'Payment Made to'} ${party.name}`,
    lines,
    createdBy: params.userId,
    createdByName: params.userName,
    createdByRole: params.userRole,
    isIntercompany: Boolean(party.is_intercompany),
    forceStatus: 'POSTED',
    skipPeriodCheck: params.skipPeriodCheck,
  });

  db.prepare('UPDATE payments SET journal_entry_id = ? WHERE id = ?').run(je.id, paymentId);
  return { paymentId, journalEntryId: je.id };
}

export interface FinancialStatementsResult {
  scopeLabel: string;
  currency: string;
  trialBalance: Array<{
    accountCode: string;
    accountName: string;
    accountType: string;
    debit: number;
    credit: number;
    netBalance: number;
  }>;
  totalTrialDebit: number;
  totalTrialCredit: number;
  isBalanced: boolean;
  profitAndLoss: {
    revenues: Array<{ code: string; name: string; amount: number }>;
    cogs: Array<{ code: string; name: string; amount: number }>;
    operatingExpenses: Array<{ code: string; name: string; amount: number }>;
    totalRevenue: number;
    totalCogs: number;
    grossProfit: number;
    totalOperatingExpenses: number;
    netIncome: number;
  };
  balanceSheet: {
    assets: Array<{ code: string; name: string; subType: string; amount: number }>;
    liabilities: Array<{ code: string; name: string; subType: string; amount: number }>;
    equity: Array<{ code: string; name: string; subType: string; amount: number }>;
    totalAssets: number;
    totalLiabilities: number;
    totalEquityBeforeCurrentNet: number;
    currentNetIncome: number;
    totalLiabilitiesAndEquity: number;
    balanceSheetDiff: number;
  };
  cashFlow: {
    operatingCashFlow: number;
    investingCashFlow: number;
    financingCashFlow: number;
    netCashChange: number;
    endingCashBalance: number;
  };
  ratios: {
    currentRatio: number;
    quickRatio: number;
    grossMarginPct: number;
    netMarginPct: number;
    debtToEquity: number;
    inventoryTurnover: number;
    returnOnAssetsPct: number;
  };
}

export function computeFinancialStatements(options: {
  companyIds: number[];
  branchId?: number | null;
  costCenterId?: number | null;
  includeEliminations?: boolean;
  scopeLabel: string;
  currency?: string;
}): FinancialStatementsResult {
  if (options.companyIds.length === 0) {
    throw new Error('At least one authorized company is required.');
  }

  const placeholders = options.companyIds.map(() => '?').join(',');
  const whereParts = [`je.company_id IN (${placeholders})`, `je.status = 'POSTED'`];
  const args: any[] = [...options.companyIds];

  if (options.branchId) {
    whereParts.push('jl.branch_id = ?');
    args.push(options.branchId);
  }
  if (options.costCenterId) {
    whereParts.push('jl.cost_center_id = ?');
    args.push(options.costCenterId);
  }
  if (!options.includeEliminations) {
    whereParts.push('je.is_elimination = 0');
  }

  const rows = db
    .prepare(
      `SELECT a.code, a.name, a.account_type, a.sub_type, a.is_bank_or_cash,
              SUM(jl.debit) AS sum_debit, SUM(jl.credit) AS sum_credit
       FROM journal_lines jl
       JOIN journal_entries je ON je.id = jl.journal_entry_id
       JOIN accounts a ON a.id = jl.account_id
       WHERE ${whereParts.join(' AND ')}
       GROUP BY a.code, a.name, a.account_type, a.sub_type, a.is_bank_or_cash
       ORDER BY a.code ASC`
    )
    .all(...args) as Array<{
    code: string;
    name: string;
    account_type: string;
    sub_type: string;
    is_bank_or_cash: number;
    sum_debit: number;
    sum_credit: number;
  }>;

  const trialBalance = rows.map((r) => {
    const debit = round2(r.sum_debit || 0);
    const credit = round2(r.sum_credit || 0);
    const isDebitNormal = r.account_type === 'ASSET' || r.account_type === 'EXPENSE';
    const netBalance = isDebitNormal ? round2(debit - credit) : round2(credit - debit);
    return {
      accountCode: r.code,
      accountName: r.name,
      accountType: r.account_type,
      subType: r.sub_type,
      isBankOrCash: r.is_bank_or_cash,
      debit,
      credit,
      netBalance,
    };
  });

  const totalTrialDebit = round2(trialBalance.reduce((s, r) => s + r.debit, 0));
  const totalTrialCredit = round2(trialBalance.reduce((s, r) => s + r.credit, 0));

  const revenues = trialBalance
    .filter((r) => r.accountType === 'REVENUE')
    .map((r) => ({ code: r.accountCode, name: r.accountName, amount: r.netBalance }));

  const cogs = trialBalance
    .filter((r) => r.accountType === 'EXPENSE' && r.subType === 'COGS')
    .map((r) => ({ code: r.accountCode, name: r.accountName, amount: r.netBalance }));

  const operatingExpenses = trialBalance
    .filter((r) => r.accountType === 'EXPENSE' && r.subType !== 'COGS')
    .map((r) => ({ code: r.accountCode, name: r.accountName, amount: r.netBalance }));

  const totalRevenue = round2(revenues.reduce((s, r) => s + r.amount, 0));
  const totalCogs = round2(cogs.reduce((s, r) => s + r.amount, 0));
  const grossProfit = round2(totalRevenue - totalCogs);
  const totalOperatingExpenses = round2(operatingExpenses.reduce((s, r) => s + r.amount, 0));
  const netIncome = round2(grossProfit - totalOperatingExpenses);

  const assets = trialBalance
    .filter((r) => r.accountType === 'ASSET')
    .map((r) => ({ code: r.accountCode, name: r.accountName, subType: r.subType, amount: r.netBalance }));

  const liabilities = trialBalance
    .filter((r) => r.accountType === 'LIABILITY')
    .map((r) => ({ code: r.accountCode, name: r.accountName, subType: r.subType, amount: r.netBalance }));

  const equity = trialBalance
    .filter((r) => r.accountType === 'EQUITY')
    .map((r) => ({ code: r.accountCode, name: r.accountName, subType: r.subType, amount: r.netBalance }));

  const totalAssets = round2(assets.reduce((s, r) => s + r.amount, 0));
  const totalLiabilities = round2(liabilities.reduce((s, r) => s + r.amount, 0));
  const totalEquityBeforeCurrentNet = round2(equity.reduce((s, r) => s + r.amount, 0));
  const totalLiabilitiesAndEquity = round2(
    totalLiabilities + totalEquityBeforeCurrentNet + netIncome
  );
  const balanceSheetDiff = round2(totalAssets - totalLiabilitiesAndEquity);

  // Cash flow summary
  const endingCashBalance = round2(
    trialBalance.filter((r) => r.isBankOrCash === 1).reduce((s, r) => s + r.netBalance, 0)
  );
  const fixedAssets = round2(
    assets.filter((a) => a.subType === 'FIXED_ASSET').reduce((s, a) => s + a.amount, 0)
  );
  const financingInflow = round2(
    equity.reduce((s, e) => s + e.amount, 0) +
      liabilities.filter((l) => l.subType === 'LONG_TERM').reduce((s, l) => s + l.amount, 0)
  );
  const investingCashFlow = round2(-fixedAssets);
  const operatingCashFlow = round2(endingCashBalance - investingCashFlow - financingInflow);

  // Financial Ratios
  const currentAssets = round2(
    assets.filter((a) => a.subType !== 'FIXED_ASSET').reduce((s, a) => s + a.amount, 0)
  );
  const inventoryVal = round2(
    assets.filter((a) => a.subType === 'INVENTORY').reduce((s, a) => s + a.amount, 0)
  );
  const currentLiabilities = round2(
    liabilities.filter((l) => l.subType !== 'LONG_TERM').reduce((s, l) => s + l.amount, 0)
  );
  const totalEquity = round2(totalEquityBeforeCurrentNet + netIncome);

  const safeDiv = (num: number, den: number) => (Math.abs(den) < 0.01 ? 0 : round2(num / den));

  return {
    scopeLabel: options.scopeLabel,
    currency: options.currency || 'NPR',
    trialBalance: trialBalance.map(({ subType: _s, isBankOrCash: _b, ...rest }) => rest),
    totalTrialDebit,
    totalTrialCredit,
    isBalanced: Math.abs(totalTrialDebit - totalTrialCredit) < 0.01,
    profitAndLoss: {
      revenues,
      cogs,
      operatingExpenses,
      totalRevenue,
      totalCogs,
      grossProfit,
      totalOperatingExpenses,
      netIncome,
    },
    balanceSheet: {
      assets,
      liabilities,
      equity,
      totalAssets,
      totalLiabilities,
      totalEquityBeforeCurrentNet,
      currentNetIncome: netIncome,
      totalLiabilitiesAndEquity,
      balanceSheetDiff,
    },
    cashFlow: {
      operatingCashFlow,
      investingCashFlow,
      financingCashFlow: financingInflow,
      netCashChange: endingCashBalance,
      endingCashBalance,
    },
    ratios: {
      currentRatio: safeDiv(currentAssets, currentLiabilities),
      quickRatio: safeDiv(currentAssets - inventoryVal, currentLiabilities),
      grossMarginPct: safeDiv(grossProfit * 100, totalRevenue),
      netMarginPct: safeDiv(netIncome * 100, totalRevenue),
      debtToEquity: safeDiv(totalLiabilities, totalEquity),
      inventoryTurnover: safeDiv(totalCogs, inventoryVal),
      returnOnAssetsPct: safeDiv(netIncome * 100, totalAssets),
    },
  };
}
