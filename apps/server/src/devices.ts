import { createHash, randomUUID } from "node:crypto";
import type { Database, DeviceEvent, DeviceHistory, DeviceKind } from "@masalapos/domain";
import type { FastifyInstance } from "fastify";
import { httpError } from "./http-error.js";

/** SHA-256 of a device credential (64 lowercase hex characters), or null when it is not one. Only the hash is ever stored. */
export function deviceHash(credential: unknown): string | null {
  return typeof credential === "string" && /^[a-f0-9]{64}$/.test(credential)
    ? createHash("sha256").update(credential).digest("hex") : null;
}

export interface DeviceRecord {
  id: string; kind: DeviceKind; name: string; credentialHash: string; isMain: boolean;
  settings: Record<string, unknown>; createdAt: number; removedAt: number | null;
  lastSeenAt: number | null; version: number;
}
interface DeviceRow {
  id: string; kind: DeviceKind; name: string; credential_hash: string; is_main: number; settings: string;
  created_at: number; removed_at: number | null; last_seen_at: number | null; version: number;
}
const record = (r: DeviceRow): DeviceRecord => ({
  id: r.id, kind: r.kind, name: r.name, credentialHash: r.credential_hash, isMain: r.is_main === 1,
  settings: JSON.parse(r.settings) as Record<string, unknown>, createdAt: r.created_at, removedAt: r.removed_at,
  lastSeenAt: r.last_seen_at, version: r.version,
});
const CHANGED = "This device changed. Refresh the device list and try again.";
const MAIN_NAME = "Main counter";

/**
 * The devices of this restaurant: every counter, kitchen display and captain tablet, in every build. The licence counts
 * its slots from `active()`, whose order (oldest first) decides which devices may operate, so that order must not change.
 */
export class Devices {
  constructor(private db: Database, private now: () => number = Date.now) {}

  /** Not removed, ordered created_at, id. */
  active(): DeviceRecord[] {
    return (this.db.prepare("SELECT * FROM devices WHERE removed_at IS NULL ORDER BY created_at, id").all() as DeviceRow[]).map(record);
  }
  private get(id: string): DeviceRecord | null {
    const row = this.db.prepare("SELECT * FROM devices WHERE id = ?").get(id) as DeviceRow | undefined;
    return row ? record(row) : null;
  }
  private byHash(hash: string): DeviceRecord | null {
    const row = this.db.prepare("SELECT * FROM devices WHERE credential_hash = ?").get(hash) as DeviceRow | undefined;
    return row ? record(row) : null;
  }
  /** The active device holding this credential, or null (also for a malformed credential). */
  findByCredential(credential: unknown): DeviceRecord | null {
    const hash = deviceHash(credential);
    const device = hash ? this.byHash(hash) : null;
    return device && device.removedAt === null ? device : null;
  }
  private record(deviceId: string, kind: DeviceEvent["kind"], summary: string, actorName: string) {
    this.db.prepare("INSERT INTO device_events (occurred_at, actor_name, device_id, kind, summary) VALUES (?, ?, ?, ?, ?)")
      .run(this.now(), actorName, deviceId, kind, summary);
  }

  /**
   * Adds a device. A browser that was removed and registers again gets its old row back (same id and kind, a new place
   * at the end of the list), since its credential hash is still on file.
   */
  add(input: { credentialHash: string; name: string; kind: DeviceKind; isMain?: boolean }, actorName: string): DeviceRecord {
    return this.db.transaction(() => {
      const old = this.byHash(input.credentialHash);
      if (old && old.removedAt === null) throw httpError(409, "This device is already registered");
      const id = old?.id ?? randomUUID(), isMain = input.isMain ? 1 : 0;
      if (old) {
        this.db.prepare("UPDATE devices SET name = ?, is_main = ?, created_at = ?, removed_at = NULL, last_seen_at = NULL, version = version + 1 WHERE id = ?")
          .run(input.name, isMain, this.now(), id);
      } else {
        this.db.prepare("INSERT INTO devices (id, kind, name, credential_hash, is_main, created_at) VALUES (?, ?, ?, ?, ?, ?)")
          .run(id, input.kind, input.name, input.credentialHash, isMain, this.now());
      }
      this.record(id, "joined", `Registered ${input.name}.`, actorName);
      return this.get(id)!;
    })();
  }

  /** A rename to the same name does nothing. */
  rename(id: string, name: string, version: number, actorName: string): void {
    this.db.transaction(() => {
      const device = this.get(id);
      if (!device || device.removedAt !== null) throw httpError(404, "Device not found");
      if (device.version !== version) throw httpError(409, CHANGED);
      if (device.name === name) return;
      this.db.prepare("UPDATE devices SET name = ?, version = version + 1 WHERE id = ?").run(name, id);
      this.record(id, "renamed", `Renamed ${device.name} to ${name}.`, actorName);
    })();
  }

  /** Signs everyone out on the device as well. Removing a device that is already removed does nothing. */
  remove(id: string, actorName: string, version?: number): void {
    this.db.transaction(() => {
      const device = this.get(id);
      if (!device) throw httpError(404, "Device not found");
      if (device.removedAt !== null) return;
      if (device.isMain) throw httpError(409, "The main counter can't be removed.");
      if (version !== undefined && device.version !== version) throw httpError(409, CHANGED);
      this.db.prepare("UPDATE devices SET removed_at = ?, version = version + 1 WHERE id = ?").run(this.now(), id);
      this.db.prepare("DELETE FROM sessions WHERE device = ?").run(device.credentialHash);
      this.record(id, "removed", `Removed ${device.name}.`, actorName);
    })();
  }

  /**
   * Gives the restaurant its main counter when it has none: the active device holding this credential is marked as
   * main, or the credential is added as "Main counter". Returns the main device it made, else null.
   */
  ensureMain(credential: unknown, actorName: string): DeviceRecord | null {
    const hash = deviceHash(credential);
    if (!hash) return null;
    return this.db.transaction(() => {
      if (this.db.prepare("SELECT 1 FROM devices WHERE is_main = 1 AND removed_at IS NULL").get()) return null;
      const existing = this.byHash(hash);
      if (!existing || existing.removedAt !== null) return this.add({ credentialHash: hash, name: MAIN_NAME, kind: "counter", isMain: true }, actorName);
      this.db.prepare("UPDATE devices SET is_main = 1, version = version + 1 WHERE id = ?").run(existing.id);
      return this.get(existing.id);
    })();
  }

  /** Sets last seen only; the version does not change, so a device being used never makes an edit of it stale. */
  touch(id: string, at: number): void {
    this.db.prepare("UPDATE devices SET last_seen_at = ? WHERE id = ?").run(at, id);
  }

  /** Newest first, 20 a page; pass the previous page's `nextBefore` for the next one. */
  events(before?: number): DeviceHistory {
    const rows = this.db.prepare(`SELECT id, occurred_at AS occurredAt, actor_name AS actorName, device_id AS deviceId, kind, summary
      FROM device_events WHERE id < ? ORDER BY id DESC LIMIT 21`).all(before ?? Number.MAX_SAFE_INTEGER) as DeviceEvent[];
    return { events: rows.slice(0, 20), nextBefore: rows.length > 20 ? rows[19]!.id : null };
  }
}

export function configureDevices(app: FastifyInstance, now?: () => number) {
  app.decorate("devices", new Devices(app.db, now));
}

declare module "fastify" {
  interface FastifyInstance {
    devices: Devices;
  }
}
