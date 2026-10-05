import DatabaseCtor from "better-sqlite3";
import { MIGRATIONS, localDateKey, type Database } from "@forkflow/domain";
import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync, openSync, fsyncSync, closeSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";

const managedName = /^forkflow-(daily|manual|pre-update)-\d{13}-[a-f0-9-]{36}\.db$/;
export const BackupConfig = z.object({
  retentionDays: z.number().int().min(7).max(365).default(30),
  secondLocation: z.string().trim().max(1024).default("").refine((p) => !p || isAbsolute(p), "Use an absolute folder path on the server PC"),
});
type Config = z.infer<typeof BackupConfig>;
type Kind = "daily" | "manual" | "pre-update";

export function atomicJson(path: string, value: unknown): void {
  const temp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temp, JSON.stringify(value, null, 2));
  syncFile(temp);
  renameSync(temp, path);
}
export function syncFile(path: string): void {
  const fd = openSync(path, "r+");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

/** Read-only validation: a snapshot must be a complete, supported ForkFlow database. */
export function verifyBackup(path: string): number {
  const check = new DatabaseCtor(path, { readonly: true, fileMustExist: true });
  try {
    if (check.pragma("quick_check", { simple: true }) !== "ok") throw new Error("Backup failed SQLite integrity check");
    const version = check.pragma("user_version", { simple: true }) as number;
    if (version < 1 || version > MIGRATIONS.at(-1)!.version) throw new Error("Backup schema is not supported by this app version");
    for (const table of ["settings", "users", "orders", "bills"]) check.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get();
    if ((check.pragma("foreign_key_check") as unknown[]).length) throw new Error("Backup contains broken references");
    return version;
  } finally { check.close(); }
}

export class Backups {
  readonly folder: string;
  private config: Config;
  private lastError: string | null = null;
  private secondError: string | null = null;
  private consumers = new Set<{ created: (name: string) => void; protectedNames: () => ReadonlySet<string> }>();
  constructor(readonly db: Database, readonly dataDir: string, private now = () => Date.now()) {
    this.folder = join(dataDir, "backups");
    mkdirSync(this.folder, { recursive: true });
    const path = join(dataDir, "backup-settings.json");
    this.config = BackupConfig.parse(existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {});
  }
  list(folder = this.folder) {
    return readdirSync(folder).filter((name) => managedName.test(name)).map((name) => ({
      name, kind: name.split("-")[1] === "pre" ? "pre-update" : name.split("-")[1]!,
      createdAt: Number(name.match(/-(\d{13})-/)![1]), bytes: statSync(join(folder, name)).size,
    })).sort((a, b) => b.createdAt - a.createdAt || b.name.localeCompare(a.name));
  }
  status() { return { ...this.config, folder: this.folder, backups: this.list(), lastError: this.lastError, secondError: this.secondError }; }
  subscribe(consumer: { created: (name: string) => void; protectedNames: () => ReadonlySet<string> }): () => void {
    this.consumers.add(consumer);
    return () => { this.consumers.delete(consumer); };
  }
  configure(input: unknown) {
    const config = BackupConfig.parse(input);
    if (config.secondLocation && resolve(config.secondLocation).toLowerCase() === resolve(this.folder).toLowerCase()) throw new Error("Choose a different second backup folder");
    atomicJson(join(this.dataDir, "backup-settings.json"), config);
    this.config = config;
    return this.status();
  }
  create(kind: Kind) {
    const name = `forkflow-${kind}-${this.now()}-${randomUUID()}.db`;
    const target = join(this.folder, name);
    const temp = `${target}.partial`;
    try {
      this.db.prepare("VACUUM INTO ?").run(temp);
      verifyBackup(temp);
      syncFile(temp);
      renameSync(temp, target);
      this.lastError = null;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : "Backup failed";
      if (existsSync(temp)) unlinkSync(temp);
      throw error;
    }
    this.copySecond(target, name);
    for (const consumer of this.consumers) {
      // Secondary services cannot turn a verified local backup into a failure.
      try { consumer.created(name); } catch { /* consumers report their own errors */ }
    }
    // Retention never runs before a verified snapshot exists. Preserve 10 manual
    // and 10 pre-update restore points independently of daily retention.
    try { this.prune(this.folder); } catch (e) { this.lastError = `Backup saved; retention failed: ${String(e)}`; }
    return { name, ...this.status() };
  }
  private copySecond(source: string, name: string) {
    this.secondError = null;
    if (!this.config.secondLocation) return;
    let temp: string | undefined;
    try {
      mkdirSync(this.config.secondLocation, { recursive: true });
      const target = join(this.config.secondLocation, name);
      temp = `${target}.partial`;
      copyFileSync(source, temp);
      verifyBackup(temp); syncFile(temp); renameSync(temp, target);
      this.prune(this.config.secondLocation);
    } catch (e) {
      this.secondError = `Local backup saved; second copy failed: ${String(e)}`;
      if (temp && existsSync(temp)) { try { unlinkSync(temp); } catch { /* leave partial for inspection */ } }
    }
  }
  private prune(folder: string) {
    const counts = new Map<string, number>();
    const protectedNames = folder === this.folder ? new Set([...this.consumers].flatMap((consumer) => [...consumer.protectedNames()])) : new Set<string>();
    for (const entry of this.list(folder)) {
      const count = (counts.get(entry.kind) ?? 0) + 1; counts.set(entry.kind, count);
      const expired = entry.kind === "daily" ? entry.createdAt < this.now() - this.config.retentionDays * 86400000 && count > 1 : count > 10;
      if (expired && !protectedNames.has(entry.name)) unlinkSync(join(folder, entry.name));
    }
  }
  daily() {
    const today = localDateKey(this.now());
    const latest = this.list().find((b) => b.kind === "daily" && localDateKey(b.createdAt) === today);
    if (!latest) this.create("daily");
    else if (this.config.secondLocation && !existsSync(join(this.config.secondLocation, latest.name))) this.copySecond(join(this.folder, latest.name), latest.name);
  }
  download(name: string): string | null {
    return managedName.test(name) && this.list().some((b) => b.name === name) ? join(this.folder, name) : null;
  }
}
