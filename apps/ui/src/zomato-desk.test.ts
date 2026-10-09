import { afterEach, describe, expect, it, vi } from "vitest";
import type { Order, OrderItem } from "./types";

const fetchMock = vi.hoisted(() => vi.fn());
vi.mock("./api", () => ({ apiFetch: fetchMock }));

import { billContextLabel, billPaymentLabel, billTaxRates, canReconcileZomato, DEFAULT_ZOMATO_AGE, findZomatoOrderById, kitchenContextLabel, setZomatoStatus, gstNote, validateAgeThresholds, zomatoAgeTone, zomatoCardAction, zomatoLabel, zomatoOrders } from "./zomato-desk";

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

describe("findZomatoOrderById", () => {
  const list = [
    order({ id: "a", zomatoOrderId: "Z-1" }),
    order({ id: "b", zomatoOrderId: "Z-2", status: "billed" }),
    order({ id: "c", zomatoOrderId: "Z-3", status: "settled" }),
    order({ id: "d", zomatoOrderId: "Z-4", status: "cancelled" }),
    order({ id: "e", type: "parcel", zomatoOrderId: "Z-5" }),
  ];

  it("finds an open or billed zomato order, trimming what was typed", () => {
    expect(findZomatoOrderById(list, " Z-1 ")?.id).toBe("a");
    expect(findZomatoOrderById(list, "Z-2")?.id).toBe("b");
  });

  it("finds nothing for closed, cancelled, non-zomato or unknown IDs", () => {
    for (const id of ["Z-3", "Z-4", "Z-5", "Z-9", ""]) expect(findZomatoOrderById(list, id)).toBeUndefined();
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

describe("zomatoLabel", () => {
  it("reads Zomato #<id>", () => {
    expect(zomatoLabel("Z-1")).toBe("Zomato #Z-1");
  });
});

describe("kitchenContextLabel", () => {
  const kot = { orderType: "dine_in" as const, tableName: "T1", splitLabel: "A", zomatoOrderId: null };

  it("shows Zomato #<id> for a zomato ticket", () => {
    expect(kitchenContextLabel({ ...kot, orderType: "zomato", tableName: null, splitLabel: null, zomatoOrderId: "Z-9" })).toBe("Zomato #Z-9");
  });

  it("keeps the parcel and table labels", () => {
    expect(kitchenContextLabel({ ...kot, orderType: "parcel", tableName: null })).toBe("Parcel");
    expect(kitchenContextLabel(kot)).toBe("T1");
    expect(kitchenContextLabel({ ...kot, splitLabel: "B" })).toBe("T1 · B");
    expect(kitchenContextLabel({ ...kot, tableName: null, splitLabel: null })).toBe("Table");
  });
});

describe("billContextLabel", () => {
  const receipt = { orderType: "dine_in" as const, tableName: "T1", splitLabel: null, zomatoOrderId: undefined };

  it("shows Zomato #<id> for a zomato bill", () => {
    expect(billContextLabel({ ...receipt, orderType: "zomato", tableName: null, zomatoOrderId: "Z-9" })).toBe("Zomato #Z-9");
  });

  it("keeps the parcel and table labels", () => {
    expect(billContextLabel({ ...receipt, orderType: "parcel", tableName: null })).toBe("Parcel");
    expect(billContextLabel(receipt)).toBe("T1 · A");
    expect(billContextLabel({ ...receipt, splitLabel: "C" })).toBe("T1 · C");
  });
});

describe("gstNote", () => {
  it("says GST is paid by Zomato even when the snapshot also carries the restaurant's mode", () => {
    expect(gstNote({ gstMode: "included", gstPaidBy: "zomato" })).toBe("GST paid by Zomato (section 9(5))");
    expect(gstNote({ gstMode: "none", gstPaidBy: "zomato" })).toBe("GST paid by Zomato (section 9(5))");
  });

  it("says no GST is charged for a bill issued without GST", () => {
    expect(gstNote({ gstMode: "none" })).toBe("No GST charged");
  });

  it("says the prices include GST otherwise", () => {
    expect(gstNote({ gstMode: "included" })).toBe("Includes GST");
  });

  it("reads old snapshots through their legacy flags", () => {
    expect(gstNote({ gstScheme: "composition" })).toBe("No GST charged");
    expect(gstNote({ taxInclusive: false })).toBe("Includes GST");
  });
});

describe("billPaymentLabel", () => {
  it("names the zomato receivable Zomato and upper-cases the rest as before", () => {
    expect(billPaymentLabel("zomato")).toBe("Zomato");
    expect(billPaymentLabel("cash")).toBe("CASH");
    expect(billPaymentLabel("upi")).toBe("UPI");
  });
});

describe("canReconcileZomato", () => {
  it("offers Zomato reconciliation to admins and cashiers, whether Zomato is on or off", () => {
    expect(canReconcileZomato("admin")).toBe(true);
    expect(canReconcileZomato("cashier")).toBe(true);
    for (const role of ["waiter", "captain", "kitchen"]) expect(canReconcileZomato(role)).toBe(false);
  });
});

describe("billTaxRates", () => {
  const taxes = [{ gstRate: 5, taxablePaise: 25000, cgstPaise: 0, sgstPaise: 0 }];
  it("lists no per-rate GST rows on a bill whose GST Zomato pays", () => {
    expect(billTaxRates({ taxes }, { gstPaidBy: "zomato" })).toEqual([]);
    expect(billTaxRates({ taxes }, { gstMode: "included", gstPaidBy: "zomato" })).toEqual([]);
  });
  it("lists no per-rate GST rows on a bill issued without GST", () => {
    expect(billTaxRates({ taxes }, { gstMode: "none" })).toEqual([]);
    expect(billTaxRates({ taxes }, { gstScheme: "composition" })).toEqual([]);
  });
  it("lists the per-rate GST rows on the restaurant's own bills", () => {
    expect(billTaxRates({ taxes }, undefined)).toBe(taxes);
    expect(billTaxRates({ taxes }, {})).toBe(taxes);
    expect(billTaxRates({ taxes }, { gstMode: "included" })).toBe(taxes);
  });
});

describe("validateAgeThresholds", () => {
  it("accepts whole minutes from 1 to 240 with red later than amber", () => {
    expect(validateAgeThresholds(15, 25)).toBe("");
    expect(validateAgeThresholds(1, 2)).toBe("");
    expect(validateAgeThresholds(239, 240)).toBe("");
  });

  it("says red must be later than amber when it is equal or earlier", () => {
    expect(validateAgeThresholds(20, 20)).toBe("Red must be later than amber");
    expect(validateAgeThresholds(30, 10)).toBe("Red must be later than amber");
  });

  it("asks for whole minutes from 1 to 240, including empty or fractional input", () => {
    const range = "Amber and red must be whole minutes from 1 to 240";
    for (const [warn, late] of [[0, 25], [15, 241], [-1, 25], [15, 0], [Number.NaN, 25], [15, Number.NaN], [10.5, 25], [15, 25.5]] as const) {
      expect(validateAgeThresholds(warn, late), `${warn}/${late}`).toBe(range);
    }
  });

  it("starts at 15 and 25 minutes", () => {
    expect(DEFAULT_ZOMATO_AGE).toEqual({ warnMinutes: 15, lateMinutes: 25 });
    expect(validateAgeThresholds(DEFAULT_ZOMATO_AGE.warnMinutes, DEFAULT_ZOMATO_AGE.lateMinutes)).toBe("");
  });
});

describe("zomato card age tone", () => {
  it("turns amber at the amber minute and red at the red minute", () => {
    expect(zomatoAgeTone(0, DEFAULT_ZOMATO_AGE)).toBe("ok");
    expect(zomatoAgeTone(14, DEFAULT_ZOMATO_AGE)).toBe("ok");
    expect(zomatoAgeTone(15, DEFAULT_ZOMATO_AGE)).toBe("warn");
    expect(zomatoAgeTone(24, DEFAULT_ZOMATO_AGE)).toBe("warn");
    expect(zomatoAgeTone(25, DEFAULT_ZOMATO_AGE)).toBe("late");
    expect(zomatoAgeTone(90, DEFAULT_ZOMATO_AGE)).toBe("late");
  });

  it("uses the restaurant's own thresholds", () => {
    const slowKitchen = { warnMinutes: 20, lateMinutes: 30 };
    expect(zomatoAgeTone(19, slowKitchen)).toBe("ok");
    expect(zomatoAgeTone(20, slowKitchen)).toBe("warn");
    expect(zomatoAgeTone(30, slowKitchen)).toBe("late");
  });
});
