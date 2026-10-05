import type { Migration } from "../migrate.js";

export const migration010: Migration = {
  version: 10,
  name: "menu-photos-and-preparation",
  up(db) {
    db.exec(`
      ALTER TABLE products ADD COLUMN description TEXT NOT NULL DEFAULT '';
      ALTER TABLE products ADD COLUMN is_sold_out INTEGER NOT NULL DEFAULT 0 CHECK (is_sold_out IN (0, 1));
      ALTER TABLE products ADD COLUMN photo_data TEXT;
      ALTER TABLE products ADD COLUMN photo_hash TEXT;
      ALTER TABLE order_items ADD COLUMN guest_request_id TEXT REFERENCES guest_requests(id);
      UPDATE order_items SET guest_request_id = substr(client_ref, 7, 36)
        WHERE client_ref LIKE 'guest:%' AND EXISTS (
          SELECT 1 FROM guest_requests r WHERE r.id = substr(order_items.client_ref, 7, 36)
          AND r.order_id = order_items.order_id AND r.status = 'accepted'
          AND order_items.client_ref = 'guest:' || r.id || ':' || CAST(CAST(substr(order_items.client_ref, 44) AS INTEGER) AS TEXT)
          AND CAST(substr(order_items.client_ref, 44) AS INTEGER) >= 0
          AND CAST(substr(order_items.client_ref, 44) AS INTEGER) < json_array_length(r.items_json)
        );
      CREATE INDEX idx_order_items_guest_request ON order_items(guest_request_id);
    `);
  },
};
