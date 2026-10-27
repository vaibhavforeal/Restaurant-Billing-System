import { expect, it } from "vitest";
import { openDb } from "../db.js";
import { migrate } from "../migrate.js";
import { MIGRATIONS } from "./index.js";

it("keeps existing points history, allows expiry rows and adds profiles, tiers, segments and feedback", () => {
  const db = openDb(":memory:");
  try {
    migrate(db, MIGRATIONS.filter((m) => m.version < 39));
    db.exec(`INSERT INTO users (id, name, pin_hash, role, created_at) VALUES ('u', 'Asha', 'hash', 'admin', 0);
      INSERT INTO customers (id, name, phone, created_at, created_by) VALUES ('c', 'Priya', '9876543210', 0, 'u');
      INSERT INTO loyalty_ledger (id, customer_id, kind, points, note, created_at, created_by, client_ref) VALUES ('l1', 'c', 'adjust', 40, 'Opening', 5, 'u', 'ref-1');
      INSERT INTO orders (id, client_ref, type, opened_by, opened_at) VALUES ('o', 'ref-o', 'parcel', 'u', 0);
      INSERT INTO bills (id, bill_no, order_id, subtotal_paise, discount_paise, cgst_paise, sgst_paise, rounding_paise, total_paise, created_at, created_by)
        VALUES ('b', 1, 'o', 10000, 0, 0, 0, 0, 10000, 0, 'u');`);
    migrate(db, MIGRATIONS); migrate(db, MIGRATIONS);

    expect(db.prepare("SELECT id, kind, points, note, client_ref, expires_at FROM loyalty_ledger").all())
      .toEqual([{ id: "l1", kind: "adjust", points: 40, note: "Opening", client_ref: "ref-1", expires_at: null }]);
    db.exec("INSERT INTO loyalty_ledger (id, customer_id, kind, points, created_at, created_by) VALUES ('l2', 'c', 'expire', -10, 9, 'u')");
    expect(() => db.exec("UPDATE loyalty_ledger SET points = 50")).toThrow(/append-only/);
    expect(() => db.exec("DELETE FROM loyalty_ledger")).toThrow(/append-only/);
    expect(() => db.exec("INSERT INTO loyalty_ledger (id, customer_id, kind, points, created_at, created_by, expires_at) VALUES ('l3', 'c', 'redeem', -5, 9, 'u', 99)")).toThrow();

    expect(db.prepare("SELECT marketing_opt_in, is_active, birth_date FROM customers").get()).toEqual({ marketing_opt_in: 0, is_active: 1, birth_date: null });
    db.exec("UPDATE customers SET birth_date = '--03-14', anniversary_date = '2019-11-02'");
    expect(() => db.exec("UPDATE customers SET birth_date = '14/03'")).toThrow();
    db.exec("INSERT INTO customer_tags (customer_id, tag) VALUES ('c', 'Vegan')");
    expect(() => db.exec("INSERT INTO customer_tags (customer_id, tag) VALUES ('c', 'vegan')")).toThrow();

    expect(db.prepare("SELECT expiry_months, tiers_enabled, tier_window_months, max_redeem_percent, feedback_enabled FROM loyalty_settings").get())
      .toEqual({ expiry_months: 0, tiers_enabled: 0, tier_window_months: 12, max_redeem_percent: 100, feedback_enabled: 0 });
    expect(() => db.exec("INSERT INTO loyalty_tiers (id, name, min_spend_paise, earn_multiplier, created_at) VALUES ('t', 'Gold', 0, 0.5, 0)")).toThrow();
    expect(() => db.exec("INSERT INTO customer_segments (id, name, filter_json, created_at, updated_at, created_by) VALUES ('s', 'Lapsed', '{bad', 0, 0, 'u')")).toThrow();

    db.exec("UPDATE bills SET feedback_token = 'tok'");
    db.exec("INSERT INTO customer_feedback (id, bill_id, overall, source, created_at) VALUES ('f', 'b', 5, 'qr', 0)");
    expect(() => db.exec("INSERT INTO customer_feedback (id, bill_id, overall, source, created_at) VALUES ('g', 'b', 4, 'qr', 0)")).toThrow();
    expect(db.pragma("foreign_key_check")).toEqual([]);
  } finally { db.close(); }
});
