import type { Database } from "@forkflow/domain";

export interface OrderRow {
  id: string;
  client_ref: string;
  type: "dine_in" | "parcel";
  table_id: string | null;
  status: "open" | "billed" | "settled" | "cancelled";
  opened_by: string;
  opened_at: number;
  closed_at: number | null;
}

export interface OrderItemRow {
  id: string;
  order_id: string;
  client_ref: string | null;
  product_id: string;
  variant_id: string | null;
  name_snapshot: string;
  price_paise_snapshot: number;
  gst_rate_snapshot: number;
  qty: number;
  status: "pending" | "sent" | "cancelled";
  note: string | null;
  cancel_reason: string | null;
  kot_id: string | null;
  cancelled_by: string | null;
}

export interface KotRow {
  id: string;
  kot_no: number;
  station_id: string;
  order_id: string;
  created_at: number;
  done_at: number | null;
}

export function orderItemJson(r: OrderItemRow) {
  return {
    id: r.id,
    clientRef: r.client_ref,
    productId: r.product_id,
    variantId: r.variant_id,
    name: r.name_snapshot,
    pricePaise: r.price_paise_snapshot,
    gstRate: r.gst_rate_snapshot,
    qty: r.qty,
    status: r.status,
    note: r.note,
    cancelReason: r.cancel_reason,
    kotId: r.kot_id,
  };
}

export function kotJson(r: KotRow) {
  return {
    id: r.id,
    kotNo: r.kot_no,
    stationId: r.station_id,
    orderId: r.order_id,
    createdAt: r.created_at,
    doneAt: r.done_at,
  };
}

export function kotWithContextJson(
  kot: KotRow,
  order: OrderRow,
  tableName: string | null,
  items: OrderItemRow[],
) {
  return {
    ...kotJson(kot),
    orderType: order.type,
    tableName,
    items: items.map((i) => ({ id: i.id, name: i.name_snapshot, qty: i.qty, note: i.note, status: i.status })),
  };
}

export function loadOrderJson(db: Database, orderId: string) {
  const order = db.prepare("SELECT * FROM orders WHERE id = ?").get(orderId) as OrderRow | undefined;
  if (!order) return null;

  const items = db
    .prepare("SELECT * FROM order_items WHERE order_id = ? ORDER BY id")
    .all(orderId) as OrderItemRow[];

  const kots = db
    .prepare("SELECT * FROM kots WHERE order_id = ? ORDER BY created_at")
    .all(orderId) as KotRow[];

  return {
    id: order.id,
    clientRef: order.client_ref,
    type: order.type,
    tableId: order.table_id,
    status: order.status,
    openedBy: order.opened_by,
    openedAt: order.opened_at,
    closedAt: order.closed_at,
    items: items.map(orderItemJson),
    kots: kots.map(kotJson),
  };
}
