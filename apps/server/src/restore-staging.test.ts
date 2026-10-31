import { afterEach, describe, expect, it } from "vitest";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MIGRATIONS, migrate, openDb, type Database, type RestorePreview, type ToDesktop } from "@forkflow/domain";
import type { FastifyInstance } from "fastify";
import { Backups, expiredBackups, verifyBackup } from "./backups.js";
import { buildServer } from "./server.js";
import { exportFileName } from "./system.js";
import { auth, createUser, setupAdmin } from "./test-helpers.js";

const cleanup: Array<{ folder: string; db: Database; app: FastifyInstance }> = [];
afterEach(async () => {
  for (const item of cleanup.splice(0)) {
    await item.app.close();
    if (item.db.open) item.db.close();
    rmSync(item.folder, { recursive: true, force: true });
  }
});

async function fixture(options: { desktop?: boolean } = {}) {
  const folder = mkdtempSync(join(tmpdir(), "forkflow-restore-test-"));
  const db = openDb(join(folder, "forkflow.db")); migrate(db, MIGRATIONS);
  const backups = new Backups(db, folder);
  const sent: ToDesktop[] = [];
  const app = buildServer({ db, backups, ...(options.desktop === false ? {} : { updateBridge: { send: (message) => { if (message.type === "restore") sent.push(message); }, onMessage: () => {} } }) });
  cleanup.push({ folder, db, app });
  await app.ready();
  const { token } = await setupAdmin(app);
  return { folder, db, backups, app, token, sent };
}
const LAN = { remoteAddress: "192.168.1.40" };

describe("backup file export", () => {
  it("downloads a fresh, complete database snapshot named after the restaurant", async () => {
    const f = await fixture();
    const res = await f.app.inject({ method: "POST", url: "/api/system/backups/export", headers: auth(f.token) });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-disposition"]).toMatch(/^attachment; filename="ForkFlow backup - Cafe Test - \d{4}-\d\d-\d\d \d{4}\.db"$/);
    const saved = f.backups.list();
    expect(saved).toHaveLength(1);
    expect(saved[0]!.kind).toBe("manual");
    expect(res.rawPayload.equals(readFileSync(join(f.backups.folder, saved[0]!.name)))).toBe(true);
  });
  it("keeps file names ASCII and safe for any restaurant name", () => {
    const at = new Date(2026, 9, 31, 14, 5).getTime();
    expect(exportFileName("Café \"Spice\" / Garden", at)).toBe("ForkFlow backup - Cafe Spice Garden - 2026-10-31 1405.db");
    expect(exportFileName("मसाला", at)).toBe("ForkFlow backup - Restaurant - 2026-10-31 1405.db");
  });
  it("is admin only", async () => {
    const f = await fixture();
    const cashier = await createUser(f.app, f.token, { name: "Cash", role: "cashier", pin: "5678" });
    expect((await f.app.inject({ method: "POST", url: "/api/system/backups/export" })).statusCode).toBe(401);
    expect((await f.app.inject({ method: "POST", url: "/api/system/backups/export", headers: auth(cashier.token) })).statusCode).toBe(403);
  });
});

describe("restore from a file", () => {
  async function exported(f: Awaited<ReturnType<typeof fixture>>) {
    f.db.prepare("UPDATE settings SET restaurant_name = 'Backup Cafe' WHERE id = 1").run();
    const res = await f.app.inject({ method: "POST", url: "/api/system/backups/export", headers: auth(f.token) });
    f.db.prepare("UPDATE settings SET restaurant_name = 'Cafe Test' WHERE id = 1").run();
    return res.rawPayload;
  }
  const upload = (f: Awaited<ReturnType<typeof fixture>>, payload: Buffer, extra: object = {}) => f.app.inject({
    method: "POST", url: "/api/system/restore/file", payload, ...extra,
    headers: { ...auth(f.token), "content-type": "application/octet-stream", "x-file-name": encodeURIComponent("Café backup.db") },
  });

  it("previews an uploaded backup, then hands only the confirmed staged file to the desktop app", async () => {
    const f = await fixture();
    const status = await f.app.inject({ url: "/api/system/backups", headers: auth(f.token) });
    expect(status.json()).toMatchObject({ restoreBlockedReason: null });
    const res = await upload(f, await exported(f));
    expect(res.statusCode).toBe(200);
    const preview = res.json<RestorePreview>();
    expect(preview).toMatchObject({ source: "file", label: "Café backup.db", restaurantName: "Backup Cafe", bills: 0, orders: 0, lastBillAt: null });
    expect(f.sent).toEqual([]);
    const confirm = await f.app.inject({ method: "POST", url: "/api/system/restore/confirm", headers: auth(f.token), payload: { token: preview.token } });
    expect(confirm.statusCode).toBe(202);
    expect(f.sent).toHaveLength(1);
    const message = f.sent[0] as { type: string; path: string };
    expect(message.type).toBe("restore");
    expect(message.path.startsWith(join(f.folder, "restore-incoming"))).toBe(true);
    expect(verifyBackup(message.path)).toBe(MIGRATIONS.length);
    // The live database is untouched until the desktop app restarts the server with the staged file.
    expect(f.db.prepare("SELECT restaurant_name FROM settings").get()).toEqual({ restaurant_name: "Cafe Test" });
  });

  it("rejects files that are not ForkFlow backups and keeps nothing staged", async () => {
    const f = await fixture();
    const res = await upload(f, Buffer.from("not a database at all, just some text".repeat(50)));
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("This file is not a ForkFlow backup.");
    expect(existsSync(join(f.folder, "restore-incoming"))).toBe(true);
    expect(readFileSync(join(f.folder, "forkflow.db")).length).toBeGreaterThan(0);
    const confirm = await f.app.inject({ method: "POST", url: "/api/system/restore/confirm", headers: auth(f.token), payload: { token: "00000000-0000-0000-0000-000000000000" } });
    expect(confirm.statusCode).toBe(404);
    expect(f.sent).toEqual([]);
  });

  it("refuses a stale preview after another backup is staged or the preview is cancelled", async () => {
    const f = await fixture();
    const file = await exported(f);
    const first = (await upload(f, file)).json<RestorePreview>();
    const second = (await upload(f, file)).json<RestorePreview>();
    expect((await f.app.inject({ method: "POST", url: "/api/system/restore/confirm", headers: auth(f.token), payload: { token: first.token } })).statusCode).toBe(404);
    expect((await f.app.inject({ method: "POST", url: "/api/system/restore/cancel", headers: auth(f.token) })).statusCode).toBe(204);
    expect((await f.app.inject({ method: "POST", url: "/api/system/restore/confirm", headers: auth(f.token), payload: { token: second.token } })).statusCode).toBe(404);
    expect(f.sent).toEqual([]);
  });

  it("restores one of this PC's snapshots by name only", async () => {
    const f = await fixture();
    const { name } = f.backups.create("manual");
    const res = await f.app.inject({ method: "POST", url: "/api/system/restore/local", headers: auth(f.token), payload: { name } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ source: "local", label: name, takenAt: expect.any(Number) });
    expect((await f.app.inject({ method: "POST", url: "/api/system/restore/local", headers: auth(f.token), payload: { name: "../forkflow.db" } })).statusCode).toBe(404);
  });

  it("allows restore only from the main PC's desktop app", async () => {
    const f = await fixture();
    const file = await exported(f);
    const status = await f.app.inject({ url: "/api/system/backups", headers: auth(f.token), ...LAN });
    expect(status.json().restoreBlockedReason).toMatch(/main POS PC/);
    expect((await upload(f, file, LAN)).statusCode).toBe(409);
    const preview = (await upload(f, file)).json<RestorePreview>();
    expect((await f.app.inject({ method: "POST", url: "/api/system/restore/confirm", headers: auth(f.token), payload: { token: preview.token }, ...LAN })).statusCode).toBe(409);
    expect(f.sent).toEqual([]);

    const standalone = await fixture({ desktop: false });
    expect((await standalone.app.inject({ url: "/api/system/backups", headers: auth(standalone.token) })).json().restoreBlockedReason).toMatch(/desktop app/);
    expect((await upload(standalone, file)).statusCode).toBe(409);
  });

  it("does not accept an upload from a non-admin", async () => {
    const f = await fixture();
    const cashier = await createUser(f.app, f.token, { name: "Cash", role: "cashier", pin: "5678" });
    const res = await f.app.inject({ method: "POST", url: "/api/system/restore/file", payload: Buffer.from("x"), headers: { ...auth(cashier.token), "content-type": "application/octet-stream" } });
    expect(res.statusCode).toBe(403);
  });
});

describe("shared retention", () => {
  const day = 86400000, now = 400 * day;
  const name = (kind: string, at: number, n = 0) => `forkflow-${kind}-${String(at).padStart(13, "0")}-0000000${n}-0000-0000-0000-000000000000.db`;
  it("keeps the newest daily, dailies within the window and 10 of each other kind; ignores foreign files", () => {
    const entries = [
      ...[1, 5, 40, 60].map((age, i) => ({ name: name("daily", now - age * day, i) })),
      ...Array.from({ length: 12 }, (_, i) => ({ name: name("manual", now - i * day, i % 10) })),
      { name: "holiday-photo.jpg" },
    ];
    const expired = expiredBackups(entries, 30, now).map((e) => e.name).sort();
    expect(expired).toEqual([name("daily", now - 40 * day, 2), name("daily", now - 60 * day, 3), name("manual", now - 10 * day, 0), name("manual", now - 11 * day, 1)].sort());
    expect(expiredBackups([{ name: name("daily", now - 90 * day) }], 30, now)).toEqual([]);
  });
});

describe("Google Drive connect and restore routes", () => {
  it("starts sign-in and restores a Drive backup only from the main PC", async () => {
    const folder = mkdtempSync(join(tmpdir(), "forkflow-restore-test-"));
    const db = openDb(join(folder, "forkflow.db")); migrate(db, MIGRATIONS);
    const backups = new Backups(db, folder);
    let source = "";
    const sent: ToDesktop[] = [];
    const account = { id: "a", email: "owner@example.com" };
    const provider = {
      connection: () => ({ state: "connected" as const, account }),
      upload: async () => ({ remoteId: "r" }), prune: async () => {}, disconnect: async () => {},
      beginConnect: async () => ({ authUrl: "https://accounts.google.com/o/oauth2/v2/auth?x=1" }),
      list: async () => [{ id: "drive-1", name: "forkflow-daily-1761868800000-00000000-0000-0000-0000-000000000000.db", kind: "daily" as const, createdAt: 1761868800000, bytes: 1, restaurantName: "Cafe Test", thisPc: false }],
      download: async (_id: string, target: string) => { copyFileSync(source, target); return { name: "forkflow-daily-1761868800000-00000000-0000-0000-0000-000000000000.db" }; },
    };
    const app = buildServer({ db, backups, cloudBackupProvider: provider, updateBridge: { send: (m) => { if (m.type === "restore") sent.push(m); }, onMessage: () => {} } });
    cleanup.push({ folder, db, app });
    const { token } = await setupAdmin(app);
    source = join(backups.folder, backups.create("manual").name);
    expect((await app.inject({ method: "POST", url: "/api/system/cloud-backups/connect", headers: auth(token), ...LAN })).statusCode).toBe(409);
    expect((await app.inject({ method: "POST", url: "/api/system/cloud-backups/connect", headers: auth(token) })).json()).toEqual({ authUrl: expect.stringMatching(/^https:\/\/accounts\.google\.com\//) });
    expect((await app.inject({ url: "/api/system/cloud-backups", headers: auth(token) })).json()).toMatchObject({ state: "connected", onMainPc: true, connecting: false });
    expect((await app.inject({ url: "/api/system/cloud-backups", headers: auth(token), ...LAN })).json()).toMatchObject({ onMainPc: false });
    expect((await app.inject({ url: "/api/system/cloud-backups/files", headers: auth(token) })).json().files).toHaveLength(1);
    expect((await app.inject({ method: "POST", url: "/api/system/cloud-backups/restore", headers: auth(token), payload: { id: "drive-1" }, ...LAN })).statusCode).toBe(409);
    const preview = await app.inject({ method: "POST", url: "/api/system/cloud-backups/restore", headers: auth(token), payload: { id: "drive-1" } });
    expect(preview.json()).toMatchObject({ source: "drive", restaurantName: "Cafe Test", takenAt: 1761868800000 });
    await app.inject({ method: "POST", url: "/api/system/restore/confirm", headers: auth(token), payload: { token: preview.json().token } });
    expect(sent).toHaveLength(1);
  });
});
