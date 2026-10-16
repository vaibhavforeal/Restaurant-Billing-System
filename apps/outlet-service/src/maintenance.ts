import { existsSync, readdirSync, cpSync, mkdirSync, lstatSync } from "node:fs";
import { join, resolve, relative, isAbsolute } from "node:path";
import { openDb } from "@forkflow/domain";
import { lockDataDirectory } from "../../server/src/data-lock.js";
import { Backups, verifyBackup } from "../../server/src/backups.js";
import { restoreDatabase } from "../../server/src/recovery.js";
import { reconcileCloud, type CloudRecoveryOptions } from "../../server/src/cloud-recovery.js";

type MaintenanceCommand = "status" | "backup" | "restore" | "prepare-update" | "migrate-data" | "reconcile-cloud";
type MaintenanceOptions = { source?: string; schema?: number; minSchema?: number; destination?: string } & CloudRecoveryOptions;
export async function maintainOutlet(dataDir: string, command: MaintenanceCommand, options: MaintenanceOptions = {}): Promise<{ schema?: number; backup?: string; archive?: string | null }> {
  const release = await lockDataDirectory(dataDir);
  try {
    const live = join(dataDir, "forkflow.db");
    if (command === "reconcile-cloud") {
      const result = await reconcileCloud(dataDir, options);
      return { archive: result.archive, schema: verifyBackup(live) };
    }
    if (command === "restore") {
      if (!options.source) throw new Error("Restore requires a backup path");
      restoreDatabase(dataDir);
      return { archive: restoreDatabase(dataDir, options.source), schema: verifyBackup(live) };
    }
    if (existsSync(join(dataDir, "restore-pending.json"))) throw new Error("Interrupted recovery is pending; finish restore before maintenance");
    if (!existsSync(live)) throw new Error("Outlet database does not exist");
    const schema = verifyBackup(live);
    if (command === "migrate-data") {
      if (!options.destination || !isAbsolute(options.destination)) throw new Error("Migration requires an absolute destination directory");
      const destination = resolve(options.destination), rel = relative(resolve(dataDir), destination);
      if (!rel || (!rel.startsWith("..") && !isAbsolute(rel))) throw new Error("Migration destination must be outside the source data directory");
      const targetRelease = await lockDataDirectory(destination);
      try {
        if (existsSync(destination) && readdirSync(destination).length) throw new Error("Migration destination must be empty");
        mkdirSync(destination, { recursive: true });
        const ensureNoLinks = (folder: string) => {
          for (const entry of readdirSync(folder)) {
            const path = join(folder, entry), stat = lstatSync(path);
            if (stat.isSymbolicLink()) throw new Error("Migration refuses linked/reparse data paths");
            if (stat.isDirectory()) ensureNoLinks(path);
          }
        };
        ensureNoLinks(dataDir);
        cpSync(dataDir, destination, { recursive: true, errorOnExist: true, force: false });
        verifyBackup(join(destination, "forkflow.db"));
        return { schema };
      } finally { await targetRelease(); }
    }
    if (command === "status") return { schema };
    if (command === "prepare-update") {
      if (!Number.isInteger(options.schema) || !Number.isInteger(options.minSchema)) throw new Error("Update schema compatibility is required");
      if (schema > options.schema!) throw new Error("Database is newer than the proposed update; downgrades are refused");
      if (schema < options.minSchema!) throw new Error("Database is older than the minimum supported update schema");
    }
    if (command !== "backup" && command !== "prepare-update") throw new Error("Unknown maintenance command");
    const db = openDb(live);
    try { return { schema, backup: new Backups(db, dataDir).create(command === "prepare-update" ? "pre-update" : "manual").name }; }
    finally { db.close(); }
  } finally { await release(); }
}
