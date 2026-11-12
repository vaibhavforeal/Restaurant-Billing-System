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
