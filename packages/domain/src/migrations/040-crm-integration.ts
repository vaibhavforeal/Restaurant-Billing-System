import type { Migration } from "../migrate.js";

/**
 * CRM & Loyalty becomes a Marketplace add-on (integration id `crm`). An installation that already uses customers or
 * loyalty points keeps them: the switch starts on, recorded against the first admin. Everyone else starts with it off.
 */
export const migration040: Migration = {
  version: 40,
  name: "crm-integration",
  up(db) {
    const inUse = db.prepare("SELECT EXISTS (SELECT 1 FROM customers) OR EXISTS (SELECT 1 FROM loyalty_settings WHERE enabled = 1) AS used").get() as { used: number };
    const admin = db.prepare("SELECT id FROM users WHERE role = 'admin' ORDER BY created_at, id LIMIT 1").get() as { id: string } | undefined;
    if (!inUse.used || !admin) return;
    db.prepare("INSERT OR IGNORE INTO integration_state (id, enabled, updated_at, updated_by) VALUES ('crm', 1, ?, ?)").run(Date.now(), admin.id);
  },
};
