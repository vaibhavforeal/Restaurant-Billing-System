import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb, type Database } from "./db.js";
import { migrate } from "./migrate.js";
import { MIGRATIONS } from "./migrations/index.js";
import { allocatePaise, saveReportLines } from "./report-lines.js";

interface Item { id: string; price: number; qty: number; rate: number; parent?: string }
interface Tax { rate: number; taxable: number; cgst: number; sgst: number }
interface Line { id: string; subtotal: number; discount: number; taxable: number; cgst: number; sgst: number; total: number }

describe("saveReportLines", () => {
  let db: Database;
  beforeEach(() => {
    db = openDb(":memory:");
    migrate(db, MIGRATIONS);
    // Only the line maths is under test: the bill and its lines are written directly, without the order, users and offers behind them.
    db.pragma("foreign_keys = OFF");
    db.prepare("INSERT INTO categories (id, name) VALUES ('food', 'Food')").run();
    db.prepare("INSERT INTO products (id, category_id, name, price_paise, created_at) VALUES ('dish', 'food', 'Dish', 100, 0)").run();
  });
  afterEach(() => db.close());

  /** A bill whose tax rows are given as stored; `offers` are the offer money per order item, as the server writes it. */
  function bill(items: Item[], taxes: Tax[], offers: Array<[itemId: string, offerId: string, paise: number]> = [], gstMode: "exclusive" | null = null) {
    db.prepare("INSERT INTO bills (id, bill_no, order_id, subtotal_paise, cgst_paise, sgst_paise, total_paise, created_at, created_by, receipt_json) VALUES ('b', 1, 'o', 0, 0, 0, 0, 0, 'u', ?)")
      .run(gstMode ? JSON.stringify({ gstMode }) : null);
    for (const item of items) {
      db.prepare("INSERT INTO order_items (id, order_id, product_id, name_snapshot, price_paise_snapshot, gst_rate_snapshot, qty, status, parent_item_id) VALUES (?, 'o', 'dish', ?, ?, ?, ?, 'sent', ?)")
        .run(item.id, item.id, item.price, item.rate, item.qty, item.parent ?? null);
    }
    for (const tax of taxes) db.prepare("INSERT INTO bill_taxes (id, bill_id, gst_rate, taxable_paise, cgst_paise, sgst_paise) VALUES (?, 'b', ?, ?, ?, ?)").run(`t${tax.rate}`, tax.rate, tax.taxable, tax.cgst, tax.sgst);
    for (const [itemId, offerId, paise] of offers) db.prepare("INSERT INTO bill_offer_lines (bill_id, order_item_id, offer_id, discount_paise) VALUES ('b', ?, ?, ?)").run(itemId, offerId, paise);
    saveReportLines(db, "b");
  }
  const lines = () => db.prepare("SELECT order_item_id AS id, subtotal_paise AS subtotal, discount_paise AS discount, taxable_paise AS taxable, cgst_paise AS cgst, sgst_paise AS sgst, total_paise AS total FROM bill_report_lines WHERE bill_id = 'b' ORDER BY order_item_id")
    .all() as Line[];
  const sum = (rows: Line[], key: Exclude<keyof Line, "id">) => rows.reduce((total, row) => total + row[key], 0);

  // 29900 x 2 and 6000 x 2 at 5%, GST included: 71800 less 29900 of offers and 1000 more of bill discount leaves 40900,
  // which holds 1948 of tax (974 + 974) and 38952 taxable.
  const TWO_LINES: Item[] = [{ id: "a", price: 29900, qty: 2, rate: 5 }, { id: "b", price: 6000, qty: 2, rate: 5 }];
  const TWO_LINES_TAX: Tax[] = [{ rate: 5, taxable: 38952, cgst: 974, sgst: 974 }];

  it("gives a line its own offer money plus a share of the other discount by value after offers", () => {
    bill(TWO_LINES, TWO_LINES_TAX, [["a", "bogo", 29900]]);
    expect(allocatePaise(1000, [29900, 12000])).toEqual([714, 286]);
    const rows = lines();
    expect(rows.map((row) => row.discount)).toEqual([29900 + 714, 286]);
    expect(sum(rows, "discount")).toBe(30900);
    expect(sum(rows, "taxable")).toBe(38952);
    expect(sum(rows, "cgst")).toBe(974);
    expect(sum(rows, "sgst")).toBe(974);
    for (const row of rows) expect(row.total).toBe(row.taxable + row.cgst + row.sgst);
  });

  it("adds up the offers that landed on one line", () => {
    bill(TWO_LINES, TWO_LINES_TAX, [["a", "bogo", 20000], ["a", "cool", 9900]]);
    expect(lines().map((row) => row.discount)).toEqual([29900 + 714, 286]);
  });

  it("spreads the whole discount by line value when no offer applied", () => {
    bill(TWO_LINES, TWO_LINES_TAX);
    const rows = lines();
    expect(rows.map((row) => row.discount)).toEqual(allocatePaise(30900, [59800, 12000]));
    expect(rows.map((row) => row.discount)).toEqual([25736, 5164]);
    expect(sum(rows, "taxable")).toBe(38952);
    expect(sum(rows, "cgst")).toBe(974);
    expect(sum(rows, "sgst")).toBe(974);
  });

  it("takes a free line's whole amount as its discount and leaves the rest of the group's discount to the paid line", () => {
    // A 30000 dish given free by an offer beside a 10500 line with 500 more discount: 10000 is left to pay, holding 476 of tax.
    bill(
      [{ id: "a", price: 30000, qty: 1, rate: 5 }, { id: "b", price: 10500, qty: 1, rate: 5 }],
      [{ rate: 5, taxable: 9524, cgst: 238, sgst: 238 }],
      [["a", "bogo", 30000]],
    );
    const rows = lines();
    expect(rows[0]).toEqual({ id: "a", subtotal: 30000, discount: 30000, taxable: 0, cgst: 0, sgst: 0, total: 0 });
    expect(rows[1]).toEqual({ id: "b", subtotal: 10500, discount: 500, taxable: 9524, cgst: 238, sgst: 238, total: 10000 });
    expect([sum(rows, "taxable"), sum(rows, "cgst"), sum(rows, "sgst")]).toEqual([9524, 238, 238]);
  });

  it("keeps offers inside their GST rate group, with GST added on top, and combo contents at zero", () => {
    // 5%: A is 20000, B 5000; 5000 of offers on A and 2000 more discount leave 18000 taxable. 18%: C is 10000, untouched.
    bill(
      [{ id: "a", price: 10000, qty: 2, rate: 5 }, { id: "b", price: 5000, qty: 1, rate: 5 }, { id: "c", price: 10000, qty: 1, rate: 18 }, { id: "d", price: 0, qty: 1, rate: 5, parent: "a" }],
      [{ rate: 5, taxable: 18000, cgst: 450, sgst: 450 }, { rate: 18, taxable: 10000, cgst: 900, sgst: 900 }],
      [["a", "bogo", 3000], ["a", "cool", 2000]], "exclusive",
    );
    const rows = lines();
    expect(rows.map((row) => [row.id, row.discount])).toEqual([["a", 5000 + 1500], ["b", 500], ["c", 0], ["d", 0]]);
    const five = rows.filter((row) => row.id === "a" || row.id === "b");
    expect([sum(five, "taxable"), sum(five, "cgst"), sum(five, "sgst")]).toEqual([18000, 450, 450]);
    expect(rows.find((row) => row.id === "c")).toMatchObject({ taxable: 10000, cgst: 900, sgst: 900, total: 11800 });
    expect(rows.find((row) => row.id === "d")).toMatchObject({ subtotal: 0, taxable: 0, cgst: 0, sgst: 0, total: 0 });
    expect(db.prepare("SELECT parent_order_item_id AS parent FROM bill_report_lines WHERE order_item_id = 'd'").get()).toEqual({ parent: "a" });
  });
});
