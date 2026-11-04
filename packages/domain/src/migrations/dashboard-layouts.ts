import type { Migration } from "../migrate.js";

/** One saved Home dashboard layout per person (Dynamic Reports). App code validates the layout; the database only insists it is valid JSON. */
export const dashboardLayouts: Migration = {
  version: 44,
  name: "dashboard_layouts",
  up(db) {
    db.exec(`
      CREATE TABLE dashboard_layouts (
        user_id     TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        layout_json TEXT NOT NULL CHECK (json_valid(layout_json)),
        updated_at  INTEGER NOT NULL
      );
    `);
  },
};
