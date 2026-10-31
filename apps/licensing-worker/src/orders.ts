import type { Plan } from "@masalapos/domain/licensing";
import type { ModuleOverrides } from "@masalapos/domain/modules";
import { addMonths, DAY_MS, GRACE_MS } from "./dates.js";
import type { D1Like } from "./env.js";
import { parseOverrides } from "./store.js";

export type OrderKind = "new" | "renewal" | "trial";
export type OrderStatus = "draft" | "confirmed" | "paid" | "cancelled";

/** An order as licensing needs it: what it sells and whether it may activate counters yet. */
export interface LicensingOrder {
  id: string; code: string; customerId: string; customerCode: string; customerName: string;
  kind: OrderKind; plan: Plan; termMonths: number | null; termDays: number | null;
  outlets: number; seatsUsed: number; maxDevices: number; modules: ModuleOverrides;
  status: OrderStatus; creditUntil: number | null;
}

const ORDER_COLUMNS = `o.id, o.code, o.customer_id AS customerId, c.code AS customerCode, c.business_name AS customerName, o.kind, o.plan,
  o.term_months AS termMonths, o.term_days AS termDays, o.outlets, o.seats_used AS seatsUsed, o.max_devices AS maxDevices, o.modules,
  o.status, o.credit_until AS creditUntil`;
type OrderRecord = Omit<LicensingOrder, "modules"> & { modules: string };
const toOrder = (row: OrderRecord | null): LicensingOrder | null => row && { ...row, modules: parseOverrides(row.modules) };

/** The order with this Order ID, but only when it belongs to the customer with this Customer ID. */
export async function orderByCodes(db: D1Like, customerCode: string, orderCode: string): Promise<LicensingOrder | null> {
  return toOrder(await db.prepare(`SELECT ${ORDER_COLUMNS} FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.code = ? AND c.code = ?`)
    .bind(orderCode, customerCode).first<OrderRecord>());
}

export async function orderById(db: D1Like, id: string): Promise<LicensingOrder | null> {
  return toOrder(await db.prepare(`SELECT ${ORDER_COLUMNS} FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.id = ?`).bind(id).first<OrderRecord>());
}

/** Why an order cannot activate a counter right now, or null when it can. */
export function activationBlocker(order: LicensingOrder, now: number): "order_cancelled" | "order_not_ready" | "not_paid" | "renewal_order" | null {
  if (order.kind === "renewal") return "renewal_order";
  if (order.status === "cancelled") return "order_cancelled";
  if (order.status === "draft") return "order_not_ready";
  if (order.status === "paid" || order.kind === "trial") return null;
  return order.creditUntil !== null && order.creditUntil > now ? null : "not_paid";
}

export interface LicenceTerms { plan: Plan; expiresAt: number; graceUntil: number; trial: boolean }

/**
 * The licence an order grants a counter activated at `start`. A trial runs its days with no grace; a paid order its months plus grace;
 * an order on credit only to its credit date (plus grace), and the full term once it is paid.
 */
export function orderTerms(order: LicensingOrder, start: number): LicenceTerms {
  if (order.kind === "trial") {
    const expiresAt = start + order.termDays! * DAY_MS;
    return { plan: order.plan, expiresAt, graceUntil: expiresAt, trial: true };
  }
  const full = addMonths(start, order.termMonths!);
  const expiresAt = order.status === "paid" || order.creditUntil === null ? full : Math.min(full, order.creditUntil);
  return { plan: order.plan, expiresAt, graceUntil: expiresAt + GRACE_MS, trial: false };
}
