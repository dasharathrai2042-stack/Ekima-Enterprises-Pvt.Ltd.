import { Router } from 'express';
import {
  db,
  getIdempotentResponse,
  round2,
  saveIdempotentResponse,
  withTransaction,
  writeAuditLog,
} from './db.ts';
import { assertCompanyAccess, requireAuth, type AuthedRequest } from './auth.ts';
import { issueStockInTx, receiveStockInTx, transferStockInTx } from './inventory.ts';
import { getAccountByCode, postJournalEntryInTx } from './accounting.ts';

export const inventoryRouter = Router();

function sendError(res: any, err: any) {
  res.status(err?.statusCode || 400).json({ error: err?.message || 'Inventory operation failed.' });
}

// Warehouses & Stock Locations
inventoryRouter.get('/companies/:companyId/warehouses', requireAuth, (req: AuthedRequest, res) => {
  try {
    const companyId = Number(req.params.companyId);
    assertCompanyAccess(req.user!, companyId);
    const warehouses = db
      .prepare(
        `SELECT w.id, w.company_id AS companyId, w.branch_id AS branchId, w.code, w.name, b.name AS branchName
         FROM warehouses w
         JOIN branches b ON b.id = w.branch_id
         WHERE w.company_id = ?
         ORDER BY w.id ASC`
      )
      .all(companyId) as Array<any>;

    const result = warehouses.map((w) => {
      const locations = db
        .prepare('SELECT id, warehouse_id AS warehouseId, code, name FROM stock_locations WHERE warehouse_id = ? ORDER BY code ASC')
        .all(w.id);
      return { ...w, locations };
    });
    res.json(result);
  } catch (err) {
    sendError(res, err);
  }
});

// Inventory items with real-time on-hand qty, FIFO valuation, and Weighted Average cost
inventoryRouter.get('/companies/:companyId/items', requireAuth, (req: AuthedRequest, res) => {
  try {
    const companyId = Number(req.params.companyId);
    assertCompanyAccess(req.user!, companyId);
    const branchId = req.query.branchId ? Number(req.query.branchId) : null;

    const items = db
      .prepare(
        `SELECT id, company_id AS companyId, sku, name, category, unit,
                valuation_method AS valuationMethod, tracking_type AS trackingType,
                standard_sale_price AS standardSalePrice, standard_cost AS standardCost,
                reorder_level AS reorderLevel, reorder_qty AS reorderQty
         FROM inventory_items WHERE company_id = ? ORDER BY name ASC`
      )
      .all(companyId) as Array<any>;

    const enriched = items.map((item) => {
      const lotAgg = branchId
        ? (db
            .prepare(
              `SELECT COALESCE(SUM(qty_remaining), 0) AS qty, COALESCE(SUM(qty_remaining * unit_cost), 0) AS val
               FROM stock_lots WHERE company_id = ? AND item_id = ? AND branch_id = ? AND qty_remaining > 0`
            )
            .get(companyId, item.id, branchId) as { qty: number; val: number })
        : (db
            .prepare(
              `SELECT COALESCE(SUM(qty_remaining), 0) AS qty, COALESCE(SUM(qty_remaining * unit_cost), 0) AS val
               FROM stock_lots WHERE company_id = ? AND item_id = ? AND qty_remaining > 0`
            )
            .get(companyId, item.id) as { qty: number; val: number });

      const onHandQty = round2(lotAgg.qty || 0);
      const valuationAmount = round2(lotAgg.val || 0);
      const weightedAvgCost = onHandQty > 0 ? round2(valuationAmount / onHandQty) : item.standardCost;

      return {
        ...item,
        onHandQty,
        valuationAmount,
        weightedAvgCost,
        needsReorder: onHandQty <= item.reorderLevel,
      };
    });

    res.json(enriched);
  } catch (err) {
    sendError(res, err);
  }
});

inventoryRouter.post('/companies/:companyId/items', requireAuth, (req: AuthedRequest, res) => {
  try {
    const companyId = Number(req.params.companyId);
    const user = req.user!;
    assertCompanyAccess(user, companyId);
    const {
      sku,
      name,
      category = 'General',
      unit = 'PCS',
      valuationMethod = 'FIFO',
      trackingType = 'NONE',
      standardSalePrice = 0,
      standardCost = 0,
      reorderLevel = 5,
      reorderQty = 10,
    } = req.body || {};

    if (!sku || !name) {
      res.status(400).json({ error: 'SKU and item name are required.' });
      return;
    }

    const r = db
      .prepare(
        `INSERT INTO inventory_items
         (company_id, sku, name, category, unit, valuation_method, tracking_type, standard_sale_price, standard_cost, reorder_level, reorder_qty)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        companyId,
        String(sku).trim().toUpperCase(),
        String(name).trim(),
        String(category).trim(),
        String(unit).trim().toUpperCase(),
        valuationMethod,
        trackingType,
        Number(standardSalePrice) || 0,
        Number(standardCost) || 0,
        Number(reorderLevel) || 0,
        Number(reorderQty) || 0
      );

    writeAuditLog({
      companyId,
      userId: user.id,
      userName: user.fullName,
      userRole: user.role,
      action: 'ITEM_CREATED',
      entityType: 'inventory_item',
      entityId: String(sku).trim().toUpperCase(),
      summary: `Created item "${name}" (${valuationMethod}, tracking: ${trackingType})`,
    });
    res.status(201).json({ id: Number(r.lastInsertRowid), sku, name });
  } catch (err) {
    sendError(res, err);
  }
});

// Stock Lots Registry (VIN, Engine, Serial, Batch tracking)
inventoryRouter.get('/companies/:companyId/stock-lots', requireAuth, (req: AuthedRequest, res) => {
  try {
    const companyId = Number(req.params.companyId);
    assertCompanyAccess(req.user!, companyId);
    const search = String(req.query.q || '').trim().toLowerCase();

    const rows = db
      .prepare(
        `SELECT sl.id, sl.company_id AS companyId, sl.item_id AS itemId, i.sku AS itemSku, i.name AS itemName,
                i.tracking_type AS trackingType, i.valuation_method AS valuationMethod,
                sl.warehouse_id AS warehouseId, w.name AS warehouseName,
                sl.location_id AS locationId, loc.code AS locationCode,
                sl.branch_id AS branchId, b.name AS branchName,
                sl.batch_number AS batchNumber, sl.serial_number AS serialNumber,
                sl.vin_number AS vinNumber, sl.engine_number AS engineNumber,
                sl.expiry_date AS expiryDate, sl.qty_initial AS qtyInitial,
                sl.qty_remaining AS qtyRemaining, sl.unit_cost AS unitCost, sl.received_at AS receivedAt
         FROM stock_lots sl
         JOIN inventory_items i ON i.id = sl.item_id
         JOIN warehouses w ON w.id = sl.warehouse_id
         JOIN branches b ON b.id = sl.branch_id
         LEFT JOIN stock_locations loc ON loc.id = sl.location_id
         WHERE sl.company_id = ?
         ORDER BY sl.qty_remaining DESC, sl.received_at DESC`
      )
      .all(companyId) as Array<any>;

    const filtered = search
      ? rows.filter((r) =>
          [r.itemSku, r.itemName, r.batchNumber, r.serialNumber, r.vinNumber, r.engineNumber, r.warehouseName]
            .filter(Boolean)
            .some((v) => String(v).toLowerCase().includes(search))
        )
      : rows;

    res.json(filtered);
  } catch (err) {
    sendError(res, err);
  }
});

// Stock movements ledger
inventoryRouter.get('/companies/:companyId/stock-movements', requireAuth, (req: AuthedRequest, res) => {
  try {
    const companyId = Number(req.params.companyId);
    assertCompanyAccess(req.user!, companyId);
    const rows = db
      .prepare(
        `SELECT sm.id, sm.movement_type AS movementType, sm.qty_change AS qtyChange,
                sm.unit_cost AS unitCost, sm.total_cost AS totalCost,
                sm.reference_type AS referenceType, sm.notes, sm.created_at AS createdAt,
                i.sku AS itemSku, i.name AS itemName, w.name AS warehouseName, b.name AS branchName
         FROM stock_movements sm
         JOIN inventory_items i ON i.id = sm.item_id
         JOIN warehouses w ON w.id = sm.warehouse_id
         JOIN branches b ON b.id = sm.branch_id
         WHERE sm.company_id = ?
         ORDER BY sm.id DESC LIMIT 120`
      )
      .all(companyId);
    res.json(rows);
  } catch (err) {
    sendError(res, err);
  }
});

// Inter-branch / inter-warehouse stock transfer (transaction-safe & idempotent)
inventoryRouter.post('/companies/:companyId/stock-transfers', requireAuth, (req: AuthedRequest, res) => {
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

    const { itemId, fromWarehouseId, toWarehouseId, toLocationId, qty, notes } = req.body || {};
    if (!itemId || !fromWarehouseId || !toWarehouseId || !qty) {
      res.status(400).json({ error: 'Item, source warehouse, destination warehouse, and quantity are required.' });
      return;
    }

    const result = withTransaction(() => {
      const tr = transferStockInTx({
        companyId,
        itemId: Number(itemId),
        fromWarehouseId: Number(fromWarehouseId),
        toWarehouseId: Number(toWarehouseId),
        toLocationId: toLocationId ? Number(toLocationId) : null,
        qty: Number(qty),
        notes: notes || '',
        userId: user.id,
      });

      // If transfer crosses branches, post balanced inter-branch inventory reclassification JE
      if (tr.fromBranchId !== tr.toBranchId && tr.transferredCost > 0) {
        const invAcct = getAccountByCode(companyId, '1300');
        postJournalEntryInTx({
          companyId,
          entryDate: new Date().toISOString().slice(0, 10),
          referenceType: 'STOCK_TRANSFER',
          description: `Inter-branch inventory transfer (${qty} units, value ${tr.transferredCost.toFixed(2)})`,
          lines: [
            { accountId: invAcct.id, branchId: tr.toBranchId, debit: tr.transferredCost, credit: 0, memo: 'Inventory received from branch' },
            { accountId: invAcct.id, branchId: tr.fromBranchId, debit: 0, credit: tr.transferredCost, memo: 'Inventory dispatched to branch' },
          ],
          createdBy: user.id,
          createdByName: user.fullName,
          createdByRole: user.role,
          forceStatus: 'POSTED',
        });
      }

      writeAuditLog({
        companyId,
        branchId: tr.fromBranchId,
        userId: user.id,
        userName: user.fullName,
        userRole: user.role,
        action: 'STOCK_TRANSFER',
        entityType: 'inventory_item',
        entityId: itemId,
        summary: `Transferred ${qty} units (NPR ${tr.transferredCost.toFixed(2)}) from WH#${fromWarehouseId} to WH#${toWarehouseId}`,
      });

      const payload = { ok: true, ...tr };
      saveIdempotentResponse(idemKey, 'POST /stock-transfers', companyId, payload);
      return payload;
    });

    res.status(201).json(result);
  } catch (err) {
    sendError(res, err);
  }
});

// Inventory Reconciliation (Physical Count vs System Qty -> adjusts stock lots + posts GL variance!)
inventoryRouter.post('/companies/:companyId/stock-reconcile', requireAuth, (req: AuthedRequest, res) => {
  try {
    const companyId = Number(req.params.companyId);
    const user = req.user!;
    assertCompanyAccess(user, companyId);

    const { itemId, warehouseId, countedQty, unitCost, notes } = req.body || {};
    if (!itemId || !warehouseId || countedQty === undefined) {
      res.status(400).json({ error: 'Item, warehouse, and physical counted quantity are required.' });
      return;
    }

    const result = withTransaction(() => {
      const wh = db
        .prepare('SELECT id, branch_id, name FROM warehouses WHERE id = ? AND company_id = ?')
        .get(Number(warehouseId), companyId) as { id: number; branch_id: number; name: string } | undefined;
      if (!wh) throw new Error('Warehouse not found.');

      const item = db
        .prepare('SELECT id, sku, name, standard_cost FROM inventory_items WHERE id = ? AND company_id = ?')
        .get(Number(itemId), companyId) as { id: number; sku: string; name: string; standard_cost: number } | undefined;
      if (!item) throw new Error('Item not found.');

      const agg = db
        .prepare(
          `SELECT COALESCE(SUM(qty_remaining), 0) AS qty FROM stock_lots WHERE company_id = ? AND item_id = ? AND warehouse_id = ? AND qty_remaining > 0`
        )
        .get(companyId, item.id, wh.id) as { qty: number };

      const systemQty = round2(agg.qty || 0);
      const targetQty = round2(Number(countedQty));
      const diff = round2(targetQty - systemQty);

      if (Math.abs(diff) < 0.0001) {
        return { systemQty, countedQty: targetQty, varianceQty: 0, varianceValue: 0, message: 'Stock matches physical count. No adjustment required.' };
      }

      const invAcct = getAccountByCode(companyId, '1300');
      const adjAcct = getAccountByCode(companyId, '6200');
      let varianceValue = 0;

      if (diff > 0) {
        const rate = Number(unitCost) > 0 ? Number(unitCost) : item.standard_cost;
        const rec = receiveStockInTx({
          companyId,
          itemId: item.id,
          warehouseId: wh.id,
          qty: diff,
          unitCost: rate,
          referenceType: 'INVENTORY_RECONCILIATION',
          notes: notes || `Physical count surplus (+${diff})`,
          userId: user.id,
        });
        varianceValue = rec.totalCost;
        postJournalEntryInTx({
          companyId,
          entryDate: new Date().toISOString().slice(0, 10),
          referenceType: 'INVENTORY_RECONCILIATION',
          description: `Inventory Surplus Reconciliation: ${item.sku} (+${diff} at ${wh.name})`,
          lines: [
            { accountId: invAcct.id, branchId: wh.branch_id, debit: varianceValue, credit: 0, memo: 'Inventory surplus adjustment' },
            { accountId: adjAcct.id, branchId: wh.branch_id, debit: 0, credit: varianceValue, memo: 'Reconciliation gain/offset' },
          ],
          createdBy: user.id,
          createdByName: user.fullName,
          createdByRole: user.role,
          forceStatus: 'POSTED',
        });
      } else {
        const iss = issueStockInTx({
          companyId,
          itemId: item.id,
          warehouseId: wh.id,
          qty: Math.abs(diff),
          referenceType: 'INVENTORY_RECONCILIATION',
          notes: notes || `Physical count shrinkage (${diff})`,
          userId: user.id,
        });
        varianceValue = -iss.totalCost;
        postJournalEntryInTx({
          companyId,
          entryDate: new Date().toISOString().slice(0, 10),
          referenceType: 'INVENTORY_RECONCILIATION',
          description: `Inventory Shrinkage Reconciliation: ${item.sku} (${diff} at ${wh.name})`,
          lines: [
            { accountId: adjAcct.id, branchId: wh.branch_id, debit: iss.totalCost, credit: 0, memo: 'Inventory shrinkage write-off' },
            { accountId: invAcct.id, branchId: wh.branch_id, debit: 0, credit: iss.totalCost, memo: 'Reduce stock valuation' },
          ],
          createdBy: user.id,
          createdByName: user.fullName,
          createdByRole: user.role,
          forceStatus: 'POSTED',
        });
      }

      return { systemQty, countedQty: targetQty, varianceQty: diff, varianceValue };
    });

    res.json(result);
  } catch (err) {
    sendError(res, err);
  }
});
