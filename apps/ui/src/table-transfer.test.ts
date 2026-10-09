import { describe, expect, it } from "vitest";
import type { Order, OrderItem, TableInfo } from "./types";
import { mergeBlockedReason, mergeRoles, mergeTargets, moveTargets, qrBillGroupOptions, receivingLabel, tableCardNote, tableOpenTargets } from "./table-transfer";

const table = (id: string, patch: Partial<TableInfo> = {}): TableInfo => ({
  id, name: id.toUpperCase(), area: null, sortOrder: 0, priceTier: "non_ac", isActive: true,
  status: "free", activeOrders: [], link: null, ...patch,
});

const item = (id: string, qty: number, pricePaise: number, status: OrderItem["status"] = "sent"): OrderItem => ({
  id, clientRef: null, productId: "p", variantId: null, name: "Dish", pricePaise, gstRate: 5, qty, status,
  note: null, cancelReason: null, kotId: null,
});

const order = (id: string, patch: Partial<Order> = {}): Order => ({
  id, clientRef: id, priceTier: "non_ac", stockWarnings: [], type: "dine_in", zomatoOrderId: null, zomatoStatus: null, tableId: "t", splitLabel: "A",
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
    ], "t3", "me");
    expect(targets.map((t) => [t.table.id, t.selectable, t.note])).toEqual([
      ["t4", true, null],
      ["t5", false, "occupied — merge instead"],
      ["t6", false, "reserved now"],
      ["t8", false, "occupied — merge instead"],
    ]);
  });

  it("lets a combined order move onto a table that is linked only to it", () => {
    const own = { orderId: "me", status: "open" as const, label: "T3, T5", tableName: "T3" };
    const now = 1_000_000;
    const booking = (startsAt: number) => ({ id: "r", customerName: "Rao", partySize: 2, startsAt, endsAt: startsAt + 3_600_000, startsLocal: "" });
    const targets = moveTargets([
      table("t5", { status: "occupied", link: own }),
      table("t6", { status: "occupied", link: own, activeOrders: [{ id: "x", splitLabel: "A", status: "open" }] }),
      table("t7", { status: "occupied", link: { ...own, orderId: "someone-else" } }),
      table("t8", { status: "occupied", link: own, reservation: booking(now - 60_000) }),
      table("t9", { status: "occupied", link: own, reservation: booking(now + 60_000) }),
    ], "t3", "me", now);
    expect(targets.map((t) => [t.table.id, t.selectable, t.note])).toEqual([
      ["t5", true, "linked to this bill"],
      ["t6", false, "occupied — merge instead"],
      ["t7", false, "occupied — merge instead"],
      ["t8", false, "reserved now"],
      ["t9", true, "linked to this bill"],
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

describe("mergeRoles", () => {
  it("keeps the bill on the chosen side and folds the other order", () => {
    expect(mergeRoles("me", { billAt: "this", otherOrderId: "other" })).toEqual({ keepsBill: "me", foldedIn: "other" });
    expect(mergeRoles("me", { billAt: "other", otherOrderId: "other" })).toEqual({ keepsBill: "other", foldedIn: "me" });
  });
});

describe("mergeBlockedReason", () => {
  const blocked = "Save or discard the cart items before merging.";
  type Cart = { draft: number; queued: number };
  /** What the order screen does: look up the cart of the order being folded away. */
  const reasonFor = (billAt: "this" | "other", carts: Record<"me" | "other", Cart>) => {
    const { foldedIn } = mergeRoles("me", { billAt, otherOrderId: "other" });
    const cart = carts[foldedIn as "me" | "other"];
    return mergeBlockedReason({ foldedDraftCount: cart.draft, foldedQueuedCount: cart.queued });
  };
  const empty = { draft: 0, queued: 0 };

  it("allows a merge when the folded order has nothing unsaved", () => {
    expect(mergeBlockedReason({ foldedDraftCount: 0, foldedQueuedCount: 0 })).toBeNull();
    expect(reasonFor("this", { me: empty, other: empty })).toBeNull();
    expect(reasonFor("other", { me: empty, other: empty })).toBeNull();
  });

  it("Bill at this table: this order's cart is safe, the other order's held cart blocks", () => {
    expect(reasonFor("this", { me: { draft: 3, queued: 1 }, other: empty })).toBeNull();
    expect(reasonFor("this", { me: empty, other: { draft: 2, queued: 0 } })).toBe(blocked);
    expect(reasonFor("this", { me: empty, other: { draft: 0, queued: 1 } })).toBe(blocked);
  });

  it("Bill at the other table: this order is folded, so its cart or queued items block", () => {
    expect(reasonFor("other", { me: empty, other: { draft: 4, queued: 2 } })).toBeNull();
    expect(reasonFor("other", { me: { draft: 1, queued: 0 }, other: empty })).toBe(blocked);
    expect(reasonFor("other", { me: { draft: 0, queued: 1 }, other: empty })).toBe(blocked);
  });
});

describe("qrBillGroupOptions", () => {
  it("is empty when the table is unknown or has no open groups", () => {
    expect(qrBillGroupOptions(undefined)).toEqual([]);
    expect(qrBillGroupOptions(table("t1"))).toEqual([]);
  });

  it("lists the table's open bill groups only", () => {
    expect(qrBillGroupOptions(table("t1", { status: "occupied", activeOrders: [
      { id: "a", splitLabel: "A", status: "open" }, { id: "b", splitLabel: "B", status: "billed" }, { id: "c", splitLabel: null, status: "open" },
    ] }))).toEqual([{ value: "a", label: "Existing group A" }, { value: "c", label: "Existing group ?" }]);
  });

  it("offers the open combined order a linked table belongs to", () => {
    const linked = { orderId: "o9", status: "open" as const, label: "T3, T4", tableName: "T3" };
    expect(qrBillGroupOptions(table("t4", { status: "occupied", link: linked }))).toEqual([{ value: "o9", label: "T3, T4" }]);
    expect(qrBillGroupOptions(table("t4", { status: "occupied", link: linked, activeOrders: [{ id: "a", splitLabel: "A", status: "open" }] })))
      .toEqual([{ value: "a", label: "Existing group A" }, { value: "o9", label: "T3, T4" }]);
  });

  it("does not offer a combined order that is already billed", () => {
    expect(qrBillGroupOptions(table("t4", { status: "billed", link: { orderId: "o9", status: "billed", label: "T3, T4", tableName: "T3" } }))).toEqual([]);
  });
});

const link = { orderId: "o9", status: "open" as const, label: "T3, T4", tableName: "T3" };

describe("tableCardNote", () => {
  it("names the table a linked table is billed with", () => {
    expect(tableCardNote(table("t4", { status: "occupied", link }))).toBe("with T3");
  });

  it("has no note for an unlinked table", () => {
    expect(tableCardNote(table("t4"))).toBeNull();
    expect(tableCardNote(table("t4", { status: "occupied", activeOrders: [{ id: "o1", splitLabel: "A", status: "open" }] }))).toBeNull();
  });
});

describe("tableOpenTargets", () => {
  it("is empty for a free table", () => {
    expect(tableOpenTargets(table("t1"))).toEqual([]);
  });

  it("lists own groups only when there is no link", () => {
    expect(tableOpenTargets(table("t1", { status: "occupied", activeOrders: [
      { id: "a", splitLabel: "A", status: "open" }, { id: "b", splitLabel: null, status: "billed" },
    ] }))).toEqual([{ orderId: "a", label: "Split A" }, { orderId: "b", label: "Split ?" }]);
  });

  it("opens only the combined order for a linked table with no own groups", () => {
    expect(tableOpenTargets(table("t4", { status: "occupied", link }))).toEqual([{ orderId: "o9", label: "T3, T4" }]);
  });

  it("lists own groups plus the combined order when a linked table has its own bills", () => {
    expect(tableOpenTargets(table("t4", { status: "occupied", link, activeOrders: [{ id: "a", splitLabel: "A", status: "open" }] })))
      .toEqual([{ orderId: "a", label: "Split A" }, { orderId: "o9", label: "T3, T4" }]);
  });
});

describe("receivingLabel", () => {
  it("returns the combined label of an own order that absorbed other tables", () => {
    const t3 = table("t3", { name: "T3", status: "occupied", activeOrders: [{ id: "o9", splitLabel: "A", status: "open" }] });
    const linked = table("t4", { name: "T4", status: "occupied", link });
    expect(receivingLabel(t3, [linked, t3])).toBe("T3, T4");
  });

  it("is null when nothing is linked to the table's orders", () => {
    const t3 = table("t3", { name: "T3", status: "occupied", activeOrders: [{ id: "o1", splitLabel: "A", status: "open" }] });
    expect(receivingLabel(t3, [t3, table("t4", { name: "T4", status: "occupied", link })])).toBeNull();
    expect(receivingLabel(table("t5"), [])).toBeNull();
  });
});
