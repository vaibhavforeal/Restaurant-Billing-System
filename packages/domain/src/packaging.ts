import type { Database } from "./db.js";

/**
 * Each billed line's packaging on a takeaway or delivery parcel, by order item id: the variant's amount (or the
 * product's when the variant has none) times qty. Empty when "Charge packaging per item" is off or the order is not a
 * takeaway or delivery parcel. Combo children, add-ons and cancelled items are left out; a combo uses its own amount.
 */
export function orderItemPackaging(db: Database, orderId: string): Map<string, number> {
  const { packaging_per_item: perItem } = db.prepare("SELECT packaging_per_item FROM settings WHERE id = 1").get() as { packaging_per_item: number };
  if (!perItem) return new Map();
  const order = db.prepare("SELECT o.type, t.kind FROM orders o LEFT JOIN order_types t ON t.id = COALESCE(o.order_type_id, o.type) WHERE o.id = ?").get(orderId) as
    { type: string; kind: string | null } | undefined;
  if (order?.type !== "parcel" || (order.kind !== "takeaway" && order.kind !== "delivery")) return new Map();
  const rows = db.prepare(`SELECT oi.id, COALESCE(v.packaging_paise, p.packaging_paise) * oi.qty AS packaging
    FROM order_items oi JOIN products p ON p.id = oi.product_id LEFT JOIN variants v ON v.id = oi.variant_id
    WHERE oi.order_id = ? AND oi.status != 'cancelled' AND oi.parent_item_id IS NULL AND oi.addon_of_item_id IS NULL ORDER BY oi.id`).all(orderId) as Array<{ id: string; packaging: number }>;
  return new Map(rows.map((row) => [row.id, row.packaging]));
}
