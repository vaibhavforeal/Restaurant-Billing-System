import type { Migration } from "../migrate.js";

const OLD_CHECK = "CHECK (gst_mode IN ('included', 'none'))";
const NEW_CHECK = "CHECK (gst_mode IN ('included', 'exclusive', 'none'))";

/** GST added on top: widens the gst_mode CHECK. SQLite cannot alter a CHECK in place, so the table is rebuilt from its stored SQL, which keeps every column and check added since the baseline. */
export const gstExclusive: Migration = {
  version: 58,
  name: "gst_exclusive",
  up(db) {
    const { sql } = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'settings'").get() as { sql: string };
    if (!sql.includes(OLD_CHECK)) throw new Error("settings.gst_mode check not found; cannot add the exclusive GST mode");
    const widened = sql.replace(OLD_CHECK, NEW_CHECK);
    const rebuilt = widened.replace(/^CREATE TABLE "?settings"?/, "CREATE TABLE settings_new");
    if (rebuilt === widened) throw new Error("settings table definition not recognised");
    db.exec(`
      ${rebuilt};
      INSERT INTO settings_new SELECT * FROM settings;
      DROP TABLE settings;
      ALTER TABLE settings_new RENAME TO settings;
    `);
  },
};
