import { createHash, randomInt, randomUUID } from "node:crypto";
import { JOIN_CODE_ALPHABET, JOIN_CODE_LENGTH, JOIN_CODE_TTL_MS, normalizeJoinCode, type Database, type DeviceKind, type JoinCodeCreate } from "@masalapos/domain";
import { deviceHash, type DeviceRecord, type Devices } from "./devices.js";
import { httpError } from "./http-error.js";

/** One answer for a wrong, used or expired code, so a code cannot be probed for which of those it is. */
const INVALID = "That code is not valid or has expired";
const LIMIT = "Device limit reached. Remove an old device or upgrade your plan.";
const codeHash = (code: string) => createHash("sha256").update(code).digest("hex");
const randomJoinCode = () => Array.from({ length: JOIN_CODE_LENGTH }, () => JOIN_CODE_ALPHABET[randomInt(JOIN_CODE_ALPHABET.length)]).join("");

export interface IssuedCode { code: string; expiresAt: number; kind: DeviceKind; name: string; replacesDeviceId: string | null }
interface CodeRow { id: string; kind: DeviceKind; name: string; replaces_device_id: string | null; created_by: string; expires_at: number; used_at: number | null }

/**
 * Join codes: how a browser becomes one of the restaurant's devices, or takes over one whose browser was lost. A code
 * works once, for ten minutes, and only its hash is stored. `limit` is the licence's device count, or null for no limit;
 * a code that replaces a device needs no free slot.
 */
export class JoinCodes {
  constructor(private db: Database, private devices: Devices, private now: () => number = Date.now, private randomCode: () => string = randomJoinCode) {}

  private full(limit: number | null) { return limit !== null && this.devices.active().length >= limit; }

  create(input: JoinCodeCreate, createdBy: string, limit: number | null): IssuedCode {
    return this.db.transaction(() => {
      const now = this.now();
      this.db.prepare("DELETE FROM device_join_codes WHERE expires_at < ?").run(now);
      let kind: DeviceKind, name: string, replaces: string | null = null;
      if ("replacesDeviceId" in input) {
        const target = this.devices.active().find((d) => d.id === input.replacesDeviceId);
        if (!target) throw httpError(404, "Device not found");
        ({ kind, name } = target); replaces = target.id;
        this.db.prepare("DELETE FROM device_join_codes WHERE used_at IS NULL AND replaces_device_id = ?").run(replaces);
      } else {
        if (this.full(limit)) throw httpError(409, LIMIT);
        ({ kind, name } = input);
        this.db.prepare("DELETE FROM device_join_codes WHERE used_at IS NULL AND replaces_device_id IS NULL AND kind = ? AND name = ? COLLATE NOCASE").run(kind, name);
      }
      let code = this.randomCode();
      // A live code with the same characters is next to impossible, and must still never be handed out twice.
      while (this.db.prepare("SELECT 1 FROM device_join_codes WHERE code_hash = ?").get(codeHash(code))) code = this.randomCode();
      const expiresAt = now + JOIN_CODE_TTL_MS;
      this.db.prepare("INSERT INTO device_join_codes (id, code_hash, kind, name, replaces_device_id, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .run(randomUUID(), codeHash(code), kind, name, replaces, createdBy, now, expiresAt);
      return { code, expiresAt, kind, name, replacesDeviceId: replaces };
    })();
  }

  /** Joins the browser holding `credential` and returns its device. The code is used up only when that succeeds. */
  redeem(code: unknown, credential: unknown, limit: number | null): DeviceRecord {
    return this.db.transaction(() => {
      const hash = deviceHash(credential);
      if (!hash) throw httpError(400, "A device credential is required");
      if (this.devices.findByCredential(credential)) throw httpError(409, "This device has already joined.");
      const normalized = normalizeJoinCode(code), now = this.now();
      const row = normalized ? this.db.prepare("SELECT * FROM device_join_codes WHERE code_hash = ?").get(codeHash(normalized)) as CodeRow | undefined : undefined;
      if (!row || row.used_at !== null || row.expires_at <= now) throw httpError(400, INVALID);
      let device: DeviceRecord;
      if (row.replaces_device_id) {
        if (!this.devices.active().some((d) => d.id === row.replaces_device_id)) throw httpError(400, INVALID);
        device = this.devices.replaceCredential(row.replaces_device_id, hash, row.created_by, `Replaced the browser of ${row.name}.`);
      } else {
        if (this.full(limit)) throw httpError(409, LIMIT);
        device = this.devices.add({ credentialHash: hash, name: row.name, kind: row.kind }, row.created_by, `Joined as ${row.name}.`);
      }
      this.db.prepare("UPDATE device_join_codes SET used_at = ? WHERE id = ?").run(now, row.id);
      return device;
    })();
  }
}
