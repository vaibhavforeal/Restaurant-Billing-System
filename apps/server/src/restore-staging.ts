import DatabaseCtor from "better-sqlite3";
import { copyFileSync, createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Transform, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { RestorePreview } from "@forkflow/domain";
import { parseBackupName, syncFile, verifyBackup } from "./backups.js";
import { httpError } from "./http-error.js";

/** Larger than any realistic restaurant database, small enough to refuse a runaway upload. */
export const MAX_RESTORE_BYTES = 4 * 1024 ** 3;

/**
 * Holds at most one candidate backup in `<data>/restore-incoming` while an admin reviews what it contains.
 * Nothing here touches the live database: confirming hands the staged path to the desktop shell, which stops
 * the server and runs the journaled restore in `recovery.ts`. The folder is emptied whenever the server starts,
 * which is after any pending restore has already copied its source.
 */
export class RestoreStaging {
  readonly folder: string;
  private current: { token: string; path: string; preview: RestorePreview } | null = null;

  constructor(dataDir: string) {
    this.folder = join(dataDir, "restore-incoming");
    rmSync(this.folder, { recursive: true, force: true });
    mkdirSync(this.folder, { recursive: true });
  }

  /** Discard the staged candidate, if any. */
  clear() {
    this.current = null;
    for (const name of readdirSync(this.folder)) rmSync(join(this.folder, name), { force: true });
  }

  /** A browser upload. The size cap is enforced while streaming, before anything is opened as SQLite. */
  async fromStream(stream: Readable, label: string): Promise<RestorePreview> {
    let bytes = 0;
    const limit = new Transform({ transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      callback(bytes > MAX_RESTORE_BYTES ? httpError(413, "This file is too large to be a ForkFlow backup") : null, chunk);
    } });
    return this.stage("file", label, (target) => pipeline(stream, limit, createWriteStream(target)));
  }

  /** One of this PC's verified snapshots. */
  fromFile(source: string, label: string): Promise<RestorePreview> {
    return this.stage("local", label, async (target) => { copyFileSync(source, target); });
  }

  /** A download (e.g. from Google Drive) written by the caller into `target`. */
  fromDownload(label: string, write: (target: string) => Promise<void>): Promise<RestorePreview> {
    return this.stage("drive", label, write);
  }

  /** The staged path for a confirmed preview. */
  take(token: string): string {
    if (!this.current || this.current.token !== token || !existsSync(this.current.path)) {
      throw httpError(404, "This backup is no longer ready to restore. Choose it again.");
    }
    return this.current.path;
  }

  private async stage(source: RestorePreview["source"], label: string, write: (target: string) => Promise<void>): Promise<RestorePreview> {
    this.clear();
    const token = randomUUID();
    const path = join(this.folder, `${token}.db`);
    const partial = `${path}.partial`;
    try {
      await write(partial);
      renameSync(partial, path);
    } catch (error) {
      rmSync(partial, { force: true });
      throw error;
    }
    let preview: RestorePreview;
    try {
      verifyBackup(path);
      preview = { token, source, label, bytes: statSync(path).size, takenAt: parseBackupName(label)?.createdAt ?? null, ...summarize(path) };
      syncFile(path);
    } catch (error) {
      rmSync(path, { force: true });
      const reason = error instanceof Error ? error.message : "";
      throw httpError(400, /not a database|file is (encrypted|not)/i.test(reason) || !reason
        ? "This file is not a ForkFlow backup." : `This file cannot be restored: ${reason}.`);
    }
    this.current = { token, path, preview };
    return preview;
  }
}

function summarize(path: string): Omit<RestorePreview, "token" | "source" | "label" | "bytes" | "takenAt"> {
  const db = new DatabaseCtor(path, { readonly: true, fileMustExist: true });
  try {
    const settings = db.prepare("SELECT restaurant_name FROM settings WHERE id = 1").get() as { restaurant_name: string } | undefined;
    const orders = db.prepare("SELECT COUNT(*) AS count, MAX(opened_at) AS last FROM orders").get() as { count: number; last: number | null };
    const bills = db.prepare("SELECT COUNT(*) AS count, MAX(created_at) AS last FROM bills").get() as { count: number; last: number | null };
    return { restaurantName: settings?.restaurant_name ?? "", orders: orders.count, bills: bills.count, lastOrderAt: orders.last, lastBillAt: bills.last };
  } finally { db.close(); }
}
