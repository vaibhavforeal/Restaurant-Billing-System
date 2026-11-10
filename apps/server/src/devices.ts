import { createHash, randomUUID } from "node:crypto";
import { deviceSettings, type Database, type DeviceEvent, type DeviceHistory, type DeviceKind, type DeviceSettings, type DeviceSettingsPatch, type PaymentStart } from "@masalapos/domain";
import type { FastifyInstance } from "fastify";
import { httpError } from "./http-error.js";

/** SHA-256 of a device credential (64 lowercase hex characters), or null when it is not one. Only the hash is ever stored. */
export function deviceHash(credential: unknown): string | null {
  return typeof credential === "string" && /^[a-f0-9]{64}$/.test(credential)
    ? createHash("sha256").update(credential).digest("hex") : null;
}

export interface DeviceRecord {
  id: string; kind: DeviceKind; name: string; isMain: boolean;
  /** Readable in code, but left out when the record is serialised or spread, so no response can carry it by accident. */
  readonly credentialHash: string;
  settings: Record<string, unknown>; createdAt: number; removedAt: number | null;
  lastSeenAt: number | null; version: number;
}
interface DeviceRow {
  id: string; kind: DeviceKind; name: string; credential_hash: string; is_main: number; settings: string;
  created_at: number; removed_at: number | null; last_seen_at: number | null; version: number;
}
const record = (r: DeviceRow): DeviceRecord => Object.defineProperty({
  id: r.id, kind: r.kind, name: r.name, isMain: r.is_main === 1,
  settings: JSON.parse(r.settings) as Record<string, unknown>, createdAt: r.created_at, removedAt: r.removed_at,
  lastSeenAt: r.last_seen_at, version: r.version,
}, "credentialHash", { value: r.credential_hash, enumerable: false }) as DeviceRecord;
const CHANGED = "This device changed. Refresh the device list and try again.";
const MAIN_NAME = "Main counter";
const JOINED = "This device has already joined.";
const PAYMENT_START_NAMES: Record<PaymentStart, string> = { last: "the method used last", cash: "Cash", card: "Card", upi: "UPI" };

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
   * A removed device keeps its row for the history, but not its browser: its credential hash is swapped for a marker no
   * real hash can equal, so the same browser can join again as another device.
   */
  private retire(credentialHash: string) {
    this.db.prepare("UPDATE devices SET credential_hash = 'retired:' || id WHERE credential_hash = ? AND removed_at IS NOT NULL").run(credentialHash);
  }
  /** The active main counter, or null. */
  main(): DeviceRecord | null {
    const row = this.db.prepare("SELECT * FROM devices WHERE is_main = 1 AND removed_at IS NULL").get() as DeviceRow | undefined;
    return row ? record(row) : null;
  }

  /**
   * Adds a device at the end of the list. A browser that was removed and joins again is a new device, with the name and
   * kind asked for now; its removed row stays as it was.
   */
  add(input: { credentialHash: string; name: string; kind: DeviceKind; isMain?: boolean }, actorName: string, summary = `Registered ${input.name}.`): DeviceRecord {
    return this.db.transaction(() => {
      if (this.byHash(input.credentialHash)?.removedAt === null) throw httpError(409, JOINED);
      this.retire(input.credentialHash);
      const id = randomUUID();
      this.db.prepare("INSERT INTO devices (id, kind, name, credential_hash, is_main, created_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(id, input.kind, input.name, input.credentialHash, input.isMain ? 1 : 0, this.now());
      this.record(id, "joined", summary, actorName);
      return this.get(id)!;
    })();
  }

  /**
   * Moves an active device to another browser and signs everyone out on the old one. Its name, kind, settings, place in
   * the list (and so its licence slot) and main-counter mark are kept.
   */
  replaceCredential(id: string, credentialHash: string, actorName: string, summary: string): DeviceRecord {
    return this.db.transaction(() => {
      const device = this.get(id);
      if (!device || device.removedAt !== null) throw httpError(404, "Device not found");
      if (this.byHash(credentialHash)?.removedAt === null) throw httpError(409, JOINED);
      this.retire(credentialHash);
      this.db.prepare("UPDATE devices SET credential_hash = ?, last_seen_at = NULL, version = version + 1 WHERE id = ?").run(credentialHash, id);
      this.db.prepare("DELETE FROM sessions WHERE device = ?").run(device.credentialHash);
      this.record(id, "replaced", summary, actorName);
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
   * With a `limit` (the licence's device count), nothing is added once that many devices are in use: a main counter
   * added past the limit would be blocked and could never be removed. Marking a device already in the list is always allowed.
   */
  ensureMain(credential: unknown, actorName: string, limit?: number | null): DeviceRecord | null {
    const hash = deviceHash(credential);
    if (!hash) return null;
    return this.db.transaction(() => {
      if (this.main()) return null;
      const existing = this.byHash(hash);
      if (existing && existing.removedAt === null) {
        this.db.prepare("UPDATE devices SET is_main = 1, version = version + 1 WHERE id = ?").run(existing.id);
        return this.get(existing.id);
      }
      if (limit != null && this.active().length >= limit) return null;
      return this.add({ credentialHash: hash, name: MAIN_NAME, kind: "counter", isMain: true }, actorName);
    })();
  }

  /** What is saved for the device, with defaults for anything missing. */
  settings(device: DeviceRecord): DeviceSettings {
    return deviceSettings(device.settings);
  }
  private activePrinter(id: string): { name: string } | undefined {
    return this.db.prepare("SELECT name FROM printers WHERE id = ? AND is_active = 1").get(id) as { name: string } | undefined;
  }
  /** The device's bill printer if one is saved and active, else null. Null for a browser that is not a device. */
  billPrinterId(device: DeviceRecord | null): string | null {
    const id = device ? this.settings(device).billPrinterId : null;
    return id && this.activePrinter(id) ? id : null;
  }
  /** True when a printer is saved for the device and that printer is switched off (or gone). */
  printerInactive(device: DeviceRecord): boolean {
    return this.settings(device).billPrinterId !== null && this.billPrinterId(device) === null;
  }
  /**
   * Saves the settings given and leaves the others as they are saved, even a printer that has since been switched off.
   * Saving the values a device already has does nothing.
   */
  updateSettings(id: string, patch: Omit<DeviceSettingsPatch, "version">, version: number, actorName: string): DeviceRecord {
    return this.db.transaction(() => {
      const device = this.get(id);
      if (!device || device.removedAt !== null) throw httpError(404, "Device not found");
      if (device.version !== version) throw httpError(409, CHANGED);
      const saved = this.settings(device), next = { ...saved }, changes: string[] = [];
      if (patch.billPrinterId !== undefined && patch.billPrinterId !== saved.billPrinterId) {
        const printer = patch.billPrinterId === null ? null : this.activePrinter(patch.billPrinterId);
        if (printer === undefined) throw httpError(400, "Choose an active printer");
        next.billPrinterId = patch.billPrinterId;
        changes.push(`Bill printer of ${device.name} set to ${printer?.name ?? "Browser / A4"}.`);
      }
      if (patch.paymentStart !== undefined && patch.paymentStart !== saved.paymentStart) {
        next.paymentStart = patch.paymentStart;
        changes.push(`Starting payment method of ${device.name} set to ${PAYMENT_START_NAMES[patch.paymentStart]}.`);
      }
      if (!changes.length) return device;
      this.db.prepare("UPDATE devices SET settings = ?, version = version + 1 WHERE id = ?").run(JSON.stringify(next), id);
      this.record(id, "settings_changed", changes.join(" "), actorName);
      return this.get(id)!;
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
