import { afterEach, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate, MIGRATIONS, openDb } from "@forkflow/domain";
import { Backups } from "./backups.js";
import { buildServer } from "./server.js";
import { auth, createUser, setupAdmin } from "./test-helpers.js";
import { edgeShortcut } from "./system.js";

let app: ReturnType<typeof buildServer>; let folder: string;
afterEach(async () => { await app?.close(); if (app?.db.open) app.db.close(); if (folder) rmSync(folder, { recursive: true, force: true }); });
it("restricts backups and network details to admins and downloads only managed snapshots", async () => {
  folder = mkdtempSync(join(tmpdir(), "forkflow-system-test-")); const db = openDb(join(folder, "forkflow.db")); migrate(db, MIGRATIONS);
  app = buildServer({ db, backups: new Backups(db, folder) });
  const admin = await setupAdmin(app); const cashier = await createUser(app, admin.token, { name: "Cashier", pin: "4321", role: "cashier" });
  for (const path of ["/api/system/backups", "/api/system/connections"]) {
    expect((await app.inject({ url: path })).statusCode).toBe(401);
    expect((await app.inject({ url: path, headers: auth(cashier.token) })).statusCode).toBe(403);
  }
  const manual = await app.inject({ method: "POST", url: "/api/system/backups", headers: auth(admin.token) }); expect(manual.statusCode).toBe(200);
  const download = await app.inject({ url: `/api/system/backups/${manual.json().name}`, headers: auth(admin.token) });
  expect(download.statusCode).toBe(200); expect(download.rawPayload.subarray(0, 15).toString()).toBe("SQLite format 3");
  expect((await app.inject({ url: "/api/system/backups/not-a-backup.db", headers: auth(admin.token) })).statusCode).toBe(404);
  expect((await app.inject({ url: "/api/system/shortcut?url=http%3A%2F%2Fevil.example", headers: auth(admin.token) })).statusCode).toBe(400);
  expect((await app.inject({ method: "PUT", url: "/api/system/backups", headers: auth(admin.token), payload: { retentionDays: 1 } })).statusCode).toBe(400);
  expect((await app.inject({ url: "/api/system/generation", headers: auth(cashier.token) })).json()).toEqual({ generation: "initial" });
});
it("creates a Windows Edge app-mode shortcut with a fixed server URL", () => {
  const result = edgeShortcut("http://192.168.1.50:4100");
  expect(result).toContain("--app=http://192.168.1.50:4100");
  expect(result).toContain("CreateShortcut"); expect(result).toContain("GetFolderPath('Desktop')");
});
