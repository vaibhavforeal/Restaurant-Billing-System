import type { Database } from "@forkflow/domain";

// A link is active only while its order is open or billed; settled/cancelled orders release their linked tables.
export function activeLinkedTableNames(db: Database, orderId: string): string[] {
  return (db.prepare(`SELECT dt.name FROM table_links tl
    JOIN dining_tables dt ON dt.id = tl.table_id
    JOIN orders o ON o.id = tl.order_id
    WHERE tl.order_id = ? AND o.status IN ('open', 'billed')
    ORDER BY tl.linked_at, tl.id`).all(orderId) as Array<{ name: string }>).map((r) => r.name);
}

// Own table name followed by the active linked table names, e.g. "T3, T4". Parcels have no label.
export function orderTableLabel(db: Database, orderId: string): string | null {
  const own = db.prepare(`SELECT dt.name FROM orders o JOIN dining_tables dt ON dt.id = o.table_id WHERE o.id = ?`).get(orderId) as { name: string } | undefined;
  if (!own) return null;
  return [own.name, ...activeLinkedTableNames(db, orderId)].join(", ");
}

// The combined order this table is currently linked to (if any).
export function activeLinkForTable(db: Database, tableId: string): { orderId: string; status: "open" | "billed"; label: string } | null {
  const row = db.prepare(`SELECT tl.order_id AS orderId, o.status FROM table_links tl
    JOIN orders o ON o.id = tl.order_id
    WHERE tl.table_id = ? AND o.status IN ('open', 'billed')
    ORDER BY (o.status = 'open') DESC, tl.linked_at, tl.id LIMIT 1`).get(tableId) as { orderId: string; status: "open" | "billed" } | undefined;
  return row ? { orderId: row.orderId, status: row.status, label: orderTableLabel(db, row.orderId)! } : null;
}
