import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb, type Database } from "./db.js";
import { migrate } from "./migrate.js";
import { MIGRATIONS } from "./migrations/index.js";
import { customerLastOrder, customerUsual } from "./customer-usual.js";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 4, 12);

describe("customer's usual", () => {
  let db: Database;
  let seq = 0;

  beforeEach(() => {
    db = openDb(":memory:");
    migrate(db, MIGRATIONS);
    // Only the queries are under test: bills and lines are written directly, without the orders and users behind them.
    db.pragma("foreign_keys = OFF");
    seq = 0;
    db.prepare("INSERT INTO categories (id, name, sort_order, is_active) VALUES ('food', 'Food', 0, 1), ('old', 'Old', 0, 0)").run();
    for (const id of ["paneer", "naan", "dal", "lassi", "thali"]) product(id);
    product("kulfi", "old");
    db.prepare("UPDATE products SET kind = 'combo' WHERE id = 'thali'").run();
  });
  afterEach(() => db.close());

  function product(id: string, categoryId = "food") {
    db.prepare("INSERT INTO products (id, category_id, name, price_paise, created_at) VALUES (?, ?, ?, 10000, 0)").run(id, categoryId, id);
  }
  function variant(id: string, productId: string, active = 1) {
    db.prepare("INSERT INTO variants (id, product_id, name, price_paise, is_active) VALUES (?, ?, ?, 10000, ?)").run(id, productId, id, active);
  }
  /** One bill for `customer`: lines are [productId, qty, variantId?, parentOrderItemId?]. */
  function bill(customer: string | null, at: number, lines: Array<[string, number, (string | null)?, string?]>, status = "paid") {
    const billId = `b${++seq}`;
    db.prepare(`INSERT INTO bills (id, bill_no, order_id, subtotal_paise, cgst_paise, sgst_paise, total_paise, status, created_at, created_by, customer_id)
      VALUES (?, ?, ?, 0, 0, 0, 0, ?, ?, 'u', ?)`).run(billId, seq, `o${seq}`, status, at, customer);
    for (const [productId, qty, variantId, parent] of lines) {
      db.prepare(`INSERT INTO bill_report_lines (bill_id, order_item_id, product_id, variant_id, name, category_id, category_name, qty,
        subtotal_paise, discount_paise, taxable_paise, cgst_paise, sgst_paise, rounding_paise, total_paise, parent_order_item_id)
        VALUES (?, ?, ?, ?, ?, 'food', 'Food', ?, 0, 0, 0, 0, 0, 0, 0, ?)`).run(billId, `i${++seq}`, productId, variantId ?? null, `${productId} name`, qty, parent ?? null);
    }
    return billId;
  }
  const usual = () => customerUsual(db, "asha", NOW);

  describe("customerUsual", () => {
    it("lists dishes on at least 2 of the customer's bills, most bills first, then most recent", () => {
      bill("asha", NOW - 10 * DAY, [["paneer", 1], ["naan", 4], ["dal", 1]]);
      bill("asha", NOW - 5 * DAY, [["paneer", 1], ["dal", 1]]);
      bill("asha", NOW - 2 * DAY, [["paneer", 2], ["naan", 1], ["lassi", 1]]);
      bill("ravi", NOW - DAY, [["lassi", 1]]);
      expect(usual()).toEqual([
        { productId: "paneer", variantId: null, bills: 3 },
        { productId: "naan", variantId: null, bills: 2 },
        { productId: "dal", variantId: null, bills: 2 },
      ]);
    });

    it("ignores void bills, bills older than 6 months and items inside combos", () => {
      bill("asha", NOW - DAY, [["paneer", 1]], "void");
      bill("asha", NOW - 2 * DAY, [["paneer", 1], ["naan", 1, null, "combo-line"]]);
      bill("asha", NOW - 190 * DAY, [["paneer", 1], ["naan", 1]]);
      bill("asha", NOW - 3 * DAY, [["naan", 1, null, "combo-line"]]);
      expect(usual()).toEqual([]);
    });

    it("skips sold-out, inactive and inactive-category dishes, but keeps combos", () => {
      db.prepare("UPDATE products SET is_sold_out = 1 WHERE id = 'paneer'").run();
      db.prepare("UPDATE products SET is_active = 0 WHERE id = 'naan'").run();
      for (const days of [1, 2]) bill("asha", NOW - days * DAY, [["paneer", 1], ["naan", 1], ["kulfi", 1], ["thali", 1]]);
      expect(usual()).toEqual([{ productId: "thali", variantId: null, bills: 2 }]);
    });

    it("uses the size this customer orders most, or the first active size", () => {
      variant("half", "paneer"); variant("full", "paneer"); variant("jumbo", "paneer", 0);
      variant("small", "lassi"); variant("large", "lassi", 0);
      bill("asha", NOW - 3 * DAY, [["paneer", 1, "half"], ["lassi", 1, "large"]]);
      bill("asha", NOW - 2 * DAY, [["paneer", 3, "full"], ["lassi", 1, "large"]]);
      bill("asha", NOW - DAY, [["paneer", 5, "jumbo"]]);
      expect(usual()).toEqual([
        { productId: "paneer", variantId: "full", bills: 3 },
        { productId: "lassi", variantId: "small", bills: 2 },
      ]);
    });

    it("honours limit, days and minBills", () => {
      for (const days of [1, 40]) bill("asha", NOW - days * DAY, [["paneer", 1], ["naan", 1]]);
      expect(customerUsual(db, "asha", NOW, { limit: 1 })).toEqual([{ productId: "naan", variantId: null, bills: 2 }]);
      expect(customerUsual(db, "asha", NOW, { days: 30 })).toEqual([]);
      expect(customerUsual(db, "asha", NOW, { days: 30, minBills: 1 }).map((d) => d.productId)).toEqual(["naan", "paneer"]);
    });
  });

  describe("customerLastOrder", () => {
    it("returns the latest non-void bill's dishes, same dish and size added together, in bill order", () => {
      variant("half", "paneer");
      bill("asha", NOW - 3 * DAY, [["dal", 1]]);
      bill("asha", NOW - 2 * DAY, [["naan", 2], ["paneer", 1, "half"], ["naan", 1], ["dal", 1, null, "combo-line"], ["thali", 1]]);
      bill("asha", NOW - DAY, [["lassi", 1]], "void");
      bill("ravi", NOW, [["kulfi", 1]]);
      expect(customerLastOrder(db, "asha")).toEqual({
        billNo: 3, createdAt: NOW - 2 * DAY,
        items: [
          { productId: "naan", variantId: null, name: "naan name", qty: 3 },
          { productId: "paneer", variantId: "half", name: "paneer name", qty: 1 },
          { productId: "thali", variantId: null, name: "thali name", qty: 1 },
        ],
      });
    });

    it("is null for a customer without bills", () => {
      expect(customerLastOrder(db, "nobody")).toBeNull();
    });
  });
});
