import { expect, it } from "vitest";
import { openDb } from "../db.js";
import { migrate } from "../migrate.js";
import { MIGRATIONS } from "./index.js";

it("allows one open shift per cashier and freezes closed shifts, movements and day closes", () => {
  const db = openDb(":memory:");
  try {
    migrate(db, MIGRATIONS); migrate(db, MIGRATIONS);
    db.exec(`INSERT INTO users (id, name, pin_hash, role, created_at) VALUES ('u', 'Meena', 'hash', 'cashier', 0);
      INSERT INTO shifts (id, cashier_id, opened_at, opening_float_paise, open_client_ref) VALUES ('s1', 'u', 0, 50000, 'ref-1');`);
    expect(() => db.exec("INSERT INTO shifts (id, cashier_id, opened_at, opening_float_paise, open_client_ref) VALUES ('s2', 'u', 1, 0, 'ref-2')")).toThrow();
    expect(() => db.exec("UPDATE shifts SET closed_at = 5 WHERE id = 's1'")).toThrow();
    db.exec("UPDATE shifts SET closed_at = 5, closed_by = 'u', counted_cash_paise = 50000, expected_cash_paise = 50000, variance_paise = 0 WHERE id = 's1'");
    expect(() => db.exec("UPDATE shifts SET close_note = 'later' WHERE id = 's1'")).toThrow(/closed shift/);
    expect(() => db.exec("DELETE FROM shifts")).toThrow(/append-only/);
    db.exec("INSERT INTO shifts (id, cashier_id, opened_at, opening_float_paise, open_client_ref) VALUES ('s2', 'u', 6, 0, 'ref-2')");
    db.exec("INSERT INTO cash_movements (id, shift_id, kind, amount_paise, reason, created_at, created_by, client_ref, request_json) VALUES ('m', 's2', 'pay_out', 100, 'Milk', 7, 'u', 'ref-m', '{}')");
    expect(() => db.exec("UPDATE cash_movements SET amount_paise = 1")).toThrow(/append-only/);
    db.exec("INSERT INTO day_closes (business_date, closed_at, closed_by, report_json, client_ref) VALUES ('2026-10-25', 9, 'u', '{}', 'ref-d')");
    expect(() => db.exec("INSERT INTO day_closes (business_date, closed_at, closed_by, report_json, client_ref) VALUES ('25/10/2026', 9, 'u', '{}', 'ref-e')")).toThrow();
    expect(() => db.exec("DELETE FROM day_closes")).toThrow(/cannot change/);
  } finally { db.close(); }
});
