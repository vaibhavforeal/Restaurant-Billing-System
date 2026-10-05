import { describe, expect, it } from "vitest";
import type { Order, OrderItem, TableInfo } from "./types";
import { mergeBlockedReason, mergeTargets, moveTargets } from "./table-transfer";

const table = (id: string, patch: Partial<TableInfo> = {}): TableInfo => ({
  id, name: id.toUpperCase(), area: null, sortOrder: 0, priceTier: "non_ac", isActive: true,
  status: "free", activeOrders: [], link: null, ...patch,
});

const item = (id: string, qty: number, pricePaise: number, status: OrderItem["status"] = "sent"): OrderItem => ({
  id, clientRef: null, productId: "p", variantId: null, name: "Dish", pricePaise, gstRate: 5, qty, status,
  note: null, cancelReason: null, kotId: null,
});

const order = (id: string, patch: Partial<Order> = {}): Order => ({
  id, clientRef: id, priceTier: "non_ac", stockWarnings: [], type: "dine_in", tableId: "t", splitLabel: "A",
  tableName: "T4", tableLabel: "T4", mergedInto: null, status: "open", openedBy: "u", openedAt: 0, closedAt: null, items: [], kots: [], ...patch,
});

describe("moveTargets", () => {
  it("lets only free active tables be chosen and explains the rest", () => {
    const targets = moveTargets([
      table("t3", { status: "occupied" }),
      table("t4", { status: "free" }),
      table("t5", { status: "occupied", link: { orderId: "o", status: "open", label: "T9, T5", tableName: "T9" } }),
      table("t6", { status: "reserved" }),
      table("t7", { status: "free", isActive: false }),
      table("t8", { status: "billed" }),
    ], "t3");
    expect(targets.map((t) => [t.table.id, t.selectable, t.note])).toEqual([
      ["t4", true, null],
      ["t5", false, "occupied — merge instead"],
      ["t6", false, "reserved now"],
      ["t8", false, "occupied — merge instead"],
    ]);
  });
});

describe("mergeTargets", () => {
  it("groups other open dine-in bills by table label with item counts and totals", () => {
    const groups = mergeTargets([
      order("me", { tableName: "T3", tableLabel: "T3" }),
      order("a", { tableName: "T4", tableLabel: "T4", splitLabel: "A", items: [item("1", 2, 15000), item("2", 1, 24000), item("3", 5, 9900, "cancelled")] }),
      order("b", { tableName: "T4", tableLabel: "T4", splitLabel: "B", items: [item("4", 1, 5000)] }),
      order("c", { tableName: "T9", tableLabel: "T9, T5", splitLabel: "A", items: [] }),
      order("billed", { tableName: "T6", tableLabel: "T6", status: "billed" }),
      order("parcel", { type: "parcel", tableId: null, tableName: null, tableLabel: null }),
      order("settled", { tableName: "T7", tableLabel: "T7", status: "settled" }),
      order("folded", { tableName: "T8", tableLabel: "T8", mergedInto: "a" }),
    ], "me");
    expect(groups).toEqual([
      { tableLabel: "T4", options: [
        { orderId: "a", label: "T4 (A) · 3 items · ₹540.00" },
        { orderId: "b", label: "T4 (B) · 1 items · ₹50.00" },
      ] },
      { tableLabel: "T9, T5", options: [{ orderId: "c", label: "T9 (A) · 0 items · ₹0.00" }] },
    ]);
  });

  it("falls back to the table name when no label is present", () => {
    expect(mergeTargets([order("a", { tableLabel: null, tableName: "T2" })], "x")[0]!.tableLabel).toBe("T2");
  });
});

describe("mergeBlockedReason", () => {
  it("blocks a merge while the cart holds unsaved items", () => {
    expect(mergeBlockedReason(0)).toBeNull();
    expect(mergeBlockedReason(1)).toBe("Save or discard the cart items before merging.");
    expect(mergeBlockedReason(4)).toBe("Save or discard the cart items before merging.");
  });
});
