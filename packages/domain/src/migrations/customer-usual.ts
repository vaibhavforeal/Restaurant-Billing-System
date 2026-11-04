import type { Migration } from "../migrate.js";

/** Customer's usual: the order screen offers a known customer's regular dishes and last order unless turned off in Settings. */
export const customerUsual: Migration = {
  version: 51,
  name: "customer_usual",
  up(db) {
    db.exec("ALTER TABLE settings ADD COLUMN customer_usual_enabled INTEGER NOT NULL DEFAULT 1 CHECK (customer_usual_enabled IN (0, 1));");
  },
};
