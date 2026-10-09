import { describe, expect, it } from "vitest";
import { openDb, type Database } from "../db.js";
import { migrate } from "../migrate.js";
import { MIGRATIONS } from "./index.js";
import { migration027 } from "./027-zomato-desk.js";

const COUNTED = [
  "orders", "order_items", "kots", "kot_requests", "bills", "payments", "credit_notes", "refund_payments",
  "reservations", "guest_requests", "table_links", "order_table_events",
];

/** A v26 database holding one of every row that points at `orders` or `payments`. */
function seededV26(): Database {
  const db = openDb(":memory:");
  migrate(db, MIGRATIONS.filter((m) => m.version <= 26));
  db.exec(`
    INSERT INTO users (id, name, pin_hash, role, created_at) VALUES ('u', 'Asha', 'h', 'admin', 0);
    INSERT INTO dining_tables (id, name) VALUES ('t1', 'T1');
    INSERT INTO dining_tables (id, name) VALUES ('t2', 'T2');
    INSERT INTO kot_stations (id, name) VALUES ('s1', 'Kitchen');
    INSERT INTO categories (id, name) VALUES ('cat', 'Mains');
    INSERT INTO products (id, category_id, name, price_paise, gst_rate, kot_station_id, created_at) VALUES ('p', 'cat', 'Dosa', 10000, 5, 's1', 0);
    INSERT INTO variants (id, product_id, name, price_paise) VALUES ('v', 'p', 'Large', 12000);

    -- dine-in order with an item, a KOT, a bill, a payment and a credit note
    INSERT INTO orders (id, client_ref, type, table_id, status, opened_by, opened_at, closed_at, captain_id, captain_name)
      VALUES ('o1', 'ref-o1', 'dine_in', 't1', 'settled', 'u', 1, 9, 'u', 'Asha');
    INSERT INTO kots (id, order_id, kot_no, station_id, created_at, created_by, done_at) VALUES ('k1', 'o1', 1, 's1', 2, 'u', 3);
    INSERT INTO kot_requests (client_ref, order_id, user_id, fingerprint, kot_ids) VALUES ('kr1', 'o1', 'u', 'fp', '["k1"]');
    INSERT INTO order_items (id, order_id, product_id, variant_id, name_snapshot, price_paise_snapshot, gst_rate_snapshot, qty, status, kot_id)
      VALUES ('i1', 'o1', 'p', 'v', 'Dosa (Large)', 12000, 5, 1, 'sent', 'k1');
    INSERT INTO bills (id, bill_no, order_id, subtotal_paise, cgst_paise, sgst_paise, rounding_paise, total_paise, status, created_by, created_at)
      VALUES ('b1', 1, 'o1', 12000, 300, 300, 0, 12600, 'paid', 'u', 4);
    INSERT INTO payments (id, bill_id, mode, amount_paise, ref_note, created_at) VALUES ('pay1', 'b1', 'upi', 12600, 'utr-1', 5);
    INSERT INTO credit_notes (id, cn_no, bill_id, kind, reason, taxable_paise, cgst_paise, sgst_paise, rounding_paise, total_paise,
        requested_by, approved_by, created_at, client_ref, request_json)
      VALUES ('c1', 1, 'b1', 'refund', 'Wrong dish', 12000, 300, 300, 0, 12600, 'u', 'u', 6, 'cn-ref-1', '{}');
    INSERT INTO refund_payments (id, credit_note_id, mode, amount_paise, created_at) VALUES ('r1', 'c1', 'cash', 12600, 6);

    -- a parcel (016 backfilled parcels to the takeaway tier)
    INSERT INTO orders (id, client_ref, type, status, opened_by, opened_at, price_tier, split_label)
      VALUES ('o2', 'ref-o2', 'parcel', 'open', 'u', 2, 'takeaway', 'A');

    -- an order merged into o1
    INSERT INTO orders (id, client_ref, type, table_id, status, opened_by, opened_at, closed_at, cancelled_by, cancel_reason, merged_into)
      VALUES ('o3', 'ref-o3', 'dine_in', 't2', 'cancelled', 'u', 3, 7, 'u', 'merged', 'o1');

    -- a reservation seated into o1, a guest request accepted into o1, a table transfer of o1
    INSERT INTO reservations (id, client_ref, request_json, table_id, customer_name, party_size, starts_at, ends_at, status, order_id,
        created_at, created_by, updated_at, updated_by)
      VALUES ('res1', 'res-ref-1', '{}', 't1', 'Ravi', 2, 0, 100, 'seated', 'o1', 0, 'u', 1, 'u');
    INSERT INTO guest_requests (id, client_ref, table_id, table_name, receipt_hash, fingerprint, items_json, subtotal_paise, tax_inclusive,
        status, created_at, expires_at, order_id)
      VALUES ('g1', 'guest-ref-1', 't1', 'T1', 'rh', 'fp', '[]', 12000, 0, 'accepted', 1, 100, 'o1');
    INSERT INTO table_links (id, table_id, order_id, linked_at, linked_by) VALUES ('l1', 't2', 'o1', 7, 'u');
    INSERT INTO order_table_events (id, kind, order_id, target_order_id, from_table_id, to_table_id, created_at, created_by, client_ref, request_json)
      VALUES ('e1', 'merge', 'o3', 'o1', 't2', 't1', 7, 'u', 'move-ref-1', '{}');
  `);
  return db;
}

const counts = (db: Database) =>
  Object.fromEntries(COUNTED.map((t) => [t, (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n]));

const indexNames = (db: Database) =>
  (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name IN ('orders', 'payments') ORDER BY name").all() as Array<{ name: string }>)
    .map((r) => r.name);

describe("migration 027 zomato desk", () => {
  it("rebuilds orders and payments without losing a row, an index or a foreign key", () => {
    const db = seededV26();
    try {
      const before = counts(db);
      const indexesBefore = indexNames(db);
      const ordersBefore = db.prepare("SELECT * FROM orders ORDER BY id").all();
      const paymentsBefore = db.prepare("SELECT * FROM payments ORDER BY id").all();
      expect(Object.values(before).every((n) => n > 0)).toBe(true);

      migrate(db, MIGRATIONS.filter((m) => m.version <= 27));

      expect(db.pragma("user_version", { simple: true })).toBe(27);
      expect(counts(db)).toEqual(before);
      expect(db.pragma("foreign_key_check")).toEqual([]);
      expect(indexNames(db)).toEqual(expect.arrayContaining(indexesBefore));
      expect(indexNames(db)).toContain("orders_zomato_order_id");

      // Old columns keep their values and order; the two new columns come last, empty.
      expect(db.prepare("SELECT * FROM orders ORDER BY id").all()).toEqual(
        (ordersBefore as Array<Record<string, unknown>>).map((r) => ({ ...r, zomato_order_id: null, zomato_status: null })),
      );
      expect(db.prepare("SELECT * FROM payments ORDER BY id").all()).toEqual(paymentsBefore);

      // Every reference to orders still names `orders`, never the temporary table.
      const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((r) => r.name);
      const targets = tables.flatMap((t) =>
        (db.prepare(`PRAGMA foreign_key_list(${t})`).all() as Array<{ table: string }>).map((fk) => fk.table));
      expect(targets.filter((t) => t.endsWith("_new"))).toEqual([]);
      expect(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE sql LIKE '%orders_new%' OR sql LIKE '%payments_new%'").get()).toEqual({ n: 0 });
      expect(db.pragma("foreign_key_list(orders)")).toEqual(expect.arrayContaining([expect.objectContaining({ table: "orders", from: "merged_into" })]));
    } finally {
      db.close();
    }
  });

  it("copies several thousand orders with their items, bills and payments in one pass", () => {
    const db = seededV26();
    try {
      const N = 3000;
      const order = db.prepare(`INSERT INTO orders (id, client_ref, type, table_id, status, opened_by, opened_at, closed_at, price_tier)
        VALUES (?, ?, ?, ?, 'settled', 'u', ?, ?, ?)`);
      const item = db.prepare(`INSERT INTO order_items (id, order_id, product_id, variant_id, name_snapshot, price_paise_snapshot, gst_rate_snapshot, qty, status)
        VALUES (?, ?, 'p', NULL, 'Dosa', 10000, 5, ?, 'sent')`);
      const bill = db.prepare(`INSERT INTO bills (id, bill_no, order_id, subtotal_paise, cgst_paise, sgst_paise, rounding_paise, total_paise, status, created_by, created_at)
        VALUES (?, ?, ?, 10000, 250, 250, 0, 10500, 'paid', 'u', ?)`);
      const payment = db.prepare("INSERT INTO payments (id, bill_id, mode, amount_paise, ref_note, created_at) VALUES (?, ?, ?, ?, NULL, ?)");
      db.transaction(() => {
        for (let n = 0; n < N; n++) {
          const parcel = n % 2 === 0;
          order.run(`bulk-${n}`, `bulk-ref-${n}`, parcel ? "parcel" : "dine_in", parcel ? null : "t2", 100 + n, 200 + n, parcel ? "takeaway" : "ac");
          item.run(`bulk-i-${n}`, `bulk-${n}`, 1 + (n % 3));
          bill.run(`bulk-b-${n}`, 100 + n, `bulk-${n}`, 200 + n);
          // Every third bill is split across two payment modes.
          if (n % 3 === 0) { payment.run(`bulk-p-${n}a`, `bulk-b-${n}`, "cash", 5000, 200 + n); payment.run(`bulk-p-${n}b`, `bulk-b-${n}`, "card", 5500, 200 + n); }
          else payment.run(`bulk-p-${n}`, `bulk-b-${n}`, n % 3 === 1 ? "upi" : "cash", 10500, 200 + n);
        }
      })();
      const before = counts(db);
      const ordersBefore = db.prepare("SELECT * FROM orders ORDER BY id").all() as Array<Record<string, unknown>>;
      const paymentsBefore = db.prepare("SELECT * FROM payments ORDER BY id").all();
      expect(before.orders).toBe(3 + N);
      expect(before.payments).toBe(1 + N + N / 3);

      migrate(db, MIGRATIONS.filter((m) => m.version <= 27));

      expect(db.pragma("user_version", { simple: true })).toBe(27);
      expect(counts(db)).toEqual(before);
      expect(db.prepare("SELECT * FROM orders ORDER BY id").all()).toEqual(ordersBefore.map((r) => ({ ...r, zomato_order_id: null, zomato_status: null })));
      expect(db.prepare("SELECT * FROM payments ORDER BY id").all()).toEqual(paymentsBefore);
      expect(db.prepare("SELECT COUNT(*) AS n FROM orders o JOIN bills b ON b.order_id = o.id JOIN payments p ON p.bill_id = b.id WHERE o.id LIKE 'bulk-%'").get())
        .toEqual({ n: N + N / 3 });
      expect(db.pragma("foreign_key_check")).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("starts over a broken link that predates it in an unrelated table, and leaves that row as it was", () => {
    const db = seededV26();
    try {
      // An old orphan the restaurant has lived with: a variant whose product was removed while foreign keys were off.
      db.pragma("foreign_keys = OFF");
      db.prepare("INSERT INTO variants (id, product_id, name, price_paise) VALUES ('ghost', 'gone', 'Half', 5000)").run();
      db.pragma("foreign_keys = ON");
      const orphans = db.pragma("foreign_key_check");
      expect(orphans).toEqual([expect.objectContaining({ table: "variants", parent: "products" })]);

      migrate(db, MIGRATIONS.filter((m) => m.version <= 27));

      expect(db.pragma("user_version", { simple: true })).toBe(27);
      expect(db.pragma("foreign_key_check")).toEqual(orphans);
    } finally {
      db.close();
    }
  });

  it("still fails, changing nothing, when the rebuild itself breaks a link", () => {
    const db = seededV26();
    try {
      // Simulate a faulty copy: o1 (referenced by its items, KOT, bill, reservation...) disappears during the rebuild.
      const faulty = new Proxy(db, {
        get(target, key) {
          if (key === "exec") {
            return (sql: string) => {
              const result = target.exec(sql);
              if (sql.includes("RENAME TO payments")) target.exec("DELETE FROM orders WHERE id = 'o1'");
              return result;
            };
          }
          const value = Reflect.get(target, key) as unknown;
          return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
        },
      });
      const before = counts(db);
      expect(() => migrate(db, [{ ...migration027, up: () => migration027.up(faulty) }])).toThrow(/foreign_key_check/);
      expect(db.pragma("user_version", { simple: true })).toBe(26);
      expect(counts(db)).toEqual(before);
      expect(db.pragma("foreign_key_check")).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("accepts zomato orders with a unique zomato order id only on zomato orders", () => {
    const db = seededV26();
    try {
      migrate(db, MIGRATIONS);
      const insertOrder = (id: string, type: string, zomatoOrderId: string | null, tier = "zomato") =>
        db.prepare(`INSERT INTO orders (id, client_ref, type, opened_by, opened_at, price_tier, zomato_order_id)
          VALUES (?, ?, ?, 'u', 10, ?, ?)`).run(id, `ref-${id}`, type, tier, zomatoOrderId);

      insertOrder("z1", "zomato", "ZOM-1001");
      expect(db.prepare("SELECT type, price_tier, zomato_order_id, zomato_status FROM orders WHERE id = 'z1'").get())
        .toEqual({ type: "zomato", price_tier: "zomato", zomato_order_id: "ZOM-1001", zomato_status: null });
      expect(() => insertOrder("z2", "zomato", "ZOM-1001")).toThrow(/UNIQUE/);
      expect(() => insertOrder("z3", "parcel", "ZOM-2002", "takeaway")).toThrow(/CHECK/);
      expect(() => insertOrder("z4", "zomato", null)).toThrow(/CHECK/);
      expect(() => insertOrder("z5", "delivery", null, "takeaway")).toThrow(/CHECK/);
      expect(() => insertOrder("z6", "parcel", null, "swiggy")).toThrow(/CHECK/);

      for (const status of ["preparing", "ready", "picked_up"]) {
        db.prepare("UPDATE orders SET zomato_status = ? WHERE id = 'z1'").run(status);
      }
      expect(() => db.prepare("UPDATE orders SET zomato_status = 'delivered' WHERE id = 'z1'").run()).toThrow(/CHECK/);
    } finally {
      db.close();
    }
  });

  it("accepts zomato payments and refuses unknown modes", () => {
    const db = seededV26();
    try {
      migrate(db, MIGRATIONS);
      db.exec(`INSERT INTO orders (id, client_ref, type, opened_by, opened_at, price_tier, zomato_order_id)
          VALUES ('z1', 'ref-z1', 'zomato', 'u', 10, 'zomato', 'ZOM-1001');
        INSERT INTO bills (id, bill_no, order_id, subtotal_paise, cgst_paise, sgst_paise, rounding_paise, total_paise, status, created_by, created_at)
          VALUES ('bz', 2, 'z1', 10000, 0, 0, 0, 10000, 'paid', 'u', 11);`);
      const insertPayment = (id: string, mode: string) =>
        db.prepare("INSERT INTO payments (id, bill_id, mode, amount_paise, created_at) VALUES (?, 'bz', ?, 10000, 11)").run(id, mode);
      insertPayment("pz", "zomato");
      expect(db.prepare("SELECT mode FROM payments WHERE id = 'pz'").get()).toEqual({ mode: "zomato" });
      expect(() => insertPayment("pw", "wallet")).toThrow(/CHECK/);
    } finally {
      db.close();
    }
  });

  it("adds a nullable non-negative zomato price to products and variants", () => {
    const db = seededV26();
    try {
      migrate(db, MIGRATIONS);
      for (const table of ["products", "variants"]) {
        const id = table === "products" ? "p" : "v";
        expect(db.prepare(`SELECT zomato_price_paise FROM ${table} WHERE id = ?`).get(id)).toEqual({ zomato_price_paise: null });
        db.prepare(`UPDATE ${table} SET zomato_price_paise = 0 WHERE id = ?`).run(id);
        db.prepare(`UPDATE ${table} SET zomato_price_paise = 15000 WHERE id = ?`).run(id);
        expect(() => db.prepare(`UPDATE ${table} SET zomato_price_paise = -1 WHERE id = ?`).run(id)).toThrow(/CHECK/);
      }
    } finally {
      db.close();
    }
  });
});
