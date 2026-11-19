import bcrypt from 'bcryptjs';
import { db, withTransaction } from './db.ts';
import { createInvoiceInTx, getAccountByCode, postJournalEntryInTx, recordPaymentInTx } from './accounting.ts';
import { receiveStockInTx, transferStockInTx } from './inventory.ts';

export const STANDARD_COA = [
  { code: '1000', name: 'Cash on Hand', type: 'ASSET', subType: 'CASH', sys: 1, ic: 0, bank: 1 },
  { code: '1010', name: 'Nabil Bank Operating Account', type: 'ASSET', subType: 'BANK', sys: 1, ic: 0, bank: 1 },
  { code: '1020', name: 'Global IME Reserve Account', type: 'ASSET', subType: 'BANK', sys: 0, ic: 0, bank: 1 },
  { code: '1200', name: 'Accounts Receivable', type: 'ASSET', subType: 'RECEIVABLE', sys: 1, ic: 0, bank: 0 },
  { code: '1300', name: 'Inventory Asset', type: 'ASSET', subType: 'INVENTORY', sys: 1, ic: 0, bank: 0 },
  { code: '1400', name: 'Input VAT Receivable', type: 'ASSET', subType: 'TAX_ASSET', sys: 1, ic: 0, bank: 0 },
  { code: '1500', name: 'Property, Plant & Equipment', type: 'ASSET', subType: 'FIXED_ASSET', sys: 0, ic: 0, bank: 0 },
  { code: '1900', name: 'Inter-Company Due From', type: 'ASSET', subType: 'INTERCOMPANY', sys: 1, ic: 1, bank: 0 },
  { code: '2000', name: 'Accounts Payable', type: 'LIABILITY', subType: 'PAYABLE', sys: 1, ic: 0, bank: 0 },
  { code: '2100', name: 'Output VAT Payable', type: 'LIABILITY', subType: 'TAX_LIABILITY', sys: 1, ic: 0, bank: 0 },
  { code: '2500', name: 'Long-Term Bank Term Loan', type: 'LIABILITY', subType: 'LONG_TERM', sys: 0, ic: 0, bank: 0 },
  { code: '2900', name: 'Inter-Company Due To', type: 'LIABILITY', subType: 'INTERCOMPANY', sys: 1, ic: 1, bank: 0 },
  { code: '3000', name: 'Paid-Up Share Capital', type: 'EQUITY', subType: 'CAPITAL', sys: 1, ic: 0, bank: 0 },
  { code: '3200', name: 'Retained Earnings', type: 'EQUITY', subType: 'RETAINED', sys: 1, ic: 0, bank: 0 },
  { code: '4000', name: 'Product & Vehicle Sales Revenue', type: 'REVENUE', subType: 'OPERATING', sys: 1, ic: 0, bank: 0 },
  { code: '4100', name: 'Service & Maintenance Revenue', type: 'REVENUE', subType: 'OPERATING', sys: 0, ic: 0, bank: 0 },
  { code: '5000', name: 'Cost of Goods Sold (COGS)', type: 'EXPENSE', subType: 'COGS', sys: 1, ic: 0, bank: 0 },
  { code: '6000', name: 'Salaries & Staff Benefits', type: 'EXPENSE', subType: 'OPERATING', sys: 0, ic: 0, bank: 0 },
  { code: '6100', name: 'Branch Rent & Utilities', type: 'EXPENSE', subType: 'OPERATING', sys: 0, ic: 0, bank: 0 },
  { code: '6200', name: 'General & Administrative Expense', type: 'EXPENSE', subType: 'OPERATING', sys: 1, ic: 0, bank: 0 },
  { code: '6300', name: 'Logistics & Freight Expense', type: 'EXPENSE', subType: 'OPERATING', sys: 0, ic: 0, bank: 0 },
];

export function createStandardAccountsForCompany(companyId: number): void {
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO accounts
     (company_id, code, name, account_type, sub_type, is_system, is_intercompany, is_bank_or_cash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (const a of STANDARD_COA) {
    stmt.run(companyId, a.code, a.name, a.type, a.subType, a.sys, a.ic, a.bank);
  }
}

export function seedDatabaseIfEmpty(): void {
  const existing = db.prepare('SELECT COUNT(*) AS cnt FROM companies').get() as { cnt: number };
  if (existing.cnt > 0) return;

  withTransaction(() => {
    const passHash = bcrypt.hashSync('Nextgen@2026', 10);

    // 1. Users across enterprise roles
    const insertUser = db.prepare(
      `INSERT INTO users (email, password_hash, full_name, role, default_mode) VALUES (?, ?, ?, ?, ?)`
    );
    const adminId = Number(insertUser.run('admin@nextgenerp.com', passHash, 'Aarav Shrestha', 'SUPER_ADMIN', 'advanced').lastInsertRowid);
    const cfoId = Number(insertUser.run('cfo@nextgenerp.com', passHash, 'Prativa Adhikari', 'CFO_APPROVER', 'advanced').lastInsertRowid);
    const branchMgrId = Number(insertUser.run('pokhara@nextgenerp.com', passHash, 'Bikash Gurung', 'BRANCH_MANAGER', 'advanced').lastInsertRowid);
    const accountantId = Number(insertUser.run('accounts@nextgenerp.com', passHash, 'Suman Karki', 'ACCOUNTANT', 'advanced').lastInsertRowid);
    const cashierId = Number(insertUser.run('cashier@nextgenerp.com', passHash, 'Rina Tamang', 'OPERATOR', 'simple').lastInsertRowid);

    // 2. Company 1: Himalayan Motors & Trading Pvt. Ltd.
    const c1Id = Number(
      db
        .prepare(
          `INSERT INTO companies (code, legal_name, tax_id_label, pan_vat_number, vat_rate, currency, fiscal_year_label, fiscal_start_date, fiscal_end_date, invoice_prefix, purchase_prefix, journal_prefix, address)
           VALUES ('HMT', 'Himalayan Motors & Trading Pvt. Ltd.', 'VAT/PAN', '601842915', 13.0, 'NPR', 'FY 2082/83', '2025-07-16', '2026-07-15', 'HMT-INV', 'HMT-PUR', 'HMT-JV', 'Durbar Marg, Kathmandu, Nepal')`
        )
        .run().lastInsertRowid
    );
    createStandardAccountsForCompany(c1Id);

    // Company 1 Branches
    const c1HoId = Number(
      db.prepare(`INSERT INTO branches (company_id, code, name, branch_type, city) VALUES (?, 'KTM-HO', 'Kathmandu Head Office', 'HEAD_OFFICE', 'Kathmandu')`).run(c1Id).lastInsertRowid
    );
    const c1PkrId = Number(
      db.prepare(`INSERT INTO branches (company_id, code, name, branch_type, city) VALUES (?, 'PKR-SB', 'Pokhara Sales & Service', 'SALES_BRANCH', 'Pokhara')`).run(c1Id).lastInsertRowid
    );
    const c1BrjId = Number(
      db.prepare(`INSERT INTO branches (company_id, code, name, branch_type, city) VALUES (?, 'BRJ-WH', 'Birgunj Central Depot', 'WAREHOUSE', 'Birgunj')`).run(c1Id).lastInsertRowid
    );

    // Company 1 Cost & Profit Centers
    const c1PcShowroom = Number(
      db.prepare(`INSERT INTO cost_profit_centers (company_id, code, name, kind, department) VALUES (?, 'PC-AUTO', 'EV & Auto Showroom', 'PROFIT_CENTER', 'Sales')`).run(c1Id).lastInsertRowid
    );
    const c1PcParts = Number(
      db.prepare(`INSERT INTO cost_profit_centers (company_id, code, name, kind, department) VALUES (?, 'PC-PART', 'Genuine Spare Parts', 'PROFIT_CENTER', 'After-Sales')`).run(c1Id).lastInsertRowid
    );
    const c1CcAdmin = Number(
      db.prepare(`INSERT INTO cost_profit_centers (company_id, code, name, kind, department) VALUES (?, 'CC-HO', 'Corporate Administration', 'COST_CENTER', 'Finance & HR')`).run(c1Id).lastInsertRowid
    );

    // Company 1 Warehouses & Locations
    const c1WhKtm = Number(db.prepare(`INSERT INTO warehouses (company_id, branch_id, code, name) VALUES (?, ?, 'WH-KTM', 'Kathmandu Showroom & Parts')`).run(c1Id, c1HoId).lastInsertRowid);
    const c1WhPkr = Number(db.prepare(`INSERT INTO warehouses (company_id, branch_id, code, name) VALUES (?, ?, 'WH-PKR', 'Pokhara Branch Warehouse')`).run(c1Id, c1PkrId).lastInsertRowid);
    const c1WhBrj = Number(db.prepare(`INSERT INTO warehouses (company_id, branch_id, code, name) VALUES (?, ?, 'WH-BRJ', 'Birgunj Bonded Yard')`).run(c1Id, c1BrjId).lastInsertRowid);

    const locKtmFloor = Number(db.prepare(`INSERT INTO stock_locations (warehouse_id, code, name) VALUES (?, 'SHOW-01', 'Main Showroom Floor')`).run(c1WhKtm).lastInsertRowid);
    const locKtmBin = Number(db.prepare(`INSERT INTO stock_locations (warehouse_id, code, name) VALUES (?, 'BIN-A1', 'Parts Rack A1')`).run(c1WhKtm).lastInsertRowid);
    const locPkrBay = Number(db.prepare(`INSERT INTO stock_locations (warehouse_id, code, name) VALUES (?, 'PKR-01', 'Pokhara Bay 1')`).run(c1WhPkr).lastInsertRowid);
    const locBrjYard = Number(db.prepare(`INSERT INTO stock_locations (warehouse_id, code, name) VALUES (?, 'YARD-A', 'Bonded Vehicle Yard A')`).run(c1WhBrj).lastInsertRowid);

    // Company 1 Fiscal Period Locks (Q1 locked to demonstrate enforcement)
    db.prepare(
      `INSERT INTO fiscal_period_locks (company_id, period_name, start_date, end_date, is_locked, locked_by_name, locked_at)
       VALUES (?, 'Q1 FY 2082/83 (Closed)', '2025-07-16', '2025-10-16', 1, 'Prativa Adhikari', '2025-10-20T10:00:00.000Z')`
    ).run(c1Id);
    db.prepare(
      `INSERT INTO fiscal_period_locks (company_id, period_name, start_date, end_date, is_locked)
       VALUES (?, 'Q2-Q4 FY 2082/83 (Active)', '2025-10-17', '2026-07-15', 0)`
    ).run(c1Id);

    // Company 1 Parties
    const c1Cust1 = Number(db.prepare(`INSERT INTO parties (company_id, code, name, party_type, pan_vat, phone, email, credit_limit) VALUES (?, 'CUST-001', 'Annapurna Fleet Services Pvt. Ltd.', 'CUSTOMER', '604112233', '+977-9851023411', 'procurement@annapurnafleet.np', 4500000)`).run(c1Id).lastInsertRowid);
    const c1Cust2 = Number(db.prepare(`INSERT INTO parties (company_id, code, name, party_type, pan_vat, phone, email, credit_limit) VALUES (?, 'CUST-002', 'Gandaki Tours & Mobility', 'CUSTOMER', '605998877', '+977-9846011223', 'accounts@gandakitours.np', 2500000)`).run(c1Id).lastInsertRowid);
    const c1CustWalk = Number(db.prepare(`INSERT INTO parties (company_id, code, name, party_type, pan_vat, phone, email, credit_limit) VALUES (?, 'CUST-CASH', 'Walk-in Counter Customer', 'CUSTOMER', '', '', '', 0)`).run(c1Id).lastInsertRowid);
    const c1Supp1 = Number(db.prepare(`INSERT INTO parties (company_id, code, name, party_type, pan_vat, phone, email, credit_limit) VALUES (?, 'SUPP-001', 'Pacific EV Global Exports', 'SUPPLIER', 'INT-884120', '+65-6722-9100', 'billing@pacificev.sg', 15000000)`).run(c1Id).lastInsertRowid);
    const c1SuppIc = Number(db.prepare(`INSERT INTO parties (company_id, code, name, party_type, pan_vat, phone, email, credit_limit, is_intercompany) VALUES (?, 'IC-EPM', 'Everest Precision Manufacturing Ltd. (Inter-Co)', 'SUPPLIER', '602918344', '+977-01-5542100', 'interco@everestprecision.np', 5000000, 1)`).run(c1Id).lastInsertRowid);

    // Company 1 Inventory Items (VIN+Engine, Serial, Batch, Standard)
    const itemEv = Number(db.prepare(`INSERT INTO inventory_items (company_id, sku, name, category, unit, valuation_method, tracking_type, standard_sale_price, standard_cost, reorder_level, reorder_qty) VALUES (?, 'VEH-EVX4', 'TerraVolt X4 Electric SUV', 'Vehicles', 'UNIT', 'FIFO', 'VIN_ENGINE', 3850000, 3100000, 2, 4)`).run(c1Id).lastInsertRowid);
    const itemBatt = Number(db.prepare(`INSERT INTO inventory_items (company_id, sku, name, category, unit, valuation_method, tracking_type, standard_sale_price, standard_cost, reorder_level, reorder_qty) VALUES (?, 'PRT-BATT60', '60kWh LFP Battery Module', 'EV Powertrain', 'UNIT', 'FIFO', 'SERIAL', 420000, 330000, 3, 5)`).run(c1Id).lastInsertRowid);
    const itemOil = Number(db.prepare(`INSERT INTO inventory_items (company_id, sku, name, category, unit, valuation_method, tracking_type, standard_sale_price, standard_cost, reorder_level, reorder_qty) VALUES (?, 'LUB-SYN5W30', 'Synthetic Coolant & Gear Fluid 4L', 'Consumables', 'CAN', 'WEIGHTED_AVERAGE', 'BATCH', 4800, 3100, 20, 50)`).run(c1Id).lastInsertRowid);
    const itemBrake = Number(db.prepare(`INSERT INTO inventory_items (company_id, sku, name, category, unit, valuation_method, tracking_type, standard_sale_price, standard_cost, reorder_level, reorder_qty) VALUES (?, 'PRT-BRK09', 'Ceramic Regenerative Brake Kit', 'Spare Parts', 'SET', 'WEIGHTED_AVERAGE', 'NONE', 14500, 9200, 12, 25)`).run(c1Id).lastInsertRowid);

    // Company 1 Opening Capital & Fixed Assets
    const c1Bank = getAccountByCode(c1Id, '1010');
    const c1Cash = getAccountByCode(c1Id, '1000');
    const c1InvAcct = getAccountByCode(c1Id, '1300');
    const c1Fixed = getAccountByCode(c1Id, '1500');
    const c1Cap = getAccountByCode(c1Id, '3000');
    const c1Loan = getAccountByCode(c1Id, '2500');
    const c1Sal = getAccountByCode(c1Id, '6000');
    const c1Rent = getAccountByCode(c1Id, '6100');

    // Receive initial stock lots (matches opening inventory capital)
    const lot1 = receiveStockInTx({
      companyId: c1Id, itemId: itemEv, warehouseId: c1WhKtm, locationId: locKtmFloor,
      qty: 1, unitCost: 3100000, vinNumber: 'VIN-HMT2026EV001', engineNumber: 'ENG-TVX4-88201',
      referenceType: 'OPENING_STOCK', notes: 'Opening showroom unit #1', userId: adminId, receivedAt: '2025-10-18T08:00:00.000Z',
    });
    const lot2 = receiveStockInTx({
      companyId: c1Id, itemId: itemEv, warehouseId: c1WhKtm, locationId: locKtmFloor,
      qty: 1, unitCost: 3150000, vinNumber: 'VIN-HMT2026EV002', engineNumber: 'ENG-TVX4-88202',
      referenceType: 'OPENING_STOCK', notes: 'Opening showroom unit #2', userId: adminId, receivedAt: '2025-10-19T08:00:00.000Z',
    });
    const lot3 = receiveStockInTx({
      companyId: c1Id, itemId: itemEv, warehouseId: c1WhBrj, locationId: locBrjYard,
      qty: 2, unitCost: 3120000, vinNumber: 'VIN-HMT2026EV003', engineNumber: 'ENG-TVX4-88203',
      referenceType: 'OPENING_STOCK', notes: 'Birgunj bonded yard stock', userId: adminId, receivedAt: '2025-10-20T08:00:00.000Z',
    });
    const lot4 = receiveStockInTx({
      companyId: c1Id, itemId: itemBatt, warehouseId: c1WhKtm, locationId: locKtmBin,
      qty: 4, unitCost: 330000, serialNumber: 'SN-LFP60-9001',
      referenceType: 'OPENING_STOCK', notes: 'Opening battery reserve', userId: adminId, receivedAt: '2025-10-20T09:00:00.000Z',
    });
    const lot5 = receiveStockInTx({
      companyId: c1Id, itemId: itemOil, warehouseId: c1WhPkr, locationId: locPkrBay,
      qty: 35, unitCost: 3000, batchNumber: 'BATCH-2026-A', expiryDate: '2028-06-30',
      referenceType: 'OPENING_STOCK', notes: 'Pokhara service fluid batch A', userId: adminId, receivedAt: '2025-10-20T09:30:00.000Z',
    });
    const lot6 = receiveStockInTx({
      companyId: c1Id, itemId: itemBrake, warehouseId: c1WhKtm, locationId: locKtmBin,
      qty: 8, unitCost: 9200,
      referenceType: 'OPENING_STOCK', notes: 'Opening brake kits (low stock alert test)', userId: adminId, receivedAt: '2025-10-20T10:00:00.000Z',
    });

    const openingStockTotal = lot1.totalCost + lot2.totalCost + lot3.totalCost + lot4.totalCost + lot5.totalCost + lot6.totalCost;

    postJournalEntryInTx({
      companyId: c1Id,
      entryDate: '2025-10-20',
      referenceType: 'OPENING_BALANCE',
      description: 'Opening Capital, Bank Balances, Fixed Assets & Stock Valuation',
      lines: [
        { accountId: c1Bank.id, branchId: c1HoId, debit: 8500000, credit: 0, memo: 'Opening Nabil Bank balance' },
        { accountId: c1Cash.id, branchId: c1HoId, debit: 450000, credit: 0, memo: 'Opening HO Petty Cash' },
        { accountId: c1Fixed.id, branchId: c1HoId, debit: 4200000, credit: 0, memo: 'Showroom fixtures & EV lifts' },
        { accountId: c1InvAcct.id, branchId: c1HoId, debit: openingStockTotal, credit: 0, memo: 'Opening Inventory Valuation' },
        { accountId: c1Loan.id, branchId: c1HoId, debit: 0, credit: 5000000, memo: 'Working Capital Term Loan' },
        { accountId: c1Cap.id, branchId: c1HoId, debit: 0, credit: 8500000 + 450000 + 4200000 + openingStockTotal - 5000000, memo: 'Paid-Up Share Capital' },
      ],
      createdBy: adminId,
      createdByName: 'Aarav Shrestha',
      createdByRole: 'SUPER_ADMIN',
      forceStatus: 'POSTED',
    });

    // Inter-branch transfer: move 1 battery from KTM to PKR
    transferStockInTx({
      companyId: c1Id,
      itemId: itemBatt,
      fromWarehouseId: c1WhKtm,
      toWarehouseId: c1WhPkr,
      toLocationId: locPkrBay,
      qty: 1,
      notes: 'Replenish Pokhara service bay',
      userId: adminId,
    });

    // Company 1 Sales Invoices & Payments
    const inv1 = createInvoiceInTx({
      companyId: c1Id, branchId: c1HoId, invoiceType: 'SALES', invoiceDate: '2026-01-12', dueDate: '2026-02-11',
      partyId: c1Cust1, applyVat: true, profitCenterId: c1PcShowroom,
      notes: 'Fleet EV delivery with warranty registration',
      lines: [{ itemId: itemEv, warehouseId: c1WhKtm, description: 'TerraVolt X4 Electric SUV (VIN-HMT2026EV001)', qty: 1, unitPrice: 3850000 }],
      userId: adminId, userName: 'Aarav Shrestha', userRole: 'SUPER_ADMIN',
    });
    recordPaymentInTx({
      companyId: c1Id, branchId: c1HoId, paymentType: 'RECEIPT', paymentDate: '2026-01-20',
      partyId: c1Cust1, invoiceId: inv1.invoiceId, bankAccountId: c1Bank.id, amount: 3000000,
      method: 'RTGS', reference: 'RTGS-99812', userId: accountantId, userName: 'Suman Karki', userRole: 'ACCOUNTANT',
    });

    createInvoiceInTx({
      companyId: c1Id, branchId: c1PkrId, invoiceType: 'SALES', invoiceDate: '2026-02-05', dueDate: '2026-03-07',
      partyId: c1Cust2, applyVat: true, profitCenterId: c1PcParts, paidImmediately: true, bankAccountId: c1Bank.id,
      notes: 'Pokhara branch battery & coolant replacement',
      lines: [
        { itemId: itemBatt, warehouseId: c1WhPkr, description: '60kWh LFP Battery Module', qty: 1, unitPrice: 420000 },
        { itemId: itemOil, warehouseId: c1WhPkr, description: 'Synthetic Coolant & Gear Fluid 4L', qty: 10, unitPrice: 4800 },
      ],
      userId: branchMgrId, userName: 'Bikash Gurung', userRole: 'BRANCH_MANAGER',
    });

    createInvoiceInTx({
      companyId: c1Id, branchId: c1HoId, invoiceType: 'SALES', invoiceDate: '2026-02-14', dueDate: '2026-02-14',
      partyId: c1CustWalk, applyVat: true, profitCenterId: c1PcParts, paidImmediately: true, bankAccountId: c1Cash.id,
      notes: 'Counter cash sale - brake kits',
      lines: [{ itemId: itemBrake, warehouseId: c1WhKtm, description: 'Ceramic Regenerative Brake Kit', qty: 3, unitPrice: 14500 }],
      userId: cashierId, userName: 'Rina Tamang', userRole: 'OPERATOR',
    });

    // Company 1 Purchase from external supplier (adds second batch at higher price to demonstrate Weighted Average)
    createInvoiceInTx({
      companyId: c1Id, branchId: c1PkrId, invoiceType: 'PURCHASE', invoiceDate: '2026-02-10', dueDate: '2026-03-12',
      partyId: c1Supp1, applyVat: true, costCenterId: c1CcAdmin,
      notes: 'Restock synthetic fluid Batch B',
      lines: [{ itemId: itemOil, warehouseId: c1WhPkr, description: 'Synthetic Coolant & Gear Fluid 4L', qty: 20, unitPrice: 3300, batchNumber: 'BATCH-2026-B', expiryDate: '2028-12-31' }],
      userId: accountantId, userName: 'Suman Karki', userRole: 'ACCOUNTANT',
    });

    // Company 1 Inter-Company Purchase from Company 2 (Everest Precision Manufacturing) - NPR 600,000 + VAT
    createInvoiceInTx({
      companyId: c1Id, branchId: c1HoId, invoiceType: 'PURCHASE', invoiceDate: '2026-02-18', dueDate: '2026-03-20',
      partyId: c1SuppIc, applyVat: false, costCenterId: c1CcAdmin,
      notes: 'Inter-company procurement of precision chassis brackets',
      lines: [{ description: 'Precision CNC Chassis Assembly Kits (Inter-Company)', qty: 10, unitPrice: 60000 }],
      userId: accountantId, userName: 'Suman Karki', userRole: 'ACCOUNTANT',
    });

    // Operating expenses across branches
    postJournalEntryInTx({
      companyId: c1Id, entryDate: '2026-02-28', referenceType: 'EXPENSE',
      description: 'Monthly Branch Salaries & Showroom Rent (Feb 2026)',
      lines: [
        { accountId: c1Sal.id, branchId: c1HoId, costCenterId: c1CcAdmin, debit: 340000, credit: 0, memo: 'Kathmandu HO payroll' },
        { accountId: c1Sal.id, branchId: c1PkrId, costCenterId: c1CcAdmin, debit: 185000, credit: 0, memo: 'Pokhara branch payroll' },
        { accountId: c1Rent.id, branchId: c1HoId, costCenterId: c1CcAdmin, debit: 160000, credit: 0, memo: 'Durbar Marg showroom lease' },
        { accountId: c1Rent.id, branchId: c1PkrId, costCenterId: c1CcAdmin, debit: 75000, credit: 0, memo: 'Pokhara service bay rent' },
        { accountId: c1Bank.id, branchId: c1HoId, debit: 0, credit: 760000, memo: 'Bank transfer for payroll & rent' },
      ],
      createdBy: accountantId, createdByName: 'Suman Karki', createdByRole: 'ACCOUNTANT', forceStatus: 'POSTED',
    });

    // One PENDING_APPROVAL high-value manual journal by Accountant (to demonstrate SoD & Approval Queue!)
    postJournalEntryInTx({
      companyId: c1Id, entryDate: '2026-03-02', referenceType: 'MANUAL',
      description: 'Proposed Birgunj Yard Expansion CapEx Provision (Pending CFO Approval)',
      lines: [
        { accountId: c1Fixed.id, branchId: c1BrjId, costCenterId: c1CcAdmin, debit: 650000, credit: 0, memo: 'Yard paving & EV fast charger' },
        { accountId: c1Bank.id, branchId: c1BrjId, debit: 0, credit: 650000, memo: 'Proposed disbursement from Nabil Bank' },
      ],
      createdBy: accountantId, createdByName: 'Suman Karki', createdByRole: 'ACCOUNTANT',
    });

    // Bank statement lines for Company 1 Bank Reconciliation
    db.prepare(
      `INSERT INTO bank_statement_lines (company_id, bank_account_id, statement_date, description, reference, amount, is_reconciled)
       VALUES (?, ?, '2026-01-20', 'RTGS Credit - Annapurna Fleet Services', 'RTGS-99812', 3000000, 1)`
    ).run(c1Id, c1Bank.id);
    db.prepare(
      `INSERT INTO bank_statement_lines (company_id, bank_account_id, statement_date, description, reference, amount, is_reconciled)
       VALUES (?, ?, '2026-02-05', 'ConnectIPS Settlement - Gandaki Tours', 'CIPS-44210', 528840, 0)`
    ).run(c1Id, c1Bank.id);
    db.prepare(
      `INSERT INTO bank_statement_lines (company_id, bank_account_id, statement_date, description, reference, amount, is_reconciled)
       VALUES (?, ?, '2026-02-28', 'Bulk Payroll & Lease Debit', 'PAY-FEB26', -760000, 0)`
    ).run(c1Id, c1Bank.id);

    // Budgets for Company 1
    db.prepare(`INSERT INTO budgets (company_id, branch_id, cost_center_id, account_id, fiscal_year_label, budget_amount) VALUES (?, ?, ?, ?, 'FY 2082/83', 12000000)`).run(c1Id, c1HoId, c1PcShowroom, getAccountByCode(c1Id, '4000').id);
    db.prepare(`INSERT INTO budgets (company_id, branch_id, cost_center_id, account_id, fiscal_year_label, budget_amount) VALUES (?, ?, ?, ?, 'FY 2082/83', 2400000)`).run(c1Id, c1HoId, c1CcAdmin, c1Sal.id);
    db.prepare(`INSERT INTO budgets (company_id, branch_id, cost_center_id, account_id, fiscal_year_label, budget_amount) VALUES (?, ?, ?, ?, 'FY 2082/83', 1200000)`).run(c1Id, c1HoId, c1CcAdmin, c1Rent.id);

    // 3. Company 2: Everest Precision Manufacturing Ltd.
    const c2Id = Number(
      db
        .prepare(
          `INSERT INTO companies (code, legal_name, tax_id_label, pan_vat_number, vat_rate, currency, fiscal_year_label, fiscal_start_date, fiscal_end_date, invoice_prefix, purchase_prefix, journal_prefix, address)
           VALUES ('EPM', 'Everest Precision Manufacturing Ltd.', 'VAT/PAN', '602918344', 13.0, 'NPR', 'FY 2082/83', '2025-07-16', '2026-07-15', 'EPM-INV', 'EPM-PUR', 'EPM-JV', 'Patan Industrial Estate, Lalitpur, Nepal')`
        )
        .run().lastInsertRowid
    );
    createStandardAccountsForCompany(c2Id);

    const c2HoId = Number(db.prepare(`INSERT INTO branches (company_id, code, name, branch_type, city) VALUES (?, 'LTP-HO', 'Lalitpur Plant & HO', 'HEAD_OFFICE', 'Lalitpur')`).run(c2Id).lastInsertRowid);
    const c2BhwId = Number(db.prepare(`INSERT INTO branches (company_id, code, name, branch_type, city) VALUES (?, 'BHW-REG', 'Bhairahawa Industrial Hub', 'REGIONAL_OFFICE', 'Bhairahawa')`).run(c2Id).lastInsertRowid);

    const c2PcMfg = Number(db.prepare(`INSERT INTO cost_profit_centers (company_id, code, name, kind, department) VALUES (?, 'PC-CNC', 'CNC Precision Fabrication', 'PROFIT_CENTER', 'Production')`).run(c2Id).lastInsertRowid);
    const c2CcPlant = Number(db.prepare(`INSERT INTO cost_profit_centers (company_id, code, name, kind, department) VALUES (?, 'CC-PLT', 'Plant Operations', 'COST_CENTER', 'Manufacturing')`).run(c2Id).lastInsertRowid);

    const c2WhLtp = Number(db.prepare(`INSERT INTO warehouses (company_id, branch_id, code, name) VALUES (?, ?, 'WH-LTP', 'Lalitpur Finished Goods Store')`).run(c2Id, c2HoId).lastInsertRowid);
    const c2WhBhw = Number(db.prepare(`INSERT INTO warehouses (company_id, branch_id, code, name) VALUES (?, ?, 'WH-BHW', 'Bhairahawa Raw Material Depot')`).run(c2Id, c2BhwId).lastInsertRowid);
    const locLtpFg = Number(db.prepare(`INSERT INTO stock_locations (warehouse_id, code, name) VALUES (?, 'FG-01', 'Finished Goods Bay 1')`).run(c2WhLtp).lastInsertRowid);
    db.prepare(`INSERT INTO stock_locations (warehouse_id, code, name) VALUES (?, 'RM-01', 'Alloy Steel Rack 1')`).run(c2WhBhw);

    db.prepare(
      `INSERT INTO fiscal_period_locks (company_id, period_name, start_date, end_date, is_locked, locked_by_name, locked_at)
       VALUES (?, 'Q1 FY 2082/83 (Closed)', '2025-07-16', '2025-10-16', 1, 'Prativa Adhikari', '2025-10-20T10:00:00.000Z')`
    ).run(c2Id);

    const c2CustIc = Number(db.prepare(`INSERT INTO parties (company_id, code, name, party_type, pan_vat, phone, email, credit_limit, is_intercompany) VALUES (?, 'IC-HMT', 'Himalayan Motors & Trading Pvt. Ltd. (Inter-Co)', 'CUSTOMER', '601842915', '+977-01-4221100', 'interco@himalayanmotors.np', 6000000, 1)`).run(c2Id).lastInsertRowid);
    const c2CustExt = Number(db.prepare(`INSERT INTO parties (company_id, code, name, party_type, pan_vat, phone, email, credit_limit) VALUES (?, 'CUST-E01', 'Sagarmatha Hydro Infrastructure Ltd.', 'CUSTOMER', '607778899', '+977-9851190022', 'orders@sagarmathahydro.np', 8000000)`).run(c2Id).lastInsertRowid);
    db.prepare(`INSERT INTO parties (company_id, code, name, party_type, pan_vat, phone, email, credit_limit) VALUES (?, 'SUPP-E01', 'Biratnagar Alloy & Foundry Co.', 'SUPPLIER', '603331122', '+977-021-521900', 'sales@biratalloy.np', 4000000)`).run(c2Id);

    const c2ItemChassis = Number(db.prepare(`INSERT INTO inventory_items (company_id, sku, name, category, unit, valuation_method, tracking_type, standard_sale_price, standard_cost, reorder_level, reorder_qty) VALUES (?, 'CNC-CHS01', 'Precision CNC Chassis Bracket Kit', 'Fabricated Parts', 'KIT', 'FIFO', 'BATCH', 60000, 38000, 10, 20)`).run(c2Id).lastInsertRowid);
    const c2ItemTurbine = Number(db.prepare(`INSERT INTO inventory_items (company_id, sku, name, category, unit, valuation_method, tracking_type, standard_sale_price, standard_cost, reorder_level, reorder_qty) VALUES (?, 'HYD-VLV05', 'High-Pressure Hydro Control Valve', 'Hydro Hardware', 'UNIT', 'FIFO', 'SERIAL', 295000, 195000, 4, 8)`).run(c2Id).lastInsertRowid);

    const c2Lot1 = receiveStockInTx({
      companyId: c2Id, itemId: c2ItemChassis, warehouseId: c2WhLtp, locationId: locLtpFg,
      qty: 25, unitCost: 38000, batchNumber: 'MFG-2026-01', referenceType: 'OPENING_STOCK',
      notes: 'Manufactured batch #1', userId: adminId, receivedAt: '2025-10-20T08:00:00.000Z',
    });
    const c2Lot2 = receiveStockInTx({
      companyId: c2Id, itemId: c2ItemTurbine, warehouseId: c2WhLtp, locationId: locLtpFg,
      qty: 8, unitCost: 195000, serialNumber: 'SN-HYD-5001', referenceType: 'OPENING_STOCK',
      notes: 'Hydro valves lot', userId: adminId, receivedAt: '2025-10-20T09:00:00.000Z',
    });

    const c2Bank = getAccountByCode(c2Id, '1010');
    const c2InvAcct = getAccountByCode(c2Id, '1300');
    const c2Fixed = getAccountByCode(c2Id, '1500');
    const c2Cap = getAccountByCode(c2Id, '3000');

    postJournalEntryInTx({
      companyId: c2Id, entryDate: '2025-10-20', referenceType: 'OPENING_BALANCE',
      description: 'Opening Capital, CNC Plant Assets & Finished Goods Inventory',
      lines: [
        { accountId: c2Bank.id, branchId: c2HoId, debit: 5200000, credit: 0, memo: 'Opening Bank Balance' },
        { accountId: c2Fixed.id, branchId: c2HoId, debit: 6800000, credit: 0, memo: '5-Axis CNC Machinery' },
        { accountId: c2InvAcct.id, branchId: c2HoId, debit: c2Lot1.totalCost + c2Lot2.totalCost, credit: 0, memo: 'Opening Inventory' },
        { accountId: c2Cap.id, branchId: c2HoId, debit: 0, credit: 5200000 + 6800000 + c2Lot1.totalCost + c2Lot2.totalCost, memo: 'Share Capital' },
      ],
      createdBy: adminId, createdByName: 'Aarav Shrestha', createdByRole: 'SUPER_ADMIN', forceStatus: 'POSTED',
    });

    // External sale from Company 2
    createInvoiceInTx({
      companyId: c2Id, branchId: c2HoId, invoiceType: 'SALES', invoiceDate: '2026-01-25', dueDate: '2026-02-24',
      partyId: c2CustExt, applyVat: true, profitCenterId: c2PcMfg, paidImmediately: true, bankAccountId: c2Bank.id,
      notes: 'Hydro control valves delivery',
      lines: [{ itemId: c2ItemTurbine, warehouseId: c2WhLtp, description: 'High-Pressure Hydro Control Valve', qty: 4, unitPrice: 295000 }],
      userId: adminId, userName: 'Aarav Shrestha', userRole: 'SUPER_ADMIN',
    });

    // Matching Inter-Company Sale from Company 2 -> Company 1 (NPR 600,000)
    createInvoiceInTx({
      companyId: c2Id, branchId: c2HoId, invoiceType: 'SALES', invoiceDate: '2026-02-18', dueDate: '2026-03-20',
      partyId: c2CustIc, applyVat: false, profitCenterId: c2PcMfg,
      notes: 'Inter-company supply to Himalayan Motors & Trading',
      lines: [{ itemId: c2ItemChassis, warehouseId: c2WhLtp, description: 'Precision CNC Chassis Bracket Kit', qty: 10, unitPrice: 60000 }],
      userId: adminId, userName: 'Aarav Shrestha', userRole: 'SUPER_ADMIN',
    });

    // Consolidation Elimination Entry (eliminates NPR 600,000 inter-company revenue/expense & AR/AP when viewing Consolidated!)
    postJournalEntryInTx({
      companyId: c2Id, entryDate: '2026-02-28', referenceType: 'ELIMINATION',
      description: 'Group Consolidation Elimination: EPM-HMT Inter-Company Chassis Supply (600,000)',
      isIntercompany: true, isElimination: true,
      lines: [
        { accountId: getAccountByCode(c2Id, '4000').id, branchId: c2HoId, debit: 600000, credit: 0, memo: 'Eliminate inter-company sales revenue' },
        { accountId: getAccountByCode(c2Id, '6200').id, branchId: c2HoId, debit: 0, credit: 600000, memo: 'Eliminate inter-company purchase expense' },
        { accountId: getAccountByCode(c2Id, '2900').id, branchId: c2HoId, debit: 600000, credit: 0, memo: 'Eliminate inter-company Due To' },
        { accountId: getAccountByCode(c2Id, '1900').id, branchId: c2HoId, debit: 0, credit: 600000, memo: 'Eliminate inter-company Due From' },
      ],
      createdBy: cfoId, createdByName: 'Prativa Adhikari', createdByRole: 'CFO_APPROVER', forceStatus: 'POSTED',
    });

    // Company 2 operating expense
    postJournalEntryInTx({
      companyId: c2Id, entryDate: '2026-02-28', referenceType: 'EXPENSE',
      description: 'Plant Payroll & Power Expense (Feb 2026)',
      lines: [
        { accountId: getAccountByCode(c2Id, '6000').id, branchId: c2HoId, costCenterId: c2CcPlant, debit: 260000, credit: 0, memo: 'Lalitpur plant payroll' },
        { accountId: getAccountByCode(c2Id, '6100').id, branchId: c2BhwId, costCenterId: c2CcPlant, debit: 95000, credit: 0, memo: 'Bhairahawa hub industrial power' },
        { accountId: c2Bank.id, branchId: c2HoId, debit: 0, credit: 355000, memo: 'Bank payout' },
      ],
      createdBy: cfoId, createdByName: 'Prativa Adhikari', createdByRole: 'CFO_APPROVER', forceStatus: 'POSTED',
    });

    // User Permissions (Company & Branch RBAC isolation!)
    const addPerm = db.prepare('INSERT OR IGNORE INTO user_permissions (user_id, company_id, branch_id) VALUES (?, ?, ?)');
    // Admin & CFO: full access to both companies (NULL branch = all branches in company)
    addPerm.run(adminId, c1Id, null);
    addPerm.run(adminId, c2Id, null);
    addPerm.run(cfoId, c1Id, null);
    addPerm.run(cfoId, c2Id, null);
    // Accountant: access to Company 1 all branches + Company 2 all branches
    addPerm.run(accountantId, c1Id, null);
    addPerm.run(accountantId, c2Id, null);
    // Branch Manager: strictly restricted to Company 1, Pokhara Branch!
    addPerm.run(branchMgrId, c1Id, c1PkrId);
    // Cashier (Simple Mode Operator): strictly restricted to Company 1, Kathmandu HO!
    addPerm.run(cashierId, c1Id, c1HoId);
  });
}
