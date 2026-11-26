import type { Migration } from "../migrate.js";

export const cashCustody: Migration = {
  version: 64, name: "cash-custody",
  up(db) {
    db.exec(`
      CREATE TABLE drawers (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE);
      INSERT INTO drawers VALUES ('main', 'Main drawer');
      ALTER TABLE shifts ADD COLUMN drawer_id TEXT REFERENCES drawers(id);
      INSERT INTO drawers SELECT s.id, 'Drawer ' || ROW_NUMBER() OVER (ORDER BY s.opened_at,s.id) || ' · ' || u.name
        FROM shifts s JOIN users u ON u.id=s.cashier_id WHERE s.closed_at IS NULL;
      UPDATE shifts SET drawer_id=id WHERE closed_at IS NULL;
      CREATE UNIQUE INDEX one_shift_per_drawer ON shifts(drawer_id) WHERE closed_at IS NULL;
      ALTER TABLE payments ADD COLUMN shift_id TEXT REFERENCES shifts(id);
      ALTER TABLE refund_payments ADD COLUMN shift_id TEXT REFERENCES shifts(id);
      CREATE TABLE handover_events (
        seq INTEGER PRIMARY KEY, shift_id TEXT NOT NULL REFERENCES shifts(id), client_ref TEXT NOT NULL UNIQUE,
        request_json TEXT NOT NULL, actor TEXT NOT NULL REFERENCES users(id), recipient TEXT NOT NULL REFERENCES users(id),
        final INTEGER NOT NULL, state TEXT NOT NULL, expected INTEGER NOT NULL, counted INTEGER NOT NULL,
        received INTEGER, note TEXT NOT NULL, at INTEGER NOT NULL);
      CREATE INDEX handover_by_shift ON handover_events(shift_id, seq);
    `);
  },
};
