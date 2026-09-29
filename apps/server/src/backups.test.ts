import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MIGRATIONS, migrate, openDb, type Database } from "@forkflow/domain";
import { Backups, atomicJson, verifyBackup } from "./backups.js";
import { restoreDatabase } from "./recovery.js";
import { prepareDatabase } from "./startup.js";
import { lockDataDirectory } from "./data-lock.js";

const folders: string[] = [], databases: Database[] = [];
function fixture(version = MIGRATIONS.length) {
  const folder = mkdtempSync(join(tmpdir(), "forkflow-backup-test-")); folders.push(folder);
  const db = openDb(join(folder, "forkflow.db")); databases.push(db);
  migrate(db, MIGRATIONS.slice(0, version));
  return { folder, db };
}
afterEach(() => { vi.restoreAllMocks(); databases.splice(0).forEach((db) => { if (db.open) db.close(); }); folders.splice(0).forEach((folder) => rmSync(folder, { recursive: true, force: true })); });

it("captures committed WAL data in a standalone verified snapshot", () => {
  const { folder, db } = fixture();
  db.prepare("UPDATE settings SET restaurant_name = 'Snapshot Cafe'").run();
  const backups = new Backups(db, folder);
  const result = backups.create("manual");
  const path = join(backups.folder, result.name);
  expect(verifyBackup(path)).toBe(MIGRATIONS.length);
  const copy = openDb(path); databases.push(copy);
  expect(copy.prepare("SELECT restaurant_name FROM settings").get()).toEqual({ restaurant_name: "Snapshot Cafe" });
  expect(backups.download("../forkflow.db")).toBeNull();
});
it("takes one daily snapshot per local day and prunes only managed expired snapshots", () => {
  const { folder, db } = fixture(); let now = Date.now();
  const backups = new Backups(db, folder, () => now);
  backups.configure({ retentionDays: 7 });
  backups.daily(); backups.daily(); expect(backups.list()).toHaveLength(1);
  const original = backups.list()[0]!.name;
  writeFileSync(join(backups.folder, "owner-notes.txt"), "keep");
  const manual = backups.create("manual").name;
  now += 8 * 86400000; backups.daily();
  expect(existsSync(join(backups.folder, original))).toBe(false);
  expect(existsSync(join(backups.folder, manual))).toBe(true);
  expect(existsSync(join(backups.folder, "owner-notes.txt"))).toBe(true);
});
it("retains ten pre-update points and ten manual points independently", () => {
  const { folder, db } = fixture(); let now = Date.now(); const backups = new Backups(db, folder, () => now++);
  for (let i = 0; i < 12; i++) { backups.create("manual"); backups.create("pre-update"); }
  expect(backups.list().filter((b) => b.kind === "manual")).toHaveLength(10);
  expect(backups.list().filter((b) => b.kind === "pre-update")).toHaveLength(10);
});
it("keeps the local snapshot when a second location fails, then retries the daily copy", () => {
  const { folder, db } = fixture(); const second = join(folder, "usb"); writeFileSync(second, "not a directory");
  const backups = new Backups(db, folder); backups.configure({ secondLocation: second }); backups.daily();
  expect(backups.status().secondError).toContain("second copy failed");
  expect(backups.list()).toHaveLength(1);
  rmSync(second); mkdirSync(second); backups.daily();
  expect(backups.status().secondError).toBeNull(); expect(verifyBackup(join(second, backups.list()[0]!.name))).toBe(MIGRATIONS.length);
});
it("backs up before migrating or changing app version and fails closed if the snapshot fails", () => {
  const { folder, db } = fixture(6); const backups = new Backups(db, folder);
  const fail = vi.spyOn(backups, "create").mockImplementation(() => { throw new Error("disk full"); });
  expect(() => prepareDatabase(db, backups, "0.6.0")).toThrow("disk full");
  expect(db.pragma("user_version", { simple: true })).toBe(6);
  fail.mockRestore(); prepareDatabase(db, backups, "0.6.0");
  expect(verifyBackup(join(backups.folder, backups.list()[0]!.name))).toBe(6);
  expect(db.pragma("user_version", { simple: true })).toBe(MIGRATIONS.length);
  prepareDatabase(db, backups, "0.6.0"); expect(backups.list()).toHaveLength(1);
  prepareDatabase(db, backups, "0.6.1"); expect(backups.list()).toHaveLength(2);
});
it("rejects newer database versions without migration or a backup rewrite", () => {
  const { folder, db } = fixture(); db.pragma("user_version = 999");
  const backups = new Backups(db, folder);
  expect(() => prepareDatabase(db, backups, "0.6.0")).toThrow("newer"); expect(backups.list()).toHaveLength(0);
});
it("restores a snapshot, archives current data and invalidates sessions and browser queues", () => {
  const { folder, db } = fixture(); const backups = new Backups(db, folder);
  db.prepare("UPDATE settings SET restaurant_name = 'Before'").run();
  const backup = backups.create("manual"); db.prepare("UPDATE settings SET restaurant_name = 'After'").run(); db.close();
  const archive = restoreDatabase(folder, join(backups.folder, backup.name));
  expect(existsSync(join(archive!, "forkflow.db"))).toBe(true);
  const restored = openDb(join(folder, "forkflow.db")); databases.push(restored);
  expect(restored.prepare("SELECT restaurant_name FROM settings").get()).toEqual({ restaurant_name: "Before" });
  expect(JSON.parse(readFileSync(join(folder, "recovery-generation.json"), "utf8")).generation).toBeTruthy();
  expect(existsSync(join(folder, "restore-pending.json"))).toBe(false);
});
it("rejects corrupt or unrelated input before touching live data", () => {
  const { folder, db } = fixture(); db.close(); const before = readFileSync(join(folder, "forkflow.db"));
  const invalid = join(folder, "invalid.db"); writeFileSync(invalid, "bad");
  expect(() => restoreDatabase(folder, invalid)).toThrow();
  expect(readFileSync(join(folder, "forkflow.db"))).toEqual(before);
});
it("resumes interrupted archive and install phases without losing the old database", () => {
  const { folder, db } = fixture(); const backup = new Backups(db, folder).create("manual"); db.close();
  copyFileSync(join(folder, "backups", backup.name), join(folder, "restore-staged.db"));
  const archive = join(folder, "recovery", "test"); mkdirSync(archive, { recursive: true });
  renameSync(join(folder, "forkflow.db"), join(archive, "forkflow.db"));
  atomicJson(join(folder, "restore-pending.json"), { archive, phase: "archive" });
  expect(restoreDatabase(folder)).toBe(archive);
  expect(verifyBackup(join(folder, "forkflow.db"))).toBe(MIGRATIONS.length);
  expect(restoreDatabase(folder)).toBeNull();
});
it("rejects a second writer lock and allows restart after release", async () => {
  const { folder } = fixture(); const release = await lockDataDirectory(folder);
  try { await expect(lockDataDirectory(folder)).rejects.toThrow(); } finally { await release(); }
  await (await lockDataDirectory(folder))();
});
