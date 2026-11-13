import type { Migration } from "../migrate.js";

/** Synced tables carry id, updated_at and deleted_at; money is integer paise and times are epoch milliseconds. */
const SCHEMA = [
  `CREATE TABLE cafe (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, address TEXT NOT NULL DEFAULT '', phone TEXT NOT NULL DEFAULT '',
  gstin TEXT NOT NULL DEFAULT '', fssai TEXT NOT NULL DEFAULT '',
  gst_mode TEXT NOT NULL CHECK (gst_mode IN ('included','exclusive','none')),
  default_gst_rate INTEGER NOT NULL CHECK (default_gst_rate IN (0,5,12,18,28)),
  round_off TEXT NOT NULL CHECK (round_off IN ('rupee','half','off')),
  invoice_prefix TEXT NOT NULL DEFAULT '', receipt_header TEXT NOT NULL DEFAULT '', receipt_footer TEXT NOT NULL DEFAULT '',
  receipt_style TEXT NOT NULL DEFAULT 'classic', upi_id TEXT NOT NULL DEFAULT '', owner_pin_hash TEXT,
  updated_at INTEGER NOT NULL, deleted_at INTEGER)`,
  `CREATE TABLE device (id TEXT PRIMARY KEY, name TEXT NOT NULL, series_letter TEXT NOT NULL CHECK (length(series_letter) = 1))`,
  `CREATE TABLE categories (id TEXT PRIMARY KEY, name TEXT NOT NULL, sort INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER)`,
  `CREATE TABLE items (
  id TEXT PRIMARY KEY, category_id TEXT NOT NULL REFERENCES categories(id), name TEXT NOT NULL,
  price_paise INTEGER NOT NULL CHECK (price_paise >= 0), gst_rate INTEGER CHECK (gst_rate IN (0,5,12,18,28)),
  available INTEGER NOT NULL DEFAULT 1, sort INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER)`,
  `CREATE TABLE item_variants (
  id TEXT PRIMARY KEY, item_id TEXT NOT NULL REFERENCES items(id), name TEXT NOT NULL,
  price_paise INTEGER NOT NULL CHECK (price_paise >= 0), sort INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER)`,
  `CREATE TABLE bills (
  id TEXT PRIMARY KEY, device_id TEXT NOT NULL, bill_no INTEGER NOT NULL, invoice_no TEXT NOT NULL UNIQUE,
  token INTEGER NOT NULL, business_date TEXT NOT NULL, created_at INTEGER NOT NULL,
  discount_paise INTEGER NOT NULL, discount_note TEXT, total_paise INTEGER NOT NULL,
  totals_json TEXT NOT NULL, receipt_json TEXT NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER)`,
  `CREATE INDEX bills_by_date ON bills (business_date, created_at)`,
  `CREATE TABLE bill_lines (
  id TEXT PRIMARY KEY, bill_id TEXT NOT NULL REFERENCES bills(id), item_id TEXT, variant_id TEXT, name TEXT NOT NULL,
  price_paise INTEGER NOT NULL, qty INTEGER NOT NULL CHECK (qty >= 1), gst_rate INTEGER NOT NULL,
  offer_discount_paise INTEGER NOT NULL DEFAULT 0, sort INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER)`,
  `CREATE INDEX bill_lines_by_bill ON bill_lines (bill_id)`,
  `CREATE TABLE payments (
  id TEXT PRIMARY KEY, bill_id TEXT NOT NULL REFERENCES bills(id), mode TEXT NOT NULL CHECK (mode IN ('cash','upi','card')),
  amount_paise INTEGER NOT NULL CHECK (amount_paise > 0), ref_note TEXT, created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL, deleted_at INTEGER)`,
  `CREATE INDEX payments_by_bill ON payments (bill_id)`,
  `CREATE TABLE bill_voids (
  id TEXT PRIMARY KEY, bill_id TEXT NOT NULL UNIQUE REFERENCES bills(id), credit_note_no TEXT NOT NULL UNIQUE,
  reason TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER)`,
  `CREATE TABLE sequences (name TEXT PRIMARY KEY, value INTEGER NOT NULL)`,
  `CREATE TABLE printers (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, transport TEXT NOT NULL CHECK (transport IN ('bluetooth','network')),
  address TEXT NOT NULL, paper_width INTEGER NOT NULL CHECK (paper_width IN (58,80)),
  role TEXT NOT NULL CHECK (role IN ('receipt','kitchen')), profile_json TEXT NOT NULL)`,
];

export const initial: Migration = {
  version: 1,
  up(db) {
    for (const sql of SCHEMA) db.run(sql);
  },
};
