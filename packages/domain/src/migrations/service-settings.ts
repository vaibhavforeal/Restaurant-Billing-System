import type { Migration } from "../migrate.js";

const flag = (column: string, on: 0 | 1) => `ALTER TABLE settings ADD COLUMN ${column} INTEGER NOT NULL DEFAULT ${on} CHECK (${column} IN (0,1));`;

/**
 * Service settings, set in Settings rather than on other screens or in code:
 * - when an open order turns amber and red on the order board, for every order type (until now the Zomato dialog held
 *   these two numbers; they are copied over and the Zomato columns are no longer read);
 * - whether KOT slips still print while the Kitchen Display is on;
 * - which payment methods the counter takes (at least one stays on; the API enforces that);
 * - whether QR guest orders are accepted without staff review, and the admin who switched that on: auto-accepted orders,
 *   tickets and stock moves are recorded under that admin, since every order needs a person behind it;
 * - the hour the business day starts, so a night past midnight still counts as one day (0 = midnight).
 */
export const serviceSettings: Migration = {
  version: 64,
  name: "service_settings",
  up(db) {
    db.exec(`
      ALTER TABLE settings ADD COLUMN order_warn_minutes INTEGER NOT NULL DEFAULT 15 CHECK (order_warn_minutes BETWEEN 1 AND 240);
      ALTER TABLE settings ADD COLUMN order_late_minutes INTEGER NOT NULL DEFAULT 25 CHECK (order_late_minutes BETWEEN 1 AND 240);
      ${flag("kot_print_with_kds", 1)}
      ${flag("pay_cash_enabled", 1)}
      ${flag("pay_card_enabled", 1)}
      ${flag("pay_upi_enabled", 1)}
      ${flag("qr_auto_accept", 0)}
      ALTER TABLE settings ADD COLUMN qr_auto_accept_by TEXT REFERENCES users(id);
      ALTER TABLE settings ADD COLUMN day_start_hour INTEGER NOT NULL DEFAULT 0 CHECK (day_start_hour BETWEEN 0 AND 6);
      UPDATE settings SET
        order_warn_minutes = COALESCE((SELECT warn_minutes FROM zomato_settings WHERE id = 1), order_warn_minutes),
        order_late_minutes = COALESCE((SELECT late_minutes FROM zomato_settings WHERE id = 1), order_late_minutes);
    `);
  },
};
