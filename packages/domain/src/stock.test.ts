import { describe, expect, it } from "vitest";
import { openDb, type Database } from "./db.js";
import { migrate } from "./migrate.js";
import { MIGRATIONS } from "./migrations/index.js";
import { appendStockMove, consumeStock, reverseStock } from "./stock.js";
import { stockMilli, StockCreate, StockAdjust, StockLinkUpdate, UnitCostSet } from "./stock-schemas.js";

describe("stock quantities", () => {
  it("uses integer thousandths without accumulating decimal noise", () => {
    expect(stockMilli(0.1 + 0.2)).toBe(300);
    expect(stockMilli(-1.125)).toBe(-1125);
    expect((stockMilli(1) - stockMilli(0.1) * 10) / 1000).toBe(0);
    expect(stockMilli(1_000_000_000)).toBe(1_000_000_000_000);
  });
  it("rejects non-finite, excessive and over-precise quantities", () => {
    for (const n of [NaN, Infinity, -Infinity, 1e10, 0.0001, -1.2345]) expect(() => stockMilli(n)).toThrow();
  });
  it("validates units, opening balances, reasons and positive sale quantities", () => {
    expect(StockCreate.safeParse({ clientRef: "stock-ref-1", name: "Rice", unit: "kg", openingQty: 2.125 }).success).toBe(true);
    expect(StockCreate.safeParse({ clientRef: "stock-ref-1", name: "Rice", unit: "bag" }).success).toBe(false);
    expect(StockCreate.safeParse({ clientRef: "stock-ref-1", name: "Rice", unit: "kg", openingQty: -1 }).success).toBe(false);
    expect(StockAdjust.safeParse({ clientRef: "movement1", expectedVersion: 0, reason: "purchase", quantity: 1, note: "" }).success).toBe(false);
    expect(StockAdjust.safeParse({ clientRef: "movement1", expectedVersion: 0, reason: "adjustment", quantity: 0, note: "Count" }).success).toBe(true);
    expect(StockAdjust.safeParse({ clientRef: "movement1", expectedVersion: 0, reason: "wastage", quantity: 0, note: "Waste" }).success).toBe(false);
    expect(StockLinkUpdate.safeParse({ expectedVersion: 0, stockItemId: "rice", qtyPerSale: 0.125 }).success).toBe(true);
    expect(StockLinkUpdate.safeParse({ expectedVersion: 0, stockItemId: "rice", qtyPerSale: 0 }).success).toBe(false);
  });
});

function costingDb(): Database {
  const db = openDb(":memory:");
  migrate(db, MIGRATIONS);
  db.exec(`INSERT INTO users (id, name, pin_hash, role, created_at) VALUES ('u', 'Asha', 'h', 'admin', 0);
    INSERT INTO categories (id, name) VALUES ('c', 'Mains');
    INSERT INTO products (id, category_id, name, price_paise, gst_rate, created_at) VALUES ('p', 'c', 'Paneer tikka', 30000, 5, 0);
    INSERT INTO orders (id, client_ref, type, opened_by, opened_at) VALUES ('o', 'order-ref-1', 'parcel', 'u', 0);
    INSERT INTO order_items (id, order_id, product_id, name_snapshot, price_paise_snapshot, gst_rate_snapshot, qty)
      VALUES ('oi', 'o', 'p', 'Paneer tikka', 30000, 5, 1);
    INSERT INTO stock_items (id, name, unit, qty, unit_cost_milli_paise) VALUES ('s', 'Paneer', 'kg', 10, 30000000);
    INSERT INTO stock_items (id, name, unit, qty) VALUES ('n', 'Salt', 'kg', 5);
    INSERT INTO product_stock_links (id, product_id, stock_item_id, qty_per_sale) VALUES ('l', 'p', 's', 1.5);`);
  return db;
}
const item = (db: Database, id: string) => db.prepare("SELECT qty, unit_cost_milli_paise FROM stock_items WHERE id = ?").get(id) as
  { qty: number; unit_cost_milli_paise: number | null };
const move = (db: Database, id: string) => db.prepare("SELECT cost_paise, unit_cost_after FROM stock_moves WHERE id = ?").get(id) as
  { cost_paise: number | null; unit_cost_after: number | null };
const purchase = (db: Database, delta: number, costPaise: number) => db.transaction(() =>
  appendStockMove(db, { stockItemId: "s", delta, reason: "purchase", actorId: "u", costPaise }))();

describe("stock ledger costs", () => {
  it("records purchase cost and blends the average", () => {
    const db = costingDb();
    const id = purchase(db, 10, 340_000);
    expect(item(db, "s")).toEqual({ qty: 20, unit_cost_milli_paise: 32_000_000 });
    expect(move(db, id)).toEqual({ cost_paise: 340_000, unit_cost_after: 32_000_000 });
    db.close();
  });
  it("values sales at the current average and leaves it unchanged", () => {
    const db = costingDb();
    purchase(db, 10, 340_000);
    db.transaction(() => consumeStock(db, ["oi"], "u"))();
    const sale = db.prepare("SELECT id FROM stock_moves WHERE reason = 'sale'").get() as { id: string };
    expect(move(db, sale.id)).toEqual({ cost_paise: -48_000, unit_cost_after: 32_000_000 });
    expect(item(db, "s").unit_cost_milli_paise).toBe(32_000_000);
    db.close();
  });
  it("reverses a sale at its original cost even after the average changed", () => {
    const db = costingDb();
    purchase(db, 10, 340_000);
    db.transaction(() => consumeStock(db, ["oi"], "u"))();
    purchase(db, 10, 600_000);
    expect(item(db, "s").unit_cost_milli_paise).not.toBe(32_000_000);
    db.transaction(() => reverseStock(db, "oi", "u", "Cancelled"))();
    const reversal = db.prepare("SELECT id FROM stock_moves WHERE reason = 'cancel_reversal'").get() as { id: string };
    expect(move(db, reversal.id).cost_paise).toBe(48_000);
    db.close();
  });
  it("reverses an unknown-cost sale with a null cost", () => {
    const db = costingDb();
    db.prepare("UPDATE stock_items SET unit_cost_milli_paise = NULL").run();
    db.transaction(() => consumeStock(db, ["oi"], "u"))();
    db.transaction(() => reverseStock(db, "oi", "u", "Cancelled"))();
    expect(db.prepare("SELECT cost_paise FROM stock_moves WHERE reason = 'cancel_reversal'").get()).toEqual({ cost_paise: null });
    db.close();
  });
  it("records null cost when the average is unknown", () => {
    const db = costingDb();
    const id = db.transaction(() => appendStockMove(db, { stockItemId: "n", delta: -1, reason: "wastage", actorId: "u", note: "Spilt" }))();
    expect(move(db, id)).toEqual({ cost_paise: null, unit_cost_after: null });
    expect(item(db, "n").unit_cost_milli_paise).toBeNull();
    db.close();
  });
  it("prices an unknown-cost average from the delivery alone", () => {
    const db = costingDb();
    const id = db.transaction(() => appendStockMove(db, { stockItemId: "n", delta: 2, reason: "purchase", actorId: "u", costPaise: 5_000 }))();
    expect(item(db, "n").unit_cost_milli_paise).toBe(2_500_000);
    expect(move(db, id)).toEqual({ cost_paise: 5_000, unit_cost_after: 2_500_000 });
    db.close();
  });
  it("rejects costPaise on non-purchase movements", () => {
    const db = costingDb();
    expect(() => db.transaction(() => appendStockMove(db, { stockItemId: "s", delta: -1, reason: "wastage", actorId: "u", costPaise: 10 }))()).toThrow();
    expect(db.prepare("SELECT COUNT(*) AS n FROM stock_moves").get()).toEqual({ n: 0 });
    const parsed = StockAdjust.safeParse({ clientRef: "movement1", expectedVersion: 0, reason: "wastage", quantity: 1, note: "Spilt", costPaise: 10 });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.map((i) => i.message)).toContain("Amount paid applies only to received stock");
    expect(StockAdjust.safeParse({ clientRef: "movement1", expectedVersion: 0, reason: "purchase", quantity: 1, note: "Bill 7", costPaise: 10 }).success).toBe(true);
    expect(StockAdjust.safeParse({ clientRef: "movement1", expectedVersion: 0, reason: "purchase", quantity: 1, note: "Bill 7", costPaise: -1 }).success).toBe(false);
    db.close();
  });
  it("validates unit cost updates", () => {
    const ok = { clientRef: "cost-ref-1", expectedVersion: 0, unitCostMilliPaise: 32_000_000, note: " Supplier quote " };
    expect(UnitCostSet.parse(ok).note).toBe("Supplier quote");
    expect(UnitCostSet.safeParse({ ...ok, unitCostMilliPaise: 0 }).success).toBe(false);
    expect(UnitCostSet.safeParse({ ...ok, unitCostMilliPaise: 1.5 }).success).toBe(false);
    expect(UnitCostSet.safeParse({ ...ok, note: "  " }).success).toBe(false);
    expect(UnitCostSet.safeParse({ ...ok, extra: 1 }).success).toBe(false);
  });
});
