import type { Order } from "./types";

/** What the table view's side panel shows for a running order: the dishes still on it, their total, and dishes held back. */
export function orderSummary(order: Order): { lines: Order["items"]; itemCount: number; subtotalPaise: number; heldCount: number } {
  const lines = order.items.filter((item) => item.status !== "cancelled" && !item.parentItemId);
  return {
    lines,
    itemCount: lines.reduce((sum, item) => sum + item.qty, 0),
    subtotalPaise: lines.reduce((sum, item) => sum + item.pricePaise * item.qty, 0),
    heldCount: lines.filter((item) => item.held && item.status === "pending").length,
  };
}

export function maskedPhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  return digits.length > 4 ? `${digits.slice(0, 2)}${"*".repeat(digits.length - 4)}${digits.slice(-2)}` : "*".repeat(digits.length);
}

export function transferableItems(order: Order): Order["items"] {
  return order.items.filter((item) => !item.parentItemId && item.status === "pending" && !item.kotId && !item.clientRef?.startsWith("guest:")
    && order.items.filter((child) => child.parentItemId === item.id).every((child) => child.status === "pending" && !child.kotId && !child.clientRef?.startsWith("guest:")));
}

/**
 * Why the order must be finished on its order screen before it can be billed from the table view: a cart this device has
 * not punched, actions waiting to reach the hub, or dishes held back from the kitchen. Null when billing can go ahead here.
 */
export function checkoutBlocker({ draftCount, queuedCount, heldCount }: { draftCount: number; queuedCount: number; heldCount: number }): string | null {
  if (draftCount > 0) return "This order has cart items that are not punched yet. Open the order to punch or remove them.";
  if (queuedCount > 0) return "Actions for this order are saved on this device and waiting to reach the hub. Open the order to check them.";
  if (heldCount > 0) return `${heldCount} ${heldCount === 1 ? "dish is" : "dishes are"} held back from the kitchen. Open the order to fire ${heldCount === 1 ? "it" : "them"} first.`;
  return null;
}

/** Billing's own requests: issuing the bill and recording payment. The billing panel shows and finishes these itself. */
const BILLING_PATH = /^\/api\/(orders\/[^/]+\/bill|bills\/[^/]+\/settle)$/;

/**
 * Actions for this order still waiting on this device that must reach the hub before billing from the table view:
 * punched dishes, holds, fires, moves. Billing's own requests are left out, or issuing a bill would block its own payment.
 */
export function pendingOrderActions(requests: Array<{ lane: string; path: string }>, orderId: string): number {
  return requests.filter((request) => request.lane === orderId && !BILLING_PATH.test(request.path)).length;
}

/** Unsaved cart rows this device holds for an order (the same keys the order screen writes). */
export function draftCount(userId: string, orderId: string): number {
  try {
    const rows: unknown = JSON.parse(localStorage.getItem(`masalapos.draft.${userId}.${orderId}`) ?? localStorage.getItem(`masalapos.draft.${orderId}`) ?? "[]");
    return Array.isArray(rows) ? rows.length : 0;
  } catch { return 0; }
}
