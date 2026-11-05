import type { Order } from "./types";

/** The order board's columns, in order. Worked out from data the orders already carry; there is no stored stage. */
export const STAGES = ["new", "preparing", "prepared", "processed"] as const;
export type Stage = typeof STAGES[number];

export const STAGE_LABEL: Record<Stage, string> = { new: "New", preparing: "Preparing", prepared: "Prepared", processed: "Processed" };

/**
 * Where a non-table order stands. Zomato orders follow their own status; others follow their kitchen tickets.
 * Without the Kitchen Display no ticket is ever marked done, so an order sent to the kitchen counts as prepared.
 */
export function orderStage(order: Order, kdsOn: boolean): Stage {
  if (order.status === "settled") return "processed";
  if (order.type === "zomato") {
    if (order.zomatoStatus === "ready" || order.zomatoStatus === "picked_up") return "prepared";
    return order.zomatoStatus === "preparing" ? "preparing" : "new";
  }
  if (order.kots.length === 0) {
    return order.items.some((item) => item.status === "sent") ? "prepared" : "new";
  }
  return kdsOn && order.kots.some((kot) => kot.doneAt === null) ? "preparing" : "prepared";
}

/** The orders the board shows: takeaway, delivery and Zomato, not cancelled. Dine-in stays on Tables. */
export function boardOrders(orders: Order[]): Order[] {
  return orders.filter((order) => order.type !== "dine_in" && order.status !== "cancelled");
}

/** Board orders in their columns, oldest first. */
export function groupByStage(orders: Order[], kdsOn: boolean): Record<Stage, Order[]> {
  const groups: Record<Stage, Order[]> = { new: [], preparing: [], prepared: [], processed: [] };
  for (const order of [...boardOrders(orders)].sort((a, b) => a.openedAt - b.openedAt)) groups[orderStage(order, kdsOn)].push(order);
  return groups;
}

/** Whether the search box text matches the order number, Zomato ID, customer name or phone, or order type name. */
export function matchesSearch(order: Order, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [order.clientRef, order.zomatoOrderId, order.customer?.name, order.customer?.phone, order.orderTypeName]
    .some((field) => field?.toLowerCase().includes(q));
}

/** Local midnight of `now`: the Processed column shows orders settled since then. */
export function startOfLocalDay(now: number): number {
  const day = new Date(now);
  day.setHours(0, 0, 0, 0);
  return day.getTime();
}
