import type { Migration } from "../migrate.js";

/** Staff activity report: the limits that flag cash short, big discounts and pay-outs, and unusual counts. Admins edit them in Settings. */
export const activityAlerts: Migration = {
  version: 52,
  name: "activity_alerts",
  up(db) {
    db.exec(`
      ALTER TABLE settings ADD COLUMN alert_cash_short_paise INTEGER NOT NULL DEFAULT 20000 CHECK (alert_cash_short_paise >= 0);
      ALTER TABLE settings ADD COLUMN alert_discount_percent REAL NOT NULL DEFAULT 20 CHECK (alert_discount_percent > 0 AND alert_discount_percent <= 100);
      ALTER TABLE settings ADD COLUMN alert_pay_out_paise INTEGER NOT NULL DEFAULT 50000 CHECK (alert_pay_out_paise >= 0);
      ALTER TABLE settings ADD COLUMN alert_multiplier REAL NOT NULL DEFAULT 2 CHECK (alert_multiplier >= 1);
      ALTER TABLE settings ADD COLUMN alert_min_events INTEGER NOT NULL DEFAULT 3 CHECK (alert_min_events >= 1);
    `);
  },
};
