import { describe, expect, it } from "vitest";
import { addStaff, deleteHeld, holdCart, listHeld, takeHeld, type HeldCart } from "./index.js";
import { memoryCafeDb } from "./testing/sqlite-driver.js";

const cart = (lines: HeldCart["lines"]): HeldCart => ({
  lines, discount: { kind: "percent", bp: 1000 }, discountNote: "regular", orderKind: "delivery", deliveryNote: "Flat 4",
  customerId: "c1", removedOfferIds: [],
});

describe("held carts", () => {
  it("holds carts and lists them oldest first with the holder's name and line count", () => {
    const db = memoryCafeDb();
    const ravi = addStaff(db, { name: "Ravi", role: "cashier", pinHash: "h" }, 1);
    holdCart(db, { id: "h2", cart: cart([{ itemId: "i1", variantId: null, qty: 1 }]), note: "  table by door  ", staffId: null, now: 200 });
    holdCart(db, { id: "h1", cart: cart([{ itemId: "i1", variantId: null, qty: 2 }, { itemId: null, variantId: null, qty: 1,
      custom: { name: "Cake", pricePaise: 5000, gstRate: null } }]), note: "x".repeat(50), staffId: ravi.id, now: 100 });
    expect(listHeld(db)).toEqual([
      { id: "h1", note: "x".repeat(40), staffName: "Ravi", lineCount: 2, createdAt: 100 },
      { id: "h2", note: "table by door", staffName: null, lineCount: 1, createdAt: 200 },
    ]);
  });
  it("takes a held cart once", () => {
    const db = memoryCafeDb();
    const held = cart([{ itemId: "i1", variantId: "v1", qty: 2, note: "less sugar" }]);
    holdCart(db, { id: "h1", cart: held, note: "", staffId: null, now: 1 });
    expect(takeHeld(db, "h1")).toEqual({ ...held, lines: [{ ...held.lines[0], addonOptionIds: [] }] });
    expect(takeHeld(db, "h1")).toBeNull();
    expect(listHeld(db)).toEqual([]);
  });
  it("defaults add-on picks and removed offers when they are missing", () => {
    const db = memoryCafeDb();
    const { removedOfferIds: _r, ...old } = cart([{ itemId: "i1", variantId: null, qty: 1 }]);
    db.run("INSERT INTO held_carts (id, cart_json, note, staff_id, created_at) VALUES ('h1', ?, '', NULL, 1)", [JSON.stringify(old)]);
    const taken = takeHeld(db, "h1")!;
    expect(taken.removedOfferIds).toEqual([]);
    expect(taken.lines[0]!.addonOptionIds).toEqual([]);
  });
  it("drops a held cart that no longer parses", () => {
    const db = memoryCafeDb();
    db.run("INSERT INTO held_carts (id, cart_json, note, staff_id, created_at) VALUES ('h1', '{\"lines\":7}', '', NULL, 1)");
    db.run("INSERT INTO held_carts (id, cart_json, note, staff_id, created_at) VALUES ('h2', 'not json', '', NULL, 1)");
    expect(takeHeld(db, "h1")).toBeNull();
    expect(takeHeld(db, "h2")).toBeNull();
    expect(listHeld(db)).toEqual([]);
  });
  it("deletes a held cart", () => {
    const db = memoryCafeDb();
    holdCart(db, { id: "h1", cart: cart([{ itemId: "i1", variantId: null, qty: 1 }]), note: "", staffId: null, now: 1 });
    deleteHeld(db, "h1");
    expect(listHeld(db)).toEqual([]);
  });
});
