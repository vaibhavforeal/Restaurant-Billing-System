import { afterEach, describe, expect, it, vi } from "vitest";
import type { Order, OrderItem } from "./types";

const fetchMock = vi.hoisted(() => vi.fn());
vi.mock("./api", () => ({ apiFetch: fetchMock }));

import { setZomatoStatus, zomatoCardAction, zomatoOrders } from "./zomato-desk";

function item(status: OrderItem["status"]): OrderItem {
  return { id: `i-${status}`, name: "Dosa", pricePaise: 5000, qty: 1, status, note: null, cancelReason: null, kotId: null } as OrderItem;
}

function order(over: Partial<Order>): Order {
  return { id: "o1", clientRef: "c1", type: "zomato", zomatoOrderId: "Z-1", zomatoStatus: null, tableId: null, status: "open", openedAt: 1000, items: [], kots: [], ...over } as Order;
}

describe("zomatoCardAction", () => {
  it("asks for items while a new order has none, ignoring cancelled lines", () => {
    expect(zomatoCardAction(order({ items: [] }))).toEqual({ label: "Add items", status: null });
    expect(zomatoCardAction(order({ items: [item("cancelled")] }))).toEqual({ label: "Add items", status: null });
  });

  it("offers Ready on a new order with live items, sent or still pending (the server decides)", () => {
    expect(zomatoCardAction(order({ items: [item("pending")] }))).toEqual({ label: "Ready", status: "ready" });
    expect(zomatoCardAction(order({ items: [item("sent"), item("cancelled")] }))).toEqual({ label: "Ready", status: "ready" });
  });

  it("offers Ready while preparing and Picked up once ready", () => {
    expect(zomatoCardAction(order({ zomatoStatus: "preparing", items: [item("sent")] }))).toEqual({ label: "Ready", status: "ready" });
    expect(zomatoCardAction(order({ zomatoStatus: "ready", items: [item("sent")] }))).toEqual({ label: "Picked up", status: "picked_up" });
  });
});

describe("zomatoOrders", () => {
  it("keeps open and billed zomato orders only, oldest first", () => {
    const list = [
      order({ id: "new", openedAt: 3000 }),
      order({ id: "parcel", type: "parcel", openedAt: 500 }),
      order({ id: "dine", type: "dine_in", openedAt: 600 }),
      order({ id: "old", openedAt: 1000, status: "billed" }),
      order({ id: "done", openedAt: 100, status: "settled" }),
      order({ id: "gone", openedAt: 200, status: "cancelled" }),
      order({ id: "mid", openedAt: 2000 }),
    ];
    expect(zomatoOrders(list).map((o) => o.id)).toEqual(["old", "mid", "new"]);
  });

  it("does not reorder the caller's list", () => {
    const list = [order({ id: "b", openedAt: 2 }), order({ id: "a", openedAt: 1 })];
    zomatoOrders(list);
    expect(list.map((o) => o.id)).toEqual(["b", "a"]);
  });
});

describe("setZomatoStatus", () => {
  afterEach(() => fetchMock.mockReset());

  it("posts the status with a fresh clientRef and returns the order", async () => {
    fetchMock.mockResolvedValue({ order: order({ zomatoStatus: "ready" }) });
    const result = await setZomatoStatus("o1", "ready");
    expect(result.zomatoStatus).toBe("ready");
    const [path, init] = fetchMock.mock.calls[0]!;
    expect(path).toBe("/api/orders/o1/zomato-status");
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body);
    expect(body.status).toBe("ready");
    expect(body.clientRef).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("reuses the clientRef when the same click is retried after a failure, then uses a new one after success", async () => {
    fetchMock.mockRejectedValueOnce(new Error("network")).mockResolvedValue({ order: order({}) });
    await expect(setZomatoStatus("o1", "ready")).rejects.toThrow("network");
    await setZomatoStatus("o1", "ready");
    await setZomatoStatus("o1", "ready");
    const refs = fetchMock.mock.calls.map((call) => JSON.parse(call[1].body).clientRef);
    expect(refs[1]).toBe(refs[0]);
    expect(refs[2]).not.toBe(refs[0]);
  });

  it("keeps separate clientRefs per order and status", async () => {
    fetchMock.mockRejectedValue(new Error("network"));
    await expect(setZomatoStatus("o1", "ready")).rejects.toThrow();
    await expect(setZomatoStatus("o2", "ready")).rejects.toThrow();
    await expect(setZomatoStatus("o1", "picked_up")).rejects.toThrow();
    const refs = fetchMock.mock.calls.map((call) => JSON.parse(call[1].body).clientRef);
    expect(new Set(refs).size).toBe(3);
  });
});
