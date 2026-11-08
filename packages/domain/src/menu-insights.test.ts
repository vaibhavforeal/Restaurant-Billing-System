import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb, type Database } from "./db.js";
import { migrate } from "./migrate.js";
import { MIGRATIONS } from "./migrations/index.js";
import { orderedTogether, popularProductIds } from "./menu-insights.js";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 4, 12);

describe("menu insights", () => {
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
  function product(id: string, categoryId: string, opts: { active?: number; soldOut?: number; kind?: "item" | "combo" } = {}) {
    db.prepare("INSERT INTO products (id, category_id, name, price_paise, is_active, is_sold_out, kind, created_at) VALUES (?, ?, ?, 10000, ?, ?, ?, 0)")
      .run(id, categoryId, id, opts.active ?? 1, opts.soldOut ?? 0, opts.kind ?? "item");
  }
  function variant(id: string, productId: string, active = 1) {
    db.prepare("INSERT INTO variants (id, product_id, name, price_paise, is_active) VALUES (?, ?, ?, 10000, ?)").run(id, productId, id, active);
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

  describe("popular by time of day", () => {
    /** Local wall-clock time, so the test holds in any time zone. */
    const at = (day: number, hour: number) => new Date(2026, 10, day, hour).getTime();

    it("ranks by sales within 2 hours of now, falling back to all day where the window has none", () => {
      bill(at(3, 8), [["paneer", 3]]);
      bill(at(3, 20), [["samosa", 9], ["biryani", 4]]);
      expect(popularProductIds(db, at(4, 9), { aroundHour: 2 })).toEqual(["biryani", "paneer"]);
      expect(popularProductIds(db, at(4, 9))).toEqual(["biryani", "samosa"]);
    });

    it("counts the window's edges and nothing beyond them", () => {
      bill(at(3, 11), [["paneer", 3]]);
      bill(at(3, 6), [["samosa", 9]]);
      expect(popularProductIds(db, at(4, 9), { aroundHour: 2 })).toEqual(["paneer"]);
      expect(popularProductIds(db, at(4, 9), { aroundHour: 3 })).toEqual(["samosa"]);
    });

    it("wraps past midnight", () => {
      bill(at(2, 23), [["samosa", 3]]);
      bill(at(3, 12), [["paneer", 5]]);
      expect(popularProductIds(db, at(4, 1), { aroundHour: 2 })).toEqual(["samosa"]);
    });
  });

  describe("orderedTogether", () => {
    const together = () => orderedTogether(db, NOW);
    /** `times` bills, each holding these products once. */
    const bills = (times: number, products: string[], at = NOW - DAY) => { for (let n = 0; n < times; n++) bill(at, products.map((id) => [id, 1])); };

    it("pairs dishes from other categories that share at least 3 bills, most shared first", () => {
      bills(4, ["biryani", "lassi"]);
      bills(3, ["biryani", "samosa"]);
      bills(2, ["biryani", "paneer"]);
      expect(together().biryani).toEqual([{ productId: "lassi", variantId: null }, { productId: "samosa", variantId: null }]);
      expect(together().lassi).toEqual([{ productId: "biryani", variantId: null }]);
      expect(together().paneer).toBeUndefined();
    });

    it("never pairs dishes from the same category", () => {
      bills(5, ["biryani", "dal"]);
      expect(together()).toEqual({});
    });

    it("skips combos, sold-out and inactive partners, and partners in inactive categories", () => {
      product("thali", "drinks", { kind: "combo" });
      category("desserts", 0); product("kulfi", "desserts");
      db.prepare("UPDATE products SET is_sold_out = 1 WHERE id = 'samosa'").run();
      db.prepare("UPDATE products SET is_active = 0 WHERE id = 'paneer'").run();
      bills(3, ["biryani", "thali", "kulfi", "samosa", "paneer", "lassi"]);
      expect(together().biryani).toEqual([{ productId: "lassi", variantId: null }]);
    });

    it("counts a bill once however many lines a dish has, and ignores items inside combos", () => {
      bills(2, ["biryani", "lassi", "lassi"]);
      bill(NOW - DAY, [["biryani", 1], ["lassi", 1, 0, "combo-line"]]);
      expect(together()).toEqual({});
    });

    it("only counts bills from the last 30 days", () => {
      bills(2, ["biryani", "lassi"]);
      bills(1, ["biryani", "lassi"], NOW - 31 * DAY);
      expect(together()).toEqual({});
    });

    it("suggests a partner's most ordered active size", () => {
      variant("small", "lassi"); variant("large", "lassi"); variant("jumbo", "lassi", 0);
      for (let n = 0; n < 3; n++) bill(NOW - DAY, [["biryani", 1], ["lassi", 1, undefined, undefined, n === 0 ? "small" : "jumbo"]]);
      bill(NOW - DAY, [["lassi", 2, undefined, undefined, "large"]]);
      expect(together().biryani).toEqual([{ productId: "lassi", variantId: "large" }]);
    });

    it("keeps at most perProduct partners and honours minBills", () => {
      bills(3, ["biryani", "lassi", "samosa", "paneer"]);
      expect(orderedTogether(db, NOW, { perProduct: 1 }).biryani).toEqual([{ productId: "lassi", variantId: null }]);
      expect(orderedTogether(db, NOW, { minBills: 4 })).toEqual({});
    });
  });

  describe("add-ons", () => {
    /** Marks a report line as an add-on picked under another line of the same bill. */
    function asAddon(orderItemId: string, productId: string, dishItemId: string) {
      db.prepare(`INSERT INTO order_items (id, order_id, product_id, name_snapshot, price_paise_snapshot, gst_rate_snapshot, qty, addon_of_item_id)
        VALUES (?, 'o', ?, ?, 0, 5, 1, ?)`).run(orderItemId, productId, productId, dishItemId);
    }

    it("never badges an add-on-only product as popular", () => {
      product("cheese", "drinks");
      db.prepare("UPDATE products SET addon_only = 1 WHERE id = 'cheese'").run();
      bill(NOW - DAY, [["cheese", 9], ["lassi", 4], ["dal", 5], ["biryani", 1]]);
      expect(popular()).toEqual(["dal", "lassi"]);
    });

    it("does not count a dish picked as an add-on towards popular or ordered together", () => {
      product("coke", "drinks");
      for (let i = 0; i < 3; i++) {
        const { itemIds } = bill(NOW - DAY, [["dal", 1], ["coke", 5]]);
        asAddon(itemIds[1]!, "coke", itemIds[0]!);
      }
      bill(NOW - DAY, [["lassi", 4]]);
      expect(popular()).toEqual(["dal", "lassi"]);
      expect(orderedTogether(db, NOW).dal).toBeUndefined();
    });
  });
});
