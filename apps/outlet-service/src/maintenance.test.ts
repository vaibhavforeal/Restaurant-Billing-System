import { afterEach, expect, it } from "vitest";
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MIGRATIONS, migrate, openDb } from "@forkflow/domain";
import { lockDataDirectory } from "../../server/src/data-lock.js";
import { verifyBackup } from "../../server/src/backups.js";
import { maintainOutlet } from "./maintenance.js";

const folders: string[] = [];
function fixture() {
  const folder = mkdtempSync(join(tmpdir(), "forkflow-outlet-test-")); folders.push(folder);
  const db = openDb(join(folder, "forkflow.db")); migrate(db, MIGRATIONS);
  db.prepare("UPDATE settings SET restaurant_name = 'Safe snapshot'").run(); db.close();
  return folder;
}
afterEach(() => { for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true }); });

it("backs up and restores through the journaled recovery path", async () => {
  const folder = fixture();
  const result = await maintainOutlet(folder, "backup");
  const backup = join(folder, "backups", result.backup!);
  expect(verifyBackup(backup)).toBe(MIGRATIONS.at(-1)!.version);
  const db = openDb(join(folder, "forkflow.db")); db.prepare("UPDATE settings SET restaurant_name = 'Later edit'").run(); db.close();
  await maintainOutlet(folder, "restore", { source: backup });
  const restored = openDb(join(folder, "forkflow.db"));
  try { expect(restored.prepare("SELECT restaurant_name FROM settings").get()).toEqual({ restaurant_name: "Safe snapshot" }); } finally { restored.close(); }
  expect(existsSync(join(folder, "recovery-generation.json"))).toBe(true);
});

it("refuses maintenance while the data directory is owned by the running server", async () => {
  const folder = fixture(), release = await lockDataDirectory(folder);
  try { await expect(maintainOutlet(folder, "backup")).rejects.toThrow(); } finally { await release(); }
  expect((await maintainOutlet(folder, "backup")).backup).toBeTruthy();
});

it("rejects incompatible update schema before creating a backup", async () => {
  const folder = fixture();
  await expect(maintainOutlet(folder, "prepare-update", { schema: 1, minSchema: 0 })).rejects.toThrow(/newer/);
  expect(existsSync(join(folder, "backups"))).toBe(false);
  const result = await maintainOutlet(folder, "prepare-update", { schema: MIGRATIONS.at(-1)!.version, minSchema: 0 });
  expect(result.backup).toMatch(/^forkflow-pre-update-/);
});

it("refuses missing databases instead of creating a blank outlet", async () => {
  const folder = mkdtempSync(join(tmpdir(), "forkflow-outlet-test-")); folders.push(folder);
  await expect(maintainOutlet(folder, "backup")).rejects.toThrow(/database/i);
  expect(existsSync(join(folder, "forkflow.db"))).toBe(false);
});

it("migrates full outlet data under the single-writer lock and refuses destination overwrites", async () => {
  const folder = fixture();
  writeFileSync(join(folder, "installation.json"), '{"installationId":"kept"}');
  const target = mkdtempSync(join(tmpdir(), "forkflow-outlet-test-")); folders.push(target);
  await maintainOutlet(folder, "migrate-data", { destination: target });
  expect(readFileSync(join(target, "installation.json"), "utf8")).toContain('"kept"');
  expect(verifyBackup(join(target, "forkflow.db"))).toBe(MIGRATIONS.at(-1)!.version);
  await expect(maintainOutlet(folder, "migrate-data", { destination: target })).rejects.toThrow(/empty/);
});

it("refuses migration while the original server owns its store", async () => {
  const folder = fixture(), release = await lockDataDirectory(folder);
  const target = mkdtempSync(join(tmpdir(), "forkflow-outlet-test-")); folders.push(target);
  try { await expect(maintainOutlet(folder, "migrate-data", { destination: target })).rejects.toThrow(); }
  finally { await release(); }
  expect(existsSync(join(target, "forkflow.db"))).toBe(false);
});
