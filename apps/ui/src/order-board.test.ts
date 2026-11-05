import { describe, expect, it } from "vitest";
import { boardOrders, groupByStage, matchesSearch, orderStage, startOfLocalDay } from "./order-board";
import type { Kot, Order, OrderItem } from "./types";

function item(status: OrderItem["status"], extra: Partial<OrderItem> = {}): OrderItem {
  return { id: `i-${Math.random()}`, name: "Dal", pricePaise: 10000, gstRate: 5, qty: 1, status, note: null, cancelReason: null, kotId: null, ...extra } as OrderItem;
}
function kot(doneAt: number | null): Kot {
  return { id: `k-${Math.random()}`, kotNo: 1, stationId: "s", orderId: "o", createdAt: 1, acceptedAt: null, doneAt };
}
function order(extra: Partial<Order> = {}): Order {
  return {
    id: "o1", clientRef: "abcd1234-ef", type: "parcel", orderTypeId: "parcel", orderTypeName: null, zomatoOrderId: null, zomatoStatus: null,
    tableId: null, splitLabel: null, tableName: null, mergedInto: null, customer: null, status: "open", openedBy: "u", openedAt: 100,
    closedAt: null, items: [], kots: [], priceTier: "takeaway", stockWarnings: [], ...extra,
  } as Order;
}

describe("orderStage", () => {
  it("puts an order with nothing sent to the kitchen in New", () => {
    expect(orderStage(order(), true)).toBe("new");
    expect(orderStage(order({ items: [item("pending")] }), true)).toBe("new");
  });

  it("puts an order with an open KOT in Preparing", () => {
    expect(orderStage(order({ items: [item("sent")], kots: [kot(5), kot(null)] }), true)).toBe("preparing");
  });

  it("puts an order whose KOTs are all done in Prepared, billed or not", () => {
    expect(orderStage(order({ items: [item("sent")], kots: [kot(5)] }), true)).toBe("prepared");
    expect(orderStage(order({ status: "billed", items: [item("sent")], kots: [kot(5)] }), true)).toBe("prepared");
  });

  it("treats sent items with no kitchen ticket as prepared (nothing to cook)", () => {
    expect(orderStage(order({ items: [item("sent")] }), true)).toBe("prepared");
  });

  it("moves sent orders straight to Prepared while the Kitchen Display is off", () => {
    expect(orderStage(order({ items: [item("sent")], kots: [kot(null)] }), false)).toBe("prepared");
  });

  it("puts settled orders in Processed", () => {
    expect(orderStage(order({ status: "settled", kots: [kot(null)] }), true)).toBe("processed");
  });

  it("follows the Zomato status for Zomato orders", () => {
    const z = (zomatoStatus: Order["zomatoStatus"], extra: Partial<Order> = {}) => orderStage(order({ type: "zomato", zomatoOrderId: "Z1", zomatoStatus, ...extra }), true);
    expect(z(null)).toBe("new");
    expect(z("preparing", { kots: [kot(5)] })).toBe("preparing");
    expect(z("ready", { kots: [kot(null)] })).toBe("prepared");
    expect(z("picked_up", { status: "settled" })).toBe("processed");
  });
});

describe("boardOrders and groupByStage", () => {
  it("drops dine-in and cancelled orders", () => {
    const list = [order({ id: "a" }), order({ id: "b", type: "dine_in" }), order({ id: "c", status: "cancelled" }), order({ id: "d", type: "zomato" })];
    expect(boardOrders(list).map((o) => o.id)).toEqual(["a", "d"]);
  });

  it("groups by stage, oldest first", () => {
    const list = [order({ id: "late", openedAt: 300 }), order({ id: "early", openedAt: 100 }), order({ id: "done", status: "settled" })];
    const groups = groupByStage(list, true);
    expect(groups.new.map((o) => o.id)).toEqual(["early", "late"]);
    expect(groups.preparing).toEqual([]);
    expect(groups.prepared).toEqual([]);
    expect(groups.processed.map((o) => o.id)).toEqual(["done"]);
  });
});

describe("matchesSearch", () => {
  const o = order({
    clientRef: "7f3a9c21-0000", orderTypeName: "Swiggy delivery",
    customer: { id: "c", name: "Asha Rao", phone: "9876543210" } as Order["customer"],
  });

  it("matches everything on an empty query", () => {
    expect(matchesSearch(o, "  ")).toBe(true);
  });

  it("matches the order number, customer name or phone and order type, ignoring case", () => {
    expect(matchesSearch(o, "7F3A")).toBe(true);
    expect(matchesSearch(o, "asha")).toBe(true);
    expect(matchesSearch(o, "98765")).toBe(true);
    expect(matchesSearch(o, "swiggy")).toBe(true);
    expect(matchesSearch(o, "zzz")).toBe(false);
  });

  it("matches a Zomato order ID", () => {
    expect(matchesSearch(order({ type: "zomato", zomatoOrderId: "Z-5521" }), "5521")).toBe(true);
  });
});

describe("startOfLocalDay", () => {
  it("returns local midnight of the given moment", () => {
    const now = new Date(2026, 10, 5, 14, 30).getTime();
    expect(startOfLocalDay(now)).toBe(new Date(2026, 10, 5).getTime());
  });
});
