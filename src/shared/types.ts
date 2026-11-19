export type UserRole =
  | 'SUPER_ADMIN'
  | 'CFO_APPROVER'
  | 'BRANCH_MANAGER'
  | 'ACCOUNTANT'
  | 'OPERATOR';

export type ErpUiMode = 'simple' | 'advanced';

export type BranchType =
  | 'HEAD_OFFICE'
  | 'REGIONAL_OFFICE'
  | 'SALES_BRANCH'
  | 'SERVICE_BRANCH'
  | 'WAREHOUSE';

export type AccountType = 'ASSET' | 'LIABILITY' | 'EQUITY' | 'REVENUE' | 'EXPENSE';

export type ValuationMethod = 'FIFO' | 'WEIGHTED_AVERAGE';

export type TrackingType = 'NONE' | 'BATCH' | 'SERIAL' | 'VIN_ENGINE';

export type JournalStatus = 'DRAFT' | 'PENDING_APPROVAL' | 'POSTED' | 'REJECTED';

export interface AuthUser {
  id: number;
  email: string;
  fullName: string;
  role: UserRole;
  defaultMode: ErpUiMode;
  allowedCompanyIds: number[];
  allowedBranchIds: number[];
}

export interface Company {
  id: number;
  code: string;
  legalName: string;
  taxIdLabel: string;
  panVatNumber: string;
  vatRate: number;
  currency: string;
  fiscalYearLabel: string;
  fiscalStartDate: string;
  fiscalEndDate: string;
  invoicePrefix: string;
  nextInvoiceSeq: number;
  purchasePrefix: string;
  nextPurchaseSeq: number;
  journalPrefix: string;
  nextJournalSeq: number;
  address: string;
  isActive: number;
  createdAt: string;
}

export interface Branch {
  id: number;
  companyId: number;
  code: string;
  name: string;
  branchType: BranchType;
  city: string;
  isActive: number;
}

export interface CostProfitCenter {
  id: number;
  companyId: number;
  code: string;
  name: string;
  kind: 'COST_CENTER' | 'PROFIT_CENTER';
  department: string;
}

export interface Account {
  id: number;
  companyId: number;
  code: string;
  name: string;
  accountType: AccountType;
  subType: string;
  isSystem: number;
  isIntercompany: number;
  isBankOrCash: number;
  balance?: number;
}

export interface FiscalPeriodLock {
  id: number;
  companyId: number;
  periodName: string;
  startDate: string;
  endDate: string;
  isLocked: number;
  lockedByName: string | null;
  lockedAt: string | null;
}

export interface Party {
  id: number;
  companyId: number;
  code: string;
  name: string;
  partyType: 'CUSTOMER' | 'SUPPLIER' | 'BOTH';
  panVat: string;
  phone: string;
  email: string;
  creditLimit: number;
  isIntercompany: number;
  receivableBalance?: number;
  payableBalance?: number;
}

export interface Warehouse {
  id: number;
  companyId: number;
  branchId: number;
  code: string;
  name: string;
  branchName?: string;
  locations?: StockLocation[];
}

export interface StockLocation {
  id: number;
  warehouseId: number;
  code: string;
  name: string;
}

export interface InventoryItem {
  id: number;
  companyId: number;
  sku: string;
  name: string;
  category: string;
  unit: string;
  valuationMethod: ValuationMethod;
  trackingType: TrackingType;
  standardSalePrice: number;
  standardCost: number;
  reorderLevel: number;
  reorderQty: number;
  onHandQty?: number;
  valuationAmount?: number;
  weightedAvgCost?: number;
}

export interface StockLot {
  id: number;
  companyId: number;
  itemId: number;
  itemSku?: string;
  itemName?: string;
  warehouseId: number;
  warehouseName?: string;
  locationId: number | null;
  locationCode?: string | null;
  branchId: number;
  branchName?: string;
  batchNumber: string | null;
  serialNumber: string | null;
  vinNumber: string | null;
  engineNumber: string | null;
  expiryDate: string | null;
  qtyInitial: number;
  qtyRemaining: number;
  unitCost: number;
  receivedAt: string;
}

export interface JournalLineInput {
  accountId: number;
  branchId: number;
  costCenterId?: number | null;
  profitCenterId?: number | null;
  partyId?: number | null;
  debit: number;
  credit: number;
  memo?: string;
}

export interface JournalEntry {
  id: number;
  companyId: number;
  entryNumber: string;
  entryDate: string;
  referenceType: string;
  referenceId: number | null;
  description: string;
  status: JournalStatus;
  isIntercompany: number;
  isElimination: number;
  totalAmount: number;
  createdBy: number;
  createdByName?: string;
  approvedBy: number | null;
  approvedByName?: string | null;
  createdAt: string;
  lines?: Array<{
    id: number;
    accountId: number;
    accountCode: string;
    accountName: string;
    accountType: AccountType;
    branchId: number;
    branchName: string;
    costCenterName: string | null;
    profitCenterName: string | null;
    debit: number;
    credit: number;
    memo: string;
  }>;
}

export interface InvoiceRecord {
  id: number;
  companyId: number;
  branchId: number;
  branchName?: string;
  invoiceType: 'SALES' | 'PURCHASE';
  invoiceNumber: string;
  invoiceDate: string;
  dueDate: string;
  partyId: number;
  partyName?: string;
  subtotal: number;
  vatAmount: number;
  totalAmount: number;
  paidAmount: number;
  balanceDue: number;
  status: 'OPEN' | 'PARTIAL' | 'PAID';
  isIntercompany: number;
  notes: string;
  createdByName?: string;
}

export interface BankStatementLine {
  id: number;
  companyId: number;
  bankAccountId: number;
  statementDate: string;
  description: string;
  reference: string;
  amount: number;
  isReconciled: number;
  matchedJournalEntryId: number | null;
}

export interface BudgetRow {
  id: number;
  companyId: number;
  branchId: number | null;
  branchName?: string | null;
  costCenterId: number | null;
  costCenterName?: string | null;
  accountId: number;
  accountCode?: string;
  accountName?: string;
  accountType?: AccountType;
  fiscalYearLabel: string;
  budgetAmount: number;
  actualAmount?: number;
  variance?: number;
  utilizationPct?: number;
}

export interface AuditLogRow {
  id: number;
  companyId: number | null;
  branchId: number | null;
  userId: number | null;
  userName: string;
  userRole: string;
  action: string;
  entityType: string;
  entityId: string;
  summary: string;
  createdAt: string;
}

export interface VerificationCheck {
  id: string;
  category: string;
  name: string;
  passed: boolean;
  details: string;
  durationMs: number;
}

export interface ModuleChecklistItem {
  module: string;
  capability: string;
  status: 'IMPLEMENTED' | 'PARTIAL' | 'PENDING';
  notes: string;
}
