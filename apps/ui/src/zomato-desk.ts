import { apiFetch } from "./api";
import type { Order } from "./types";
import { uuid } from "./uuid";

export type ZomatoNext = "ready" | "picked_up";
export type ZomatoTone = "ok" | "warn" | "late";

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

/**
 * How urgent a Zomato card looks, from the minutes since the order was opened.
 *
 * Decision for the owner: when does a card turn amber ("warn") and red ("late")?
 * Zomato tracks the restaurant's preparation time, so a slow order costs ratings and
 * rider waiting time, but a screen that is mostly red stops meaning anything. Pick the
 * thresholds that match your usual prep time so red is the exception.
 */
export function zomatoAgeTone(minutes: number): ZomatoTone {
  void minutes;
  return "ok"; // TODO(you): choose thresholds
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
