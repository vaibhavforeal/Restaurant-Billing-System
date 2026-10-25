import { expect, it } from "vitest";
import { openDb } from "../db.js";
import { migrate } from "../migrate.js";
import { MIGRATIONS } from "./index.js";

it("adds customers, slabs and an append-only points ledger without touching existing bills", () => {
  const db = openDb(":memory:");
  try {
    migrate(db, MIGRATIONS.filter((m) => m.version < 36));
    db.exec(`INSERT INTO users (id, name, pin_hash, role, created_at) VALUES ('u', 'Asha', 'hash', 'admin', 0);
      INSERT INTO orders (id, client_ref, type, opened_by, opened_at) VALUES ('o', 'ref-o', 'parcel', 'u', 0);
      INSERT INTO bills (id, bill_no, order_id, subtotal_paise, discount_paise, cgst_paise, sgst_paise, rounding_paise, total_paise, created_at, created_by)
        VALUES ('b', 1, 'o', 10000, 0, 0, 0, 0, 10000, 0, 'u');`);
    migrate(db, MIGRATIONS); migrate(db, MIGRATIONS);
    expect(db.prepare("SELECT customer_id, customer_discount_paise, points_redeemed, points_value_paise FROM bills").get())
      .toEqual({ customer_id: null, customer_discount_paise: 0, points_redeemed: 0, points_value_paise: 0 });
    expect(db.prepare("SELECT enabled, points_per_100, point_value_paise FROM loyalty_settings").get()).toEqual({ enabled: 0, points_per_100: 1, point_value_paise: 100 });
    db.exec("INSERT INTO customers (id, name, phone, created_at, created_by) VALUES ('c', 'Priya', '9876543210', 0, 'u')");
    expect(() => db.exec("INSERT INTO customers (id, name, phone, created_at, created_by) VALUES ('d', 'Bad', '12345', 0, 'u')")).toThrow();
    expect(() => db.exec("INSERT INTO customers (id, name, phone, created_at, created_by) VALUES ('e', 'Dup', '9876543210', 0, 'u')")).toThrow();
    db.exec("INSERT INTO loyalty_ledger (id, customer_id, kind, points, created_at, created_by) VALUES ('l', 'c', 'earn', 5, 0, 'u')");
    expect(() => db.exec("UPDATE loyalty_ledger SET points = 50")).toThrow(/append-only/);
    db.exec("INSERT INTO customer_types (id, name, created_at) VALUES ('t', 'Regular', 0)");
    expect(() => db.exec("INSERT INTO customer_type_slabs (id, type_id, min_bill_paise, percent, valid_from, valid_to) VALUES ('s', 't', 0, 5, '2026-12-01', '2026-01-01')")).toThrow();
  } finally { db.close(); }
});
