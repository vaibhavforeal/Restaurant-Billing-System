import type { Migration } from "../migrate.js";
export const migration007: Migration = {
  version: 7, name: "kot-requests",
  up(db) {
    db.exec(`CREATE TABLE kot_requests (
      client_ref TEXT PRIMARY KEY,
      order_id TEXT NOT NULL REFERENCES orders(id),
      user_id TEXT NOT NULL REFERENCES users(id),
      fingerprint TEXT NOT NULL,
      kot_ids TEXT NOT NULL
    )`);
  },
};
