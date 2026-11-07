import { orderStockWarnings, type Database } from "@masalapos/domain";
import { orderTableLabel } from "./table-label.js";
import { currentTier, spendableBalance } from "./loyalty.js";

export interface OrderRow {
  order_notes?: string;
  guest_count?: number | null;
  sold_by_id?: string | null;
  sold_by_name?: string | null;
  summary_revision?: number;
  captain_id?: string | null;
  captain_name?: string | null;
  id: string;
  client_ref: string;
  price_tier: import("@masalapos/domain").PriceTier;
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
  /** NULL for the built-in type named by `type`. */
  order_type_id?: string | null;
  /** Name snapshot of the restaurant's own type, shown on slips and bills; NULL for the built-in types. */
  order_type_name?: string | null;
  customer_id?: string | null;
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
  /** Set on an item inside a combo: the combo's own line. */
  parent_item_id: string | null;
  /** Set on an add-on line: the dish it was picked under. */
  addon_of_item_id: string | null;
  /** 1 while a pending item is held back from the kitchen (a combo's line carries it for its items). */
  held: number;
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

function orderItemJson(r: OrderItemRow) {
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
    parentItemId: r.parent_item_id,
    addonOfItemId: r.addon_of_item_id ?? null,
    held: r.held === 1,
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
  db?: Database,
) {
  // An add-on names its dish, which may be on another station's ticket.
  const dishName = (id: string | null) => {
    if (!id) return null;
    const local = items.find((i) => i.id === id);
    if (local) return local.name_snapshot;
    return (db?.prepare("SELECT name_snapshot FROM order_items WHERE id = ?").get(id) as { name_snapshot: string } | undefined)?.name_snapshot ?? null;
  };
  return {
    ...kotJson(kot),
    orderType: order.type,
    orderTypeName: order.order_type_name ?? null,
    zomatoOrderId: order.zomato_order_id ?? null,
    tableName,
    splitLabel: order.split_label,
    items: items.map((i) => ({ id: i.id, name: i.name_snapshot, qty: i.qty, note: i.note, status: i.status,
      addonOfItemId: i.addon_of_item_id ?? null, addonOfItemName: dishName(i.addon_of_item_id ?? null) })),
  };
}

/** Points the customer can spend now: expired points are left out even before a sweep records them. */
export const pointsBalance = (db: Database, customerId: string) => spendableBalance(db, customerId);

const customerTags = (db: Database, customerId: string) =>
  (db.prepare("SELECT tag FROM customer_tags WHERE customer_id = ? ORDER BY tag COLLATE NOCASE").all(customerId) as Array<{ tag: string }>).map((r) => r.tag);

/** A customer as staff screens show them: profile, tags, type name, current tier (when tiers are on) and points balance. */
export function customerJson(db: Database, id: string) {
  const row = db.prepare(`SELECT c.*, t.name AS type_name FROM customers c LEFT JOIN customer_types t ON t.id = c.type_id WHERE c.id = ?`).get(id) as
    { id: string; name: string; phone: string; type_id: string | null; notes: string | null; created_at: number; type_name: string | null;
      email: string | null; birth_date: string | null; anniversary_date: string | null; gender: "female" | "male" | "other" | null;
      marketing_opt_in: number; is_active: number; gstin: string | null; legal_name: string | null } | undefined;
  if (!row) return null;
  const tier = currentTier(db, row.id);
  return {
    id: row.id, name: row.name, phone: row.phone, typeId: row.type_id, typeName: row.type_name, notes: row.notes ?? "",
    email: row.email, birthDate: row.birth_date, anniversaryDate: row.anniversary_date, gender: row.gender,
    marketingOptIn: row.marketing_opt_in === 1, isActive: row.is_active === 1, tags: customerTags(db, row.id),
    gstin: row.gstin, legalName: row.legal_name,
    tier: tier && { id: tier.id, name: tier.name, earnMultiplier: tier.earnMultiplier },
    pointsBalance: pointsBalance(db, row.id), createdAt: row.created_at,
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
    orderTypeId: row.order_type_id ?? row.type,
    orderTypeName: row.order_type_name ?? null,
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
    customer: row.customer_id ? customerJson(db, row.customer_id) : null,
    status: row.status,
    openedBy: row.opened_by,
    notes: row.order_notes ?? "",
    guestCount: row.guest_count ?? null,
    soldById: row.sold_by_id ?? row.opened_by,
    soldByName: row.sold_by_name ?? (db.prepare("SELECT name FROM users WHERE id = ?").get(row.opened_by) as { name: string } | undefined)?.name ?? null,
    summaryRevision: row.summary_revision ?? 0,
    openedAt: row.opened_at,
    closedAt: row.closed_at,
    items: items.map(orderItemJson),
    kots: kots.map(kotJson),
    stockWarnings: orderStockWarnings(db, orderId),
  };
}
