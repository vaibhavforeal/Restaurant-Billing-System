import type { Migration } from "../migrate.js";

export const migration018: Migration = {
  version: 18,
  name: "table-captains",
  up(db) {
    db.exec(`
      ALTER TABLE dining_tables ADD COLUMN captain_id TEXT REFERENCES users(id);
      ALTER TABLE orders ADD COLUMN captain_id TEXT REFERENCES users(id);
      ALTER TABLE orders ADD COLUMN captain_name TEXT;
      CREATE TRIGGER order_captain_snapshot AFTER INSERT ON orders WHEN NEW.table_id IS NOT NULL BEGIN
        UPDATE orders SET captain_id = (SELECT captain_id FROM dining_tables WHERE id = NEW.table_id),
          captain_name = (SELECT u.name FROM users u JOIN dining_tables t ON t.captain_id = u.id WHERE t.id = NEW.table_id)
          WHERE id = NEW.id;
      END;
      CREATE TRIGGER clear_inactive_captain AFTER UPDATE OF role, is_active ON users WHEN NEW.role != 'waiter' OR NEW.is_active = 0 BEGIN
        UPDATE dining_tables SET captain_id = NULL WHERE captain_id = NEW.id;
      END;
    `);
  },
};
