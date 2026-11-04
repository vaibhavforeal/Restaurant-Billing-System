import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb, type Database } from "./db.js";
import { migrate } from "./migrate.js";
import { MIGRATIONS } from "./migrations/index.js";
import { popularProductIds } from "./menu-insights.js";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 4, 12);

describe("popularProductIds", () => {
  let db: Database;
  let seq = 0;

  beforeEach(() => {
    db = openDb(":memory:");
    migrate(db, MIGRATIONS);
    // Only the ranking query is under test: bills and lines are written directly, without the orders and users behind them.
    db.pragma("foreign_keys = OFF");
    seq = 0;
    category("starters"); category("mains"); category("drinks");
    product("paneer", "starters"); product("samosa", "starters"); product("kebab", "starters");
    product("dal", "mains"); product("biryani", "mains");
    product("lassi", "drinks");
  });
  afterEach(() => db.close());

  function category(id: string, active = 1) {
    db.prepare("INSERT INTO categories (id, name, sort_order, is_active) VALUES (?, ?, 0, ?)").run(id, id, active);
  }
  function product(id: string, categoryId: string, opts: { active?: number; soldOut?: number } = {}) {
    db.prepare("INSERT INTO products (id, category_id, name, price_paise, is_active, is_sold_out, created_at) VALUES (?, ?, ?, 10000, ?, ?, 0)")
      .run(id, categoryId, id, opts.active ?? 1, opts.soldOut ?? 0);
  }
  /** One bill with the given lines: [productId, qty, totalPaise?, parentOrderItemId?, variantId?]. Returns the bill id and its order item ids. */
  function bill(at: number, lines: Array<[string, number, (number | undefined)?, (string | undefined)?, (string | undefined)?]>) {
    const billId = `b${++seq}`;
    db.prepare(`INSERT INTO bills (id, bill_no, order_id, subtotal_paise, cgst_paise, sgst_paise, total_paise, status, created_at, created_by)
      VALUES (?, ?, ?, 0, 0, 0, 0, 'paid', ?, 'u')`).run(billId, seq, `o${seq}`, at);
    const itemIds = lines.map(([productId, qty, total, parent, variant]) => {
      const itemId = `i${++seq}`;
      db.prepare(`INSERT INTO bill_report_lines (bill_id, order_item_id, product_id, variant_id, name, category_id, category_name, qty,
        subtotal_paise, discount_paise, taxable_paise, cgst_paise, sgst_paise, rounding_paise, total_paise, parent_order_item_id)
        VALUES (?, ?, ?, ?, ?, 'old', 'old', ?, 0, 0, 0, 0, 0, 0, ?, ?)`).run(billId, itemId, productId, variant ?? null, productId, qty, total ?? qty * 10000, parent ?? null);
      return itemId;
    });
    return { billId, itemIds };
  }
  function credit(billId: string, orderItemId: string, qty: number, totalPaise = qty * 10000) {
    const id = `c${++seq}`;
    db.prepare(`INSERT INTO credit_notes (id, cn_no, bill_id, kind, reason, taxable_paise, cgst_paise, sgst_paise, rounding_paise, total_paise,
      requested_by, approved_by, created_at, client_ref, request_json) VALUES (?, ?, ?, 'refund', 'x', 0, 0, 0, 0, ?, 'u', 'u', ?, ?, '{}')`)
      .run(id, seq, billId, totalPaise, NOW, id);
    db.prepare(`INSERT INTO credit_note_lines (credit_note_id, order_item_id, name, category_name, gst_rate, qty, taxable_paise, cgst_paise, sgst_paise, rounding_paise, total_paise)
      VALUES (?, ?, 'x', 'x', 5, ?, 0, 0, 0, 0, ?)`).run(id, orderItemId, qty, totalPaise);
  }
  const popular = () => popularProductIds(db, NOW);

  it("picks the most ordered product in each category", () => {
    bill(NOW - DAY, [["paneer", 3], ["samosa", 5], ["dal", 4], ["biryani", 6]]);
    expect(popular()).toEqual(["biryani", "samosa"]);
  });

  it("adds a product's variants together", () => {
    bill(NOW - DAY, [["samosa", 4], ["paneer", 2, undefined, undefined, "half"], ["paneer", 3, undefined, undefined, "full"]]);
    expect(popular()).toEqual(["paneer"]);
  });

  it("subtracts credited quantities", () => {
    const { billId, itemIds } = bill(NOW - DAY, [["paneer", 6], ["samosa", 4]]);
    credit(billId, itemIds[0]!, 3);
    expect(popular()).toEqual(["samosa"]);
  });

  it("ignores items sold inside combos", () => {
    bill(NOW - DAY, [["samosa", 3], ["paneer", 9, 0, "combo-line"]]);
    expect(popular()).toEqual(["samosa"]);
  });

  it("only counts bills from the last 30 days", () => {
    bill(NOW - 31 * DAY, [["paneer", 20]]);
    bill(NOW - 29 * DAY, [["samosa", 3]]);
    expect(popular()).toEqual(["samosa"]);
  });

  it("needs at least 3 sold", () => {
    bill(NOW - DAY, [["paneer", 2], ["samosa", 1]]);
    expect(popular()).toEqual([]);
  });

  it("skips a sold-out or inactive top product and badges the next one", () => {
    db.prepare("UPDATE products SET is_sold_out = 1 WHERE id = 'paneer'").run();
    db.prepare("UPDATE products SET is_active = 0 WHERE id = 'biryani'").run();
    product("korma", "mains");
    bill(NOW - DAY, [["paneer", 9], ["samosa", 4], ["biryani", 9], ["dal", 3]]);
    expect(popular()).toEqual(["dal", "samosa"]);
  });

  it("gives no badge in a category with only one active product", () => {
    bill(NOW - DAY, [["lassi", 10]]);
    expect(popular()).toEqual([]);
  });

  it("gives no badge in an inactive category", () => {
    db.prepare("UPDATE categories SET is_active = 0 WHERE id = 'starters'").run();
    bill(NOW - DAY, [["paneer", 10]]);
    expect(popular()).toEqual([]);
  });

  it("breaks ties by revenue, then by name", () => {
    bill(NOW - DAY, [["paneer", 4, 40000], ["samosa", 4, 50000], ["dal", 3, 30000], ["biryani", 3, 30000]]);
    expect(popular()).toEqual(["biryani", "samosa"]);
  });

  it("counts a moved product in its current category", () => {
    db.prepare("UPDATE products SET category_id = 'mains' WHERE id = 'kebab'").run();
    bill(NOW - DAY, [["kebab", 8], ["biryani", 5], ["samosa", 3]]);
    expect(popular()).toEqual(["kebab", "samosa"]);
  });

  it("honours the window, per-category and minimum options", () => {
    bill(NOW - 10 * DAY, [["paneer", 5], ["samosa", 2]]);
    expect(popularProductIds(db, NOW, { days: 7 })).toEqual([]);
    expect(popularProductIds(db, NOW, { perCategory: 2, minQty: 2 })).toEqual(["paneer", "samosa"]);
  });
});
