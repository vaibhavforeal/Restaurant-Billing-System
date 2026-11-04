import { describe, expect, it } from "vitest";
import type { Order, OrderItem } from "./types";
import { checkoutBlocker, orderSummary, pendingOrderActions } from "./table-order-summary";

describe("pendingOrderActions", () => {
  it("counts this order's waiting actions but not billing's own issue and payment requests", () => {
    const requests = [
      { lane: "o1", path: "/api/orders/o1/items" },
      { lane: "o1", path: "/api/order-items/i1" },
      { lane: "o1", path: "/api/orders/o1/bill" },
      { lane: "o1", path: "/api/bills/b1/settle" },
      { lane: "o1", path: "/api/bills/{after:abc}/settle" },
      { lane: "o2", path: "/api/orders/o2/items" },
    ];
    expect(pendingOrderActions(requests, "o1")).toBe(2);
    expect(pendingOrderActions(requests, "o2")).toBe(1);
    expect(pendingOrderActions([{ lane: "o1", path: "/api/orders/o1/bill" }], "o1")).toBe(0);
  });
});

function item(over: Partial<OrderItem>): OrderItem {
  return { id: "i", name: "Dosa", pricePaise: 5000, qty: 1, status: "pending", note: null, cancelReason: null, kotId: null, ...over } as OrderItem;
}

describe("orderSummary", () => {
  it("counts quantities and totals live dishes, leaving cancelled ones out, and counts held pending dishes", () => {
    const order = { items: [item({ id: "a", qty: 2 }), item({ id: "b", pricePaise: 12000, status: "sent" }), item({ id: "c", status: "cancelled" }), item({ id: "d", held: true }), item({ id: "e", held: true, status: "sent" })] } as Order;
    const summary = orderSummary(order);
    expect(summary.lines.map((l) => l.id)).toEqual(["a", "b", "d", "e"]);
    expect(summary.itemCount).toBe(5);
    expect(summary.subtotalPaise).toBe(2 * 5000 + 12000 + 5000 + 5000);
    expect(summary.heldCount).toBe(1);
  });
});

describe("checkoutBlocker", () => {
  it("lets billing go ahead only with no cart, no waiting actions and no held dishes", () => {
    expect(checkoutBlocker({ draftCount: 0, queuedCount: 0, heldCount: 0 })).toBeNull();
    expect(checkoutBlocker({ draftCount: 1, queuedCount: 0, heldCount: 0 })).toMatch(/not punched/);
    expect(checkoutBlocker({ draftCount: 0, queuedCount: 2, heldCount: 0 })).toMatch(/waiting to reach the hub/);
    expect(checkoutBlocker({ draftCount: 0, queuedCount: 0, heldCount: 1 })).toMatch(/1 dish is held/);
    expect(checkoutBlocker({ draftCount: 0, queuedCount: 0, heldCount: 3 })).toMatch(/3 dishes are held/);
  });
});
