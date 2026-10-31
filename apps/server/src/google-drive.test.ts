import { afterEach, describe, expect, it } from "vitest";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DRIVE_SCOPE, GoogleDriveProvider } from "./google-drive.js";

interface FakeFile { id: string; name: string; mimeType: string; parents: string[]; appProperties: Record<string, string>; trashed: boolean; data: Buffer; createdTime: number }

/** In-memory stand-in for Google's OAuth and Drive v3 endpoints used by the provider. */
function fakeGoogle(options: { scope?: string; refreshToken?: string | null; sub?: string } = {}) {
  const files = new Map<string, FakeFile>();
  const sessions = new Map<string, { meta: Partial<FakeFile>; size: number; received: Buffer }>();
  const calls: string[] = [];
  let refreshFails = false, corruptNextUpload = false, corruptDownload = false, clock = 0;
  const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
  const md5 = (data: Buffer) => createHash("md5").update(data).digest("hex");
  const view = (file: FakeFile) => ({ id: file.id, name: file.name, size: String(file.data.length), md5Checksum: md5(file.data), trashed: file.trashed, appProperties: file.appProperties });
  function matches(file: FakeFile, q: string) {
    if (/trashed = false/.test(q) && file.trashed) return false;
    const mime = /mimeType = '([^']+)'/.exec(q); if (mime && file.mimeType !== mime[1]) return false;
    for (const [, key, value] of q.matchAll(/appProperties has \{ key='([^']+)' and value='([^']*)' \}/g)) if (file.appProperties[key!] !== value) return false;
    return true;
  }
  const fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? "GET";
    calls.push(`${method} ${url.origin}${url.pathname}`);
    const authorized = new Headers(init.headers).get("authorization") === "Bearer access-1";
    if (url.href.startsWith("https://oauth2.googleapis.com/token")) {
      const body = new URLSearchParams(String(init.body));
      if (body.get("grant_type") === "refresh_token") return refreshFails ? json({ error: "invalid_grant" }, 400) : json({ access_token: "access-1", expires_in: 3600 });
      if (body.get("code") !== "good-code" || !body.get("code_verifier")) return json({ error: "invalid_grant" }, 400);
      return json({ access_token: "access-1", expires_in: 3600, scope: options.scope ?? `openid email ${DRIVE_SCOPE}`, ...(options.refreshToken === null ? {} : { refresh_token: options.refreshToken ?? "refresh-1" }) });
    }
    if (url.href.startsWith("https://oauth2.googleapis.com/revoke")) return new Response(null, { status: 200 });
    if (url.href.startsWith("https://openidconnect.googleapis.com/")) return json({ sub: options.sub ?? "google-user-1", email: "owner@example.com" });
    if (url.hostname === "upload.fake") {
      const session = sessions.get(url.pathname)!;
      const [, start, end, total] = /bytes (\d+)-(\d+)\/(\d+)/.exec(new Headers(init.headers).get("content-range")!)!.map(Number) as [number, number, number, number];
      expect(start).toBe(session.received.length);
      session.received = Buffer.concat([session.received, Buffer.from(init.body as Uint8Array)]);
      expect(session.received.length).toBe(end + 1);
      if (session.received.length < total) return new Response(null, { status: 308, headers: { range: `bytes=0-${end}` } });
      const data = corruptNextUpload ? Buffer.concat([session.received, Buffer.from("x")]) : session.received;
      corruptNextUpload = false;
      const file: FakeFile = { id: randomUUID(), name: session.meta.name!, mimeType: session.meta.mimeType!, parents: session.meta.parents ?? [], appProperties: session.meta.appProperties ?? {}, trashed: false, data, createdTime: clock++ };
      files.set(file.id, file);
      return json(view(file), 200);
    }
    if (!authorized) return json({ error: "unauthorized" }, 401);
    if (url.pathname === "/upload/drive/v3/files" && method === "POST") {
      const id = `/session/${randomUUID()}`;
      sessions.set(id, { meta: JSON.parse(String(init.body)), size: Number(new Headers(init.headers).get("x-upload-content-length")), received: Buffer.alloc(0) });
      return new Response(null, { status: 200, headers: { location: `https://upload.fake${id}` } });
    }
    if (url.pathname === "/drive/v3/files" && method === "GET") {
      const q = url.searchParams.get("q")!;
      const found = [...files.values()].filter((file) => matches(file, q)).sort((a, b) => b.createdTime - a.createdTime);
      return json({ files: found.slice(0, Number(url.searchParams.get("pageSize"))).map(view) });
    }
    if (url.pathname === "/drive/v3/files" && method === "POST") {
      const meta = JSON.parse(String(init.body));
      const file: FakeFile = { id: randomUUID(), name: meta.name, mimeType: meta.mimeType, parents: [], appProperties: meta.appProperties ?? {}, trashed: false, data: Buffer.alloc(0), createdTime: clock++ };
      files.set(file.id, file);
      return json(view(file));
    }
    const file = files.get(decodeURIComponent(url.pathname.split("/").at(-1)!));
    if (!file) return json({ error: "notFound" }, 404);
    if (method === "PATCH") { Object.assign(file, JSON.parse(String(init.body))); return json(view(file)); }
    if (url.searchParams.get("alt") === "media") return new Response(corruptDownload ? Buffer.concat([file.data, Buffer.from("!")]) : file.data, { status: 200 });
    return json(view(file));
  }) as typeof globalThis.fetch;
  return { fetch, files, calls,
    failRefresh() { refreshFails = true; }, corruptNextUpload() { corruptNextUpload = true; }, corruptDownload() { corruptDownload = true; },
    put(name: string, appProperties: Record<string, string>) {
      const file: FakeFile = { id: randomUUID(), name, mimeType: "application/x-sqlite3", parents: [], appProperties, trashed: false, data: Buffer.from("x"), createdTime: clock++ };
      files.set(file.id, file); return file;
    } };
}

const folders: string[] = [];
const providers: GoogleDriveProvider[] = [];
afterEach(async () => {
  for (const provider of providers.splice(0)) await provider.disconnect().catch(() => {});
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

function setup(google = fakeGoogle(), key: Buffer = randomBytes(32), dataDir?: string) {
  const folder = dataDir ?? mkdtempSync(join(tmpdir(), "forkflow-drive-test-"));
  if (!dataDir) folders.push(folder);
  let now = Date.UTC(2026, 9, 31);
  const provider = new GoogleDriveProvider({ clientId: "client.apps.googleusercontent.com", clientSecret: "desktop-secret", dataDir: folder, secretKey: key,
    restaurantName: () => "Spice Garden", fetch: google.fetch, now: () => now });
  providers.push(provider);
  return { folder, provider, google, key, advance(ms: number) { now += ms; } };
}

/** Run the real loopback redirect the system browser would follow. */
async function signIn(provider: GoogleDriveProvider, params: Record<string, string> = { code: "good-code" }) {
  const { authUrl } = await provider.beginConnect();
  const auth = new URL(authUrl);
  expect(auth.searchParams.get("code_challenge_method")).toBe("S256");
  expect(auth.searchParams.get("scope")).toBe(`openid email ${DRIVE_SCOPE}`);
  const redirect = new URL(auth.searchParams.get("redirect_uri")!);
  expect(redirect.hostname).toBe("127.0.0.1");
  for (const [key, value] of Object.entries({ state: auth.searchParams.get("state")!, ...params })) redirect.searchParams.set(key, value);
  const res = await fetch(redirect);
  return { res, html: await res.text(), redirect };
}
const account = { id: "google-user-1", email: "owner@example.com" };
const snapshotName = (kind: string, at: number) => `forkflow-${kind}-${at}-${randomUUID()}.db`;
function snapshot(folder: string, name: string, bytes = 4096) {
  const path = join(folder, name);
  writeFileSync(path, randomBytes(bytes));
  return { path, name, sha256: createHash("sha256").update(readFileSync(path)).digest("hex") };
}
const signal = () => AbortSignal.timeout(10_000);

describe("Google sign-in", () => {
  it("connects through the loopback redirect with PKCE and seals the refresh token", async () => {
    const { provider, folder } = setup();
    expect(provider.connection()).toMatchObject({ state: "not_connected", account: null });
    const { res, html } = await signIn(provider);
    expect(res.status).toBe(200);
    expect(html).toContain("owner@example.com");
    expect(provider.connection()).toMatchObject({ state: "connected", account, connecting: false });
    const stored = readFileSync(join(folder, "google-drive.json"), "utf8");
    expect(stored).not.toContain("refresh-1");
    expect(JSON.parse(stored).refreshToken).toMatch(/^v1\./);
  });

  it("ignores a forged state and accepts the genuine redirect afterwards", async () => {
    const { provider } = setup();
    const { authUrl } = await provider.beginConnect();
    const auth = new URL(authUrl);
    const redirect = new URL(auth.searchParams.get("redirect_uri")!);
    redirect.searchParams.set("code", "good-code");
    redirect.searchParams.set("state", "forged");
    expect((await fetch(redirect)).status).toBe(400);
    expect(provider.connection()).toMatchObject({ state: "not_connected", connecting: true });
    redirect.searchParams.set("state", auth.searchParams.get("state")!);
    expect((await fetch(redirect)).status).toBe(200);
    expect(provider.connection().state).toBe("connected");
  });

  it("reports a cancelled sign-in and a missing Drive permission", async () => {
    const cancelled = setup();
    await signIn(cancelled.provider, { error: "access_denied" });
    expect(cancelled.provider.connection()).toMatchObject({ state: "not_connected", connecting: false, message: "Google sign-in was cancelled." });
    const noDrive = setup(fakeGoogle({ scope: "openid email" }));
    const { res } = await signIn(noDrive.provider);
    expect(res.status).toBe(400);
    expect(noDrive.provider.connection()).toMatchObject({ state: "not_connected", message: expect.stringMatching(/permission to save its backups/) });
    expect(noDrive.google.calls).toContain("POST https://oauth2.googleapis.com/revoke");
  });

  it("refuses to silently switch to a different Google account", async () => {
    const first = setup();
    await signIn(first.provider);
    const other = setup(fakeGoogle({ sub: "someone-else" }), first.key, first.folder);
    await signIn(other.provider);
    expect(other.provider.connection()).toMatchObject({ state: "connected", account, message: expect.stringMatching(/Disconnect Google Drive/) });
  });

  it("needs a new sign-in when the grant is revoked or the token was sealed on another PC", async () => {
    const { provider, folder, google } = setup();
    await signIn(provider);
    const moved = setup(google, randomBytes(32), folder);
    expect(moved.provider.connection()).toMatchObject({ state: "reconnect_required", account });

    const reloaded = setup(google, readKey(provider), folder);
    expect(reloaded.provider.connection().state).toBe("connected");
    google.failRefresh();
    await expect(reloaded.provider.list(signal())).rejects.toThrow();
    expect(reloaded.provider.connection().state).toBe("reconnect_required");
  });

  it("disconnect forgets the credential and revokes it", async () => {
    const { provider, folder, google } = setup();
    await signIn(provider);
    await provider.disconnect();
    expect(provider.connection()).toMatchObject({ state: "not_connected", account: null });
    expect(JSON.parse(readFileSync(join(folder, "google-drive.json"), "utf8"))).toMatchObject({ account: null, refreshToken: null });
    expect(google.calls).toContain("POST https://oauth2.googleapis.com/revoke");
  });
});
// The key is private to the provider; tests reuse the one passed to setup().
function readKey(provider: GoogleDriveProvider): Buffer { return (provider as unknown as { options: { secretKey: Buffer } }).options.secretKey; }

describe("Drive backups", () => {
  it("uploads in resumable chunks into one app folder and verifies the stored checksum", async () => {
    const { provider, folder, google } = setup();
    await signIn(provider);
    const file = snapshot(folder, snapshotName("daily", Date.UTC(2026, 9, 30)), 9 * 1024 * 1024 + 123);
    const { remoteId } = await provider.upload({ ...file, idempotencyKey: file.name, account, folderName: "ForkFlow Backups", signal: signal() });
    const stored = google.files.get(remoteId)!;
    expect(stored.data.equals(readFileSync(file.path))).toBe(true);
    expect(stored.appProperties).toMatchObject({ forkflowRole: "backup", forkflowKey: file.name, sha256: file.sha256, forkflowRestaurant: "Spice Garden" });
    const folders = [...google.files.values()].filter((f) => f.mimeType === "application/vnd.google-apps.folder");
    expect(folders).toHaveLength(1);
    expect(stored.parents).toEqual([folders[0]!.id]);
    expect(google.calls.filter((call) => call.startsWith("PUT https://upload.fake"))).toHaveLength(2);

    // A retried upload after a lost response reuses the confirmed file instead of creating a duplicate.
    expect((await provider.upload({ ...file, idempotencyKey: file.name, account, folderName: "ForkFlow Backups", signal: signal() })).remoteId).toBe(remoteId);
    // A renamed preference renames the same folder.
    const second = snapshot(folder, snapshotName("manual", Date.UTC(2026, 9, 31)));
    await provider.upload({ ...second, idempotencyKey: second.name, account, folderName: "Spice Garden Backups", signal: signal() });
    expect([...google.files.values()].filter((f) => f.mimeType === "application/vnd.google-apps.folder").map((f) => f.name)).toEqual(["Spice Garden Backups"]);
  });

  it("rejects and removes an upload whose checksum does not match", async () => {
    const { provider, folder, google } = setup();
    await signIn(provider);
    const file = snapshot(folder, snapshotName("manual", Date.UTC(2026, 9, 30)));
    google.corruptNextUpload();
    await expect(provider.upload({ ...file, idempotencyKey: file.name, account, folderName: "ForkFlow Backups", signal: signal() })).rejects.toThrow(/did not match/);
    expect([...google.files.values()].filter((f) => f.appProperties["forkflowRole"] === "backup" && !f.trashed)).toEqual([]);
  });

  it("prunes only this installation's expired backups, to the trash", async () => {
    const { provider, folder, google } = setup();
    await signIn(provider);
    const installation = JSON.parse(readFileSync(join(folder, "google-drive.json"), "utf8")).installationId as string;
    const day = 86400000, now = Date.UTC(2026, 9, 31);
    const recent = google.put(snapshotName("daily", now - day), { forkflowRole: "backup", forkflowInstallation: installation });
    const old = google.put(snapshotName("daily", now - 60 * day), { forkflowRole: "backup", forkflowInstallation: installation });
    const otherPc = google.put(snapshotName("daily", now - 90 * day), { forkflowRole: "backup", forkflowInstallation: randomUUID() });
    const unrelated = google.put("tax-return.pdf", { forkflowInstallation: installation });
    await provider.prune({ account, retentionDays: 30, signal: signal() });
    expect([recent, old, otherPc, unrelated].map((f) => f.trashed)).toEqual([false, true, false, false]);
  });

  it("lists backups from every PC for restore and downloads with checksum verification", async () => {
    const { provider, folder, google } = setup();
    await signIn(provider);
    const file = snapshot(folder, snapshotName("manual", Date.UTC(2026, 9, 31)));
    const { remoteId } = await provider.upload({ ...file, idempotencyKey: file.name, account, folderName: "ForkFlow Backups", signal: signal() });
    google.put(snapshotName("daily", Date.UTC(2026, 9, 1)), { forkflowRole: "backup", forkflowInstallation: randomUUID(), forkflowRestaurant: "Old PC" });
    google.put("notes.txt", { forkflowRole: "backup" });
    const list = await provider.list(signal());
    expect(list.map(({ restaurantName, thisPc, kind }) => ({ restaurantName, thisPc, kind }))).toEqual([
      { restaurantName: "Spice Garden", thisPc: true, kind: "manual" }, { restaurantName: "Old PC", thisPc: false, kind: "daily" }]);

    const target = join(folder, "downloaded.db");
    expect(await provider.download(remoteId, target, signal())).toEqual({ name: file.name });
    expect(readFileSync(target).equals(readFileSync(file.path))).toBe(true);
    google.corruptDownload();
    await expect(provider.download(remoteId, join(folder, "bad.db"), signal())).rejects.toThrow(/did not match/);
    const folderId = [...google.files.values()].find((f) => f.mimeType === "application/vnd.google-apps.folder")!.id;
    await expect(provider.download(folderId, join(folder, "folder.db"), signal())).rejects.toThrow(/not found/);
  });
});
