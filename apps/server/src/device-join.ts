import { createHash, randomInt, randomUUID } from "node:crypto";
import { JOIN_CODE_ALPHABET, JOIN_CODE_LENGTH, JOIN_CODE_TTL_MS, JoinCodeCreate, normalizeJoinCode, type Database, type DeviceJoined, type DeviceKind, type DeviceMe, type JoinCodeIssued } from "@masalapos/domain";
import type { FastifyInstance } from "fastify";
import QRCode from "qrcode";
import { z } from "zod";
import type { CaptainHttpsInfo } from "./captain-https.js";
import { deviceHash, type DeviceRecord, type Devices } from "./devices.js";
import { guestRateLimiter } from "./guest-rate.js";
import { httpError } from "./http-error.js";
import { fromMainPc, lanUrls } from "./system.js";

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

const DEVICE_HEADER = "x-masalapos-device";
/** Wrong guesses from one address in a minute. A code has about 887 million possibilities and lasts ten minutes. */
const JOIN_ATTEMPTS_PER_MINUTE = 10;

/**
 * How devices join. Joining and "who am I" need no sign-in, since a browser that has not joined cannot sign in to
 * anything; what protects them is the code itself, the per-address limit, and that a browser only ever learns about itself.
 */
export function registerDeviceJoin(app: FastifyInstance, port = 4100, captainHttps?: CaptainHttpsInfo, now?: () => number) {
  const codes = new JoinCodes(app.db, app.devices, now);
  const rate = guestRateLimiter();
  /** The licence's device count; none in builds without licensing. A licensed build whose licence cannot be read has no known count, so no new device gets in until it can. */
  const limit = () => { const max = app.licensing.status().maxDevices; return max === null && app.licensing.enabled ? 0 : max; };
  const joined = (device: DeviceRecord): DeviceJoined => ({ kind: device.kind, name: device.name });
  /** Where the new device can open the join screen. A captain tablet works over HTTPS when that is set up, and a browser's credential belongs to one origin. */
  const origins = (kind: DeviceRecord["kind"]) => {
    const secure = kind === "captain" && captainHttps?.enabled ? (captainHttps.addresses ?? []).map((address) => `https://${address}:${captainHttps.port}`) : [];
    return secure.length ? secure : lanUrls(port);
  };

  app.post("/api/devices/join-codes", { preHandler: app.requirePermission("settings.manage") }, async (req, reply) => {
    const issued = codes.create(JoinCodeCreate.parse(req.body), req.user.name, limit());
    const links = await Promise.all(origins(issued.kind).map(async (origin) => {
      const url = `${origin}/join#${issued.code}`;
      return { url, qr: await QRCode.toDataURL(url, { width: 220, margin: 2 }) };
    }));
    reply.header("Cache-Control", "no-store");
    return reply.status(201).send({ ...issued, links } satisfies JoinCodeIssued);
  });

  app.post("/api/devices/join", async (req, reply) => {
    rate(req, "device-join", JOIN_ATTEMPTS_PER_MINUTE);
    const { code } = z.object({ code: z.string().max(40) }).parse(req.body);
    const device = codes.redeem(code, req.headers[DEVICE_HEADER], limit());
    app.licensing.announceChange();
    reply.header("Cache-Control", "no-store");
    return joined(device);
  });

  app.get("/api/devices/me", async (req, reply) => {
    const device = app.devices.findByCredential(req.headers[DEVICE_HEADER]);
    reply.header("Cache-Control", "no-store");
    return { joined: device !== null, kind: device?.kind ?? null, mainPc: fromMainPc(req) } satisfies DeviceMe;
  });

  // The way back in when the main counter's browser storage was cleared: no code, but only for an administrator sitting at the main PC.
  app.post("/api/devices/rejoin-main", { preHandler: app.requireAuth }, async (req, reply) => {
    if (req.user.role !== "admin") throw httpError(403, "Only an administrator can re-join the main counter.");
    if (!fromMainPc(req)) throw httpError(403, "Re-join the main counter from the main POS PC.");
    const hash = deviceHash(req.headers[DEVICE_HEADER]);
    if (!hash) throw httpError(400, "A device credential is required");
    const main = app.devices.main();
    if (!main) throw httpError(409, "There is no main counter to re-join.");
    const device = app.devices.replaceCredential(main.id, hash, req.user.name, `Re-joined ${main.name} from the main PC.`);
    app.licensing.announceChange();
    reply.header("Cache-Control", "no-store");
    return joined(device);
  });
}
