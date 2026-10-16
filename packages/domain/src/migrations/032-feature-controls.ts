import type { Migration } from "../migrate.js";

export const migration032: Migration = {
  version: 32,
  name: "feature-controls",
  up(db) {
    db.exec(`CREATE TABLE feature_state (
      id TEXT PRIMARY KEY,
      enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
      updated_at INTEGER NOT NULL,
      updated_by TEXT NOT NULL
    );
    CREATE TABLE feature_revision (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL);
    INSERT INTO feature_revision VALUES (1,0);
    CREATE TRIGGER integration_feature_insert AFTER INSERT ON integration_state BEGIN
      UPDATE feature_revision SET revision=revision+1 WHERE id=1;
    END;
    CREATE TRIGGER integration_feature_update AFTER UPDATE OF enabled ON integration_state WHEN OLD.enabled<>NEW.enabled BEGIN
      UPDATE feature_revision SET revision=revision+1 WHERE id=1;
    END;
    CREATE TRIGGER integration_feature_delete AFTER DELETE ON integration_state BEGIN
      UPDATE feature_revision SET revision=revision+1 WHERE id=1;
    END;`);
  },
};
