import { describe, expect, it } from "vitest";
import { openDb } from "../db.js";
import { migrate } from "../migrate.js";
import { MIGRATIONS } from "./index.js";

function fresh() {
  const db = openDb(":memory:");
  migrate(db, MIGRATIONS);
  db.prepare("INSERT INTO users (id, name, pin_hash, role, created_at) VALUES ('u', 'Admin', 'x', 'admin', 0)").run();
  db.prepare("INSERT INTO categories (id, name) VALUES ('pizza', 'Pizzas'), ('drinks', 'Drinks')").run();
  db.prepare("INSERT INTO products (id, category_id, name, price_paise, created_at) VALUES ('margherita', 'pizza', 'Margherita', 29900, 0)").run();
  db.prepare("INSERT INTO order_types (id, name, kind, created_at) VALUES ('ot-dine', 'Dine here', 'dine_in', 0), ('ot-away', 'Take away', 'takeaway', 0)").run();
  return db;
}
type Db = ReturnType<typeof fresh>;

const BASE = { name: "Deal", created_at: 0, updated_at: 0 };
const BUY_GET = { ...BASE, kind: "buy_get", buy_qty: 1, get_qty: 1, percent_bp: 10000 };
const ITEM_OFF = { ...BASE, kind: "item_off", percent_bp: 2000 };
const BILL_OFF = { ...BASE, kind: "bill_off", percent_bp: 1000 };

let seq = 0;
/** Inserts an offer from the columns given; a column left out takes its default. */
function addOffer(db: Db, fields: Record<string, unknown>): string {
  const row = { id: `o${++seq}`, ...fields };
  const columns = Object.keys(row);
  db.prepare(`INSERT INTO offers (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`).run(...Object.values(row));
  return row.id;
}

describe("migration 63: offers", () => {
  it("creates the offers tables", () => {
    const db = fresh();
    expect(db.pragma("user_version", { simple: true })).toBeGreaterThanOrEqual(63);
    db.close();
  });

  it("accepts a valid offer of each kind", () => {
    const db = fresh();
    expect(() => addOffer(db, BUY_GET)).not.toThrow();
    expect(() => addOffer(db, { ...BUY_GET, buy_qty: 20, get_qty: 20, percent_bp: 5000, same_item_only: 1 })).not.toThrow();
    expect(() => addOffer(db, ITEM_OFF)).not.toThrow();
    expect(() => addOffer(db, { ...ITEM_OFF, percent_bp: null, amount_paise: 500 })).not.toThrow();
    expect(() => addOffer(db, BILL_OFF)).not.toThrow();
    expect(() => addOffer(db, { ...BILL_OFF, min_bill_paise: 50000, max_discount_paise: 15000 })).not.toThrow();
    expect(() => addOffer(db, { ...BILL_OFF, percent_bp: null, amount_paise: 5000, min_bill_paise: 50000 })).not.toThrow();
    db.close();
  });

  it("fills in the defaults", () => {
    const db = fresh();
    const id = addOffer(db, ITEM_OFF);
    expect(db.prepare("SELECT active, same_item_only, min_bill_paise, days_mask, buy_qty, valid_from, time_from FROM offers WHERE id = ?").get(id))
      .toEqual({ active: 1, same_item_only: 0, min_bill_paise: 0, days_mask: 127, buy_qty: null, valid_from: null, time_from: null });
    db.close();
  });

  it("accepts the edges of each range", () => {
    const db = fresh();
    for (const edge of [
      { ...ITEM_OFF, percent_bp: 1 }, { ...ITEM_OFF, percent_bp: 10000 }, { ...ITEM_OFF, percent_bp: null, amount_paise: 1 },
      { ...BUY_GET, buy_qty: 1, get_qty: 20 },
      { ...ITEM_OFF, days_mask: 1 }, { ...ITEM_OFF, days_mask: 127 },
      { ...ITEM_OFF, time_from: 0, time_until: 1439 },
      { ...ITEM_OFF, time_from: 1320, time_until: 120 },
      { ...ITEM_OFF, valid_from: "2026-11-13", valid_until: "2026-11-13" },
      { ...ITEM_OFF, valid_from: "2026-11-13" }, { ...ITEM_OFF, valid_until: "2026-11-13" },
      { ...ITEM_OFF, valid_from: "2024-02-29", valid_until: "2024-02-29" },
      { ...ITEM_OFF, name: "x".repeat(40) }, { ...ITEM_OFF, active: 0 },
    ]) expect(() => addOffer(db, edge), JSON.stringify(edge)).not.toThrow();
    db.close();
  });

  const rejected: Array<[string, Record<string, unknown>]> = [
    ["a kind outside buy_get, item_off and bill_off", { ...ITEM_OFF, kind: "half_off" }],
    ["an empty name", { ...ITEM_OFF, name: "" }],
    ["a blank name", { ...ITEM_OFF, name: "   " }],
    ["a name over 40 characters", { ...ITEM_OFF, name: "x".repeat(41) }],
    ["active other than 0 or 1", { ...ITEM_OFF, active: 2 }],
    ["buy_get without buy_qty", { ...BUY_GET, buy_qty: null }],
    ["buy_get without get_qty", { ...BUY_GET, get_qty: null }],
    ["buy_qty of 0", { ...BUY_GET, buy_qty: 0 }],
    ["buy_qty over 20", { ...BUY_GET, buy_qty: 21 }],
    ["get_qty of 0", { ...BUY_GET, get_qty: 0 }],
    ["get_qty over 20", { ...BUY_GET, get_qty: 21 }],
    ["buy_get without percent_bp", { ...BUY_GET, percent_bp: null }],
    ["buy_get with amount_paise", { ...BUY_GET, amount_paise: 100 }],
    ["item_off with buy_qty", { ...ITEM_OFF, buy_qty: 1 }],
    ["item_off with get_qty", { ...ITEM_OFF, get_qty: 1 }],
    ["bill_off with buy_qty", { ...BILL_OFF, buy_qty: 1 }],
    ["bill_off with get_qty", { ...BILL_OFF, get_qty: 1 }],
    ["percent_bp of 0", { ...ITEM_OFF, percent_bp: 0 }],
    ["percent_bp over 10000", { ...ITEM_OFF, percent_bp: 10001 }],
    ["amount_paise of 0", { ...ITEM_OFF, percent_bp: null, amount_paise: 0 }],
    ["a negative amount_paise", { ...BILL_OFF, percent_bp: null, amount_paise: -5 }],
    ["item_off with neither percent nor amount", { ...ITEM_OFF, percent_bp: null }],
    ["item_off with both percent and amount", { ...ITEM_OFF, amount_paise: 100 }],
    ["bill_off with neither percent nor amount", { ...BILL_OFF, percent_bp: null }],
    ["bill_off with both percent and amount", { ...BILL_OFF, amount_paise: 100 }],
    ["same_item_only other than 0 or 1", { ...BUY_GET, same_item_only: 2 }],
    ["same_item_only on item_off", { ...ITEM_OFF, same_item_only: 1 }],
    ["same_item_only on bill_off", { ...BILL_OFF, same_item_only: 1 }],
    ["a negative min_bill_paise", { ...BILL_OFF, min_bill_paise: -1 }],
    ["min_bill_paise on item_off", { ...ITEM_OFF, min_bill_paise: 100 }],
    ["min_bill_paise on buy_get", { ...BUY_GET, min_bill_paise: 100 }],
    ["max_discount_paise of 0", { ...BILL_OFF, max_discount_paise: 0 }],
    ["max_discount_paise on item_off", { ...ITEM_OFF, max_discount_paise: 100 }],
    ["max_discount_paise on buy_get", { ...BUY_GET, max_discount_paise: 100 }],
    ["max_discount_paise on a bill_off with an amount", { ...BILL_OFF, percent_bp: null, amount_paise: 500, max_discount_paise: 100 }],
    ["days_mask of 0", { ...ITEM_OFF, days_mask: 0 }],
    ["days_mask over 127", { ...ITEM_OFF, days_mask: 128 }],
    ["time_from over 1439", { ...ITEM_OFF, time_from: 1440, time_until: 60 }],
    ["a negative time_from", { ...ITEM_OFF, time_from: -1, time_until: 60 }],
    ["time_until over 1439", { ...ITEM_OFF, time_from: 60, time_until: 1440 }],
    ["a negative time_until", { ...ITEM_OFF, time_from: 60, time_until: -1 }],
    ["time_from without time_until", { ...ITEM_OFF, time_from: 600 }],
    ["time_until without time_from", { ...ITEM_OFF, time_until: 600 }],
    ["time_from equal to time_until", { ...ITEM_OFF, time_from: 600, time_until: 600 }],
    ["valid_from after valid_until", { ...ITEM_OFF, valid_from: "2026-11-14", valid_until: "2026-11-13" }],
    ["a valid_from that is not YYYY-MM-DD", { ...ITEM_OFF, valid_from: "13/11/2026" }],
    // SQLite rolls 2026-02-30 over to March but returns NULL for a month 13, a day 32 or a zero month or day; none may get through.
    ...["valid_from", "valid_until"].flatMap((column): Array<[string, Record<string, unknown>]> =>
      ["2026-02-30", "2026-02-29", "2026-13-01", "2026-00-10", "2026-01-32", "2026-01-00"].map((date) => [`${column} ${date}, which is not a calendar date`, { ...ITEM_OFF, [column]: date }])),
  ];
  it.each(rejected)("rejects %s", (_rule, row) => {
    const db = fresh();
    expect(() => addOffer(db, row)).toThrow(/CHECK/);
    db.close();
  });

  it("keeps one target per category or product, and exactly one of the two", () => {
    const db = fresh();
    const offer = addOffer(db, ITEM_OFF), other = addOffer(db, ITEM_OFF);
    const target = db.prepare("INSERT INTO offer_targets (offer_id, category_id, product_id) VALUES (?, ?, ?)");
    expect(() => target.run(offer, "pizza", null)).not.toThrow();
    expect(() => target.run(offer, "drinks", null)).not.toThrow();
    expect(() => target.run(offer, null, "margherita")).not.toThrow();
    expect(() => target.run(other, "pizza", null)).not.toThrow();
    expect(() => target.run(offer, "pizza", null)).toThrow(/UNIQUE/);
    expect(() => target.run(offer, null, "margherita")).toThrow(/UNIQUE/);
    expect(() => target.run(offer, "pizza", "margherita")).toThrow(/CHECK/);
    expect(() => target.run(offer, null, null)).toThrow(/CHECK/);
    expect(() => target.run(offer, "nowhere", null)).toThrow(/FOREIGN KEY/);
    expect(() => target.run("no-offer", "pizza", null)).toThrow(/FOREIGN KEY/);
    db.close();
  });

  it("keeps one row per offer and order type", () => {
    const db = fresh();
    const offer = addOffer(db, ITEM_OFF);
    const orderType = db.prepare("INSERT INTO offer_order_types (offer_id, order_type_id) VALUES (?, ?)");
    expect(() => orderType.run(offer, "ot-dine")).not.toThrow();
    expect(() => orderType.run(offer, "ot-away")).not.toThrow();
    expect(() => orderType.run(offer, "ot-dine")).toThrow(/UNIQUE|PRIMARY/);
    expect(() => orderType.run(offer, "no-type")).toThrow(/FOREIGN KEY/);
    db.close();
  });

  it("deletes an offer's targets and order types with it", () => {
    const db = fresh();
    const gone = addOffer(db, ITEM_OFF), kept = addOffer(db, ITEM_OFF);
    for (const offer of [gone, kept]) {
      db.prepare("INSERT INTO offer_targets (offer_id, category_id) VALUES (?, 'pizza')").run(offer);
      db.prepare("INSERT INTO offer_order_types (offer_id, order_type_id) VALUES (?, 'ot-dine')").run(offer);
    }
    db.prepare("DELETE FROM offers WHERE id = ?").run(gone);
    expect(db.prepare("SELECT offer_id FROM offer_targets").all()).toEqual([{ offer_id: kept }]);
    expect(db.prepare("SELECT offer_id FROM offer_order_types").all()).toEqual([{ offer_id: kept }]);
    db.close();
  });

  describe("on a bill", () => {
    function seedBill(db: Db) {
      db.prepare("INSERT INTO orders (id, client_ref, type, status, opened_by, opened_at) VALUES ('o', 'o', 'dine_in', 'open', 'u', 0)").run();
      db.prepare("INSERT INTO order_items (id, order_id, product_id, name_snapshot, price_paise_snapshot, gst_rate_snapshot, qty, status) VALUES ('line', 'o', 'margherita', 'Margherita', 29900, 5, 2, 'sent')").run();
      db.prepare("INSERT INTO bills (id, bill_no, order_id, subtotal_paise, cgst_paise, sgst_paise, total_paise, created_at, created_by) VALUES ('b', 1, 'o', 59800, 0, 0, 59800, 0, 'u')").run();
    }

    it("defaults bills.offer_discount_paise to 0 and refuses a negative one", () => {
      const db = fresh();
      seedBill(db);
      expect(db.prepare("SELECT offer_discount_paise FROM bills WHERE id = 'b'").get()).toEqual({ offer_discount_paise: 0 });
      const col = (db.pragma("table_info(bills)") as Array<{ name: string; notnull: number }>).find((c) => c.name === "offer_discount_paise");
      expect(col).toMatchObject({ notnull: 1 });
      expect(() => db.prepare("UPDATE bills SET offer_discount_paise = 29900 WHERE id = 'b'").run()).not.toThrow();
      expect(() => db.prepare("UPDATE bills SET offer_discount_paise = -1 WHERE id = 'b'").run()).toThrow(/CHECK/);
      db.close();
    });

    it("records each applied offer once, with a positive amount", () => {
      const db = fresh();
      seedBill(db);
      const offer = addOffer(db, BUY_GET);
      const applied = db.prepare("INSERT INTO bill_offers (bill_id, offer_id, name, discount_paise) VALUES (?, ?, ?, ?)");
      expect(() => applied.run("b", offer, "BOGO Pizza", 29900)).not.toThrow();
      expect(() => applied.run("b", offer, "BOGO Pizza", 100)).toThrow(/UNIQUE|PRIMARY/);
      const second = addOffer(db, ITEM_OFF);
      expect(() => applied.run("b", second, "Cool Drinks", 0)).toThrow(/CHECK/);
      expect(() => applied.run("b", second, "Cool Drinks", -1)).toThrow(/CHECK/);
      expect(() => applied.run("b", second, null, 100)).toThrow(/NOT NULL/);
      expect(() => applied.run("no-bill", second, "Cool Drinks", 100)).toThrow(/FOREIGN KEY/);
      expect(() => applied.run("b", "no-offer", "Cool Drinks", 100)).toThrow(/FOREIGN KEY/);
      db.close();
    });

    it("records where each offer's money went, with a positive amount", () => {
      const db = fresh();
      seedBill(db);
      const offer = addOffer(db, BUY_GET), second = addOffer(db, ITEM_OFF), third = addOffer(db, BILL_OFF);
      const part = db.prepare("INSERT INTO bill_offer_lines (bill_id, order_item_id, offer_id, discount_paise) VALUES (?, ?, ?, ?)");
      expect(() => part.run("b", "line", offer, 29900)).not.toThrow();
      expect(() => part.run("b", "line", second, 500)).not.toThrow();
      expect(() => part.run("b", "line", offer, 100)).toThrow(/UNIQUE|PRIMARY/);
      expect(() => part.run("b", "line", third, 0)).toThrow(/CHECK/);
      expect(() => part.run("b", "line", third, -1)).toThrow(/CHECK/);
      expect(() => part.run("no-bill", "line", offer, 100)).toThrow(/FOREIGN KEY/);
      expect(() => part.run("b", "no-line", offer, 100)).toThrow(/FOREIGN KEY/);
      expect(() => part.run("b", "line", "no-offer", 100)).toThrow(/FOREIGN KEY/);
      db.close();
    });

    it("never changes or removes what a bill recorded about its offers", () => {
      const db = fresh();
      seedBill(db);
      const offer = addOffer(db, BUY_GET);
      db.prepare("INSERT INTO bill_offers (bill_id, offer_id, name, discount_paise) VALUES ('b', ?, 'BOGO Pizza', 29900)").run(offer);
      db.prepare("INSERT INTO bill_offer_lines (bill_id, order_item_id, offer_id, discount_paise) VALUES ('b', 'line', ?, 29900)").run(offer);
      expect(() => db.prepare("UPDATE bill_offers SET discount_paise = 1").run()).toThrow(/bill offers are immutable/);
      expect(() => db.prepare("DELETE FROM bill_offers").run()).toThrow(/bill offers are immutable/);
      expect(() => db.prepare("UPDATE bill_offer_lines SET discount_paise = 1").run()).toThrow(/bill offer lines are immutable/);
      expect(() => db.prepare("DELETE FROM bill_offer_lines").run()).toThrow(/bill offer lines are immutable/);
      expect(db.prepare("SELECT discount_paise FROM bill_offers").all()).toEqual([{ discount_paise: 29900 }]);
      expect(db.prepare("SELECT discount_paise FROM bill_offer_lines").all()).toEqual([{ discount_paise: 29900 }]);
      db.close();
    });
  });
});
