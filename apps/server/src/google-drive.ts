import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { closeSync, createReadStream, createWriteStream, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { z } from "zod";
import type { CloudBackupAccount, CloudBackupFile } from "@forkflow/domain";
import { atomicJson, expiredBackups, parseBackupName } from "./backups.js";
import type { CloudBackupConnection, CloudBackupProvider } from "./cloud-backups.js";

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo";
const DRIVE = "https://www.googleapis.com/drive/v3/files";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3/files";
/** Only files ForkFlow itself creates: no access to the restaurant's other Drive files. */
export const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";
const FOLDER_MIME = "application/vnd.google-apps.folder";
const BACKUP_MIME = "application/x-sqlite3";
/** Resumable upload chunk; Google requires a multiple of 256 KiB. */
const CHUNK_BYTES = 8 * 1024 * 1024;
const SIGN_IN_WINDOW_MS = 10 * 60_000;

export interface GoogleDriveOptions {
  clientId: string;
  clientSecret: string;
  dataDir: string;
  /** 32-byte key from the desktop shell (Windows-protected). Seals the refresh token at rest. */
  secretKey: Buffer;
  restaurantName: () => string;
  fetch?: typeof fetch;
  now?: () => number;
}

const storedState = z.object({
  version: z.literal(1),
  /** Identifies this POS installation's backups so retention never touches another PC's files. */
  installationId: z.string().uuid(),
  account: z.object({ id: z.string(), email: z.string() }).nullable(),
  refreshToken: z.string().nullable(),
  folderId: z.string().nullable(),
  folderName: z.string().nullable(),
  reconnect: z.boolean(),
});
type StoredState = z.infer<typeof storedState>;
interface DriveFile { id: string; name: string; size?: string; md5Checksum?: string; trashed?: boolean; appProperties?: Record<string, string> }

class DriveError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

const base64url = (bytes: Buffer) => bytes.toString("base64url");
/** Drive query string literal. */
const literal = (value: string) => `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
/** appProperties allow 124 bytes per key + value; keep whole UTF-8 characters. */
function truncateBytes(text: string, max: number) {
  let out = "";
  for (const char of text) { if (Buffer.byteLength(out + char) > max) break; out += char; }
  return out;
}

export class GoogleDriveProvider implements CloudBackupProvider {
  private state: StoredState;
  private refreshToken: string | null = null;
  private access: { token: string; expiresAt: number } | null = null;
  private refreshing: Promise<string> | null = null;
  private signIn: { close: () => void } | null = null;
  private signInMessage: string | null = null;
  private readonly path: string;
  private readonly fetch: typeof fetch;
  private readonly now: () => number;

  constructor(private readonly options: GoogleDriveOptions) {
    if (options.secretKey.length !== 32) throw new Error("Google Drive secret key must be 32 bytes");
    this.path = join(options.dataDir, "google-drive.json");
    this.fetch = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
    this.state = existsSync(this.path) ? storedState.parse(JSON.parse(readFileSync(this.path, "utf8")))
      : { version: 1, installationId: randomUUID(), account: null, refreshToken: null, folderId: null, folderName: null, reconnect: false };
    if (this.state.refreshToken) {
      // A token sealed on another PC or Windows account cannot be opened here: ask for a fresh sign-in.
      try { this.refreshToken = this.unseal(this.state.refreshToken); } catch { this.refreshToken = null; }
    }
    if (!existsSync(this.path)) this.save();
  }

  connection(): CloudBackupConnection {
    const connecting = !!this.signIn;
    const message = this.signInMessage;
    if (!this.state.account) return { state: "not_connected", account: null, connecting, message };
    if (this.state.reconnect || !this.refreshToken) return { state: "reconnect_required", account: this.state.account, connecting, message };
    return { state: "connected", account: this.state.account, connecting, message };
  }

  /**
   * Desktop OAuth with PKCE: Google redirects the system browser to a single-use listener on 127.0.0.1.
   * Returns the URL for the main PC's browser; completion is observed through `connection()`.
   */
  async beginConnect(): Promise<{ authUrl: string }> {
    this.signIn?.close();
    this.signInMessage = null;
    const verifier = base64url(randomBytes(32));
    const challenge = base64url(createHash("sha256").update(verifier).digest());
    const state = base64url(randomBytes(24));
    const server = createServer();
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const port = (server.address() as { port: number }).port;
    const redirectUri = `http://127.0.0.1:${port}/oauth2callback`;
    let done = false;
    const close = () => {
      clearTimeout(timer);
      server.close();
      server.closeAllConnections?.();
      if (this.signIn === handle) this.signIn = null;
    };
    const handle = { close };
    const timer = setTimeout(() => { if (!done) this.signInMessage = "Google sign-in timed out. Choose Connect Google Drive to try again."; close(); }, SIGN_IN_WINDOW_MS);
    timer.unref();
    server.on("request", (req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? "/", redirectUri);
      if (url.pathname !== "/oauth2callback" || done) { page(res, 404, "This page is not part of a ForkFlow sign-in."); return; }
      // A mismatched state is a stale or forged link: refuse it but keep waiting for the real redirect.
      if (url.searchParams.get("state") !== state) { page(res, 400, "This sign-in link is out of date. Start again from ForkFlow Settings."); return; }
      done = true;
      const error = url.searchParams.get("error");
      const code = url.searchParams.get("code");
      const finish = (status: number, text: string) => { page(res, status, text); setImmediate(close); };
      if (error || !code) {
        this.signInMessage = error === "access_denied" ? "Google sign-in was cancelled." : "Google sign-in did not complete. Try again.";
        finish(400, this.signInMessage);
        return;
      }
      this.completeSignIn(code, verifier, redirectUri).then(
        (account) => finish(200, `Google Drive (${account.email}) is now connected to ForkFlow. You can close this tab.`),
        (failure: unknown) => {
          this.signInMessage = failure instanceof DriveError || failure instanceof Error ? failure.message : "Google sign-in failed. Try again.";
          finish(400, this.signInMessage);
        });
    });
    this.signIn = handle;
    const params = new URLSearchParams({
      client_id: this.options.clientId, redirect_uri: redirectUri, response_type: "code",
      scope: `openid email ${DRIVE_SCOPE}`, code_challenge: challenge, code_challenge_method: "S256",
      state, access_type: "offline", prompt: "consent",
      ...(this.state.account ? { login_hint: this.state.account.email } : {}),
    });
    return { authUrl: `${AUTH_URL}?${params}` };
  }

  private async completeSignIn(code: string, verifier: string, redirectUri: string): Promise<CloudBackupAccount> {
    const res = await this.fetch(TOKEN_URL, { method: "POST", signal: AbortSignal.timeout(30_000), body: new URLSearchParams({
      code, code_verifier: verifier, redirect_uri: redirectUri, grant_type: "authorization_code",
      client_id: this.options.clientId, client_secret: this.options.clientSecret,
    }) });
    const token = await res.json().catch(() => ({})) as { access_token?: string; refresh_token?: string; expires_in?: number; scope?: string };
    if (!res.ok || !token.access_token) throw new Error("Google did not accept the sign-in. Try again.");
    const revoke = () => { void this.fetch(REVOKE_URL, { method: "POST", body: new URLSearchParams({ token: token.refresh_token ?? token.access_token! }), signal: AbortSignal.timeout(10_000) }).catch(() => {}); };
    if (!(token.scope ?? "").split(" ").includes(DRIVE_SCOPE)) {
      revoke();
      throw new Error("ForkFlow needs permission to save its backups in your Google Drive. Connect again and allow access when Google asks.");
    }
    if (!token.refresh_token) { revoke(); throw new Error("Google did not allow ForkFlow to stay connected. Try connecting again."); }
    const info = await this.fetch(USERINFO_URL, { headers: { authorization: `Bearer ${token.access_token}` }, signal: AbortSignal.timeout(30_000) });
    const user = await info.json().catch(() => ({})) as { sub?: string; email?: string };
    if (!info.ok || !user.sub) { revoke(); throw new Error("Could not read the Google account. Try again."); }
    if (this.state.account && this.state.account.id !== user.sub) {
      revoke();
      throw new Error(`Backups on this PC are linked to ${this.state.account.email}. Disconnect Google Drive in ForkFlow before using a different account.`);
    }
    const account = { id: user.sub, email: user.email ?? user.sub };
    this.state = { ...this.state, account, refreshToken: this.seal(token.refresh_token), reconnect: false };
    this.save();
    this.refreshToken = token.refresh_token;
    this.access = { token: token.access_token, expiresAt: this.now() + (token.expires_in ?? 3600) * 1000 };
    return account;
  }

  async disconnect(): Promise<void> {
    this.signIn?.close();
    const token = this.refreshToken;
    this.state = { ...this.state, account: null, refreshToken: null, folderId: null, folderName: null, reconnect: false };
    this.save();
    this.refreshToken = null; this.access = null; this.signInMessage = null;
    // Revocation is best effort: the local credential is already gone either way.
    if (token) await this.fetch(REVOKE_URL, { method: "POST", body: new URLSearchParams({ token }), signal: AbortSignal.timeout(10_000) }).catch(() => {});
  }

  async upload(input: Parameters<CloudBackupProvider["upload"]>[0]): Promise<{ remoteId: string }> {
    const { path, name, sha256, idempotencyKey, account, folderName, signal } = input;
    this.requireAccount(account);
    const size = statSync(path).size;
    const md5 = await hashFile(path, "md5", signal);
    // A lost success response leaves a complete file behind: reuse it instead of uploading twice.
    const existing = await this.listFiles(`trashed = false and appProperties has { key='forkflowKey' and value=${literal(idempotencyKey)} }`, signal);
    for (const file of existing) {
      if (Number(file.size) === size && file.md5Checksum === md5 && file.appProperties?.["sha256"] === sha256) return { remoteId: file.id };
      await this.trash(file.id, signal);
    }
    const parent = await this.folder(folderName, signal);
    const start = await this.authorized(`${UPLOAD}?uploadType=resumable&fields=id,size,md5Checksum`, {
      method: "POST", signal,
      headers: { "content-type": "application/json; charset=UTF-8", "x-upload-content-type": BACKUP_MIME, "x-upload-content-length": String(size) },
      body: JSON.stringify({ name, parents: [parent], mimeType: BACKUP_MIME, appProperties: {
        forkflowRole: "backup", forkflowInstallation: this.state.installationId, forkflowKey: idempotencyKey, sha256,
        forkflowRestaurant: truncateBytes(this.options.restaurantName(), 100),
      } }),
    });
    const session = start.headers.get("location");
    if (!start.ok || !session) throw new DriveError(start.status, "Google Drive did not start the upload");
    const uploaded = await this.sendChunks(session, path, size, signal);
    if (Number(uploaded.size) !== size || uploaded.md5Checksum !== md5) {
      await this.trash(uploaded.id, signal).catch(() => {});
      throw new Error("The copy in Google Drive did not match the local backup");
    }
    return { remoteId: uploaded.id };
  }

  /** Resumable upload in fixed chunks: constant memory, and Drive reports how much it already has. */
  private async sendChunks(session: string, path: string, size: number, signal: AbortSignal): Promise<DriveFile> {
    const fd = openSync(path, "r");
    try {
      let offset = 0;
      for (;;) {
        signal.throwIfAborted();
        const length = Math.min(CHUNK_BYTES, size - offset);
        const chunk = Buffer.alloc(length);
        for (let read = 0; read < length;) read += readSync(fd, chunk, read, length - read, offset + read);
        const res = await this.fetch(session, { method: "PUT", signal, body: chunk, headers: { "content-range": `bytes ${offset}-${offset + length - 1}/${size}` } });
        if (res.status === 308) {
          const range = res.headers.get("range");
          offset = range ? Number(range.split("-")[1]) + 1 : 0;
          continue;
        }
        if (!res.ok) throw new DriveError(res.status, "Google Drive upload failed");
        return await res.json() as DriveFile;
      }
    } finally { closeSync(fd); }
  }

  async prune(input: { account: CloudBackupAccount; retentionDays: number; signal: AbortSignal }): Promise<void> {
    this.requireAccount(input.account);
    // Only this installation's snapshots: never another PC's backups or any other file in the account.
    const files = await this.listFiles(`trashed = false and appProperties has { key='forkflowInstallation' and value=${literal(this.state.installationId)} }`, input.signal);
    // Trash rather than delete: Drive keeps trashed files for 30 days.
    for (const file of expiredBackups(files, input.retentionDays, this.now())) await this.trash(file.id, input.signal);
  }

  /** Every ForkFlow backup in the account, including those uploaded by a previous PC. */
  async list(signal: AbortSignal): Promise<CloudBackupFile[]> {
    const files = await this.listFiles("trashed = false and appProperties has { key='forkflowRole' and value='backup' }", signal, 500);
    return files.flatMap((file) => {
      const info = parseBackupName(file.name);
      return info ? [{ id: file.id, name: file.name, ...info, bytes: Number(file.size ?? 0),
        restaurantName: file.appProperties?.["forkflowRestaurant"] || null, thisPc: file.appProperties?.["forkflowInstallation"] === this.state.installationId }] : [];
    }).sort((a, b) => b.createdAt - a.createdAt);
  }

  /** Download a ForkFlow backup into `target`, checking Drive's MD5 and the SHA-256 recorded at upload. */
  async download(id: string, target: string, signal: AbortSignal): Promise<{ name: string }> {
    const meta = await this.json<DriveFile>(`${DRIVE}/${encodeURIComponent(id)}?fields=id,name,size,md5Checksum,trashed,appProperties`, { signal });
    if (meta.trashed || meta.appProperties?.["forkflowRole"] !== "backup" || !parseBackupName(meta.name)) throw new DriveError(404, "That Google Drive backup was not found");
    const res = await this.authorized(`${DRIVE}/${encodeURIComponent(id)}?alt=media`, { signal });
    if (!res.ok || !res.body) throw new DriveError(res.status, "Google Drive download failed");
    const md5 = createHash("md5"), sha256 = createHash("sha256");
    const hasher = new Transform({ transform(chunk: Buffer, _encoding, callback) { md5.update(chunk); sha256.update(chunk); callback(null, chunk); } });
    await pipeline(Readable.fromWeb(res.body as unknown as WebReadableStream<Uint8Array>), hasher, createWriteStream(target), { signal });
    const expectedSha = meta.appProperties?.["sha256"];
    if ((meta.md5Checksum && md5.digest("hex") !== meta.md5Checksum) || (expectedSha && sha256.digest("hex") !== expectedSha)) {
      throw new Error("The downloaded backup did not match the copy in Google Drive. Try again.");
    }
    return { name: meta.name };
  }

  /** The shared "ForkFlow Backups" folder, created once per account and renamed when the preference changes. */
  private async folder(name: string, signal: AbortSignal): Promise<string> {
    if (this.state.folderId) {
      const res = await this.authorized(`${DRIVE}/${encodeURIComponent(this.state.folderId)}?fields=id,name,trashed`, { signal });
      if (res.ok) {
        const folder = await res.json() as DriveFile;
        if (!folder.trashed) { await this.rename(folder, name, signal); return folder.id; }
      } else if (res.status !== 404) throw new DriveError(res.status, "Google Drive folder check failed");
    }
    const found = (await this.listFiles(`mimeType = '${FOLDER_MIME}' and trashed = false and appProperties has { key='forkflowRole' and value='backup-folder' }`, signal, 1))[0];
    const folder = found ?? await this.json<DriveFile>(`${DRIVE}?fields=id,name`, { method: "POST", signal, headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, mimeType: FOLDER_MIME, appProperties: { forkflowRole: "backup-folder" } }) });
    this.state = { ...this.state, folderId: folder.id, folderName: found ? this.state.folderName : name };
    this.save();
    await this.rename(folder, name, signal);
    return folder.id;
  }
  private async rename(folder: DriveFile, name: string, signal: AbortSignal) {
    // Rename only when this PC's preference changes; a second PC never fights over the folder name.
    if (this.state.folderName === name || folder.name === name) {
      if (this.state.folderName !== name) { this.state = { ...this.state, folderName: name }; this.save(); }
      return;
    }
    await this.json(`${DRIVE}/${encodeURIComponent(folder.id)}?fields=id`, { method: "PATCH", signal, headers: { "content-type": "application/json" }, body: JSON.stringify({ name }) });
    this.state = { ...this.state, folderName: name };
    this.save();
  }

  private async trash(id: string, signal: AbortSignal) {
    await this.json(`${DRIVE}/${encodeURIComponent(id)}?fields=id`, { method: "PATCH", signal, headers: { "content-type": "application/json" }, body: JSON.stringify({ trashed: true }) });
  }
  private async listFiles(q: string, signal: AbortSignal, limit = 1000): Promise<DriveFile[]> {
    const files: DriveFile[] = [];
    let pageToken: string | undefined;
    do {
      const params = new URLSearchParams({ q, spaces: "drive", orderBy: "createdTime desc", pageSize: String(Math.min(100, limit - files.length)),
        fields: "nextPageToken,files(id,name,size,md5Checksum,appProperties)", ...(pageToken ? { pageToken } : {}) });
      const page = await this.json<{ files?: DriveFile[]; nextPageToken?: string }>(`${DRIVE}?${params}`, { signal });
      files.push(...(page.files ?? []));
      pageToken = page.nextPageToken;
    } while (pageToken && files.length < limit);
    return files;
  }
  private async json<T>(url: string, init: RequestInit & { signal: AbortSignal }): Promise<T> {
    const res = await this.authorized(url, init);
    if (!res.ok) throw new DriveError(res.status, `Google Drive request failed (${res.status})`);
    return await res.json() as T;
  }
  private async authorized(url: string, init: RequestInit & { signal: AbortSignal }): Promise<Response> {
    const token = await this.accessToken(init.signal);
    const res = await this.fetch(url, { ...init, headers: { ...init.headers as Record<string, string>, authorization: `Bearer ${token}` } });
    if (res.status === 401) this.access = null;
    return res;
  }
  private accessToken(signal: AbortSignal): Promise<string> {
    if (this.access && this.access.expiresAt > this.now() + 60_000) return Promise.resolve(this.access.token);
    this.refreshing ??= this.refresh(signal).finally(() => { this.refreshing = null; });
    return this.refreshing;
  }
  private async refresh(signal: AbortSignal): Promise<string> {
    const refreshToken = this.refreshToken;
    if (!refreshToken || this.state.reconnect) throw new Error("Google Drive needs to be connected again");
    const res = await this.fetch(TOKEN_URL, { method: "POST", signal, body: new URLSearchParams({
      refresh_token: refreshToken, grant_type: "refresh_token", client_id: this.options.clientId, client_secret: this.options.clientSecret,
    }) });
    const body = await res.json().catch(() => ({})) as { access_token?: string; expires_in?: number; error?: string };
    if (!res.ok || !body.access_token) {
      // Revoked access, a changed password or an expired grant: only a new sign-in can fix it.
      if (body.error === "invalid_grant") { this.state = { ...this.state, reconnect: true }; this.save(); }
      throw new Error("Google sign-in could not be refreshed");
    }
    this.access = { token: body.access_token, expiresAt: this.now() + (body.expires_in ?? 3600) * 1000 };
    return body.access_token;
  }
  private requireAccount(account: CloudBackupAccount) {
    if (this.state.account?.id !== account.id) throw new Error("Google account changed");
  }
  private save() { atomicJson(this.path, this.state); }
  private seal(text: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.options.secretKey, iv);
    const data = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
    return ["v1", iv, cipher.getAuthTag(), data].map((part) => typeof part === "string" ? part : part.toString("base64")).join(".");
  }
  private unseal(sealed: string): string {
    const [version, iv, tag, data] = sealed.split(".");
    if (version !== "v1" || !iv || !tag || !data) throw new Error("Unsupported credential format");
    const decipher = createDecipheriv("aes-256-gcm", this.options.secretKey, Buffer.from(iv, "base64"));
    decipher.setAuthTag(Buffer.from(tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(data, "base64")), decipher.final()]).toString("utf8");
  }
}

async function hashFile(path: string, algorithm: "md5" | "sha256", signal: AbortSignal) {
  const hash = createHash(algorithm);
  for await (const chunk of createReadStream(path, { signal })) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

function page(res: ServerResponse, status: number, text: string) {
  const escaped = text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'" });
  res.end(`<!doctype html><meta charset="utf-8"><title>ForkFlow</title><body style="font:16px system-ui;margin:15vh auto;max-width:32em;padding:0 1em;color:#1f2328"><h1 style="font-size:20px">ForkFlow</h1><p>${escaped}</p></body>`);
}
