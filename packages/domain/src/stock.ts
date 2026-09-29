import type { Database } from "./db.js";
import { uuidv7 } from "./id.js";
import { stockMilli, type StockItem, type StockUnit, type StockWarning } from "./stock-schemas.js";

export interface StockRow {
  id: string; name: string; unit: StockUnit; qty: number; low_stock_threshold: number | null;
  is_active: number; version: number; client_ref: string | null; request_json: string | null;
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
  clientRef?: string | null; requestJson?: string | null;
}): string {
  requireTransaction(db);
  const row = db.prepare("SELECT qty FROM stock_items WHERE id = ?").get(input.stockItemId) as { qty: number } | undefined;
  if (!row) throw new Error("Stock item not found");
  const delta = stockMilli(input.delta);
  if (!delta) throw new Error("Stock movement cannot be zero");
  const after = (stockMilli(row.qty) + delta) / 1000;
  stockMilli(after);
  const id = uuidv7();
  db.prepare(`INSERT INTO stock_moves (id, stock_item_id, delta, reason, ref, note, created_at, created_by,
    order_item_id, reversal_of, client_ref, request_json, balance_after) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    id, input.stockItemId, delta / 1000, input.reason, input.orderItemId ?? null, input.note ?? null, Date.now(), input.actorId,
    input.orderItemId ?? null, input.reversalOf ?? null, input.clientRef ?? null, input.requestJson ?? null, after,
  );
  db.prepare("UPDATE stock_items SET qty = ?, version = version + 1 WHERE id = ?").run(after, input.stockItemId);
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
  const moves = db.prepare(`SELECT m.id, m.stock_item_id, m.delta FROM stock_moves m WHERE m.order_item_id = ? AND m.reason = 'sale'
    AND NOT EXISTS (SELECT 1 FROM stock_moves r WHERE r.reversal_of = m.id) ORDER BY m.id`).all(orderItemId) as Array<{ id: string; stock_item_id: string; delta: number }>;
  for (const move of moves) appendStockMove(db, { stockItemId: move.stock_item_id, delta: -move.delta, reason: "cancel_reversal", actorId, note, orderItemId, reversalOf: move.id });
  return [...new Set(moves.map((move) => move.stock_item_id))];
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
