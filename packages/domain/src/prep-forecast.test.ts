import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb, type Database } from "./db.js";
import { migrate } from "./migrate.js";
import { MIGRATIONS } from "./migrations/index.js";
import { prepForecast } from "./prep-forecast.js";

// Today is Wednesday 4 Nov 2026; Thursday 5 Nov is tomorrow.
const TODAY = "2026-11-04";

describe("prepForecast", () => {
  let db: Database;
  let seq = 0;

  beforeEach(() => {
    db = openDb(":memory:");
    migrate(db, MIGRATIONS);
    // Only the forecast's reads are under test: bills and lines are written directly, without orders and users.
    db.pragma("foreign_keys = OFF");
    seq = 0;
    db.prepare("INSERT INTO categories (id, name, sort_order, is_active) VALUES ('mains', 'Mains', 0, 1), ('drinks', 'Drinks', 1, 1)").run();
    product("paneer", "Paneer tikka", "mains"); product("dal", "Dal", "mains"); product("naan", "Naan", "mains");
    product("lassi", "Lassi", "drinks"); product("thali", "Thali", "mains", "combo");
    db.prepare("INSERT INTO variants (id, product_id, name, price_paise, is_active) VALUES ('large', 'lassi', 'Large', 9000, 1)").run();
    db.prepare("INSERT INTO stock_items (id, name, unit, qty, is_active) VALUES ('cheese', 'Paneer', 'kg', 1.5, 1), ('curd', 'Curd', 'L', 5, 1), ('old', 'Old stock', 'kg', 0, 0)").run();
    link("paneer", "cheese", 0.15); link("lassi", "curd", 0.3); link("dal", "old", 1);
  });
  afterEach(() => db.close());

  function product(id: string, name: string, categoryId: string, kind = "item") {
    db.prepare("INSERT INTO products (id, category_id, name, price_paise, kind, created_at) VALUES (?, ?, ?, 10000, ?, 0)").run(id, categoryId, name, kind);
  }
  function link(productId: string, stockItemId: string, qtyPerSale: number) {
    db.prepare("INSERT INTO product_stock_links (id, product_id, stock_item_id, qty_per_sale) VALUES (?, ?, ?, ?)").run(`${productId}-${stockItemId}`, productId, stockItemId, qtyPerSale);
  }
  /** A bill at noon local time on `day`: lines are [productId, qty, variantId?, parentOrderItemId?]. */
  function bill(day: string, lines: Array<[string, number, (string | null)?, string?]>, status = "paid") {
    const [y, m, d] = day.split("-").map(Number) as [number, number, number];
    const billId = `b${++seq}`;
    db.prepare(`INSERT INTO bills (id, bill_no, order_id, subtotal_paise, cgst_paise, sgst_paise, total_paise, status, created_at, created_by)
      VALUES (?, ?, ?, 0, 0, 0, 0, ?, ?, 'u')`).run(billId, seq, `o${seq}`, status, new Date(y, m - 1, d, 12).getTime());
    for (const [productId, qty, variantId, parent] of lines) {
      db.prepare(`INSERT INTO bill_report_lines (bill_id, order_item_id, product_id, variant_id, name, category_id, category_name, qty,
        subtotal_paise, discount_paise, taxable_paise, cgst_paise, sgst_paise, rounding_paise, total_paise, parent_order_item_id)
        VALUES (?, ?, ?, ?, 'snapshot', 'mains', 'Mains', ?, 0, 0, 0, 0, 0, 0, 0, ?)`).run(billId, `i${++seq}`, productId, variantId ?? null, qty, parent ?? null);
    }
  }
  const dish = (forecast: ReturnType<typeof prepForecast>, name: string) => forecast.dishes.find((d) => d.name === name);

  it("averages the last 4 same weekdays, zero days included, listing dishes sold on at least 2 of them", () => {
    bill("2026-09-01", [["naan", 1]]);
    bill("2026-10-29", [["paneer", 3], ["dal", 6], ["lassi", 2, "large"]]);
    bill("2026-10-22", [["paneer", 5], ["lassi", 1, "large"]]);
    bill("2026-10-08", [["paneer", 4]]);
    bill("2026-10-28", [["paneer", 50]]);
    bill("2026-10-29", [["paneer", 10]], "void");
    const forecast = prepForecast(db, "2026-11-05", TODAY);
    expect(forecast.date).toBe("2026-11-05");
    expect(forecast.basedOn).toEqual(["2026-10-29", "2026-10-22", "2026-10-15", "2026-10-08"]);
    expect(forecast.dishes).toEqual([
      { productId: "lassi", variantId: "large", name: "Lassi (Large)", category: "Drinks", average: 0.75, days: [2, 1, 0, 0] },
      { productId: "paneer", variantId: null, name: "Paneer tikka", category: "Mains", average: 3, days: [3, 5, 0, 4] },
    ]);
  });

  it("only uses days that are over: a week ahead skips today", () => {
    bill("2026-09-01", [["naan", 1]]);
    expect(prepForecast(db, "2026-11-11", TODAY).basedOn).toEqual(["2026-10-28", "2026-10-21", "2026-10-14", "2026-10-07"]);
  });

  it("averages over fewer days for a new restaurant, and is empty without history", () => {
    expect(prepForecast(db, "2026-11-05", TODAY)).toEqual({ date: "2026-11-05", basedOn: [], dishes: [], ingredients: [], unlinkedDishes: [] });
    bill("2026-10-22", [["paneer", 2]]);
    bill("2026-10-29", [["paneer", 4]]);
    const forecast = prepForecast(db, "2026-11-05", TODAY);
    expect(forecast.basedOn).toEqual(["2026-10-29", "2026-10-22"]);
    expect(dish(forecast, "Paneer tikka")).toMatchObject({ average: 3, days: [4, 2] });
  });

  it("leaves out inactive dishes", () => {
    db.prepare("UPDATE products SET is_active = 0 WHERE id = 'paneer'").run();
    bill("2026-10-22", [["paneer", 2]]); bill("2026-10-29", [["paneer", 4]]);
    expect(prepForecast(db, "2026-11-05", TODAY).dishes).toEqual([]);
  });

  it("works out ingredients from recipes, counting items inside combos, against stock on hand", () => {
    bill("2026-10-01", [["naan", 1]]);
    for (const day of ["2026-10-29", "2026-10-22", "2026-10-15", "2026-10-08"]) {
      bill(day, [["paneer", 4], ["naan", 2], ["thali", 2], ["paneer", 2, null, "thali-line"], ["lassi", 5, "large"], ["dal", 1]]);
    }
    const forecast = prepForecast(db, "2026-11-05", TODAY);
    expect(dish(forecast, "Thali")).toMatchObject({ average: 2 });
    // Paneer: (4 + 2 inside the thali) × 0.15 kg = 0.9 kg. Curd: 5 × 0.3 L = 1.5 L. Old stock is inactive.
    expect(forecast.ingredients).toEqual([
      { stockItemId: "curd", name: "Curd", unit: "L", need: 1.5, onHand: 5 },
      { stockItemId: "cheese", name: "Paneer", unit: "kg", need: 0.9, onHand: 1.5 },
    ]);
    expect(forecast.unlinkedDishes).toEqual(["Naan"]);
  });
});
