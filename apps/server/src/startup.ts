import { MIGRATIONS, migrate, type Database } from "@forkflow/domain";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicJson, type Backups } from "./backups.js";

export function prepareDatabase(db: Database, backups: Backups, version: string) {
  const current = db.pragma("user_version", { simple: true }) as number;
  if (current > MIGRATIONS.at(-1)!.version) throw new Error("Database is newer than this app. Install the newer version; do not downgrade.");
  const versionPath = join(backups.dataDir, "app-version.json");
  const prior = existsSync(versionPath) ? JSON.parse(readFileSync(versionPath, "utf8")).version : null;
  if (current > 0 && (current < MIGRATIONS.at(-1)!.version || prior !== version)) backups.create("pre-update");
  migrate(db, MIGRATIONS);
  atomicJson(versionPath, { version });
}
