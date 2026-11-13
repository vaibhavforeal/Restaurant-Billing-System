import { uuidv7 } from "@masalapos/domain/id";
import type { Migration } from "../migrate.js";

/**
 * Phase 2A: staff with PINs and roles, customers, held carts (not synced), who made and approved each bill, order kind
 * and notes, and the counter settings. A Phase 1 owner PIN becomes an "Owner" staff row keeping the old hash, which
 * `verifyPin` accepts once and replaces.
 */
export const counter: Migration = {
  version: 4,
  up(db) {
    db.run(`CREATE TABLE staff (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL CHECK (role IN ('owner','manager','cashier')),
      pin_hash TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, sort INTEGER NOT NULL,
      updated_at INTEGER NOT NULL, deleted_at INTEGER)`);
    db.run(`CREATE TABLE customers (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, phone TEXT NOT NULL, address_note TEXT NOT NULL DEFAULT '',
      updated_at INTEGER NOT NULL, deleted_at INTEGER)`);
    db.run("CREATE UNIQUE INDEX customers_phone ON customers (phone) WHERE deleted_at IS NULL");
    db.run(`CREATE TABLE held_carts (
      id TEXT PRIMARY KEY, cart_json TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', staff_id TEXT, created_at INTEGER NOT NULL)`);
    db.run("ALTER TABLE bills ADD COLUMN staff_id TEXT");
    db.run("ALTER TABLE bills ADD COLUMN approved_by TEXT");
    db.run("ALTER TABLE bills ADD COLUMN customer_id TEXT");
    db.run("ALTER TABLE bills ADD COLUMN order_kind TEXT NOT NULL DEFAULT 'takeaway' CHECK (order_kind IN ('takeaway','delivery'))");
    db.run("ALTER TABLE bills ADD COLUMN delivery_note TEXT");
    db.run("ALTER TABLE bill_voids ADD COLUMN staff_id TEXT");
    db.run("ALTER TABLE bill_lines ADD COLUMN note TEXT");
    db.run("ALTER TABLE cafe ADD COLUMN cashier_discount_bp INTEGER NOT NULL DEFAULT 0");
    db.run("ALTER TABLE cafe ADD COLUMN lock_after_minutes INTEGER NOT NULL DEFAULT 5");
    db.run("ALTER TABLE cafe ADD COLUMN kitchen_slip TEXT NOT NULL DEFAULT 'off' CHECK (kitchen_slip IN ('off','kitchen','receipt'))");
    db.run("ALTER TABLE cafe ADD COLUMN show_served_by INTEGER NOT NULL DEFAULT 0");
    const cafe = db.get<{ owner_pin_hash: string | null; updated_at: number }>(
      "SELECT owner_pin_hash, updated_at FROM cafe WHERE deleted_at IS NULL LIMIT 1");
    if (cafe?.owner_pin_hash) {
      db.run("INSERT INTO staff (id, name, role, pin_hash, active, sort, updated_at) VALUES (?, 'Owner', 'owner', ?, 1, 1, ?)",
        [uuidv7(), cafe.owner_pin_hash, cafe.updated_at]);
    }
  },
};
