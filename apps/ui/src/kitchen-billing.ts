import type { Kot, Order, OrderItem } from "./types";

type KitchenBillingOrder = {
  type: Order["type"];
  kitchenAcceptanceRequired?: boolean;
  items: Array<Pick<OrderItem, "status" | "kotId">>;
  kots: Array<Pick<Kot, "id" | "kotNo" | "doneAt"> & Partial<Pick<Kot, "acceptedAt">>>;
};

export function kitchenBillingBlockReason(order: KitchenBillingOrder): string | null {
  if (order.type !== "dine_in" || order.kitchenAcceptanceRequired === false) return null;
  const sentKotIds = new Set<string>();
  for (const item of order.items) {
    if (item.status === "sent" && item.kotId) sentKotIds.add(item.kotId);
  }
  const tickets = new Map(order.kots.map((kot) => [kot.id, kot]));
  const waiting = Array.from(sentKotIds).filter((id) => {
    const kot = tickets.get(id);
    // Completed tickets from older installations are already accepted.
    return !kot || (kot.acceptedAt == null && kot.doneAt == null);
  });
  if (!waiting.length) return null;
  const numbers = waiting.map((id) => tickets.get(id)?.kotNo).filter((number): number is number => number !== undefined);
  const label = numbers.length === waiting.length ? `KOT ${numbers.map((number) => `#${number}`).join(", ")}` : "the kitchen tickets";
  return `Waiting for kitchen to accept ${label} before billing this table.`;
}
