import type { Database } from "./db.js";
import { uuidv7 } from "./id.js";
import { blendUnitCost, moveCostPaise } from "./costing.js";
import { stockMilli, type StockItem, type StockUnit, type StockWarning } from "./stock-schemas.js";

export interface StockRow {
  id: string; name: string; unit: StockUnit; qty: number; low_stock_threshold: number | null;
  is_active: number; version: number; client_ref: string | null; request_json: string | null;
  unit_cost_milli_paise: number | null;
}
export function stockJson(row: StockRow): StockItem {
  return { id: row.id, name: row.name, unit: row.unit, qty: row.qty, lowStockThreshold: row.low_stock_threshold,
    isActive: row.is_active === 1, isLow: row.qty <= (row.low_stock_threshold ?? 0), version: row.version };
}
function requireTransaction(db: Database) {
  if (!db.inTransaction) throw new Error("Stock writes require a transaction");
}

/** Caller owns the enclosing order/bill/manual-operation transaction. */
export function appendStockMove(db: Database, input: {
  stockItemId: string; delta: number; reason: "sale" | "purchase" | "adjustment" | "wastage" | "cancel_reversal";
  actorId: string; note?: string | null; orderItemId?: string | null; reversalOf?: string | null;
  /** A partial return: the sale move this reversal reduces (KOT edit quantity cut). */
  partialOf?: string | null;
  clientRef?: string | null; requestJson?: string | null;
  /** Purchases: amount paid (paise) blended into the average. Reversals: the frozen cost being undone (may be null). */
  costPaise?: number | null;
}): string {
  requireTransaction(db);
  const row = db.prepare("SELECT qty, unit_cost_milli_paise FROM stock_items WHERE id = ?").get(input.stockItemId) as
    { qty: number; unit_cost_milli_paise: number | null } | undefined;
  if (!row) throw new Error("Stock item not found");
  const delta = stockMilli(input.delta);
  if (!delta) throw new Error("Stock movement cannot be zero");
  const after = (stockMilli(row.qty) + delta) / 1000;
  stockMilli(after);
  let unitCost = row.unit_cost_milli_paise;
  let costPaise: number | null;
  if (input.costPaise === undefined) costPaise = moveCostPaise(delta, unitCost);
  else if (input.reason === "purchase") {
    if (input.costPaise === null) throw new Error("A purchase cost cannot be unknown");
    costPaise = input.costPaise;
    unitCost = blendUnitCost(stockMilli(row.qty), unitCost, delta, input.costPaise);
  } else if (input.reason === "cancel_reversal") costPaise = input.costPaise;
  else throw new Error("Cost can only be given for purchases and reversals");
  const id = uuidv7();
  db.prepare(`INSERT INTO stock_moves (id, stock_item_id, delta, reason, ref, note, created_at, created_by,
    order_item_id, reversal_of, client_ref, request_json, balance_after, cost_paise, unit_cost_after, partial_of)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    id, input.stockItemId, delta / 1000, input.reason, input.orderItemId ?? null, input.note ?? null, Date.now(), input.actorId,
    input.orderItemId ?? null, input.reversalOf ?? null, input.clientRef ?? null, input.requestJson ?? null, after, costPaise, unitCost, input.partialOf ?? null,
  );
  db.prepare("UPDATE stock_items SET qty = ?, unit_cost_milli_paise = ?, version = version + 1 WHERE id = ?").run(after, unitCost, input.stockItemId);
  return id;
}

/** Called while order items are still pending; historical rows make repeat calls harmless. */
export function consumeStock(db: Database, orderItemIds: string[], actorId: string): string[] {
  requireTransaction(db);
  const changed = new Set<string>();
  for (const id of new Set(orderItemIds)) {
    const item = db.prepare("SELECT product_id, qty, status FROM order_items WHERE id = ?").get(id) as { product_id: string; qty: number; status: string } | undefined;
    if (!item) throw new Error("Order item not found");
    if (item.status !== "pending") continue;
    const links = db.prepare("SELECT stock_item_id, qty_per_sale FROM product_stock_links WHERE product_id = ? ORDER BY id").all(item.product_id) as Array<{ stock_item_id: string; qty_per_sale: number }>;
    for (const link of links) {
      if (db.prepare("SELECT id FROM stock_moves WHERE order_item_id = ? AND stock_item_id = ? AND reason = 'sale'").get(id, link.stock_item_id)) continue;
      const quantity = stockMilli(link.qty_per_sale) * item.qty;
      if (quantity <= 0 || !Number.isSafeInteger(quantity)) throw new Error("Invalid product stock quantity");
      appendStockMove(db, { stockItemId: link.stock_item_id, delta: -quantity / 1000, reason: "sale", actorId, orderItemId: id });
      changed.add(link.stock_item_id);
    }
  }
  return [...changed];
}

/** Reverse saved sale quantities, never the product's current links. */
export function reverseStock(db: Database, orderItemId: string, actorId: string, note: string): string[] {
  requireTransaction(db);
  const changed = new Set<string>();
  // What is still consumed: the sale less any partial returns from earlier KOT edits.
  for (const move of unreversedSales(db, orderItemId)) {
    if (!move.remainingMilli) continue;
    appendStockMove(db, {
      stockItemId: move.stock_item_id, delta: move.remainingMilli / 1000, reason: "cancel_reversal", actorId, note, orderItemId, reversalOf: move.id,
      costPaise: move.remainingCost,
    });
    changed.add(move.stock_item_id);
  }
  return [...changed];
}

/** An order item's sale moves that are not fully reversed, with the quantity (milli-units, positive) and cost still consumed. */
function unreversedSales(db: Database, orderItemId: string) {
  const moves = db.prepare(`SELECT m.id, m.stock_item_id, m.delta, m.cost_paise,
      COALESCE((SELECT SUM(p.delta) FROM stock_moves p WHERE p.partial_of = m.id), 0) AS returned,
      (SELECT SUM(p.cost_paise) FROM stock_moves p WHERE p.partial_of = m.id) AS returned_cost
    FROM stock_moves m WHERE m.order_item_id = ? AND m.reason = 'sale'
    AND NOT EXISTS (SELECT 1 FROM stock_moves r WHERE r.reversal_of = m.id) ORDER BY m.id`).all(orderItemId) as Array<{
      id: string; stock_item_id: string; delta: number; cost_paise: number | null; returned: number; returned_cost: number | null }>;
  return moves.map((m) => ({
    id: m.id, stock_item_id: m.stock_item_id,
    remainingMilli: -stockMilli(m.delta) - stockMilli(m.returned),
    remainingCost: m.cost_paise === null ? null : 0 - m.cost_paise - (m.returned_cost ?? 0),
  }));
}

/**
 * A sent item's quantity is cut from `currentQty` to `currentQty - removedQty`: its stock for the removed units comes back,
 * recorded against the cancelled item that holds them (`cancelledItemId`). Each sale move keeps exactly the share of the
 * units still on the order, so a later full cancel returns only the rest.
 */
export function returnPartialStock(db: Database, input: {
  orderItemId: string; cancelledItemId: string; currentQty: number; removedQty: number; actorId: string; note: string;
}): string[] {
  requireTransaction(db);
  if (!Number.isInteger(input.removedQty) || input.removedQty <= 0 || input.removedQty >= input.currentQty) throw new Error("Invalid quantity cut");
  const changed = new Set<string>();
  for (const move of unreversedSales(db, input.orderItemId)) {
    const milli = move.remainingMilli * input.removedQty / input.currentQty;
    if (!Number.isSafeInteger(milli) || milli <= 0) continue;
    appendStockMove(db, {
      stockItemId: move.stock_item_id, delta: milli / 1000, reason: "cancel_reversal", actorId: input.actorId, note: input.note,
      orderItemId: input.cancelledItemId, partialOf: move.id,
      costPaise: move.remainingCost === null ? null : Math.round(move.remainingCost * input.removedQty / input.currentQty),
    });
    changed.add(move.stock_item_id);
  }
  return [...changed];
}

export function orderStockWarnings(db: Database, orderId: string): StockWarning[] {
  return db.prepare(`SELECT DISTINCT s.id, s.name, s.unit, s.qty, s.low_stock_threshold AS lowStockThreshold FROM stock_items s
    WHERE s.is_active = 1 AND s.qty <= COALESCE(s.low_stock_threshold, 0) AND (
      EXISTS (SELECT 1 FROM order_items oi JOIN product_stock_links l ON l.product_id = oi.product_id
        WHERE oi.order_id = ? AND oi.status = 'pending' AND l.stock_item_id = s.id)
      OR EXISTS (SELECT 1 FROM order_items oi JOIN stock_moves m ON m.order_item_id = oi.id
        WHERE oi.order_id = ? AND oi.status = 'sent' AND m.reason = 'sale' AND m.stock_item_id = s.id)
    ) ORDER BY s.name`).all(orderId, orderId) as StockWarning[];
}
