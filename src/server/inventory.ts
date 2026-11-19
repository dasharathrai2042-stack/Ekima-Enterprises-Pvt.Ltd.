import { db, round2 } from './db.ts';
import type { ValuationMethod } from '../shared/types.ts';

export interface ReceiveStockParams {
  companyId: number;
  itemId: number;
  warehouseId: number;
  locationId?: number | null;
  qty: number;
  unitCost: number;
  batchNumber?: string | null;
  serialNumber?: string | null;
  vinNumber?: string | null;
  engineNumber?: string | null;
  expiryDate?: string | null;
  referenceType: string;
  referenceId?: number | null;
  notes?: string;
  userId: number;
  receivedAt?: string;
}

export interface IssueStockParams {
  companyId: number;
  itemId: number;
  warehouseId: number;
  qty: number;
  referenceType: string;
  referenceId?: number | null;
  notes?: string;
  userId: number;
  preferredLotId?: number | null;
}

export function receiveStockInTx(params: ReceiveStockParams): { lotId: number; totalCost: number } {
  if (params.qty <= 0) {
    throw new Error('Stock receipt quantity must be greater than zero.');
  }
  const wh = db
    .prepare('SELECT id, branch_id FROM warehouses WHERE id = ? AND company_id = ?')
    .get(params.warehouseId, params.companyId) as { id: number; branch_id: number } | undefined;
  if (!wh) {
    throw new Error('Warehouse not found for the selected company.');
  }

  const item = db
    .prepare('SELECT id, tracking_type FROM inventory_items WHERE id = ? AND company_id = ?')
    .get(params.itemId, params.companyId) as { id: number; tracking_type: string } | undefined;
  if (!item) {
    throw new Error('Inventory item not found for the selected company.');
  }

  const receivedAt = params.receivedAt || new Date().toISOString();
  const totalCost = round2(params.qty * params.unitCost);

  const lotRes = db
    .prepare(
      `INSERT INTO stock_lots
       (company_id, item_id, warehouse_id, location_id, branch_id, batch_number, serial_number, vin_number, engine_number, expiry_date, qty_initial, qty_remaining, unit_cost, received_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      params.companyId,
      params.itemId,
      params.warehouseId,
      params.locationId ?? null,
      wh.branch_id,
      params.batchNumber || null,
      params.serialNumber || null,
      params.vinNumber || null,
      params.engineNumber || null,
      params.expiryDate || null,
      params.qty,
      params.qty,
      params.unitCost,
      receivedAt
    );

  db.prepare(
    `INSERT INTO stock_movements
     (company_id, item_id, warehouse_id, location_id, branch_id, movement_type, qty_change, unit_cost, total_cost, reference_type, reference_id, notes, created_by)
     VALUES (?, ?, ?, ?, ?, 'IN', ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    params.companyId,
    params.itemId,
    params.warehouseId,
    params.locationId ?? null,
    wh.branch_id,
    params.qty,
    params.unitCost,
    totalCost,
    params.referenceType,
    params.referenceId ?? null,
    params.notes || '',
    params.userId
  );

  return { lotId: Number(lotRes.lastInsertRowid), totalCost };
}

export function issueStockInTx(params: IssueStockParams): { totalCost: number; effectiveUnitCost: number } {
  if (params.qty <= 0) {
    throw new Error('Stock issue quantity must be greater than zero.');
  }

  const item = db
    .prepare('SELECT id, sku, name, valuation_method, standard_cost FROM inventory_items WHERE id = ? AND company_id = ?')
    .get(params.itemId, params.companyId) as
    | { id: number; sku: string; name: string; valuation_method: ValuationMethod; standard_cost: number }
    | undefined;
  if (!item) {
    throw new Error('Inventory item not found for this company.');
  }

  const wh = db
    .prepare('SELECT id, branch_id FROM warehouses WHERE id = ? AND company_id = ?')
    .get(params.warehouseId, params.companyId) as { id: number; branch_id: number } | undefined;
  if (!wh) {
    throw new Error('Warehouse not found for this company.');
  }

  const lots = db
    .prepare(
      `SELECT id, location_id, qty_remaining, unit_cost, received_at
       FROM stock_lots
       WHERE company_id = ? AND item_id = ? AND warehouse_id = ? AND qty_remaining > 0
       ORDER BY CASE WHEN id = ? THEN 0 ELSE 1 END, received_at ASC, id ASC`
    )
    .all(params.companyId, params.itemId, params.warehouseId, params.preferredLotId ?? -1) as Array<{
    id: number;
    location_id: number | null;
    qty_remaining: number;
    unit_cost: number;
    received_at: string;
  }>;

  const available = lots.reduce((sum, l) => sum + l.qty_remaining, 0);
  if (available + 1e-6 < params.qty) {
    throw new Error(
      `Insufficient stock for ${item.sku} (${item.name}). Requested ${params.qty}, available ${round2(available)}.`
    );
  }

  // Compute weighted average cost across all open lots of this item in this company if WEIGHTED_AVERAGE
  let weightedAvgCost = item.standard_cost;
  if (item.valuation_method === 'WEIGHTED_AVERAGE') {
    const agg = db
      .prepare(
        `SELECT SUM(qty_remaining) AS qty, SUM(qty_remaining * unit_cost) AS val
         FROM stock_lots WHERE company_id = ? AND item_id = ? AND qty_remaining > 0`
      )
      .get(params.companyId, params.itemId) as { qty: number | null; val: number | null };
    if (agg.qty && agg.qty > 0 && agg.val !== null) {
      weightedAvgCost = agg.val / agg.qty;
    }
  }

  let remainingToIssue = params.qty;
  let totalCost = 0;

  for (const lot of lots) {
    if (remainingToIssue <= 0) break;
    const take = Math.min(remainingToIssue, lot.qty_remaining);
    const newRemaining = round2(lot.qty_remaining - take);
    db.prepare('UPDATE stock_lots SET qty_remaining = ? WHERE id = ?').run(newRemaining, lot.id);

    const costRate = item.valuation_method === 'WEIGHTED_AVERAGE' ? weightedAvgCost : lot.unit_cost;
    totalCost += take * costRate;
    remainingToIssue = round2(remainingToIssue - take);
  }

  totalCost = round2(totalCost);
  const effectiveUnitCost = round2(totalCost / params.qty);

  db.prepare(
    `INSERT INTO stock_movements
     (company_id, item_id, warehouse_id, location_id, branch_id, movement_type, qty_change, unit_cost, total_cost, reference_type, reference_id, notes, created_by)
     VALUES (?, ?, ?, NULL, ?, 'OUT', ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    params.companyId,
    params.itemId,
    params.warehouseId,
    wh.branch_id,
    -params.qty,
    effectiveUnitCost,
    totalCost,
    params.referenceType,
    params.referenceId ?? null,
    params.notes || '',
    params.userId
  );

  return { totalCost, effectiveUnitCost };
}

export function transferStockInTx(params: {
  companyId: number;
  itemId: number;
  fromWarehouseId: number;
  toWarehouseId: number;
  toLocationId?: number | null;
  qty: number;
  notes?: string;
  userId: number;
}): { transferredCost: number; fromBranchId: number; toBranchId: number } {
  if (params.fromWarehouseId === params.toWarehouseId) {
    throw new Error('Source and destination warehouses must be different.');
  }

  const fromWh = db
    .prepare('SELECT id, branch_id, name FROM warehouses WHERE id = ? AND company_id = ?')
    .get(params.fromWarehouseId, params.companyId) as { id: number; branch_id: number; name: string } | undefined;
  const toWh = db
    .prepare('SELECT id, branch_id, name FROM warehouses WHERE id = ? AND company_id = ?')
    .get(params.toWarehouseId, params.companyId) as { id: number; branch_id: number; name: string } | undefined;

  if (!fromWh || !toWh) {
    throw new Error('Invalid source or destination warehouse for this company.');
  }

  const issued = issueStockInTx({
    companyId: params.companyId,
    itemId: params.itemId,
    warehouseId: params.fromWarehouseId,
    qty: params.qty,
    referenceType: 'STOCK_TRANSFER_OUT',
    notes: `Transfer to ${toWh.name}${params.notes ? ` - ${params.notes}` : ''}`,
    userId: params.userId,
  });

  receiveStockInTx({
    companyId: params.companyId,
    itemId: params.itemId,
    warehouseId: params.toWarehouseId,
    locationId: params.toLocationId ?? null,
    qty: params.qty,
    unitCost: issued.effectiveUnitCost,
    referenceType: 'STOCK_TRANSFER_IN',
    notes: `Transfer from ${fromWh.name}${params.notes ? ` - ${params.notes}` : ''}`,
    userId: params.userId,
  });

  return {
    transferredCost: issued.totalCost,
    fromBranchId: fromWh.branch_id,
    toBranchId: toWh.branch_id,
  };
}
