import { createHash, createPublicKey, randomUUID } from "node:crypto";
import { LicenseClaims, type Feature, type LicenseStatus, type LicensedDevice, type LicensePreview, type LicenseEvent, type LicenseHistory, type ActivationRequest } from "@forkflow/domain";
import { verifyLicenseSignature } from "@forkflow/core";
import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from "fastify";
import { z } from "zod";
import { httpError } from "./http-error.js";

const FEATURE_NAMES: Record<Feature, string> = { recipes: "recipe editing", qrOrdering: "QR ordering", kds: "the Kitchen Display" };

export interface LicensingOptions {
  publicKey: string;
  installationId: string;
  now?: () => number;
  /** Base URL of the licensing service (no trailing slash); without it nothing is ever fetched. */
  serviceUrl?: string;
  /** Tests inject a fake; defaults to the global fetch. */
  fetch?: typeof fetch;
}
export interface LicenseCheckResult {
  outcome: "installed" | "up_to_date" | "unreachable" | "rejected" | "disabled";
  message: string;
  /** Why a licence was rejected, for the log; never contains licence text. */
  detail?: string;
}
const RENEWAL_INTERVAL_MS = 6 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 10_000;
const AUTOMATIC_ACTOR = "Automatic renewal";
const CHECK_MESSAGES = {
  unreachable: "Couldn't reach the licensing service. Billing continues on your current licence.",
  up_to_date: "Your licence is up to date.",
  installed: "A new licence was installed.",
  rejected: "The licensing service returned a licence this installation can't use.",
  disabled: "Automatic renewal is not set up for this installation.",
} as const;
const serviceReply = z.object({ license: z.string().max(16_384).nullable() });
interface SavedLicense {
  envelope: string | null; revision: number; last_seen_at: number;
  license_id: string | null; organization_id: string | null; outlet_id: string | null;
}
interface DeviceRow { id: string; credential_hash: string; name: string; created_at: number; last_seen_at: number | null; version: number; revoked_at: number | null }

export function deviceHash(credential: unknown): string | null {
  return typeof credential === "string" && /^[a-f0-9]{64}$/.test(credential)
    ? createHash("sha256").update(credential).digest("hex") : null;
}

export class Licensing {
  private now: () => number;
  constructor(private app: FastifyInstance, private options?: LicensingOptions) {
    this.now = options?.now ?? Date.now;
    if (options) {
      z.string().uuid().parse(options.installationId);
      if (createPublicKey(options.publicKey).asymmetricKeyType !== "ed25519") throw new Error("License key must use Ed25519");
    }
  }
  get enabled() { return this.options !== undefined; }
  private saved() { return this.app.db.prepare("SELECT * FROM license_state WHERE id = 1").get() as SavedLicense; }
  // status() runs on every authenticated request, so remember the last verified envelope instead of re-checking its signature.
  private verified: { envelope: string; claims: LicenseClaims } | null = null;
  private claims(envelope: string) {
    if (!this.options) throw httpError(409, "This build is not configured for commercial activation");
    if (this.verified?.envelope === envelope) return this.verified.claims;
    try {
      const claims = LicenseClaims.parse(verifyLicenseSignature(envelope, this.options.publicKey));
      if (claims.installationId !== this.options.installationId) throw new Error("Wrong installation");
      this.verified = { envelope, claims };
      return claims;
    } catch { throw httpError(400, "License is invalid or belongs to another installation"); }
  }
  private activeDevices() {
    return this.app.db.prepare("SELECT * FROM licensed_devices WHERE revoked_at IS NULL ORDER BY created_at, id").all() as DeviceRow[];
  }
  private audit(kind: LicenseEvent["kind"], summary: string, actorName: string, revision: number | null = null, deviceId: string | null = null) {
    this.app.db.prepare("INSERT INTO license_events (occurred_at, actor_name, kind, summary, revision, device_id) VALUES (?, ?, ?, ?, ?, ?)")
      .run(this.now(), actorName, kind, summary, revision, deviceId);
  }
  status(credential?: unknown): LicenseStatus {
    const now = this.now();
    const base: LicenseStatus = {
      mode: this.enabled ? "commercial" : "development", state: "unactivated",
      installationId: this.options?.installationId ?? null, plan: null, maxDevices: null,
      features: { recipes: false, qrOrdering: false, kds: false }, expiresAt: null, graceUntil: null,
      deviceRegistered: false, canOperate: false, message: "Activate this installation to start billing.",
      serverTime: now, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, revision: null, registeredDevices: 0, trial: false,
      subscribeUrl: this.options?.serviceUrl ? `${this.options.serviceUrl}/subscribe?installation=${this.options.installationId}` : null,
    };
    if (!this.enabled) return { ...base, state: "development", canOperate: true, deviceRegistered: true,
      features: { recipes: true, qrOrdering: true, kds: true }, message: "Development build. Commercial license checks are not enabled." };
    const saved = this.saved();
    const devices = this.activeDevices();
    base.registeredDevices = devices.length;
    base.revision = saved.revision || null;
    if (now + 300_000 < saved.last_seen_at) return { ...base, state: "clock_error", message: "The server clock moved backwards. Correct its date and time." };
    if (now > saved.last_seen_at + 60_000) this.app.db.prepare("UPDATE license_state SET last_seen_at = ? WHERE id = 1").run(now);
    if (!saved.envelope) return base;
    let claims: LicenseClaims;
    try { claims = this.claims(saved.envelope); }
    catch { return { ...base, state: "invalid", message: "The saved license is invalid. Import a valid license." }; }
    if (claims.issuedAt > now + 300_000 || claims.revision !== saved.revision || claims.licenseId !== saved.license_id
      || claims.organizationId !== saved.organization_id || claims.outletId !== saved.outlet_id) {
      return { ...base, state: "invalid", message: "The saved license or server time is invalid." };
    }
    const state = now >= claims.graceUntil ? "expired" : now >= claims.expiresAt ? "grace" : "active";
    const hash = deviceHash(credential);
    const currentDevice = devices.find((d) => d.credential_hash === hash);
    const deviceRegistered = devices.slice(0, claims.maxDevices).some((d) => d.credential_hash === hash);
    if (deviceRegistered && currentDevice && state !== "expired" && (currentDevice.last_seen_at === null || now - currentDevice.last_seen_at >= 60_000)) {
      this.app.db.prepare("UPDATE licensed_devices SET last_seen_at = ? WHERE id = ?").run(now, currentDevice.id);
    }
    return { ...base, state, plan: claims.plan, maxDevices: claims.maxDevices, features: claims.features,
      expiresAt: claims.expiresAt, graceUntil: claims.graceUntil, deviceRegistered, trial: claims.trial === true,
      canOperate: state !== "expired" && deviceRegistered,
      message: state === "expired" ? "Your offline license has expired. Renew it to resume billing."
        : currentDevice && !deviceRegistered ? "This browser exceeds your plan's device limit. An administrator can remove an unused device or upgrade the plan."
        : !deviceRegistered ? "An administrator must register this browser before it can be used for billing."
        : state === "grace" ? "License renewal is due. Billing remains available until the grace period ends."
        : "Your plan is active." };
  }
  preview(envelope: string): LicensePreview {
    const claims = this.claims(envelope);
    const now = this.now(), saved = this.saved();
    if (now + 300_000 < saved.last_seen_at) throw httpError(409, "Correct the server clock before activating");
    if (claims.issuedAt > now + 300_000 || now >= claims.graceUntil) throw httpError(400, "License is not currently valid");
    const alreadyInstalled = saved.envelope === envelope && saved.revision === claims.revision;
    if (!alreadyInstalled && claims.revision <= saved.revision) throw httpError(409, "A newer license has already been installed");
    if (saved.license_id && (saved.organization_id !== claims.organizationId || saved.outlet_id !== claims.outletId || saved.license_id !== claims.licenseId)) {
      throw httpError(409, "A license cannot transfer this installation to another subscription or outlet");
    }
    const devices = this.activeDevices();
    let currentPlan: LicensePreview["currentPlan"] = null;
    try { if (saved.envelope) currentPlan = this.claims(saved.envelope).plan; } catch { /* Recovery from a damaged grant remains possible. */ }
    const previewKey = createHash("sha256").update(JSON.stringify({ envelope, saved: { envelope: saved.envelope, revision: saved.revision },
      devices: devices.map((d) => ({ id: d.id, name: d.name, version: d.version })) })).digest("hex");
    return { previewKey, alreadyInstalled, currentPlan, plan: claims.plan, revision: claims.revision, maxDevices: claims.maxDevices,
      features: claims.features, expiresAt: claims.expiresAt, graceUntil: claims.graceUntil, trial: claims.trial === true,
      blockedDevices: devices.slice(claims.maxDevices).map((d) => ({ id: d.id, name: d.name })) };
  }
  activate(envelope: string, actorName = "Administrator", previewKey?: string) {
    this.app.db.transaction(() => {
      const preview = this.preview(envelope), claims = this.claims(envelope), now = this.now();
      const saved = this.saved();
      if (preview.alreadyInstalled) return;
      if (previewKey && preview.previewKey !== previewKey) throw httpError(409, "The license or registered devices changed. Preview this license again before applying it.");
      this.app.db.prepare("UPDATE license_state SET envelope = ?, revision = ?, last_seen_at = ?, license_id = ?, organization_id = ?, outlet_id = ? WHERE id = 1")
        .run(envelope, claims.revision, Math.max(now, saved.last_seen_at), claims.licenseId, claims.organizationId, claims.outletId);
      this.audit("license_activated", `${claims.plan === "pro" ? "Pro" : "Basic"} license applied: revision ${claims.revision}, ${claims.maxDevices} devices.`, actorName, claims.revision);
    })();
  }
  devices(credential?: unknown): LicensedDevice[] {
    const status = this.status(credential);
    const hash = deviceHash(credential);
    return this.activeDevices().map((d, index) => ({ id: d.id, name: d.name, createdAt: d.created_at,
      lastSeenAt: d.last_seen_at, version: d.version,
      current: d.credential_hash === hash, allowed: status.maxDevices !== null && index < status.maxDevices }));
  }
  register(credential: unknown, name: string, actorName = "Administrator") {
    const hash = deviceHash(credential);
    if (!hash) throw httpError(400, "This browser has no valid device credential");
    this.app.db.transaction(() => {
      const status = this.status(credential);
      if (status.state !== "active" && status.state !== "grace") throw httpError(403, "An active license is required to register devices");
      const old = this.activeDevices().find((d) => d.credential_hash === hash);
      if (old) {
        if (old.name !== name) this.rename(old.id, name, old.version, actorName);
        return;
      }
      if (this.activeDevices().length >= status.maxDevices!) throw httpError(409, "Device limit reached. Remove an old device or upgrade your plan.");
      this.app.db.prepare(`INSERT INTO licensed_devices (id, credential_hash, name, created_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(credential_hash) DO UPDATE SET name = excluded.name, created_at = excluded.created_at, revoked_at = NULL, last_seen_at = NULL, version = licensed_devices.version + 1`)
        .run(randomUUID(), hash, name, this.now());
      const id = this.activeDevices().find((d) => d.credential_hash === hash)!.id;
      this.audit("device_registered", `Registered ${name}.`, actorName, null, id);
    })();
  }
  rename(id: string, name: string, version: number, actorName = "Administrator") {
    this.app.db.transaction(() => {
      const device = this.activeDevices().find((d) => d.id === id);
      if (!device) throw httpError(404, "Device not found");
      if (device.version !== version) throw httpError(409, "This device changed. Refresh the device list and try again.");
      if (device.name === name) return;
      this.app.db.prepare("UPDATE licensed_devices SET name = ?, version = version + 1 WHERE id = ?").run(name, id);
      this.audit("device_renamed", `Renamed ${device.name} to ${name}.`, actorName, null, id);
    })();
  }
  revoke(id: string, actorName = "Administrator", version?: number) {
    this.app.db.transaction(() => {
      const device = this.app.db.prepare("SELECT * FROM licensed_devices WHERE id = ?").get(id) as DeviceRow | undefined;
      if (!device) throw httpError(404, "Device not found");
      if (device.revoked_at !== null) return;
      if (version !== undefined && device.version !== version) throw httpError(409, "This device changed. Refresh the device list and try again.");
      this.app.db.prepare("UPDATE licensed_devices SET revoked_at = ?, version = version + 1 WHERE id = ?").run(this.now(), id);
      this.app.db.prepare("DELETE FROM sessions WHERE device = ?").run(device.credential_hash);
      this.audit("device_removed", `Removed ${device.name}.`, actorName, null, id);
    })();
  }
  history(before?: number): LicenseHistory {
    const rows = this.app.db.prepare(`SELECT id, occurred_at AS occurredAt, actor_name AS actorName, kind, summary, revision, device_id AS deviceId
      FROM license_events WHERE id < ? ORDER BY id DESC LIMIT 21`).all(before ?? Number.MAX_SAFE_INTEGER) as LicenseEvent[];
    return { events: rows.slice(0, 20), nextBefore: rows.length > 20 ? rows[19]!.id : null };
  }
  activationRequest(): ActivationRequest {
    if (!this.options) throw httpError(409, "This development build does not need activation");
    const saved = this.saved();
    return { format: "forkflow-activation-request", version: 1, installationId: this.options.installationId, licenseId: saved.license_id,
      organizationId: saved.organization_id, outletId: saved.outlet_id, currentRevision: saved.revision, generatedAt: this.now(),
      verificationKeyFingerprint: createHash("sha256").update(createPublicKey(this.options.publicKey).export({ type: "spki", format: "der" })).digest("hex") };
  }
  private inflight: Promise<LicenseCheckResult> | null = null;
  /**
   * Asks the licensing service for this installation's latest licence. Never throws, and never touches
   * `canOperate` unless the existing activate() checks accept a newer licence. Simultaneous calls share one request.
   */
  fetchLatest(): Promise<LicenseCheckResult> {
    return this.inflight ??= this.fetchOnce().finally(() => { this.inflight = null; });
  }
  private async fetchOnce(): Promise<LicenseCheckResult> {
    const result = (outcome: LicenseCheckResult["outcome"], detail?: string): LicenseCheckResult =>
      ({ outcome, message: CHECK_MESSAGES[outcome], ...(detail ? { detail } : {}) });
    const serviceUrl = this.options?.serviceUrl;
    if (!serviceUrl) return result("disabled");
    let license: string | null;
    try {
      const response = await (this.options?.fetch ?? fetch)(`${serviceUrl}/v1/activate`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(this.activationRequest()),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (response.status === 409 && (await response.json() as { error?: unknown } | null)?.error === "wrong_key") {
        return result("rejected", "The licensing service signs with a different key than this build trusts");
      }
      if (!response.ok) return result("unreachable");
      license = serviceReply.parse(await response.json()).license;
    } catch { return result("unreachable"); }
    if (license === null) return result("up_to_date");
    try {
      const revision = this.saved().revision;
      this.activate(license.trim(), AUTOMATIC_ACTOR);
      return result(this.saved().revision === revision ? "up_to_date" : "installed");
    } catch (error) { return result("rejected", error instanceof Error ? error.message : "The licence could not be installed"); }
  }
  /** Checks now and every 6 hours; failures are only logged. Returns a function that stops the checks. */
  startRenewalChecks(log: (message: string) => void): () => void {
    let stopped = false;
    const check = () => { void this.fetchLatest().then((r) => {
      if (stopped) return;
      if (r.outcome === "installed") this.announceChange();
      if (r.outcome !== "up_to_date" && r.outcome !== "disabled") log(r.detail ? `${r.message} (${r.detail})` : r.message);
    }); };
    check();
    const timer = setInterval(check, RENEWAL_INTERVAL_MS); timer.unref();
    return () => { stopped = true; clearInterval(timer); };
  }
  /** Close sockets a licence change revoked before telling the remaining clients. */
  announceChange() { this.app.wsRevalidate(); this.app.broadcast("license.changed", {}); }
  /** Whether a session created on `sessionDevice` may be used by the request's device credential. */
  deviceAllowed(sessionDevice: string | null | undefined, credential: unknown) {
    if (!this.enabled) return true;
    const hash = deviceHash(credential);
    return hash !== null && sessionDevice === hash;
  }
  sessionAllowed(token: string, credential: unknown) {
    if (!this.enabled) return true;
    const row = this.app.db.prepare("SELECT device FROM sessions WHERE token = ?").get(token) as { device: string | null } | undefined;
    return this.deviceAllowed(row?.device, credential);
  }
  assertAccess(req: FastifyRequest) {
    if (!this.enabled) return;
    const path = req.routeOptions.url;
    // Authentication and license recovery are available from unregistered devices.
    if (path === "/api/me" || path === "/api/logout" || path?.startsWith("/api/license")) return;
    // Never charge for access to backups, even after a subscription expires.
    if (path?.startsWith("/api/system/backups")) return;
    const status = this.status(req.headers["x-forkflow-device"]);
    if (!status.canOperate) throw httpError(403, status.message);
  }
  assertFeature(feature: Feature, credential: unknown) {
    const status = this.status(credential);
    if (!status.canOperate) throw httpError(403, status.message);
    if (!status.features[feature]) throw httpError(403, `This feature requires a plan with ${FEATURE_NAMES[feature]}`);
  }
}

export function configureLicensing(app: FastifyInstance, options?: LicensingOptions) {
  app.decorate("licensing", new Licensing(app, options));
  app.decorate("requireFeature", (feature: Feature): preHandlerHookHandler => async (req) => {
    app.licensing.assertFeature(feature, req.headers["x-forkflow-device"]);
  });
}
export function registerLicensing(app: FastifyInstance) {
  const manage = app.requirePermission("settings.manage");
  const licenseBody = z.object({ license: z.string().trim().min(1).max(16_384) });
  const deviceName = z.string().trim().min(1).max(80);
  const licenseChanged = () => app.licensing.announceChange();
  app.get("/api/license", { preHandler: app.requireAuth }, async (req, reply) => {
    reply.header("Cache-Control", "no-store"); return app.licensing.status(req.headers["x-forkflow-device"]);
  });
  app.post("/api/license/preview", { preHandler: manage }, async (req, reply) => {
    const { license } = licenseBody.parse(req.body);
    reply.header("Cache-Control", "no-store"); return app.licensing.preview(license);
  });
  app.put("/api/license", { preHandler: manage }, async (req) => {
    const { license, previewKey } = licenseBody.extend({ previewKey: z.string().regex(/^[a-f0-9]{64}$/).optional() }).parse(req.body);
    app.licensing.activate(license, req.user.name, previewKey); licenseChanged();
    return app.licensing.status(req.headers["x-forkflow-device"]);
  });
  app.post("/api/license/check", { preHandler: manage }, async (req, reply) => {
    const result = await app.licensing.fetchLatest();
    if (result.outcome === "installed") licenseChanged();
    reply.header("Cache-Control", "no-store"); return { ...result, status: app.licensing.status(req.headers["x-forkflow-device"]) };
  });
  app.get("/api/license/activation-request", { preHandler: manage }, async (_req, reply) => {
    reply.header("Cache-Control", "no-store"); return app.licensing.activationRequest();
  });
  app.get("/api/license/history", { preHandler: manage }, async (req, reply) => {
    const { before } = z.object({ before: z.coerce.number().int().positive().safe().optional() }).parse(req.query);
    reply.header("Cache-Control", "no-store"); return app.licensing.history(before);
  });
  app.get("/api/license/devices", { preHandler: manage }, async (req, reply) => {
    reply.header("Cache-Control", "no-store"); return { devices: app.licensing.devices(req.headers["x-forkflow-device"]) };
  });
  app.post("/api/license/devices", { preHandler: manage }, async (req) => {
    const { name } = z.object({ name: deviceName }).parse(req.body);
    app.licensing.register(req.headers["x-forkflow-device"], name, req.user.name); licenseChanged();
    return { devices: app.licensing.devices(req.headers["x-forkflow-device"]) };
  });
  app.patch("/api/license/devices/:id", { preHandler: manage }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { name, version } = z.object({ name: deviceName, version: z.number().int().positive() }).parse(req.body);
    app.licensing.rename(id, name, version, req.user.name); licenseChanged();
    return { devices: app.licensing.devices(req.headers["x-forkflow-device"]) };
  });
  app.delete("/api/license/devices/:id", { preHandler: manage }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { version } = z.object({ version: z.number().int().positive().optional() }).parse(req.body ?? {});
    app.licensing.revoke(id, req.user.name, version); licenseChanged();
    return reply.status(204).send();
  });
}

declare module "fastify" {
  interface FastifyInstance {
    licensing: Licensing;
    requireFeature(feature: Feature): preHandlerHookHandler;
  }
}
