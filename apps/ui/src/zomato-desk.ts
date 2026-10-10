import { useRef, useState } from "react";
import type { PaymentMode } from "@forkflow/domain";
import { receiptGstMode } from "@forkflow/domain/gst";
import { ApiError, apiFetch } from "./api";
import type { Order } from "./types";
import { uuid } from "./uuid";

export type ZomatoNext = "ready" | "picked_up";
export type ZomatoTone = "ok" | "warn" | "late";

/** Pill wording for a Zomato order; a null status is a new order. */
export const ZOMATO_PILL = { new: "New", preparing: "Preparing", ready: "Ready", picked_up: "Picked up" } as const;

/** How a Zomato order is named on screens and tickets. */
export function zomatoLabel(zomatoOrderId: string | null | undefined): string {
  return `Zomato #${zomatoOrderId ?? ""}`;
}

/** The location line of a kitchen ticket. */
export function kitchenContextLabel(kot: { orderType: "dine_in" | "parcel" | "zomato"; tableName: string | null; splitLabel: string | null; zomatoOrderId?: string | null }): string {
  if (kot.orderType === "zomato") return zomatoLabel(kot.zomatoOrderId);
  if (kot.orderType === "parcel") return "Parcel";
  return kot.splitLabel && kot.splitLabel !== "A" ? `${kot.tableName ?? "Table"} · ${kot.splitLabel}` : kot.tableName ?? "Table";
}

/** The "Table / parcel" cell of a bill, from its receipt snapshot. */
export function billContextLabel(receipt: { orderType: "dine_in" | "parcel" | "zomato"; tableName: string | null; splitLabel: string | null; zomatoOrderId?: string | undefined }): string {
  if (receipt.orderType === "zomato") return zomatoLabel(receipt.zomatoOrderId);
  if (receipt.orderType === "parcel") return "Parcel";
  return `${receipt.tableName} · ${receipt.splitLabel ?? "A"}`;
}

/** The receipt fields that say who charges GST on a bill. Older snapshots carry only the legacy flags, which `receiptGstMode` reads. */
export type BillGst = Parameters<typeof receiptGstMode>[0];

/** The GST line of a bill. Zomato wins: its snapshot also carries the restaurant's mode, but Zomato pays the GST. */
export function gstNote(receipt: BillGst): string {
  if (receipt.gstPaidBy === "zomato") return "GST paid by Zomato (section 9(5))";
  return receiptGstMode(receipt) === "none" ? "No GST charged" : "Includes GST";
}

/** The per-rate GST rows a bill shows: none when Zomato pays the GST or the bill was issued without GST. */
export function billTaxRates<T>(bill: { taxes: T[] }, receipt: BillGst | undefined): T[] {
  return !receipt || (receipt.gstPaidBy !== "zomato" && receiptGstMode(receipt) === "included") ? bill.taxes : [];
}

/**
 * Who sees Reports, Zomato reconciliation: admins and cashiers, whether Zomato is on or off, so receivables from
 * orders closed before Zomato was turned off (or the licence changed) can still be matched against payouts.
 */
export function canReconcileZomato(role: string): boolean {
  return role === "admin" || role === "cashier";
}

export function billPaymentLabel(mode: PaymentMode): string {
  return mode === "zomato" ? "Zomato" : mode.toUpperCase();
}

/** The one action a Zomato card offers, from where the order is in its life. */
export function zomatoCardAction(order: Order): { label: "Add items" | "Ready" | "Picked up"; status: ZomatoNext | null } {
  if (order.zomatoStatus === "ready") return { label: "Picked up", status: "picked_up" };
  if (order.zomatoStatus === "preparing") return { label: "Ready", status: "ready" };
  // A new order with nothing live on it has nothing to hand over. Whether station items are still unsent is for the server to say.
  if (!order.items.some((item) => item.status !== "cancelled")) return { label: "Add items", status: null };
  return { label: "Ready", status: "ready" };
}

/** Open or billed Zomato orders, oldest first. */
export function zomatoOrders(orders: Order[]): Order[] {
  return orders.filter((order) => order.type === "zomato" && (order.status === "open" || order.status === "billed")).sort((a, b) => a.openedAt - b.openedAt);
}

/** The Open takeaways list: parcels plus the Zomato orders this user may see (pass none when they may not), oldest first. */
export function openTakeaways(orders: Order[], zomato: Order[]): Order[] {
  return [...orders.filter((order) => order.type === "parcel"), ...zomato].sort((a, b) => a.openedAt - b.openedAt);
}

/** The open or billed Zomato order carrying this ID (trimmed), if any; closed and cancelled orders do not count. */
export function findZomatoOrderById(orders: Order[], id: string): Order | undefined {
  const wanted = id.trim();
  return wanted ? zomatoOrders(orders).find((order) => order.zomatoOrderId === wanted) : undefined;
}

/** Minutes since punch-in after which a Zomato card turns amber, then red, until the restaurant's own settings load. */
export const DEFAULT_ZOMATO_AGE = { warnMinutes: 15, lateMinutes: 25 };

const AGE_RANGE_MESSAGE = "Amber and red must be whole minutes from 1 to 240";
const AGE_ORDER_MESSAGE = "Red must be later than amber";

/** The message to show for these two thresholds (the same rules the server applies), or "" when they are fine. */
export function validateAgeThresholds(warnMinutes: number, lateMinutes: number): string {
  const whole = (n: number) => Number.isInteger(n) && n >= 1 && n <= 240;
  if (!whole(warnMinutes) || !whole(lateMinutes)) return AGE_RANGE_MESSAGE;
  return lateMinutes > warnMinutes ? "" : AGE_ORDER_MESSAGE;
}

/**
 * How urgent a Zomato card looks, from the minutes since the order was opened.
 *
 * A card turns amber at the amber minute and red at the red minute (both inclusive).
 * The restaurant sets the two thresholds in Marketplace > Zomato > Settings (amber after 15
 * and red after 25 minutes unless changed). Zomato tracks the restaurant's preparation time,
 * so a slow order costs ratings and rider waiting time, but a screen that is mostly red stops
 * meaning anything; red should be the exception.
 */
export function zomatoAgeTone(minutes: number, thresholds: { warnMinutes: number; lateMinutes: number }): ZomatoTone {
  if (minutes >= thresholds.lateMinutes) return "late";
  if (minutes >= thresholds.warnMinutes) return "warn";
  return "ok";
}

// One reference per order and target status, kept until that request succeeds, so retrying the same click is not applied twice.
const pendingRefs = new Map<string, string>();

export async function setZomatoStatus(orderId: string, status: ZomatoNext): Promise<Order> {
  const key = `${orderId}:${status}`;
  const clientRef = pendingRefs.get(key) ?? uuid();
  pendingRefs.set(key, clientRef);
  const { order } = await apiFetch<{ order: Order }>(`/api/orders/${orderId}/zomato-status`, { method: "POST", body: JSON.stringify({ status, clientRef }) });
  pendingRefs.delete(key);
  return order;
}

/**
 * One Zomato status change at a time, with the "Close Zomato #<id>?" check before Picked up and the server's message on refusal.
 * Resolves true when the server applied the change.
 */
export function useZomatoStatus() {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const lock = useRef(false);

  async function advance(order: Order, status: ZomatoNext): Promise<boolean> {
    if (lock.current) return false;
    if (status === "picked_up" && !window.confirm(`Close ${zomatoLabel(order.zomatoOrderId)}?`)) return false;
    lock.current = true; setBusyId(order.id); setError("");
    try {
      await setZomatoStatus(order.id, status);
      return true;
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Request failed");
      return false;
    } finally { lock.current = false; setBusyId(null); }
  }

  return { busyId, error, advance };
}
