import React, { useState } from 'react';
import { Plus } from 'lucide-react';
import { apiRequest, makeIdempotencyKey } from '../lib/api.ts';
import { formatMoney } from '../lib/format.ts';
import type {
  Account,
  Branch,
  Company,
  InventoryItem,
  InvoiceRecord,
  Party,
  Warehouse,
} from '../shared/types.ts';

interface CommercialProps {
  company: Company;
  branches: Branch[];
  accounts: Account[];
  parties: Party[];
  items: InventoryItem[];
  warehouses: Warehouse[];
  invoices: InvoiceRecord[];
  onRefresh: () => Promise<void>;
}

export const CommercialModule: React.FC<CommercialProps> = ({
  company,
  branches,
  accounts,
  parties,
  items,
  warehouses,
  invoices,
  onRefresh,
}) => {
  const [tab, setTab] = useState<'SALES' | 'PURCHASE' | 'PARTIES'>('SALES');
  const [showNewInv, setShowNewInv] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const bankAccts = accounts.filter((a) => a.isBankOrCash === 1);

  const [invForm, setInvForm] = useState({
    branchId: branches[0]?.id || 0,
    partyId: parties[0]?.id || 0,
    invoiceDate: new Date().toISOString().slice(0, 10),
    dueDate: new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10),
    itemId: items[0]?.id || 0,
    warehouseId: warehouses[0]?.id || 0,
    qty: 1,
    unitPrice: items[0]?.standardSalePrice || 0,
    applyVat: true,
    paidImmediately: false,
    bankAccountId: bankAccts[0]?.id || 0,
    batchNumber: '',
    serialNumber: '',
    vinNumber: '',
    engineNumber: '',
    notes: '',
  });

  const [partyForm, setPartyForm] = useState({
    name: '',
    partyType: 'CUSTOMER',
    panVat: '',
    phone: '',
    email: '',
    creditLimit: '500000',
  });

  const filteredInvoices = invoices.filter((i) => i.invoiceType === (tab === 'PURCHASE' ? 'PURCHASE' : 'SALES'));

  const openInvoiceCreator = () => {
    const isPurchase = tab === 'PURCHASE';
    const matchingParty =
      parties.find((p) => (isPurchase ? p.partyType !== 'CUSTOMER' : p.partyType !== 'SUPPLIER')) || parties[0];
    const firstItem = items[0];
    setInvForm({
      branchId: branches[0]?.id || 0,
      partyId: matchingParty?.id || 0,
      invoiceDate: new Date().toISOString().slice(0, 10),
      dueDate: new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10),
      itemId: firstItem?.id || 0,
      warehouseId: warehouses[0]?.id || 0,
      qty: 1,
      unitPrice: isPurchase ? firstItem?.standardCost || 0 : firstItem?.standardSalePrice || 0,
      applyVat: true,
      paidImmediately: false,
      bankAccountId: bankAccts[0]?.id || 0,
      batchNumber: '',
      serialNumber: '',
      vinNumber: '',
      engineNumber: '',
      notes: '',
    });
    setShowNewInv(true);
    setMsg(null);
  };

  const submitInvoice = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      const item = items.find((i) => i.id === invForm.itemId);
      const res = await apiRequest<{ invoiceNumber: string; totalAmount: number }>(
        `/companies/${company.id}/invoices`,
        {
          method: 'POST',
          idempotencyKey: makeIdempotencyKey('adv-inv'),
          body: {
            branchId: invForm.branchId || branches[0]?.id,
            invoiceType: tab === 'PURCHASE' ? 'PURCHASE' : 'SALES',
            invoiceDate: invForm.invoiceDate,
            dueDate: invForm.dueDate,
            partyId: invForm.partyId,
            applyVat: invForm.applyVat,
            paidImmediately: invForm.paidImmediately,
            bankAccountId: invForm.bankAccountId,
            notes: invForm.notes,
            lines: [
              {
                itemId: item?.id || null,
                warehouseId: item ? invForm.warehouseId : null,
                description: item ? item.name : invForm.notes || 'Service Line',
                qty: Number(invForm.qty),
                unitPrice: Number(invForm.unitPrice),
                batchNumber: invForm.batchNumber || null,
                serialNumber: invForm.serialNumber || null,
                vinNumber: invForm.vinNumber || null,
                engineNumber: invForm.engineNumber || null,
              },
            ],
          },
        }
      );
      setMsg({
        kind: 'ok',
        text: `Posted ${res.invoiceNumber} (${formatMoney(res.totalAmount, company.currency)}) with automatic GL & Stock updates.`,
      });
      setShowNewInv(false);
      await onRefresh();
    } catch (err: any) {
      setMsg({ kind: 'err', text: err.message });
    } finally {
      setBusy(false);
    }
  };

  const settleInvoice = async (inv: InvoiceRecord) => {
    setBusy(true);
    setMsg(null);
    try {
      await apiRequest(`/companies/${company.id}/payments`, {
        method: 'POST',
        idempotencyKey: makeIdempotencyKey(`adv-settle-${inv.id}`),
        body: {
          branchId: inv.branchId,
          paymentType: inv.invoiceType === 'SALES' ? 'RECEIPT' : 'PAYMENT',
          paymentDate: new Date().toISOString().slice(0, 10),
          partyId: inv.partyId,
          invoiceId: inv.id,
          bankAccountId: bankAccts[0]?.id,
          amount: inv.balanceDue,
          method: 'BANK_TRANSFER',
          reference: `Full settlement ${inv.invoiceNumber}`,
        },
      });
      setMsg({ kind: 'ok', text: `Settled ${inv.invoiceNumber} (${formatMoney(inv.balanceDue, company.currency)}).` });
      await onRefresh();
    } catch (err: any) {
      setMsg({ kind: 'err', text: err.message });
    } finally {
      setBusy(false);
    }
  };

  const submitParty = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      await apiRequest(`/companies/${company.id}/parties`, { method: 'POST', body: partyForm });
      setMsg({ kind: 'ok', text: `Created ${partyForm.partyType} "${partyForm.name}".` });
      setPartyForm({ name: '', partyType: 'CUSTOMER', panVat: '', phone: '', email: '', creditLimit: '500000' });
      await onRefresh();
    } catch (err: any) {
      setMsg({ kind: 'err', text: err.message });
    } finally {
      setBusy(false);
    }
  };

  const selectedItem = items.find((i) => i.id === invForm.itemId);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 pb-4">
        <div>
          <h1 className="text-xl font-bold text-slate-900">Sales (AR), Purchases (AP) &amp; Parties</h1>
          <p className="text-xs text-slate-500 mt-0.5">
            Company-specific sequences ({company.invoicePrefix} / {company.purchasePrefix}) · Auto {company.vatRate}% VAT &amp; FIFO/WA COGS
          </p>
        </div>
        {tab !== 'PARTIES' && (
          <button
            type="button"
            onClick={openInvoiceCreator}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-white bg-blue-700 rounded-md hover:bg-blue-800 whitespace-nowrap shrink-0"
          >
            <Plus className="w-4 h-4" /> New {tab === 'SALES' ? 'Sales Invoice' : 'Purchase Bill'}
          </button>
        )}
      </div>

      <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg w-fit">
        {(
          [
            ['SALES', 'Sales Invoices & AR'],
            ['PURCHASE', 'Purchase Bills & AP'],
            ['PARTIES', 'Customers & Suppliers'],
          ] as const
        ).map(([k, label]) => (
          <button
            key={k}
            type="button"
            onClick={() => {
              setTab(k);
              setShowNewInv(false);
            }}
            className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
              tab === k ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {msg && (
        <div
          className={`p-3 rounded-lg border text-sm ${
            msg.kind === 'ok'
              ? 'bg-emerald-50 border-emerald-200 text-emerald-900'
              : 'bg-red-50 border-red-200 text-red-900'
          }`}
        >
          {msg.text}
        </div>
      )}

      {showNewInv && tab !== 'PARTIES' && (
        <form onSubmit={submitInvoice} className="bg-white border border-slate-200 rounded-lg p-5 space-y-4">
          <div className="flex items-center justify-between border-b border-slate-200 pb-3">
            <h2 className="text-sm font-semibold text-slate-900">
              Create {tab === 'SALES' ? 'Sales Invoice (AR)' : 'Purchase Bill (AP & Stock Lot Receipt)'}
            </h2>
            <button type="button" onClick={() => setShowNewInv(false)} className="text-xs text-slate-500 hover:text-slate-900">
              Cancel
            </button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Party</label>
              <select
                value={invForm.partyId}
                onChange={(e) => setInvForm({ ...invForm, partyId: Number(e.target.value) })}
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
              <label className="block text-xs font-medium text-slate-700 mb-1">Branch</label>
              <select
                value={invForm.branchId}
                onChange={(e) => setInvForm({ ...invForm, branchId: Number(e.target.value) })}
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
              <label className="block text-xs font-medium text-slate-700 mb-1">Invoice Date</label>
              <input
                type="date"
                value={invForm.invoiceDate}
                onChange={(e) => setInvForm({ ...invForm, invoiceDate: e.target.value })}
                className="num w-full px-3 py-2 text-sm border border-slate-300 rounded-md"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Warehouse</label>
              <select
                value={invForm.warehouseId}
                onChange={(e) => setInvForm({ ...invForm, warehouseId: Number(e.target.value) })}
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-md bg-white"
              >
                {warehouses.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
              </select>
            </div>

            <div className="md:col-span-2">
              <label className="block text-xs font-medium text-slate-700 mb-1">Inventory Item</label>
              <select
                value={invForm.itemId}
                onChange={(e) => {
                  const id = Number(e.target.value);
                  const it = items.find((x) => x.id === id);
                  setInvForm({
                    ...invForm,
                    itemId: id,
                    unitPrice: it ? (tab === 'PURCHASE' ? it.standardCost : it.standardSalePrice) : 0,
                  });
                }}
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-md bg-white"
              >
                {items.map((it) => (
                  <option key={it.id} value={it.id}>
                    {it.sku} · {it.name} ({it.trackingType} · Qty: {it.onHandQty})
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
                value={invForm.qty}
                onChange={(e) => setInvForm({ ...invForm, qty: Number(e.target.value) })}
                className="num w-full px-3 py-2 text-sm border border-slate-300 rounded-md"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Unit Rate ({company.currency})</label>
              <input
                type="number"
                min="0"
                step="any"
                value={invForm.unitPrice}
                onChange={(e) => setInvForm({ ...invForm, unitPrice: Number(e.target.value) })}
                className="num w-full px-3 py-2 text-sm border border-slate-300 rounded-md"
              />
            </div>

            {/* Lot/VIN/Serial capture on Purchase Receipts */}
            {tab === 'PURCHASE' && selectedItem?.trackingType === 'VIN_ENGINE' && (
              <>
                <div className="md:col-span-2">
                  <label className="block text-xs font-medium text-slate-700 mb-1">Vehicle VIN / Chassis No.</label>
                  <input
                    type="text"
                    value={invForm.vinNumber}
                    onChange={(e) => setInvForm({ ...invForm, vinNumber: e.target.value })}
                    placeholder="VIN-HMT2026EV009"
                    className="num w-full px-3 py-2 text-sm border border-slate-300 rounded-md"
                  />
                </div>
                <div className="md:col-span-2">
                  <label className="block text-xs font-medium text-slate-700 mb-1">Engine / Motor No.</label>
                  <input
                    type="text"
                    value={invForm.engineNumber}
                    onChange={(e) => setInvForm({ ...invForm, engineNumber: e.target.value })}
                    placeholder="ENG-TVX4-88999"
                    className="num w-full px-3 py-2 text-sm border border-slate-300 rounded-md"
                  />
                </div>
              </>
            )}
            {tab === 'PURCHASE' && selectedItem?.trackingType === 'BATCH' && (
              <div className="md:col-span-2">
                <label className="block text-xs font-medium text-slate-700 mb-1">Batch Number</label>
                <input
                  type="text"
                  value={invForm.batchNumber}
                  onChange={(e) => setInvForm({ ...invForm, batchNumber: e.target.value })}
                  placeholder="BATCH-2026-C"
                  className="num w-full px-3 py-2 text-sm border border-slate-300 rounded-md"
                />
              </div>
            )}
            {tab === 'PURCHASE' && selectedItem?.trackingType === 'SERIAL' && (
              <div className="md:col-span-2">
                <label className="block text-xs font-medium text-slate-700 mb-1">Serial Number</label>
                <input
                  type="text"
                  value={invForm.serialNumber}
                  onChange={(e) => setInvForm({ ...invForm, serialNumber: e.target.value })}
                  placeholder="SN-LFP60-9055"
                  className="num w-full px-3 py-2 text-sm border border-slate-300 rounded-md"
                />
              </div>
            )}
          </div>

          <div className="flex flex-wrap items-center justify-between gap-4 pt-2 border-t border-slate-100">
            <div className="flex items-center gap-5 text-xs text-slate-700">
              <label className="inline-flex items-center gap-1.5">
                <input
                  type="checkbox"
                  checked={invForm.applyVat}
                  onChange={(e) => setInvForm({ ...invForm, applyVat: e.target.checked })}
                />
                Apply {company.vatRate}% VAT
              </label>
              <label className="inline-flex items-center gap-1.5">
                <input
                  type="checkbox"
                  checked={invForm.paidImmediately}
                  onChange={(e) => setInvForm({ ...invForm, paidImmediately: e.target.checked })}
                />
                Settle Immediately
              </label>
            </div>
            <button
              type="submit"
              disabled={busy}
              className="px-4 py-2 text-xs font-medium text-white bg-blue-700 rounded-md hover:bg-blue-800 disabled:opacity-50"
            >
              {busy ? 'Posting...' : 'Post Invoice to Ledger'}
            </button>
          </div>
        </form>
      )}

      {tab !== 'PARTIES' ? (
        <div className="bg-white border border-slate-200 rounded-lg overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-200 text-left text-xs font-medium text-slate-500">
                <th className="px-4 py-2.5">Document No.</th>
                <th className="px-4 py-2.5">Date · Due</th>
                <th className="px-4 py-2.5">Party &amp; Branch</th>
                <th className="px-4 py-2.5 text-right">Subtotal</th>
                <th className="px-4 py-2.5 text-right">VAT</th>
                <th className="px-4 py-2.5 text-right">Total</th>
                <th className="px-4 py-2.5 text-right">Balance Due</th>
                <th className="px-4 py-2.5 text-right">Status / Settle</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filteredInvoices.map((inv) => (
                <tr key={inv.id} className="hover:bg-slate-50">
                  <td className="px-4 py-2.5 num font-medium text-slate-900">
                    {inv.invoiceNumber}
                    {inv.isIntercompany === 1 && <span className="block text-[11px] font-sans text-blue-700">Inter-Company</span>}
                  </td>
                  <td className="px-4 py-2.5 num text-xs text-slate-600">
                    {inv.invoiceDate}
                    <span className="block text-slate-400">Due {inv.dueDate}</span>
                  </td>
                  <td className="px-4 py-2.5">
                    <div className="font-medium text-slate-900">{inv.partyName}</div>
                    <div className="text-xs text-slate-500">{inv.branchName}</div>
                  </td>
                  <td className="px-4 py-2.5 num text-right text-slate-700">{formatMoney(inv.subtotal, company.currency)}</td>
                  <td className="px-4 py-2.5 num text-right text-slate-500">{formatMoney(inv.vatAmount, company.currency)}</td>
                  <td className="px-4 py-2.5 num text-right font-medium text-slate-900">{formatMoney(inv.totalAmount, company.currency)}</td>
                  <td className="px-4 py-2.5 num text-right font-semibold text-slate-900">{formatMoney(inv.balanceDue, company.currency)}</td>
                  <td className="px-4 py-2.5 text-right">
                    {inv.balanceDue > 0 ? (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => settleInvoice(inv)}
                        className="px-2.5 py-1 text-xs font-medium text-blue-700 border border-blue-200 rounded hover:bg-blue-50 whitespace-nowrap"
                      >
                        Settle Full
                      </button>
                    ) : (
                      <span className="text-xs font-medium text-emerald-700">PAID</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="space-y-4">
          <form onSubmit={submitParty} className="bg-white border border-slate-200 rounded-lg p-4 grid grid-cols-1 md:grid-cols-6 gap-3 items-end">
            <div className="md:col-span-2">
              <label className="block text-xs font-medium text-slate-700 mb-1">Legal / Business Name</label>
              <input
                type="text"
                value={partyForm.name}
                onChange={(e) => setPartyForm({ ...partyForm, name: e.target.value })}
                className="w-full px-3 py-1.5 text-sm border border-slate-300 rounded-md"
                required
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Type</label>
              <select
                value={partyForm.partyType}
                onChange={(e) => setPartyForm({ ...partyForm, partyType: e.target.value })}
                className="w-full px-3 py-1.5 text-sm border border-slate-300 rounded-md bg-white"
              >
                <option value="CUSTOMER">Customer</option>
                <option value="SUPPLIER">Supplier</option>
                <option value="BOTH">Both</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">PAN / VAT No.</label>
              <input
                type="text"
                value={partyForm.panVat}
                onChange={(e) => setPartyForm({ ...partyForm, panVat: e.target.value })}
                className="num w-full px-3 py-1.5 text-sm border border-slate-300 rounded-md"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Phone</label>
              <input
                type="text"
                value={partyForm.phone}
                onChange={(e) => setPartyForm({ ...partyForm, phone: e.target.value })}
                className="w-full px-3 py-1.5 text-sm border border-slate-300 rounded-md"
              />
            </div>
            <button type="submit" disabled={busy} className="px-3 py-2 text-xs font-medium text-white bg-blue-700 rounded-md hover:bg-blue-800">
              Add Party
            </button>
          </form>

          <div className="bg-white border border-slate-200 rounded-lg overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-slate-50 border-b border-slate-200 text-left text-xs font-medium text-slate-500">
                  <th className="px-4 py-2.5">Code &amp; Party</th>
                  <th className="px-4 py-2.5">Type · Tax ID</th>
                  <th className="px-4 py-2.5">Contact</th>
                  <th className="px-4 py-2.5 text-right">AR Balance</th>
                  <th className="px-4 py-2.5 text-right">AP Balance</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {parties.map((p) => (
                  <tr key={p.id} className="hover:bg-slate-50">
                    <td className="px-4 py-2.5">
                      <div className="font-medium text-slate-900">{p.name}</div>
                      <div className="num text-xs text-slate-400">{p.code}</div>
                    </td>
                    <td className="px-4 py-2.5 text-xs text-slate-600">
                      {p.partyType} {p.panVat ? `· PAN ${p.panVat}` : ''}
                    </td>
                    <td className="px-4 py-2.5 text-xs text-slate-500">
                      {p.phone || '—'} {p.email ? `· ${p.email}` : ''}
                    </td>
                    <td className="px-4 py-2.5 num text-right font-medium text-emerald-700">
                      {formatMoney(p.receivableBalance, company.currency)}
                    </td>
                    <td className="px-4 py-2.5 num text-right font-medium text-red-700">
                      {formatMoney(p.payableBalance, company.currency)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
};
