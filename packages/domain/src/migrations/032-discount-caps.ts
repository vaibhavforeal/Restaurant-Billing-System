import type { Migration } from "../migrate.js";

/**
 * Discount limits become data. `discount_caps` holds one percentage per role (NULL = unlimited) and
 * `users.max_discount_percent` optionally overrides it for one person. The cashier's 10% limit used to live in
 * code (`roles.ts`); the seed keeps today's behaviour. A discount above the limit needs an admin PIN, recorded in
 * `bills.discount_approved_by`.
 */
export const migration032: Migration = {
  version: 32,
  name: "discount-caps",
  up(db) {
    db.exec(`
      CREATE TABLE discount_caps (
        role TEXT PRIMARY KEY CHECK (role IN ('admin', 'cashier', 'waiter', 'kitchen')),
        max_percent REAL CHECK (max_percent IS NULL OR (max_percent >= 0 AND max_percent <= 100))
      );
      INSERT INTO discount_caps (role, max_percent) VALUES ('admin', NULL), ('cashier', 10), ('waiter', 0), ('kitchen', 0);
      ALTER TABLE users ADD COLUMN max_discount_percent REAL CHECK (max_discount_percent IS NULL OR (max_discount_percent >= 0 AND max_discount_percent <= 100));
      ALTER TABLE bills ADD COLUMN discount_approved_by TEXT REFERENCES users(id);
    `);
  },
};
