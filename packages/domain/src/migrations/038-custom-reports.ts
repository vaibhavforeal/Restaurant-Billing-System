import type { Migration } from "../migrate.js";

/**
 * Saved custom reports: a name plus the JSON definition (data source, columns, filters, grouping, sort) built in the report
 * builder. Reports are shared by everyone who may read reports; only admins write them. The definition is only ever field ids from
 * the fixed catalogue in custom-reports.ts, resolved to SQL on the server, so nothing stored here is executed as SQL.
 */
export const migration038: Migration = {
  version: 38,
  name: "custom-reports",
  up(db) {
    db.exec(`
      CREATE TABLE saved_reports (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL COLLATE NOCASE UNIQUE CHECK (length(trim(name)) > 0),
        config_json TEXT NOT NULL CHECK (json_valid(config_json)),
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL,
        created_by  TEXT NOT NULL REFERENCES users(id)
      );
    `);
  },
};
