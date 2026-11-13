import { beforeEach, describe, expect, it } from "vitest";
import { createCartStore } from "./cart-store";

let cart: ReturnType<typeof createCartStore>;
const smallChai = { itemId: "chai", variantId: "small", name: "Masala Chai (Small)", pricePaise: 1500, gstRate: null };
const largeChai = { itemId: "chai", variantId: "large", name: "Masala Chai (Large)", pricePaise: 2500, gstRate: null };
const custom = { itemId: null, variantId: null, name: "Item", pricePaise: 4000, gstRate: null };

describe("cart store", () => {
  beforeEach(() => { cart = createCartStore(); });

  it("adds to the same line for the same item and variant, and a new line otherwise", () => {
    cart.add(smallChai); cart.add(smallChai);
    expect(cart.entries()).toHaveLength(1);
    expect(cart.entries()[0]!.qty).toBe(2);
    cart.add(largeChai);
    expect(cart.entries().map((e) => [e.name, e.qty])).toEqual([["Masala Chai (Small)", 2], ["Masala Chai (Large)", 1]]);
  });

  it("never merges custom lines", () => {
    cart.add(custom); cart.add(custom);
    expect(cart.entries()).toHaveLength(2);
    expect(new Set(cart.entries().map((e) => e.key)).size).toBe(2);
  });

  it("removes a line at quantity 0 and caps at 999", () => {
    cart.add(smallChai);
    const key = cart.entries()[0]!.key;
    cart.setQty(key, 5000);
    expect(cart.entries()[0]!.qty).toBe(999);
    cart.setQty(key, 0);
    expect(cart.entries()).toEqual([]);
  });

  it("turns a percent discount into paise, rounding half up, never above the subtotal", () => {
    cart.setDiscount({ kind: "percent", bp: 1250 }); expect(cart.discountPaise(3333)).toBe(417);
    cart.setDiscount({ kind: "amount", paise: 9999 }); expect(cart.discountPaise(3333)).toBe(3333);
    cart.setDiscount({ kind: "percent", bp: 1000 }, "Regular"); expect(cart.discountPaise(3600)).toBe(360);
    expect(cart.discount()).toEqual({ value: { kind: "percent", bp: 1000 }, note: "Regular" });
    cart.setDiscount(null); expect(cart.discountPaise(3600)).toBe(0);
  });

  it("turns the cart into bill lines", () => {
    cart.add(smallChai); cart.add({ ...custom, name: "Cookie", gstRate: 18 });
    expect(cart.toLines()).toEqual([
      { itemId: "chai", variantId: "small", qty: 1 },
      { itemId: null, variantId: null, qty: 1, custom: { name: "Cookie", pricePaise: 4000, gstRate: 18 } },
    ]);
  });

  it("clears lines and discount together and notifies", () => {
    let changes = 0;
    cart.subscribe(() => { changes++; });
    cart.add(smallChai); cart.setDiscount({ kind: "amount", paise: 100 }, "x");
    const before = changes;
    cart.clear();
    expect(cart.entries()).toEqual([]);
    expect(cart.discount()).toEqual({ value: null, note: "" });
    expect(changes).toBe(before + 1);
  });
});

describe("cart snapshot", () => {
  it("is the same object until the cart changes, then a new one with the change", () => {
    const store = createCartStore();
    const first = store.snapshot();
    expect(store.snapshot()).toBe(first);
    store.add({ itemId: "tea", variantId: null, name: "Tea", pricePaise: 1500, gstRate: null });
    const second = store.snapshot();
    expect(second).not.toBe(first);
    expect(second.lines.map((l) => l.name)).toEqual(["Tea"]);
    store.setDiscount({ kind: "amount", paise: 100 }, "Staff");
    expect(store.snapshot()).toMatchObject({ discount: { kind: "amount", paise: 100 }, note: "Staff" });
    expect(first.lines).toEqual([]);
  });
});

describe("cart: order kind, customer, notes, approval and hold", () => {
  const asha = { id: "c1", name: "Asha", phone: "9876543210", addressNote: "Flat 4" };
  beforeEach(() => { cart = createCartStore(); });

  it("defaults to Takeaway and resets kind, customer, notes and approval on clear", () => {
    expect(cart.snapshot()).toMatchObject({ orderKind: "takeaway", deliveryNote: "", customer: null, approvedBy: null });
    cart.add(smallChai);
    cart.setLineNote(cart.entries()[0]!.key, "less sugar");
    cart.setOrderKind("delivery");
    cart.setDeliveryNote("Gate 2");
    cart.setCustomer(asha);
    cart.setDiscount({ kind: "percent", bp: 1000 });
    cart.setApproval("m1");
    cart.clear();
    expect(cart.snapshot()).toMatchObject({ lines: [], orderKind: "takeaway", deliveryNote: "", customer: null, approvedBy: null, discount: null });
  });

  it("fills an empty delivery note from the customer's address and leaves a typed one", () => {
    cart.setOrderKind("delivery");
    cart.setCustomer(asha);
    expect(cart.snapshot().deliveryNote).toBe("Flat 4");
    expect(cart.snapshot().customer).toEqual({ id: "c1", name: "Asha", phone: "9876543210" });
    cart.clear();
    cart.setOrderKind("delivery");
    cart.setDeliveryNote("Gate 2");
    cart.setCustomer(asha);
    expect(cart.snapshot().deliveryNote).toBe("Gate 2");
    cart.clear();
    cart.setCustomer(asha);
    expect(cart.snapshot().deliveryNote).toBe("");
    cart.setOrderKind("delivery");
    expect(cart.snapshot().deliveryNote).toBe("Flat 4");
  });

  it("cuts the delivery note at 200 and a line note at 60", () => {
    cart.add(smallChai);
    cart.setDeliveryNote("x".repeat(250));
    cart.setLineNote(cart.entries()[0]!.key, "y".repeat(80));
    expect(cart.snapshot().deliveryNote).toHaveLength(200);
    expect(cart.entries()[0]!.note).toHaveLength(60);
    cart.setLineNote(cart.entries()[0]!.key, "   ");
    expect(cart.entries()[0]!.note).toBeNull();
  });

  it("clears an approval when the discount changes", () => {
    cart.setDiscount({ kind: "percent", bp: 1000 });
    cart.setApproval("m1");
    expect(cart.snapshot().approvedBy).toBe("m1");
    cart.setDiscount({ kind: "percent", bp: 1500 });
    expect(cart.snapshot().approvedBy).toBeNull();
  });

  it("does not merge a tap into a line that has a note", () => {
    cart.add(smallChai);
    cart.setLineNote(cart.entries()[0]!.key, "less sugar");
    cart.add(smallChai);
    expect(cart.entries().map((e) => [e.qty, e.note])).toEqual([[1, "less sugar"], [1, null]]);
    cart.add(smallChai);
    expect(cart.entries().map((e) => [e.qty, e.note])).toEqual([[1, "less sugar"], [2, null]]);
  });

  it("round-trips a cart through toHeld and load", () => {
    cart.add(smallChai);
    cart.add({ ...custom, name: "Cake" });
    cart.setLineNote(cart.entries()[0]!.key, "less sugar");
    cart.setDiscount({ kind: "amount", paise: 500 }, "Regular");
    cart.setApproval("m1");
    cart.setOrderKind("delivery");
    cart.setDeliveryNote("Gate 2");
    cart.setCustomer(asha);
    const held = cart.toHeld();
    expect(held).toEqual({
      lines: [
        { itemId: "chai", variantId: "small", qty: 1, note: "less sugar", addonOptionIds: [] },
        { itemId: null, variantId: null, qty: 1, custom: { name: "Cake", pricePaise: 4000, gstRate: null }, note: null, addonOptionIds: [] },
      ],
      discount: { kind: "amount", paise: 500 }, discountNote: "Regular", orderKind: "delivery", deliveryNote: "Gate 2", customerId: "c1",
      removedOfferIds: [],
    });
    const entries = cart.entries();
    const other = createCartStore();
    other.load(held, entries, { id: "c1", name: "Asha", phone: "9876543210" });
    expect(other.snapshot()).toMatchObject({ orderKind: "delivery", deliveryNote: "Gate 2", customer: { id: "c1" }, discount: held.discount,
      note: "Regular", approvedBy: null });
    expect(other.toHeld()).toEqual(held);
  });
});
