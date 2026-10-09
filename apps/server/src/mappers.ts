import { orderStockWarnings, type Database } from "@forkflow/domain";
import { orderTableLabel } from "./table-label.js";

export interface OrderRow {
  captain_id?: string | null;
  captain_name?: string | null;
  id: string;
  client_ref: string;
  price_tier: import("@forkflow/domain").PriceTier;
  type: "dine_in" | "parcel" | "zomato";
  zomato_order_id?: string | null;
  zomato_status?: "preparing" | "ready" | "picked_up" | null;
  table_id: string | null;
  split_label: string | null;
  status: "open" | "billed" | "settled" | "cancelled";
  opened_by: string;
  opened_at: number;
  closed_at: number | null;
  merged_into?: string | null;
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
  accepted_at: number | null;
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
    acceptedAt: r.accepted_at,
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
    splitLabel: order.split_label,
    items: items.map((i) => ({ id: i.id, name: i.name_snapshot, qty: i.qty, note: i.note, status: i.status })),
  };
}

export function loadOrderJson(db: Database, orderId: string) {
  const row = db
    .prepare(
      `SELECT o.*, dt.name AS table_name
       FROM orders o
       LEFT JOIN dining_tables dt ON dt.id = o.table_id
       WHERE o.id = ?`
    )
    .get(orderId) as (OrderRow & { table_name: string | null }) | undefined;

  if (!row) return null;

  const items = db
    .prepare("SELECT * FROM order_items WHERE order_id = ? ORDER BY id")
    .all(orderId) as OrderItemRow[];

  const kots = db
    .prepare("SELECT * FROM kots WHERE order_id = ? ORDER BY created_at")
    .all(orderId) as KotRow[];

  return {
    id: row.id,
    clientRef: row.client_ref,
    type: row.type,
    priceTier: row.price_tier,
    zomatoOrderId: row.zomato_order_id ?? null,
    zomatoStatus: row.zomato_status ?? null,
    tableId: row.table_id,
    splitLabel: row.split_label,
    tableName: row.table_name,
    tableLabel: orderTableLabel(db, row.id),
    captainId: row.captain_id ?? null,
    captainName: row.captain_name ?? null,
    mergedInto: row.merged_into ?? null,
    status: row.status,
    openedBy: row.opened_by,
    openedAt: row.opened_at,
    closedAt: row.closed_at,
    items: items.map(orderItemJson),
    kots: kots.map(kotJson),
    stockWarnings: orderStockWarnings(db, orderId),
  };
}
