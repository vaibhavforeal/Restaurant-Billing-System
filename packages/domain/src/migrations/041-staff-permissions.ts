import type { Migration } from "../migrate.js";

/**
 * Per-person permission changes on top of a staff member's role: `allowed` 1 adds a permission the role lacks, 0 removes
 * one it has. Only real differences from the role are stored. Admins are never restricted and managing staff or settings
 * stays admin-only; the server enforces both, so this table only holds grantable permissions.
 */
export const migration041: Migration = {
  version: 41,
  name: "staff-permissions",
  up(db) {
    db.exec(`
      CREATE TABLE user_permissions (
        user_id    TEXT NOT NULL REFERENCES users(id),
        permission TEXT NOT NULL CHECK (permission GLOB '[a-z]*.[a-z_]*' AND permission NOT IN ('users.manage', 'settings.manage')),
        allowed    INTEGER NOT NULL CHECK (allowed IN (0, 1)),
        updated_at INTEGER NOT NULL,
        updated_by TEXT NOT NULL REFERENCES users(id),
        PRIMARY KEY (user_id, permission)
      );
    `);
  },
};
