import { copyFileSync, existsSync, mkdirSync, renameSync, unlinkSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import DatabaseCtor from "better-sqlite3";
import { atomicJson, verifyBackup, syncFile } from "./backups.js";

/** Caller must hold the data-directory lock and must not have opened the live DB.
 * Journal each step so interrupted restores finish before the server accepts work.
 */
export function restoreDatabase(dataDir: string, source?: string): string | null {
  const journal = join(dataDir, "restore-pending.json");
  const live = join(dataDir, "forkflow.db");
  const staged = join(dataDir, "restore-staged.db");
  if (source) {
    if (existsSync(journal)) throw new Error("An interrupted restore must finish first");
    verifyBackup(source);
    copyFileSync(source, staged);
    verifyBackup(staged);
    syncFile(staged);
    const archive = join(dataDir, "recovery", randomUUID());
    mkdirSync(archive, { recursive: true });
    atomicJson(journal, { archive, phase: "archive" });
  }
  if (!existsSync(journal)) return null;
  const state = JSON.parse(readFileSync(journal, "utf8")) as { archive: string; phase: "archive" | "install" | "done" };
  if (state.phase === "archive") {
    verifyBackup(staged);
    for (const suffix of ["", "-wal", "-shm", "-journal"]) {
      const from = live + suffix, to = join(state.archive, "forkflow.db" + suffix);
      if (existsSync(from)) {
        if (existsSync(to)) throw new Error("Recovery archive collision; contact support");
        renameSync(from, to);
      }
    }
    state.phase = "install"; atomicJson(journal, state);
  }
  if (state.phase === "install") {
    if (existsSync(staged)) renameSync(staged, live);
    verifyBackup(live);
    const db = new DatabaseCtor(live);
    try { db.prepare("DELETE FROM sessions").run(); } finally { db.close(); }
    // Browser drafts/queues from after this restore point must never replay.
    atomicJson(join(dataDir, "recovery-generation.json"), { generation: randomUUID() });
    state.phase = "done"; atomicJson(journal, state);
  }
  unlinkSync(journal);
  return state.archive;
}
