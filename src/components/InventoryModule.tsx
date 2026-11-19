import React, { useEffect, useState } from 'react';
import { ArrowRightLeft, ClipboardCheck, Search } from 'lucide-react';
import { apiRequest, makeIdempotencyKey } from '../lib/api.ts';
import { formatMoney, formatQty } from '../lib/format.ts';
import type { Company, InventoryItem, StockLot, Warehouse } from '../shared/types.ts';

interface InventoryProps {
  company: Company;
  items: InventoryItem[];
  warehouses: Warehouse[];
  onRefresh: () => Promise<void>;
}

type InvTab = 'valuation' | 'lots' | 'transfer' | 'reconcile' | 'reorder' | 'movements';

export const InventoryModule: React.FC<InventoryProps> = ({ company, items, warehouses, onRefresh }) => {
  const [tab, setTab] = useState<InvTab>('valuation');
  const [lots, setLots] = useState<StockLot[]>([]);
  const [movements, setMovements] = useState<any[]>([]);
  const [searchQ, setSearchQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const [newItem, setNewItem] = useState({
    sku: '',
    name: '',
    category: 'Spare Parts',
    unit: 'PCS',
    valuationMethod: 'FIFO',
    trackingType: 'NONE',
    standardSalePrice: '',
    standardCost: '',
    reorderLevel: '5',
    reorderQty: '15',
  });

  const [transfer, setTransfer] = useState({
    itemId: items[0]?.id || 0,
    fromWarehouseId: warehouses[0]?.id || 0,
    toWarehouseId: warehouses[1]?.id || warehouses[0]?.id || 0,
    qty: '1',
    notes: '',
  });

  const [recon, setRecon] = useState({
    itemId: items[0]?.id || 0,
    warehouseId: warehouses[0]?.id || 0,
    countedQty: '',
    notes: 'Cycle count verification',
  });

  const loadLots = async (q = searchQ) => {
    const qs = q ? `?q=${encodeURIComponent(q)}` : '';
    const rows = await apiRequest<StockLot[]>(`/companies/${company.id}/stock-lots${qs}`);
    setLots(rows);
  };

  const loadMovements = async () => {
    const rows = await apiRequest<any[]>(`/companies/${company.id}/stock-movements`);
    setMovements(rows);
  };

  useEffect(() => {
    if (tab === 'lots') loadLots();
    if (tab === 'movements') loadMovements();
  }, [tab, company.id]);

  useEffect(() => {
    setTransfer((prev) => ({
      ...prev,
      itemId: items[0]?.id || 0,
      fromWarehouseId: warehouses[0]?.id || 0,
      toWarehouseId: warehouses[1]?.id || warehouses[0]?.id || 0,
    }));
    setRecon((prev) => ({
      ...prev,
      itemId: items[0]?.id || 0,
      warehouseId: warehouses[0]?.id || 0,
    }));
  }, [company.id, items.length, warehouses.length]);

  const submitNewItem = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      await apiRequest(`/companies/${company.id}/items`, { method: 'POST', body: newItem });
      setMsg({ kind: 'ok', text: `SKU ${newItem.sku.toUpperCase()} created (${newItem.valuationMethod} / ${newItem.trackingType}).` });
      setNewItem({
        sku: '',
        name: '',
        category: 'Spare Parts',
        unit: 'PCS',
        valuationMethod: 'FIFO',
        trackingType: 'NONE',
        standardSalePrice: '',
        standardCost: '',
        reorderLevel: '5',
        reorderQty: '15',
      });
      await onRefresh();
    } catch (err: any) {
      setMsg({ kind: 'err', text: err.message });
    } finally {
      setBusy(false);
    }
  };

  const submitTransfer = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      const res = await apiRequest<{ transferredCost: number }>(`/companies/${company.id}/stock-transfers`, {
        method: 'POST',
        idempotencyKey: makeIdempotencyKey('xfer'),
        body: transfer,
      });
      setMsg({
        kind: 'ok',
        text: `Inter-branch stock transfer completed (${transfer.qty} units, value ${formatMoney(res.transferredCost, company.currency)}).`,
      });
      await onRefresh();
    } catch (err: any) {
      setMsg({ kind: 'err', text: err.message });
    } finally {
      setBusy(false);
    }
  };

  const submitReconcile = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      const res = await apiRequest<any>(`/companies/${company.id}/stock-reconcile`, {
        method: 'POST',
        body: recon,
      });
      setMsg({
        kind: 'ok',
        text:
          res.varianceQty === 0
            ? res.message
            : `Reconciled physical count: System ${res.systemQty} -> Counted ${res.countedQty} (Variance ${res.varianceQty}, GL impact ${formatMoney(res.varianceValue, company.currency)}).`,
      });
      await onRefresh();
    } catch (err: any) {
      setMsg({ kind: 'err', text: err.message });
    } finally {
      setBusy(false);
    }
  };

  const totalInventoryValuation = items.reduce((s, i) => s + Number(i.valuationAmount || 0), 0);
  const reorderList = items.filter((i) => (i.onHandQty || 0) <= i.reorderLevel);

  const tabs: Array<[InvTab, string]> = [
    ['valuation', 'Items & Stock Valuation'],
    ['lots', 'VIN / Engine / Serial / Batch'],
    ['transfer', 'Inter-Branch Transfer'],
    ['reconcile', 'Inventory Reconciliation'],
    ['reorder', `Reorder Planning (${reorderList.length})`],
    ['movements', 'Stock Ledger'],
  ];

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3 border-b border-slate-200 pb-4">
        <div>
          <h1 className="text-xl font-bold text-slate-900">Enterprise Inventory &amp; Warehouse Control</h1>
          <p className="text-xs text-slate-500 mt-0.5">
            {warehouses.length} warehouses · FIFO &amp; Weighted Average valuation · VIN/Engine, Serial &amp; Batch lot traceability
          </p>
        </div>
        <div className="text-right">
          <div className="text-xs text-slate-500">Total Stock Valuation</div>
          <div className="num text-lg font-bold text-slate-900">{formatMoney(totalInventoryValuation, company.currency)}</div>
        </div>
      </div>

      <div className="flex items-center gap-1 overflow-x-auto p-1 bg-slate-100 rounded-lg">
        {tabs.map(([k, label]) => (
          <button
            key={k}
            type="button"
            onClick={() => {
              setTab(k);
              setMsg(null);
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

      {/* ITEMS & STOCK VALUATION */}
      {tab === 'valuation' && (
        <div className="space-y-5">
          <form onSubmit={submitNewItem} className="bg-white border border-slate-200 rounded-lg p-4 grid grid-cols-1 md:grid-cols-6 gap-3 items-end">
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">SKU</label>
              <input
                type="text"
                value={newItem.sku}
                onChange={(e) => setNewItem({ ...newItem, sku: e.target.value })}
                placeholder="VEH-EVX5"
                className="num w-full px-2.5 py-1.5 text-xs border border-slate-300 rounded"
                required
              />
            </div>
            <div className="md:col-span-2">
              <label className="block text-xs font-medium text-slate-700 mb-1">Item Name</label>
              <input
                type="text"
                value={newItem.name}
                onChange={(e) => setNewItem({ ...newItem, name: e.target.value })}
                placeholder="Item description"
                className="w-full px-2.5 py-1.5 text-xs border border-slate-300 rounded"
                required
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Valuation</label>
              <select
                value={newItem.valuationMethod}
                onChange={(e) => setNewItem({ ...newItem, valuationMethod: e.target.value })}
                className="w-full px-2.5 py-1.5 text-xs border border-slate-300 rounded bg-white"
              >
                <option value="FIFO">FIFO</option>
                <option value="WEIGHTED_AVERAGE">Weighted Average</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Tracking</label>
              <select
                value={newItem.trackingType}
                onChange={(e) => setNewItem({ ...newItem, trackingType: e.target.value })}
                className="w-full px-2.5 py-1.5 text-xs border border-slate-300 rounded bg-white"
              >
                <option value="NONE">Standard</option>
                <option value="BATCH">Batch &amp; Expiry</option>
                <option value="SERIAL">Serial Number</option>
                <option value="VIN_ENGINE">VIN &amp; Engine No.</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Sale Price</label>
              <input
                type="number"
                value={newItem.standardSalePrice}
                onChange={(e) => setNewItem({ ...newItem, standardSalePrice: e.target.value })}
                placeholder="0"
                className="num w-full px-2.5 py-1.5 text-xs border border-slate-300 rounded"
                required
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Std. Cost</label>
              <input
                type="number"
                value={newItem.standardCost}
                onChange={(e) => setNewItem({ ...newItem, standardCost: e.target.value })}
                placeholder="0"
                className="num w-full px-2.5 py-1.5 text-xs border border-slate-300 rounded"
                required
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Reorder Level</label>
              <input
                type="number"
                value={newItem.reorderLevel}
                onChange={(e) => setNewItem({ ...newItem, reorderLevel: e.target.value })}
                className="num w-full px-2.5 py-1.5 text-xs border border-slate-300 rounded"
              />
            </div>
            <div className="md:col-span-4 flex justify-end">
              <button type="submit" disabled={busy} className="px-4 py-2 text-xs font-medium text-white bg-blue-700 rounded hover:bg-blue-800">
                Create Inventory SKU
              </button>
            </div>
          </form>

          <div className="bg-white border border-slate-200 rounded-lg overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-slate-50 border-b border-slate-200 text-left text-xs font-medium text-slate-500">
                  <th className="px-4 py-2.5">SKU &amp; Item</th>
                  <th className="px-4 py-2.5">Method · Tracking</th>
                  <th className="px-4 py-2.5 text-right">On Hand</th>
                  <th className="px-4 py-2.5 text-right">Weighted Avg Cost</th>
                  <th className="px-4 py-2.5 text-right">Sale Price</th>
                  <th className="px-4 py-2.5 text-right">Total Valuation</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {items.map((it) => (
                  <tr key={it.id} className="hover:bg-slate-50">
                    <td className="px-4 py-2.5">
                      <div className="font-medium text-slate-900">{it.name}</div>
                      <div className="num text-xs text-slate-500">
                        {it.sku} · {it.category}
                      </div>
                    </td>
                    <td className="px-4 py-2.5 text-xs text-slate-600">
                      {it.valuationMethod} · {it.trackingType}
                    </td>
                    <td className="px-4 py-2.5 num text-right font-semibold text-slate-900">
                      {formatQty(it.onHandQty)} {it.unit}
                    </td>
                    <td className="px-4 py-2.5 num text-right text-slate-700">
                      {formatMoney(it.weightedAvgCost, company.currency)}
                    </td>
                    <td className="px-4 py-2.5 num text-right text-slate-700">
                      {formatMoney(it.standardSalePrice, company.currency)}
                    </td>
                    <td className="px-4 py-2.5 num text-right font-semibold text-slate-900">
                      {formatMoney(it.valuationAmount, company.currency)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* VIN / ENGINE / SERIAL / BATCH REGISTRY */}
      {tab === 'lots' && (
        <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
          <div className="p-4 border-b border-slate-200 flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-sm font-semibold text-slate-900">
              Lot Traceability Registry (VIN, Engine, Serial &amp; Batch Numbers)
            </h2>
            <div className="flex items-center gap-2">
              <div className="relative">
                <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-2.5" />
                <input
                  type="text"
                  value={searchQ}
                  onChange={(e) => {
                    setSearchQ(e.target.value);
                    loadLots(e.target.value);
                  }}
                  placeholder="Search VIN, Engine, Serial, Batch..."
                  className="pl-8 pr-3 py-1.5 text-xs border border-slate-300 rounded-md w-64"
                />
              </div>
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-slate-50 border-b border-slate-200 text-left text-slate-500">
                  <th className="px-3 py-2.5">SKU &amp; Item</th>
                  <th className="px-3 py-2.5">Warehouse · Location</th>
                  <th className="px-3 py-2.5">VIN / Engine / Serial / Batch</th>
                  <th className="px-3 py-2.5">Expiry</th>
                  <th className="px-3 py-2.5 text-right">Remaining / Initial</th>
                  <th className="px-3 py-2.5 text-right">Unit Cost</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {lots.map((l) => (
                  <tr key={l.id} className={l.qtyRemaining === 0 ? 'opacity-55 bg-slate-50/40' : 'hover:bg-slate-50'}>
                    <td className="px-3 py-2.5">
                      <div className="font-medium text-slate-900">{l.itemName}</div>
                      <div className="num text-slate-500">{l.itemSku}</div>
                    </td>
                    <td className="px-3 py-2.5 text-slate-600">
                      <div>{l.warehouseName}</div>
                      <div className="text-slate-400">
                        {l.branchName} {l.locationCode ? `· Bin ${l.locationCode}` : ''}
                      </div>
                    </td>
                    <td className="px-3 py-2.5 num text-slate-800">
                      {l.vinNumber && <div>VIN: {l.vinNumber}</div>}
                      {l.engineNumber && <div className="text-slate-500">ENG: {l.engineNumber}</div>}
                      {l.serialNumber && <div>SN: {l.serialNumber}</div>}
                      {l.batchNumber && <div>BATCH: {l.batchNumber}</div>}
                      {!l.vinNumber && !l.serialNumber && !l.batchNumber && <span className="text-slate-400">Standard Lot #{l.id}</span>}
                    </td>
                    <td className="px-3 py-2.5 num text-slate-600">{l.expiryDate || '—'}</td>
                    <td className="px-3 py-2.5 num text-right font-semibold text-slate-900">
                      {formatQty(l.qtyRemaining)} / {formatQty(l.qtyInitial)}
                    </td>
                    <td className="px-3 py-2.5 num text-right text-slate-700">
                      {formatMoney(l.unitCost, company.currency)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* INTER-BRANCH STOCK TRANSFER */}
      {tab === 'transfer' && (
        <form onSubmit={submitTransfer} className="bg-white border border-slate-200 rounded-lg p-5 space-y-4">
          <div className="flex items-center gap-2 border-b border-slate-200 pb-3">
            <ArrowRightLeft className="w-4 h-4 text-blue-700" />
            <h2 className="text-sm font-semibold text-slate-900">
              Inter-Branch &amp; Inter-Warehouse Stock Transfer (Transaction-Safe)
            </h2>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            <div className="md:col-span-2">
              <label className="block text-xs font-medium text-slate-700 mb-1">Inventory Item</label>
              <select
                value={transfer.itemId}
                onChange={(e) => setTransfer({ ...transfer, itemId: Number(e.target.value) })}
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-md bg-white"
              >
                {items.map((it) => (
                  <option key={it.id} value={it.id}>
                    {it.sku} · {it.name} (Total On Hand: {it.onHandQty})
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">From Warehouse</label>
              <select
                value={transfer.fromWarehouseId}
                onChange={(e) => setTransfer({ ...transfer, fromWarehouseId: Number(e.target.value) })}
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-md bg-white"
              >
                {warehouses.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name} ({w.branchName})
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">To Warehouse</label>
              <select
                value={transfer.toWarehouseId}
                onChange={(e) => setTransfer({ ...transfer, toWarehouseId: Number(e.target.value) })}
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-md bg-white"
              >
                {warehouses.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name} ({w.branchName})
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Transfer Quantity</label>
              <input
                type="number"
                min="1"
                step="any"
                value={transfer.qty}
                onChange={(e) => setTransfer({ ...transfer, qty: e.target.value })}
                className="num w-full px-3 py-2 text-sm border border-slate-300 rounded-md"
                required
              />
            </div>
            <div className="md:col-span-2">
              <label className="block text-xs font-medium text-slate-700 mb-1">Dispatch Reference / Note</label>
              <input
                type="text"
                value={transfer.notes}
                onChange={(e) => setTransfer({ ...transfer, notes: e.target.value })}
                placeholder="Branch replenishment / showroom transfer"
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-md"
              />
            </div>
            <div className="flex items-end justify-end">
              <button
                type="submit"
                disabled={busy || warehouses.length < 2}
                className="px-4 py-2 text-xs font-medium text-white bg-blue-700 rounded-md hover:bg-blue-800 disabled:opacity-50"
              >
                Execute Stock Transfer
              </button>
            </div>
          </div>
        </form>
      )}

      {/* PHYSICAL INVENTORY RECONCILIATION */}
      {tab === 'reconcile' && (
        <form onSubmit={submitReconcile} className="bg-white border border-slate-200 rounded-lg p-5 space-y-4">
          <div className="flex items-center gap-2 border-b border-slate-200 pb-3">
            <ClipboardCheck className="w-4 h-4 text-blue-700" />
            <h2 className="text-sm font-semibold text-slate-900">
              Physical Inventory Reconciliation (Auto-Posts GL Variance Entry)
            </h2>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Item</label>
              <select
                value={recon.itemId}
                onChange={(e) => setRecon({ ...recon, itemId: Number(e.target.value) })}
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-md bg-white"
              >
                {items.map((it) => (
                  <option key={it.id} value={it.id}>
                    {it.sku} · {it.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Warehouse</label>
              <select
                value={recon.warehouseId}
                onChange={(e) => setRecon({ ...recon, warehouseId: Number(e.target.value) })}
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
              <label className="block text-xs font-medium text-slate-700 mb-1">Physical Counted Qty</label>
              <input
                type="number"
                min="0"
                step="any"
                value={recon.countedQty}
                onChange={(e) => setRecon({ ...recon, countedQty: e.target.value })}
                className="num w-full px-3 py-2 text-sm border border-slate-300 rounded-md"
                required
              />
            </div>
            <div className="flex items-end justify-end">
              <button
                type="submit"
                disabled={busy}
                className="px-4 py-2 text-xs font-medium text-white bg-blue-700 rounded-md hover:bg-blue-800 disabled:opacity-50"
              >
                Post Reconciliation
              </button>
            </div>
          </div>
        </form>
      )}

      {/* REORDER PLANNING */}
      {tab === 'reorder' && (
        <div className="bg-white border border-slate-200 rounded-lg overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-200 text-left text-xs text-slate-500">
                <th className="px-4 py-2.5">SKU &amp; Item</th>
                <th className="px-4 py-2.5 text-right">On Hand</th>
                <th className="px-4 py-2.5 text-right">Reorder Point</th>
                <th className="px-4 py-2.5 text-right">Recommended PO Qty</th>
                <th className="px-4 py-2.5 text-right">Est. Procurement Cost</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {reorderList.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-4 py-6 text-center text-slate-500">
                    All SKUs are above safety reorder levels.
                  </td>
                </tr>
              ) : (
                reorderList.map((it) => (
                  <tr key={it.id} className="hover:bg-slate-50">
                    <td className="px-4 py-2.5 font-medium text-slate-900">
                      <span className="num text-slate-500 mr-2">{it.sku}</span>
                      {it.name}
                    </td>
                    <td className="px-4 py-2.5 num text-right font-semibold text-red-700">
                      {formatQty(it.onHandQty)} {it.unit}
                    </td>
                    <td className="px-4 py-2.5 num text-right text-slate-600">{it.reorderLevel}</td>
                    <td className="px-4 py-2.5 num text-right font-semibold text-blue-700">
                      {it.reorderQty} {it.unit}
                    </td>
                    <td className="px-4 py-2.5 num text-right text-slate-900">
                      {formatMoney(it.reorderQty * it.standardCost, company.currency)}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* STOCK MOVEMENTS */}
      {tab === 'movements' && (
        <div className="bg-white border border-slate-200 rounded-lg overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-200 text-left text-slate-500">
                <th className="px-3 py-2.5">Timestamp</th>
                <th className="px-3 py-2.5">SKU &amp; Item</th>
                <th className="px-3 py-2.5">Warehouse · Branch</th>
                <th className="px-3 py-2.5">Movement · Reference</th>
                <th className="px-3 py-2.5 text-right">Qty Change</th>
                <th className="px-3 py-2.5 text-right">Total Cost</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {movements.map((m) => (
                <tr key={m.id} className="hover:bg-slate-50">
                  <td className="px-3 py-2 num text-slate-500">{String(m.createdAt).slice(0, 16)}</td>
                  <td className="px-3 py-2 font-medium text-slate-900">
                    <span className="num text-slate-500 mr-1.5">{m.itemSku}</span>
                    {m.itemName}
                  </td>
                  <td className="px-3 py-2 text-slate-600">
                    {m.warehouseName} · {m.branchName}
                  </td>
                  <td className="px-3 py-2 text-slate-600">
                    {m.referenceType} {m.notes ? `· ${m.notes}` : ''}
                  </td>
                  <td
                    className={`px-3 py-2 num text-right font-semibold ${
                      m.qtyChange >= 0 ? 'text-emerald-700' : 'text-red-700'
                    }`}
                  >
                    {m.qtyChange > 0 ? `+${formatQty(m.qtyChange)}` : formatQty(m.qtyChange)}
                  </td>
                  <td className="px-3 py-2 num text-right text-slate-900">
                    {formatMoney(m.totalCost, company.currency)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};
