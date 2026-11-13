import { describe, expect, it } from "vitest";
import { calculateBill } from "@masalapos/domain/billing";
import { menuCafe } from "../../../../packages/cafe-data/src/testing/fixtures";
import { BillError, deleteCustomer, deleteItem, saveCustomer, type HeldCart } from "@masalapos/cafe-data";
import { createCartStore } from "./cart-store";
import { billErrorMessage, cartTotals, entriesFromHeld } from "./cart";

describe("cartTotals", () => {
  it("prices the snapshot it is given, so a screen recomputes when the snapshot changes", () => {
    const { db, samosa } = menuCafe();
    const store = createCartStore();
    expect(cartTotals(db, store.snapshot())).toBeNull();
    store.add({ itemId: samosa.id, variantId: null, name: "Samosa", pricePaise: 1800, gstRate: 5 });
    store.add({ itemId: samosa.id, variantId: null, name: "Samosa", pricePaise: 1800, gstRate: 5 });
    store.setDiscount({ kind: "percent", bp: 1000 });
    expect(cartTotals(db, store.snapshot())).toMatchObject({ ok: true, discountPaise: 360, totals: { totalPaise: calculateBill([{ pricePaise: 1800, qty: 2, gstRate: 5 }], 360, "included", "rupee").totalPaise } });
  });
});

describe("entriesFromHeld", () => {
  const held = (lines: HeldCart["lines"], customerId: string | null = null): HeldCart => ({
    lines, discount: null, discountNote: "", orderKind: "takeaway", deliveryNote: "", customerId, removedOfferIds: [],
  });

  it("rebuilds held lines from the menu and names the ones that are gone", () => {
    const { db, chai, samosa } = menuCafe();
    const large = chai.variants.find((v) => v.name === "Large")!;
    const small = chai.variants.find((v) => v.name === "Small")!;
    const result = entriesFromHeld(db, held([
      { itemId: samosa.id, variantId: null, qty: 2, note: "hot" },
      { itemId: chai.id, variantId: large.id, qty: 1 },
      { itemId: null, variantId: null, qty: 1, custom: { name: "Cake", pricePaise: 4000, gstRate: null } },
    ]));
    expect(result.missing).toEqual([]);
    expect(result.entries.map((e) => [e.name, e.pricePaise, e.qty, e.note])).toEqual([
      ["Samosa", 1800, 2, "hot"], ["Masala Chai (Large)", 2500, 1, null], ["Cake", 4000, 1, null],
    ]);
    deleteItem(db, samosa.id, 2);
    const later = entriesFromHeld(db, held([
      { itemId: samosa.id, variantId: null, qty: 2 },
      { itemId: chai.id, variantId: small.id, qty: 1 },
      { itemId: chai.id, variantId: "gone-variant", qty: 1 },
    ]));
    expect(later.missing).toEqual(["Samosa", "Masala Chai"]);
    expect(later.entries.map((e) => e.name)).toEqual(["Masala Chai (Small)"]);
  });

  it("reports a deleted customer", () => {
    const { db } = menuCafe();
    const c = saveCustomer(db, { name: "Asha", phone: "9876543210" }, 1);
    expect(entriesFromHeld(db, held([], c.id))).toMatchObject({ customer: { id: c.id, name: "Asha", phone: "9876543210" }, customerMissing: false });
    deleteCustomer(db, c.id, 2);
    expect(entriesFromHeld(db, held([], c.id))).toMatchObject({ customer: null, customerMissing: true });
    expect(entriesFromHeld(db, held([]))).toMatchObject({ customer: null, customerMissing: false });
  });
});

describe("billErrorMessage for Phase 2 refusals", () => {
  it.each([
    ["unknown_staff", "Sign in again"],
    ["unknown_customer", "The customer was deleted"],
    ["approval_needed", "A manager or the owner must approve this discount"],
  ] as const)("explains %s", (code, text) => {
    expect(billErrorMessage(new BillError(code, "x"))).toContain(text);
  });
});

describe("cartTotals with a discount above the bill", () => {
  it("prices the cart without the discount and says why", () => {
    const { db, samosa } = menuCafe();
    const store = createCartStore();
    store.add({ itemId: samosa.id, variantId: null, name: "Samosa", pricePaise: 1800, gstRate: 5 });
    store.setDiscount({ kind: "amount", paise: 5000 });
    expect(cartTotals(db, store.snapshot())).toMatchObject({ ok: true, discountPaise: 0, discountProblem: "The discount is more than the bill",
      totals: { totalPaise: 1800 } });
    store.setDiscount({ kind: "amount", paise: 500 });
    expect(cartTotals(db, store.snapshot())).toMatchObject({ ok: true, discountPaise: 500, discountProblem: null });
  });
});
