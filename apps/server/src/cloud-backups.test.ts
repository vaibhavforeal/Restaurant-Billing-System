import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { MIGRATIONS, migrate, openDb, type Database } from "@forkflow/domain";
import { Backups, verifyBackup } from "./backups.js";
import { CloudBackups, type CloudBackupConnection, type CloudBackupProvider } from "./cloud-backups.js";
import { buildServer } from "./server.js";
import { auth, createUser, setupAdmin } from "./test-helpers.js";
import type { FastifyInstance } from "fastify";

const resources: Array<{ folder: string; db: Database; workers: CloudBackups[]; app?: FastifyInstance }> = [];
function provider() {
  let connection: CloudBackupConnection = { state: "connected", account: { id: "account-a", email: "owner@example.com" } };
  return {
    connection: () => connection,
    setConnection(value: CloudBackupConnection) { connection = value; },
    upload: vi.fn<CloudBackupProvider["upload"]>(async () => ({ remoteId: "drive-file" })),
    prune: vi.fn<CloudBackupProvider["prune"]>(async () => {}),
    disconnect: vi.fn(async () => { connection = { state: "not_connected", account: null }; }),
  };
}
function fixture(adapter?: CloudBackupProvider) {
  const folder = mkdtempSync(join(tmpdir(), "forkflow-cloud-test-"));
  const db = openDb(join(folder, "forkflow.db")); migrate(db, MIGRATIONS);
  let now = Date.now();
  const backups = new Backups(db, folder, () => now++);
  const worker = new CloudBackups(backups, adapter, () => now);
  const resource = { folder, db, workers: [worker] };
  resources.push(resource);
  return { ...resource, resource, backups, worker, advance(ms: number) { now += ms; }, now: () => now };
}
afterEach(async () => {
  for (const resource of resources.splice(0)) {
    await resource.app?.close();
    for (const worker of resource.workers) await worker.close();
    if (resource.db.open) resource.db.close();
    if (!resolve(resource.folder).startsWith(resolve(tmpdir()) + "\\") && !resolve(resource.folder).startsWith(resolve(tmpdir()) + "/")) throw new Error("Unsafe test cleanup");
    rmSync(resource.folder, { recursive: true, force: true });
  }
});

describe("cloud backup readiness", () => {
  it("saves preferences without a provider and never invents an account or upload", async () => {
    const f = fixture();
    f.worker.configure({ automatic: false, folderName: "Cafe Backups", retentionDays: 90 });
    expect(f.worker.status()).toMatchObject({ state: "not_configured", account: null, pendingCount: 0, lastUploadedAt: null });
    expect(() => f.worker.uploadNow()).toThrow("not configured");
    expect(() => f.worker.retry()).toThrow("not configured");
    expect(f.backups.list()).toHaveLength(0);
    f.backups.create("manual"); await f.worker.process();
    expect(f.worker.status().queue).toEqual([]);
    const reloaded = new CloudBackups(f.backups); f.workers.push(reloaded);
    expect(reloaded.status()).toMatchObject({ automatic: false, folderName: "Cafe Backups", retentionDays: 90 });
  });
  it("rejects credentials, invalid names, and unsafe retention in ordinary preferences", () => {
    const f = fixture();
    for (const input of [{ folderName: "../private" }, { retentionDays: 1 }, { refreshToken: "secret" }]) {
      expect(() => f.worker.configure(input)).toThrow();
    }
    expect(existsSync(join(f.folder, "cloud-backup-settings.json"))).toBe(false);
  });
  it("recovers from a failed progress save once storage works again", async () => {
    const adapter = provider(); const f = fixture(adapter);
    const statePath = join(f.folder, "cloud-backup-state.json");
    mkdirSync(statePath); // makes the state file unwritable, like a full disk
    f.backups.create("manual");
    expect(f.worker.status().lastError).toContain("could not be queued");
    expect(adapter.upload).not.toHaveBeenCalled();
    rmSync(statePath, { recursive: true });
    await f.worker.process();
    expect(adapter.upload).toHaveBeenCalledTimes(1);
    expect(f.worker.status()).toMatchObject({ lastError: null, pendingCount: 0 });
    expect(() => f.worker.configure({})).not.toThrow();
  });

  it("keeps local backups available when cloud metadata is damaged", () => {
    const f = fixture();
    writeFileSync(join(f.folder, "cloud-backup-state.json"), "broken");
    const worker = new CloudBackups(f.backups, provider()); f.workers.push(worker);
    expect(worker.status().lastError).toContain("could not be read");
    expect(() => worker.configure({})).toThrow("could not be read");
    expect(f.backups.create("manual").name).toBeTruthy();
    expect(readFileSync(join(f.folder, "cloud-backup-state.json"), "utf8")).toBe("broken");
  });
});

describe("verified cloud upload queue", () => {
  it("uploads only verified snapshots with checksums and records remote confirmation", async () => {
    const adapter = provider(), f = fixture(adapter);
    const snapshot = f.backups.create("daily");
    await f.worker.process();
    expect(adapter.upload).toHaveBeenCalledTimes(1);
    const input = adapter.upload.mock.calls[0]![0];
    expect(verifyBackup(input.path)).toBe(MIGRATIONS.length);
    expect(input.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(input.idempotencyKey).toBe(snapshot.name);
    expect(input.folderName).toBe("ForkFlow Backups");
    expect(f.worker.status()).toMatchObject({ pendingCount: 0, lastUploadedName: snapshot.name, lastError: null });
    expect(adapter.prune).toHaveBeenCalledWith(expect.objectContaining({ retentionDays: 30, account: input.account }));
    await f.worker.process(); expect(adapter.upload).toHaveBeenCalledTimes(1);
  });
  it("persists failed uploads, uses backoff, and resumes the same file after restart", async () => {
    const adapter = provider(), f = fixture(adapter);
    adapter.upload.mockRejectedValueOnce(new Error("access_token=secret"));
    const snapshot = f.backups.create("manual");
    await f.worker.process();
    expect(f.worker.status()).toMatchObject({ pendingCount: 1, lastUploadedAt: null });
    expect(f.worker.status().queue[0]).toMatchObject({ name: snapshot.name, attempts: 1 });
    expect(readFileSync(join(f.folder, "cloud-backup-state.json"), "utf8")).not.toContain("secret");
    expect(existsSync(join(f.backups.folder, snapshot.name))).toBe(true);
    await f.worker.process(); expect(adapter.upload).toHaveBeenCalledTimes(1);
    await f.worker.close();
    const resumed = new CloudBackups(f.backups, adapter, f.now); f.workers.push(resumed);
    await resumed.process(); expect(adapter.upload).toHaveBeenCalledTimes(1);
    f.advance(60_000); await resumed.process();
    expect(adapter.upload).toHaveBeenCalledTimes(2);
    expect(adapter.upload.mock.calls[1]![0].idempotencyKey).toBe(snapshot.name);
    expect(resumed.status().lastUploadedName).toBe(snapshot.name);
  });
  it("recovers missed backup events and preserves in-flight files across local retention", async () => {
    const adapter = provider(), f = fixture(adapter);
    adapter.upload.mockRejectedValue(new Error("offline"));
    f.backups.configure({ retentionDays: 7 });
    const old = f.backups.create("daily"); await f.worker.process();
    f.advance(8 * 86400000);
    f.backups.create("daily"); await f.worker.process();
    expect(existsSync(join(f.backups.folder, old.name))).toBe(true);
    await f.worker.close();
    const missed = f.backups.create("pre-update");
    adapter.upload.mockResolvedValue({ remoteId: "confirmed" });
    const resumed = new CloudBackups(f.backups, adapter, f.now); f.workers.push(resumed);
    resumed.retry(); await resumed.process();
    expect(adapter.upload.mock.calls.some(([input]) => input.name === missed.name)).toBe(true);
    expect(resumed.status().pendingCount).toBe(0);
    f.backups.create("daily"); await resumed.process();
    expect(existsSync(join(f.backups.folder, old.name))).toBe(false);
  });
  it("keeps automatic uploads off but permits an explicit cloud backup", async () => {
    const adapter = provider(), f = fixture(adapter);
    f.worker.configure({ automatic: false });
    f.backups.create("daily"); await f.worker.process();
    expect(adapter.upload).not.toHaveBeenCalled();
    f.worker.uploadNow(); await f.worker.process();
    expect(adapter.upload).toHaveBeenCalledTimes(1);
    expect(f.worker.status()).toMatchObject({ pendingCount: 0, state: "connected" });
  });
  it("does not re-upload a confirmed backup when cloud retention fails", async () => {
    const adapter = provider(), f = fixture(adapter);
    adapter.prune.mockRejectedValueOnce(new Error("remote failure"));
    f.backups.create("manual"); await f.worker.process();
    expect(f.worker.status()).toMatchObject({ pendingCount: 0, lastError: expect.stringContaining("uploaded; cleanup") });
    await f.worker.process(); expect(adapter.upload).toHaveBeenCalledTimes(1);
  });
  it("serializes uploads and cancels in-flight work on disconnect without deleting snapshots", async () => {
    const adapter = provider(), f = fixture(adapter);
    adapter.upload.mockImplementation(async ({ signal }) => new Promise((_, reject) => {
      signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }));
    const snapshot = f.backups.create("manual");
    const active = f.worker.process();
    expect(f.worker.process()).toBe(active);
    await vi.waitFor(() => expect(adapter.upload).toHaveBeenCalledTimes(1));
    await f.worker.disconnect();
    expect(f.worker.status()).toMatchObject({ state: "not_connected", pendingCount: 0, lastUploadedAt: null });
    expect(existsSync(join(f.backups.folder, snapshot.name))).toBe(true);
  });
  it("does not send old account queue entries to a newly connected account", async () => {
    const adapter = provider(), f = fixture(adapter);
    f.worker.configure({ automatic: false });
    adapter.upload.mockRejectedValueOnce(new Error("offline"));
    f.worker.uploadNow(); await f.worker.process();
    adapter.setConnection({ state: "connected", account: { id: "account-b", email: "other@example.com" } });
    f.advance(60_000); await f.worker.process();
    expect(adapter.upload).toHaveBeenCalledTimes(1);
    expect(f.worker.status()).toMatchObject({ pendingCount: 0, state: "reconnect_required" });
  });
  it("refuses damaged snapshots before invoking a provider", async () => {
    const adapter = provider(), f = fixture(adapter);
    const { name } = f.backups.create("manual");
    writeFileSync(join(f.backups.folder, name), "damaged snapshot");
    await f.worker.process();
    expect(adapter.upload).not.toHaveBeenCalled();
    expect(f.worker.status()).toMatchObject({ pendingCount: 1, lastUploadedAt: null });
  });
  it("handles disconnect before a queued worker starts without damaging cloud metadata", async () => {
    const adapter = provider(), f = fixture(adapter);
    f.backups.create("manual");
    await f.worker.disconnect();
    expect(adapter.upload).not.toHaveBeenCalled();
    expect(f.worker.status()).toMatchObject({ state: "not_connected", pendingCount: 0, lastError: null });
    expect(() => f.worker.configure({ automatic: false })).not.toThrow();
  });
});

it("wires an injected provider through the cloud upload API and returns confirmed status", async () => {
  const adapter = provider(), f = fixture();
  const app = buildServer({ db: f.db, backups: f.backups, cloudBackupProvider: adapter });
  Object.assign(f.resource, { app });
  const { token } = await setupAdmin(app);
  const result = await app.inject({ method: "POST", url: "/api/system/cloud-backups/upload", headers: auth(token) });
  expect(result.statusCode).toBe(202);
  expect(result.json().state).toBe("connected");
  await vi.waitFor(() => expect(adapter.upload).toHaveBeenCalledTimes(1));
  await vi.waitFor(async () => {
    const status = await app.inject({ url: "/api/system/cloud-backups", headers: auth(token) });
    expect(status.json()).toMatchObject({ pendingCount: 0, lastUploadedName: adapter.upload.mock.calls[0]![0].name });
  });
});

it("enforces admin permissions and unavailable-provider responses at every cloud API", async () => {
  const f = fixture();
  const app = buildServer({ db: f.db, backups: f.backups });
  Object.assign(f.resource, { app });
  const { token } = await setupAdmin(app);
  const cashier = await createUser(app, token, { name: "Cashier", pin: "2345", role: "cashier" });
  const endpoints = [
    ["GET", "/api/system/cloud-backups"], ["PUT", "/api/system/cloud-backups"],
    ...["upload", "retry", "disconnect"].map((name) => ["POST", `/api/system/cloud-backups/${name}`]),
  ] as Array<["GET" | "PUT" | "POST", string]>;
  for (const [method, url] of endpoints) {
    expect((await app.inject({ method, url })).statusCode).toBe(401);
    expect((await app.inject({ method, url, headers: auth(cashier.token), ...(method === "PUT" ? { payload: {} } : {}) })).statusCode).toBe(403);
  }
  const status = await app.inject({ url: "/api/system/cloud-backups", headers: auth(token) });
  expect(status.headers["cache-control"]).toBe("no-store");
  expect(status.json()).toMatchObject({ state: "not_configured", account: null });
  expect((await app.inject({ method: "PUT", url: "/api/system/cloud-backups", headers: auth(token), payload: { folderName: "Cafe Cloud", retentionDays: 45 } })).statusCode).toBe(200);
  for (const action of ["upload", "retry", "disconnect"]) {
    const response = await app.inject({ method: "POST", url: `/api/system/cloud-backups/${action}`, headers: auth(token) });
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toContain("not configured");
  }
  expect(f.backups.list()).toHaveLength(0);
  expect((await app.inject({ method: "POST", url: "/api/system/backups", headers: auth(token) })).statusCode).toBe(200);
  expect(f.backups.list()).toHaveLength(1);
});
