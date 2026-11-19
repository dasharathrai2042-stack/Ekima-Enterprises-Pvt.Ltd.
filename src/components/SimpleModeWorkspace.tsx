import React, { useMemo, useState } from 'react';
import {
  ArrowDownLeft,
  ArrowUpRight,
  Package,
  Plus,
  Receipt,
  RefreshCw,
  ShoppingCart,
  Wallet,
} from 'lucide-react';
import { apiRequest, makeIdempotencyKey } from '../lib/api.ts';
import { formatMoney, formatQty } from '../lib/format.ts';
import type {
  Account,
  Branch,
  Company,
  InventoryItem,
  InvoiceRecord,
  Party,
  Warehouse,
} from '../shared/types.ts';

interface SimpleModeProps {
  company: Company;
  branches: Branch[];
  selectedBranchId: number | null;
  accounts: Account[];
  parties: Party[];
  items: InventoryItem[];
  warehouses: Warehouse[];
  invoices: InvoiceRecord[];
  onRefresh: () => Promise<void>;
  onSwitchToAdvanced: () => void;
}

type QuickPanel = 'none' | 'sale' | 'purchase' | 'payment' | 'expense';

export const SimpleModeWorkspace: React.FC<SimpleModeProps> = ({
  company,
  branches,
  selectedBranchId,
  accounts,
  parties,
  items,
  warehouses,
  invoices,
  onRefresh,
  onSwitchToAdvanced,
}) => {
  const [panel, setPanel] = useState<QuickPanel>('none');
  const [tab, setTab] = useState<'transactions' | 'khata' | 'stock'>('transactions');
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const defaultBranchId = selectedBranchId || branches[0]?.id || 0;
  const bankCashAccounts = useMemo(() => accounts.filter((a) => a.isBankOrCash === 1), [accounts]);
  const expenseAccounts = useMemo(
    () => accounts.filter((a) => a.accountType === 'EXPENSE' && a.subType !== 'COGS'),
    [accounts]
  );

  // Quick Sale / Purchase form state
  const [partyId, setPartyId] = useState<number>(parties[0]?.id || 0);
  const [branchId, setBranchId] = useState<number>(defaultBranchId);
  const [itemId, setItemId] = useState<number>(items[0]?.id || 0);
  const [warehouseId, setWarehouseId] = useState<number>(warehouses[0]?.id || 0);
  const [qty, setQty] = useState<number>(1);
  const [unitPrice, setUnitPrice] = useState<number>(items[0]?.standardSalePrice || 0);
  const [paidNow, setPaidNow] = useState<boolean>(true);
  const [applyVat, setApplyVat] = useState<boolean>(true);
  const [bankAccountId, setBankAccountId] = useState<number>(bankCashAccounts[0]?.id || 0);
  const [notes, setNotes] = useState('');

  // Quick Payment / Expense state
  const [payType, setPayType] = useState<'RECEIPT' | 'PAYMENT'>('RECEIPT');
  const [payAmount, setPayAmount] = useState<string>('');
  const [expenseAcctId, setExpenseAcctId] = useState<number>(expenseAccounts[0]?.id || 0);
  const [expenseDesc, setExpenseDesc] = useState<string>('');

  const totals = useMemo(() => {
    const cashBank = bankCashAccounts.reduce((s, a) => s + (a.balance || 0), 0);
    const toReceive = invoices
      .filter((i) => i.invoiceType === 'SALES')
      .reduce((s, i) => s + Number(i.balanceDue || 0), 0);
    const toPay = invoices
      .filter((i) => i.invoiceType === 'PURCHASE')
      .reduce((s, i) => s + Number(i.balanceDue || 0), 0);
    const totalSales = invoices
      .filter((i) => i.invoiceType === 'SALES')
      .reduce((s, i) => s + Number(i.totalAmount || 0), 0);
    const lowStock = items.filter((it) => (it.onHandQty || 0) <= it.reorderLevel).length;
    return { cashBank, toReceive, toPay, totalSales, lowStock };
  }, [bankCashAccounts, invoices, items]);

  const openPanel = (target: QuickPanel) => {
    setFeedback(null);
    setPanel(target);
    setBranchId(defaultBranchId);
    setBankAccountId(bankCashAccounts[0]?.id || 0);
    if (target === 'sale') {
      const cust = parties.find((p) => p.partyType !== 'SUPPLIER') || parties[0];
      setPartyId(cust?.id || 0);
      const it = items[0];
      setItemId(it?.id || 0);
      setUnitPrice(it?.standardSalePrice || 0);
      setWarehouseId(warehouses[0]?.id || 0);
      setQty(1);
    } else if (target === 'purchase') {
      const supp = parties.find((p) => p.partyType !== 'CUSTOMER') || parties[0];
      setPartyId(supp?.id || 0);
      const it = items[0];
      setItemId(it?.id || 0);
      setUnitPrice(it?.standardCost || 0);
      setWarehouseId(warehouses[0]?.id || 0);
      setQty(1);
    } else if (target === 'expense') {
      setExpenseAcctId(expenseAccounts[0]?.id || 0);
      setPayAmount('');
      setExpenseDesc('');
    } else if (target === 'payment') {
      setPartyId(parties[0]?.id || 0);
      setPayAmount('');
    }
  };

  const handleItemChange = (newItemId: number) => {
    setItemId(newItemId);
    const found = items.find((i) => i.id === newItemId);
    if (found) {
      setUnitPrice(panel === 'purchase' ? found.standardCost : found.standardSalePrice);
    }
  };

  const submitQuickInvoice = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setFeedback(null);
    try {
      const item = items.find((i) => i.id === itemId);
      const today = new Date().toISOString().slice(0, 10);
      const res = await apiRequest<{ invoiceNumber: string; totalAmount: number }>(
        `/companies/${company.id}/invoices`,
        {
          method: 'POST',
          idempotencyKey: makeIdempotencyKey('simple-inv'),
          body: {
            branchId: branchId || defaultBranchId,
            invoiceType: panel === 'purchase' ? 'PURCHASE' : 'SALES',
            invoiceDate: today,
            dueDate: today,
            partyId,
            applyVat,
            paidImmediately: paidNow,
            bankAccountId,
            notes,
            lines: [
              {
                itemId: item ? item.id : null,
                warehouseId: item ? warehouseId : null,
                description: item ? item.name : notes || 'General Item',
                qty: Number(qty),
                unitPrice: Number(unitPrice),
              },
            ],
          },
        }
      );
      setFeedback({
        kind: 'ok',
        text: `Posted ${res.invoiceNumber} (${formatMoney(res.totalAmount, company.currency)}) to General Ledger and Inventory.`,
      });
      setPanel('none');
      setNotes('');
      await onRefresh();
    } catch (err: any) {
      setFeedback({ kind: 'err', text: err.message });
    } finally {
      setBusy(false);
    }
  };

  const submitQuickPayment = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setFeedback(null);
    try {
      await apiRequest(`/companies/${company.id}/payments`, {
        method: 'POST',
        idempotencyKey: makeIdempotencyKey('simple-pay'),
        body: {
          branchId: branchId || defaultBranchId,
          paymentType: payType,
          paymentDate: new Date().toISOString().slice(0, 10),
          partyId,
          bankAccountId,
          amount: Number(payAmount),
          method: 'CASH_OR_BANK',
          reference: notes || 'Simple Mode Settlement',
        },
      });
      setFeedback({
        kind: 'ok',
        text: `${payType === 'RECEIPT' ? 'Payment received' : 'Payment paid'} (${formatMoney(Number(payAmount), company.currency)}) recorded in Ledger.`,
      });
      setPanel('none');
      setPayAmount('');
      await onRefresh();
    } catch (err: any) {
      setFeedback({ kind: 'err', text: err.message });
    } finally {
      setBusy(false);
    }
  };

  const submitQuickExpense = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setFeedback(null);
    try {
      const res = await apiRequest<{ entryNumber: string }>(`/companies/${company.id}/quick-expense`, {
        method: 'POST',
        body: {
          branchId: branchId || defaultBranchId,
          expenseAccountId: expenseAcctId,
          bankAccountId,
          amount: Number(payAmount),
          entryDate: new Date().toISOString().slice(0, 10),
          description: expenseDesc || 'Daily Business Expense',
        },
      });
      setFeedback({
        kind: 'ok',
        text: `Expense voucher ${res.entryNumber} posted to P&L and Cash/Bank.`,
      });
      setPanel('none');
      await onRefresh();
    } catch (err: any) {
      setFeedback({ kind: 'err', text: err.message });
    } finally {
      setBusy(false);
    }
  };

  const settleInvoiceFast = async (inv: InvoiceRecord) => {
    setBusy(true);
    setFeedback(null);
    try {
      await apiRequest(`/companies/${company.id}/payments`, {
        method: 'POST',
        idempotencyKey: makeIdempotencyKey(`settle-${inv.id}`),
        body: {
          branchId: inv.branchId,
          paymentType: inv.invoiceType === 'SALES' ? 'RECEIPT' : 'PAYMENT',
          paymentDate: new Date().toISOString().slice(0, 10),
          partyId: inv.partyId,
          invoiceId: inv.id,
          bankAccountId: bankCashAccounts[0]?.id,
          amount: inv.balanceDue,
          method: 'CASH_OR_BANK',
          reference: `Settled ${inv.invoiceNumber}`,
        },
      });
      setFeedback({
        kind: 'ok',
        text: `Settled ${inv.invoiceNumber} for ${formatMoney(inv.balanceDue, company.currency)}.`,
      });
      await onRefresh();
    } catch (err: any) {
      setFeedback({ kind: 'err', text: err.message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 py-6 space-y-6">
      {/* Header summary & direct switch */}
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4 border-b border-slate-200 pb-5">
        <div>
          <p className="text-xs font-medium text-slate-500">
            Simple Mode · Everyday Business Operations · {company.legalName}
          </p>
          <h1 className="text-2xl font-bold text-slate-900 mt-1">
            Daily Cashbook, Billing &amp; Party Khata
          </h1>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => onRefresh()}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-md hover:bg-slate-50 whitespace-nowrap shrink-0"
          >
            <RefreshCw className="w-3.5 h-3.5" /> Refresh
          </button>
          <button
            type="button"
            onClick={onSwitchToAdvanced}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-white bg-slate-900 rounded-md hover:bg-slate-800 whitespace-nowrap shrink-0"
          >
            Open Advanced Enterprise Mode
          </button>
        </div>
      </div>

      {/* 4 Clean Business KPIs */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-white border border-slate-200 rounded-lg p-4">
          <div className="text-xs font-medium text-slate-500">Cash &amp; Bank Balance</div>
          <div className="num text-xl font-semibold text-slate-900 mt-1.5">
            {formatMoney(totals.cashBank, company.currency)}
          </div>
          <div className="text-xs text-slate-500 mt-1">{bankCashAccounts.length} active cash/bank ledgers</div>
        </div>
        <div className="bg-white border border-slate-200 rounded-lg p-4">
          <div className="text-xs font-medium text-slate-500">To Receive (Customer Khata)</div>
          <div className="num text-xl font-semibold text-emerald-700 mt-1.5">
            {formatMoney(totals.toReceive, company.currency)}
          </div>
          <div className="text-xs text-slate-500 mt-1">Open customer credit bills</div>
        </div>
        <div className="bg-white border border-slate-200 rounded-lg p-4">
          <div className="text-xs font-medium text-slate-500">To Pay (Supplier Khata)</div>
          <div className="num text-xl font-semibold text-red-700 mt-1.5">
            {formatMoney(totals.toPay, company.currency)}
          </div>
          <div className="text-xs text-slate-500 mt-1">Open supplier purchase bills</div>
        </div>
        <div className="bg-white border border-slate-200 rounded-lg p-4">
          <div className="text-xs font-medium text-slate-500">Total Sales Volume</div>
          <div className="num text-xl font-semibold text-slate-900 mt-1.5">
            {formatMoney(totals.totalSales, company.currency)}
          </div>
          <div className="text-xs text-slate-500 mt-1">
            {totals.lowStock > 0 ? `${totals.lowStock} item(s) at reorder alert` : 'All stock levels healthy'}
          </div>
        </div>
      </div>

      {/* 4 Primary Karobar-Style Quick Action Buttons */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <button
          type="button"
          onClick={() => openPanel('sale')}
          className="flex items-center gap-3 p-4 bg-blue-700 text-white rounded-lg hover:bg-blue-800 transition-colors text-left"
        >
          <Receipt className="w-5 h-5 shrink-0" />
          <div>
            <div className="text-sm font-semibold">New Sale Bill</div>
            <div className="text-xs text-blue-100">Auto VAT, stock &amp; GL</div>
          </div>
        </button>
        <button
          type="button"
          onClick={() => openPanel('purchase')}
          className="flex items-center gap-3 p-4 bg-white border border-slate-300 text-slate-900 rounded-lg hover:bg-slate-50 transition-colors text-left"
        >
          <ShoppingCart className="w-5 h-5 text-slate-700 shrink-0" />
          <div>
            <div className="text-sm font-semibold">Add Purchase</div>
            <div className="text-xs text-slate-500">Receive stock &amp; AP</div>
          </div>
        </button>
        <button
          type="button"
          onClick={() => openPanel('payment')}
          className="flex items-center gap-3 p-4 bg-white border border-slate-300 text-slate-900 rounded-lg hover:bg-slate-50 transition-colors text-left"
        >
          <Wallet className="w-5 h-5 text-emerald-700 shrink-0" />
          <div>
            <div className="text-sm font-semibold">Payment In / Out</div>
            <div className="text-xs text-slate-500">Settle party khata</div>
          </div>
        </button>
        <button
          type="button"
          onClick={() => openPanel('expense')}
          className="flex items-center gap-3 p-4 bg-white border border-slate-300 text-slate-900 rounded-lg hover:bg-slate-50 transition-colors text-left"
        >
          <Plus className="w-5 h-5 text-amber-700 shrink-0" />
          <div>
            <div className="text-sm font-semibold">Record Expense</div>
            <div className="text-xs text-slate-500">Rent, utilities, salary</div>
          </div>
        </button>
      </div>

      {feedback && (
        <div
          className={`p-3.5 rounded-lg border text-sm ${
            feedback.kind === 'ok'
              ? 'bg-emerald-50 border-emerald-200 text-emerald-900'
              : 'bg-red-50 border-red-200 text-red-900'
          }`}
        >
          {feedback.text}
        </div>
      )}

      {/* Quick Entry Form Drawer */}
      {panel !== 'none' && (
        <div className="bg-white border border-slate-200 rounded-lg p-5">
          <div className="flex items-center justify-between border-b border-slate-200 pb-3 mb-4">
            <h2 className="text-base font-semibold text-slate-900">
              {panel === 'sale' && 'Quick Sales Invoice (Auto Double-Entry + FIFO/WA Stock)'}
              {panel === 'purchase' && 'Quick Purchase Bill (Stock Receipt + Input VAT)'}
              {panel === 'payment' && 'Record Party Payment In / Out'}
              {panel === 'expense' && 'Record Business Expense'}
            </h2>
            <button
              type="button"
              onClick={() => setPanel('none')}
              className="text-xs font-medium text-slate-500 hover:text-slate-900"
            >
              Close
            </button>
          </div>

          {(panel === 'sale' || panel === 'purchase') && (
            <form onSubmit={submitQuickInvoice} className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  {panel === 'sale' ? 'Customer' : 'Supplier'}
                </label>
                <select
                  value={partyId}
                  onChange={(e) => setPartyId(Number(e.target.value))}
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-md bg-white"
                  required
                >
                  {parties.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} ({p.partyType})
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Branch</label>
                <select
                  value={branchId}
                  onChange={(e) => setBranchId(Number(e.target.value))}
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-md bg-white"
                >
                  {branches.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Warehouse</label>
                <select
                  value={warehouseId}
                  onChange={(e) => setWarehouseId(Number(e.target.value))}
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-md bg-white"
                >
                  {warehouses.map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.name}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Product / Item</label>
                <select
                  value={itemId}
                  onChange={(e) => handleItemChange(Number(e.target.value))}
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-md bg-white"
                >
                  {items.map((it) => (
                    <option key={it.id} value={it.id}>
                      {it.sku} · {it.name} (Stock: {formatQty(it.onHandQty)})
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Quantity</label>
                <input
                  type="number"
                  min="1"
                  step="any"
                  value={qty}
                  onChange={(e) => setQty(Number(e.target.value))}
                  className="num w-full px-3 py-2 text-sm border border-slate-300 rounded-md"
                  required
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Unit Rate ({company.currency})
                </label>
                <input
                  type="number"
                  min="0"
                  step="any"
                  value={unitPrice}
                  onChange={(e) => setUnitPrice(Number(e.target.value))}
                  className="num w-full px-3 py-2 text-sm border border-slate-300 rounded-md"
                  required
                />
              </div>

              <div className="md:col-span-2 flex flex-wrap items-center gap-6 pt-1">
                <label className="inline-flex items-center gap-2 text-sm text-slate-700">
                  <input type="checkbox" checked={applyVat} onChange={(e) => setApplyVat(e.target.checked)} />
                  Include {company.vatRate}% VAT
                </label>
                <label className="inline-flex items-center gap-2 text-sm text-slate-700">
                  <input type="checkbox" checked={paidNow} onChange={(e) => setPaidNow(e.target.checked)} />
                  {panel === 'sale' ? 'Cash/Bank Received Immediately' : 'Paid Immediately'}
                </label>
                {paidNow && (
                  <select
                    value={bankAccountId}
                    onChange={(e) => setBankAccountId(Number(e.target.value))}
                    className="px-2.5 py-1.5 text-xs border border-slate-300 rounded-md bg-white"
                  >
                    {bankCashAccounts.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.code} · {a.name}
                      </option>
                    ))}
                  </select>
                )}
              </div>

              <div className="flex items-center justify-end gap-3">
                <span className="num text-sm font-semibold text-slate-900">
                  Total:{' '}
                  {formatMoney(
                    qty * unitPrice * (applyVat ? 1 + company.vatRate / 100 : 1),
                    company.currency
                  )}
                </span>
                <button
                  type="submit"
                  disabled={busy}
                  className="px-4 py-2 text-sm font-medium text-white bg-blue-700 rounded-md hover:bg-blue-800 disabled:opacity-50 whitespace-nowrap shrink-0"
                >
                  {busy ? 'Posting...' : 'Save & Post'}
                </button>
              </div>
            </form>
          )}

          {panel === 'payment' && (
            <form onSubmit={submitQuickPayment} className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Direction</label>
                <select
                  value={payType}
                  onChange={(e) => setPayType(e.target.value as 'RECEIPT' | 'PAYMENT')}
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-md bg-white"
                >
                  <option value="RECEIPT">Payment In (From Customer)</option>
                  <option value="PAYMENT">Payment Out (To Supplier)</option>
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Party</label>
                <select
                  value={partyId}
                  onChange={(e) => setPartyId(Number(e.target.value))}
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-md bg-white"
                >
                  {parties.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Cash / Bank Account</label>
                <select
                  value={bankAccountId}
                  onChange={(e) => setBankAccountId(Number(e.target.value))}
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-md bg-white"
                >
                  {bankCashAccounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.code} · {a.name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Amount ({company.currency})</label>
                <input
                  type="number"
                  min="1"
                  step="any"
                  value={payAmount}
                  onChange={(e) => setPayAmount(e.target.value)}
                  className="num w-full px-3 py-2 text-sm border border-slate-300 rounded-md"
                  required
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Reference / Note</label>
                <input
                  type="text"
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="Cheque / ConnectIPS / Cash"
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-md"
                />
              </div>
              <div className="flex items-end justify-end">
                <button
                  type="submit"
                  disabled={busy}
                  className="px-4 py-2 text-sm font-medium text-white bg-blue-700 rounded-md hover:bg-blue-800 disabled:opacity-50"
                >
                  {busy ? 'Recording...' : 'Record Payment'}
                </button>
              </div>
            </form>
          )}

          {panel === 'expense' && (
            <form onSubmit={submitQuickExpense} className="grid grid-cols-1 md:grid-cols-4 gap-4">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Expense Category</label>
                <select
                  value={expenseAcctId}
                  onChange={(e) => setExpenseAcctId(Number(e.target.value))}
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-md bg-white"
                >
                  {expenseAccounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.code} · {a.name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Paid From</label>
                <select
                  value={bankAccountId}
                  onChange={(e) => setBankAccountId(Number(e.target.value))}
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-md bg-white"
                >
                  {bankCashAccounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Amount ({company.currency})</label>
                <input
                  type="number"
                  min="1"
                  step="any"
                  value={payAmount}
                  onChange={(e) => setPayAmount(e.target.value)}
                  className="num w-full px-3 py-2 text-sm border border-slate-300 rounded-md"
                  required
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Description</label>
                <input
                  type="text"
                  value={expenseDesc}
                  onChange={(e) => setExpenseDesc(e.target.value)}
                  placeholder="Electricity bill, tea, courier..."
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-md"
                  required
                />
              </div>
              <div className="md:col-span-4 flex justify-end">
                <button
                  type="submit"
                  disabled={busy}
                  className="px-4 py-2 text-sm font-medium text-white bg-blue-700 rounded-md hover:bg-blue-800 disabled:opacity-50"
                >
                  {busy ? 'Posting...' : 'Post Expense'}
                </button>
              </div>
            </form>
          )}
        </div>
      )}

      {/* Segmented View Tabs */}
      <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-200">
          <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-md">
            {(
              [
                ['transactions', 'Recent Bills'],
                ['khata', 'Party Khata (AR/AP)'],
                ['stock', 'Quick Stock Check'],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                onClick={() => setTab(key)}
                className={`px-3 py-1.5 text-xs font-medium rounded transition-colors whitespace-nowrap shrink-0 ${
                  tab === key ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          <span className="text-xs text-slate-500 hidden sm:inline">
            Synchronized in real time with Enterprise General Ledger
          </span>
        </div>

        {tab === 'transactions' && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-left text-xs font-medium text-slate-500">
                  <th className="px-4 py-2.5">Bill No.</th>
                  <th className="px-4 py-2.5">Date</th>
                  <th className="px-4 py-2.5">Party &amp; Branch</th>
                  <th className="px-4 py-2.5">Type</th>
                  <th className="px-4 py-2.5 text-right">Total</th>
                  <th className="px-4 py-2.5 text-right">Balance Due</th>
                  <th className="px-4 py-2.5 text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {invoices.map((inv) => (
                  <tr key={inv.id} className="hover:bg-slate-50">
                    <td className="px-4 py-2.5 num font-medium text-slate-900">{inv.invoiceNumber}</td>
                    <td className="px-4 py-2.5 num text-slate-600">{inv.invoiceDate}</td>
                    <td className="px-4 py-2.5">
                      <div className="font-medium text-slate-900">{inv.partyName}</div>
                      <div className="text-xs text-slate-500">{inv.branchName}</div>
                    </td>
                    <td className="px-4 py-2.5 text-xs">
                      <span
                        className={`inline-flex items-center gap-1 font-medium ${
                          inv.invoiceType === 'SALES' ? 'text-emerald-700' : 'text-amber-700'
                        }`}
                      >
                        {inv.invoiceType === 'SALES' ? (
                          <ArrowDownLeft className="w-3.5 h-3.5" />
                        ) : (
                          <ArrowUpRight className="w-3.5 h-3.5" />
                        )}
                        {inv.invoiceType === 'SALES' ? 'Sale' : 'Purchase'} · {inv.status}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 num text-right text-slate-900">
                      {formatMoney(inv.totalAmount, company.currency)}
                    </td>
                    <td className="px-4 py-2.5 num text-right font-medium text-slate-900">
                      {formatMoney(inv.balanceDue, company.currency)}
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      {inv.balanceDue > 0 ? (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => settleInvoiceFast(inv)}
                          className="px-2.5 py-1 text-xs font-medium text-blue-700 hover:text-blue-900 border border-blue-200 rounded hover:bg-blue-50 whitespace-nowrap"
                        >
                          {inv.invoiceType === 'SALES' ? 'Collect Due' : 'Pay Due'}
                        </button>
                      ) : (
                        <span className="text-xs text-slate-400">Settled</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {tab === 'khata' && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-left text-xs font-medium text-slate-500">
                  <th className="px-4 py-2.5">Party Name</th>
                  <th className="px-4 py-2.5">Role · Contact</th>
                  <th className="px-4 py-2.5 text-right">To Receive</th>
                  <th className="px-4 py-2.5 text-right">To Pay</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {parties.map((p) => (
                  <tr key={p.id} className="hover:bg-slate-50">
                    <td className="px-4 py-2.5 font-medium text-slate-900">
                      {p.name}
                      <span className="ml-2 num text-xs font-normal text-slate-400">{p.code}</span>
                    </td>
                    <td className="px-4 py-2.5 text-xs text-slate-500">
                      {p.partyType} {p.phone ? `· ${p.phone}` : ''}
                    </td>
                    <td className="px-4 py-2.5 num text-right font-medium text-emerald-700">
                      {formatMoney(p.receivableBalance || 0, company.currency)}
                    </td>
                    <td className="px-4 py-2.5 num text-right font-medium text-red-700">
                      {formatMoney(p.payableBalance || 0, company.currency)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {tab === 'stock' && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-left text-xs font-medium text-slate-500">
                  <th className="px-4 py-2.5">SKU &amp; Item</th>
                  <th className="px-4 py-2.5">Category · Method</th>
                  <th className="px-4 py-2.5 text-right">In Stock</th>
                  <th className="px-4 py-2.5 text-right">Sale Price</th>
                  <th className="px-4 py-2.5 text-right">Stock Value</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {items.map((it) => (
                  <tr key={it.id} className="hover:bg-slate-50">
                    <td className="px-4 py-2.5">
                      <div className="font-medium text-slate-900">{it.name}</div>
                      <div className="num text-xs text-slate-500">{it.sku}</div>
                    </td>
                    <td className="px-4 py-2.5 text-xs text-slate-500">
                      {it.category} · {it.valuationMethod}
                    </td>
                    <td
                      className={`px-4 py-2.5 num text-right font-semibold ${
                        (it.onHandQty || 0) <= it.reorderLevel ? 'text-amber-700' : 'text-slate-900'
                      }`}
                    >
                      {formatQty(it.onHandQty)} {it.unit}
                      {(it.onHandQty || 0) <= it.reorderLevel && (
                        <span className="block text-[11px] font-normal text-amber-700">Reorder alert</span>
                      )}
                    </td>
                    <td className="px-4 py-2.5 num text-right text-slate-700">
                      {formatMoney(it.standardSalePrice, company.currency)}
                    </td>
                    <td className="px-4 py-2.5 num text-right font-medium text-slate-900">
                      {formatMoney(it.valuationAmount, company.currency)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
};
