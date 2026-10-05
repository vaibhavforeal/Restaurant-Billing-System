import { createHash } from "node:crypto";
import { createReadStream, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { CloudBackupPreferences, type CloudBackupAccount, type CloudBackupSettings, type CloudBackupStatus } from "@forkflow/domain";
import { atomicJson, verifyBackup, type Backups } from "./backups.js";
import { httpError } from "./http-error.js";

export interface CloudBackupConnection {
  state: "not_connected" | "connected" | "reconnect_required";
  account: CloudBackupAccount | null;
}

/** The future Drive OAuth/API module owns credentials. This worker never sees tokens.
 * Upload must find/reuse an existing remote file for (account, idempotencyKey).
 * Resolve only after Drive confirms the complete file and checksum; honor signal.
 */
export interface CloudBackupProvider {
  connection(): CloudBackupConnection;
  upload(input: {
    path: string; name: string; sha256: string; idempotencyKey: string;
    account: CloudBackupAccount; folderName: string; signal: AbortSignal;
  }): Promise<{ remoteId: string }>;
  prune(input: { account: CloudBackupAccount; retentionDays: number; signal: AbortSignal }): Promise<void>;
  disconnect(): Promise<void>;
}

const queuedFile = z.object({ name: z.string(), accountId: z.string(), attempts: z.number().int().nonnegative(), nextAttemptAt: z.number() });
const storedState = z.object({
  version: z.literal(1),
  accountId: z.string().nullable().default(null),
  queue: z.array(queuedFile),
  uploaded: z.array(z.object({ name: z.string(), accountId: z.string(), uploadedAt: z.number() })),
  lastError: z.string().nullable(),
});
type State = z.infer<typeof storedState>;

export class CloudBackups {
  private settings: CloudBackupSettings;
  private state: State;
  // Unreadable metadata: left untouched for recovery, so cloud backup stays off until the server restarts.
  private damaged: string | null = null;
  // A failed save (e.g. disk briefly full): reported in status, cleared by the next successful run.
  private storageError: string | null = null;
  private unsubscribe: () => void;
  private timer: ReturnType<typeof setInterval> | undefined;
  private active: Promise<void> | null = null;
  private controller: AbortController | null = null;
  private closing = false;
  private disconnecting = false;
  private configPath: string;
  private statePath: string;

  constructor(readonly backups: Backups, private provider?: CloudBackupProvider, private now = () => Date.now()) {
    this.configPath = join(backups.dataDir, "cloud-backup-settings.json");
    this.statePath = join(backups.dataDir, "cloud-backup-state.json");
    this.settings = CloudBackupPreferences.parse({});
    this.state = { version: 1, accountId: null, queue: [], uploaded: [], lastError: null };
    try {
      if (existsSync(this.configPath)) this.settings = CloudBackupPreferences.parse(JSON.parse(readFileSync(this.configPath, "utf8")));
      if (existsSync(this.statePath)) this.state = storedState.parse(JSON.parse(readFileSync(this.statePath, "utf8")));
    } catch {
      // Leave damaged metadata untouched for recovery and keep local billing/backups available.
      this.damaged = "Cloud backup settings could not be read. Local backups are still available.";
    }
    this.unsubscribe = backups.subscribe({
      created: (name) => {
        if (!this.settings.automatic || !this.ready()) return;
        try { this.enqueue(name); void this.process(); }
        catch { this.storageError = "Local backup saved; cloud upload could not be queued. Check free disk space."; }
      },
      protectedNames: () => new Set(this.state.queue.map((item) => item.name)),
    });
  }

  private ready(): boolean {
    const connection = this.provider?.connection();
    return !this.closing && !this.disconnecting && !this.damaged && connection?.state === "connected" &&
      !!connection.account && (!this.state.accountId || this.state.accountId === connection.account.id);
  }
  private save() { atomicJson(this.statePath, this.state); }
  status(): CloudBackupStatus {
    const connection = this.provider?.connection();
    const account = connection?.account ?? null;
    const accountChanged = !!this.state.accountId && !!account && this.state.accountId !== account.id;
    const queue = this.state.queue.filter((entry) => entry.accountId === account?.id);
    const last = this.state.uploaded.filter((entry) => entry.accountId === account?.id).at(-1);
    return { ...this.settings, provider: "google_drive", state: accountChanged ? "reconnect_required" : connection?.state ?? "not_configured", account,
      uploading: !!this.active, pendingCount: queue.length, queue: queue.map(({ name, attempts, nextAttemptAt }) => ({ name, attempts, nextAttemptAt })),
      lastUploadedAt: last?.uploadedAt ?? null, lastUploadedName: last?.name ?? null,
      lastError: this.damaged ?? this.storageError ?? (accountChanged ? "Google account changed. Disconnect before linking a different account." : this.state.lastError) };
  }
  configure(input: unknown): CloudBackupStatus {
    if (this.damaged) throw httpError(409, this.damaged);
    const settings = CloudBackupPreferences.parse(input);
    atomicJson(this.configPath, settings);
    this.settings = settings;
    return this.status();
  }
  private requireConnection(): CloudBackupAccount {
    if (this.damaged) throw httpError(409, this.damaged);
    if (!this.provider) throw httpError(409, "Google Drive backup is not configured yet. Local backups remain available.");
    const connection = this.provider.connection();
    if (connection.state !== "connected" || !connection.account) throw httpError(409, "Connect Google Drive on the main POS PC before uploading backups.");
    if (this.state.accountId && this.state.accountId !== connection.account.id) throw httpError(409, "Disconnect before linking a different Google account.");
    if (this.closing || this.disconnecting) throw httpError(409, "Cloud backup is stopping.");
    return connection.account;
  }
  private enqueue(name: string) {
    const account = this.requireConnection();
    if (!this.backups.download(name)) throw httpError(404, "Verified local backup not found");
    if (this.state.queue.some((item) => item.name === name && item.accountId === account.id) ||
        this.state.uploaded.some((item) => item.name === name && item.accountId === account.id)) return;
    this.state.accountId = account.id;
    this.state.queue.push({ name, accountId: account.id, attempts: 0, nextAttemptAt: this.now() });
    this.save();
  }
  uploadNow(): CloudBackupStatus {
    this.requireConnection();
    // The local snapshot is committed and verified before it enters the queue.
    const { name } = this.backups.create("manual");
    this.enqueue(name);
    void this.process();
    return this.status();
  }
  retry(): CloudBackupStatus {
    const account = this.requireConnection();
    for (const item of this.state.queue) if (item.accountId === account.id) item.nextAttemptAt = this.now();
    this.save();
    void this.process();
    return this.status();
  }
  async disconnect(): Promise<CloudBackupStatus> {
    if (!this.provider) throw httpError(409, "Google Drive backup is not configured yet.");
    this.disconnecting = true;
    try {
      this.controller?.abort();
      await this.active;
      await this.provider.disconnect();
      // Do not carry pending restaurant files into a different Google account.
      this.state.queue = [];
      this.state.accountId = null;
      this.state.lastError = null;
      this.save();
      return this.status();
    } finally { this.disconnecting = false; }
  }
  start() {
    if (this.timer || this.closing) return;
    void this.process();
    this.timer = setInterval(() => { void this.process(); }, 60_000);
    this.timer.unref();
  }
  process(): Promise<void> {
    if (this.active) return this.active;
    if (!this.ready()) return Promise.resolve();
    // Defer work so a local backup response never waits for network I/O.
    this.active = Promise.resolve().then(() => this.drain()).then(() => { this.storageError = null; }).catch(() => {
      this.storageError = "Cloud backup could not save its upload progress. Local backups are still available; ForkFlow will try again.";
    }).finally(() => { this.active = null; });
    return this.active;
  }
  private async drain() {
    if (!this.ready()) return;
    const provider = this.provider!;
    const account = this.requireConnection();
    if (this.settings.automatic) {
      // Recover a missed event after a crash/restart and queue existing restore points on first connection.
      for (const backup of this.backups.list()) this.enqueue(backup.name);
    }
    while (this.ready() && provider.connection().account?.id === account.id) {
      const entry = this.state.queue.find((item) => item.accountId === account.id && item.nextAttemptAt <= this.now());
      if (!entry) break;
      const path = this.backups.download(entry.name);
      if (!path) {
        this.state.queue = this.state.queue.filter((item) => item !== entry);
        this.state.lastError = "A queued local backup is missing. Create a fresh backup before retrying.";
        this.save();
        continue;
      }
      const controller = new AbortController();
      this.controller = controller;
      const timeout = setTimeout(() => controller.abort(), 120_000);
      try {
        verifyBackup(path);
        const hash = createHash("sha256");
        for await (const chunk of createReadStream(path, { signal: controller.signal })) hash.update(chunk);
        const sha256 = hash.digest("hex");
        const result = await provider.upload({ path, name: entry.name, sha256, account, idempotencyKey: entry.name,
          folderName: this.settings.folderName, signal: controller.signal });
        if (!result.remoteId) throw new Error("Cloud upload was not confirmed");
        this.state.queue = this.state.queue.filter((item) => item !== entry);
        this.state.uploaded.push({ name: entry.name, accountId: account.id, uploadedAt: this.now() });
        // Only retain completion records while the corresponding local snapshot exists.
        const localNames = new Set(this.backups.list().map((item) => item.name));
        this.state.uploaded = this.state.uploaded.filter((item) => localNames.has(item.name));
        this.state.lastError = null;
        this.save();
        // Retention is separate: a cleanup failure must never re-upload a confirmed backup.
        if (!controller.signal.aborted) {
          try { await provider.prune({ account, retentionDays: this.settings.retentionDays, signal: controller.signal }); }
          catch { this.state.lastError = "Cloud backup uploaded; cleanup of older cloud backups will be retried after the next upload."; this.save(); }
        }
      } catch {
        entry.attempts++;
        entry.nextAttemptAt = this.now() + Math.min(3_600_000, 60_000 * 2 ** Math.min(entry.attempts - 1, 6));
        this.state.lastError = "Cloud upload was not confirmed. Your local backup is safe; ForkFlow will retry.";
        this.save();
        break;
      } finally { clearTimeout(timeout); this.controller = null; }
    }
  }
  async close() {
    this.closing = true;
    if (this.timer) clearInterval(this.timer);
    this.unsubscribe();
    this.controller?.abort();
    await this.active;
  }
}
