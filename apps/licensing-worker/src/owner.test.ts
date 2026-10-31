import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { verifyLicenseSignature } from "@masalapos/core";
import { LicenseClaims } from "@masalapos/domain/licensing";
import { webCryptoSigner } from "@masalapos/license-issuer";
import type { Env } from "./env.js";
import worker from "./index.js";
import { issueLicense } from "./issue.js";
import { SECRET_HEADER } from "./secret.js";
import { getInstallation, upsertOwnerSettingsStatement } from "./store.js";
import { memoryD1 } from "./testing/d1.js";
import { TEST_SECRET } from "./testing/secret.js";
// Test-only: the Worker source never imports the counter server or the domain index.
import { MIGRATIONS, migrate, openDb } from "../../../packages/domain/src/index.js";
import { buildServer } from "../../server/src/server.js";

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 9, 10, 10, 0, 0);
const ORIGIN = "https://licensing.example";
const PASSWORD = "correct horse battery staple";
const pair = generateKeyPairSync("ed25519");
const publicPem = pair.publicKey.export({ type: "spki", format: "pem" }).toString();
const privatePem = pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const installationId = "77777777-7777-4777-8777-777777777777";

let env: Env;
let allowed: boolean;
let fingerprint: string;
beforeAll(async () => { vi.useFakeTimers({ toFake: ["Date"] }); fingerprint = (await webCryptoSigner(privatePem)).fingerprint; });
beforeEach(() => {
  vi.setSystemTime(T0);
  allowed = true;
  env = {
    DB: memoryD1(), LIMITER: { limit: async () => ({ success: allowed }) },
    RAZORPAY_KEY_ID: "k", RAZORPAY_KEY_SECRET: "s", RAZORPAY_WEBHOOK_SECRET: "w", LICENSE_SIGNING_KEY: privatePem,
    RAZORPAY_PLAN_BASIC_MONTHLY: "a", RAZORPAY_PLAN_BASIC_YEARLY: "b", RAZORPAY_PLAN_PRO_MONTHLY: "c", RAZORPAY_PLAN_PRO_YEARLY: "d",
    OWNER_PASSWORD: PASSWORD,
  };
});
afterEach(() => { vi.restoreAllMocks(); });

const send = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => worker.fetch(new Request(`${ORIGIN}${path}`, {
  method, headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...(method === "GET" ? {} : { origin: ORIGIN }), ...headers },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
}), env);
async function login(password = PASSWORD) {
  const res = await send("POST", "/owner/api/login", { password });
  const cookie = res.headers.get("set-cookie")?.split(";")[0] ?? "";
  return { res, cookie };
}
async function activate(currentRevision = 0, held?: { licenseId: string; organizationId: string; outletId: string }) {
  const res = await send("POST", "/v1/activate", {
    format: "masalapos-activation-request", version: 1, installationId, licenseId: held?.licenseId ?? null, organizationId: held?.organizationId ?? null,
    outletId: held?.outletId ?? null, currentRevision, generatedAt: Date.now(), verificationKeyFingerprint: fingerprint,
  }, { [SECRET_HEADER]: TEST_SECRET });
  const license = (await res.json() as { license: string | null }).license;
  return license ? LicenseClaims.parse(verifyLicenseSignature(license.trim(), publicPem)) : null;
}

describe("owner control panel", () => {
  it("serves the panel under a strict content security policy and keeps the API behind a login", async () => {
    const page = await send("GET", "/owner");
    expect(page.status).toBe(200);
    expect(page.headers.get("content-security-policy")).toContain("script-src 'self'");
    expect(await page.text()).toContain('<script src="/owner/app.js">');
    expect((await send("GET", "/owner/app.js")).headers.get("content-type")).toContain("javascript");
    expect((await send("GET", "/owner/api/restaurants")).status).toBe(401);
    expect((await send("GET", "/owner/api/restaurants", undefined, { cookie: "ff_owner=" + "A".repeat(43) })).status).toBe(401);
  });

  it("checks the password, the origin and the rate limit, and signs out", async () => {
    expect((await login("wrong password!!")).res.status).toBe(401);
    const noOrigin = await worker.fetch(new Request(`${ORIGIN}/owner/api/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: PASSWORD }) }), env);
    expect(noOrigin.status).toBe(403);
    allowed = false;
    expect((await login()).res.status).toBe(429);
    allowed = true;
    const { res, cookie } = await login();
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toMatch(/HttpOnly; Secure; SameSite=Strict; Max-Age=28800/);
    expect((await send("GET", "/owner/api/restaurants", undefined, { cookie })).status).toBe(200);
    vi.setSystemTime(T0 + 9 * 60 * 60 * 1000);
    expect((await send("GET", "/owner/api/restaurants", undefined, { cookie })).status).toBe(401);
    vi.setSystemTime(T0);
    const again = await login();
    expect((await send("POST", "/owner/api/logout", {}, { cookie: again.cookie })).status).toBe(200);
    expect((await send("GET", "/owner/api/restaurants", undefined, { cookie: again.cookie })).status).toBe(401);
  });

  it("stays closed while no owner password is set", async () => {
    delete env.OWNER_PASSWORD;
    expect((await login()).res.status).toBe(503);
  });

  it("signs the owner's module choices into the restaurant's next licence revision", async () => {
    const trial = (await activate())!;
    expect(trial).toMatchObject({ revision: 1, plan: "pro", trial: true });
    expect(trial.modules.reservations).toBe(true);
    const held = { licenseId: trial.licenseId, organizationId: trial.organizationId, outletId: trial.outletId };
    const { cookie } = await login();

    const list = await (await send("GET", "/owner/api/restaurants", undefined, { cookie })).json() as { modules: unknown[]; restaurants: Array<{ installationId: string; updatedAt: number | null; licence: { delivered: boolean; revision: number }; allowed: Record<string, boolean> }> };
    expect(list.modules).toHaveLength(12);
    expect(list.restaurants[0]).toMatchObject({ installationId, updatedAt: null, licence: { revision: 1, delivered: true }, allowed: { reservations: true } });

    const changed = await send("PATCH", `/owner/api/restaurants/${installationId}`, { displayName: "Spice Route", modules: { reservations: false, kds: true }, expectedUpdatedAt: null }, { cookie });
    expect(changed.status, await changed.clone().text()).toBe(200);
    const body = await changed.json() as { issuedRevision: number; restaurant: { displayName: string; updatedAt: number; overrides: object; licence: { delivered: boolean } } };
    expect(body).toMatchObject({ issuedRevision: 2, restaurant: { displayName: "Spice Route", overrides: { reservations: false, kds: true }, licence: { delivered: false } } });

    // The counter picks the change up on its next check: same terms, new modules, trial kept.
    const next = (await activate(1, held))!;
    expect(next).toMatchObject({ revision: 2, plan: "pro", trial: true, expiresAt: trial.expiresAt });
    expect(next.modules).toMatchObject({ reservations: false, kds: true });

    // A stale edit is refused; null goes back to the plan.
    expect((await send("PATCH", `/owner/api/restaurants/${installationId}`, { modules: { reservations: null }, expectedUpdatedAt: null }, { cookie })).status).toBe(409);
    const restored = await send("PATCH", `/owner/api/restaurants/${installationId}`, { modules: { reservations: null }, expectedUpdatedAt: body.restaurant.updatedAt }, { cookie });
    expect((await restored.json() as { issuedRevision: number }).issuedRevision).toBe(3);
    expect((await activate(2, held))!.modules.reservations).toBe(true);

    const events = await (await send("GET", `/owner/api/restaurants/${installationId}/events`, undefined, { cookie })).json() as { events: Array<{ moduleId: string; allowed: boolean | null; revision: number }> };
    expect(events.events.map((e) => [e.moduleId, e.allowed, e.revision])).toEqual([["reservations", null, 3], ["kds", true, 2], ["reservations", false, 2]]);

    // Renaming alone issues no licence; an unknown module is refused.
    const renamed = await send("PATCH", `/owner/api/restaurants/${installationId}`, { displayName: "Spice Route Café", expectedUpdatedAt: (await (await send("GET", "/owner/api/restaurants", undefined, { cookie })).json() as typeof list).restaurants[0]!.updatedAt }, { cookie });
    const renamedBody = await renamed.json() as { issuedRevision: number | null; restaurant: { updatedAt: number } };
    expect(renamedBody.issuedRevision).toBeNull();
    const unknown = await send("PATCH", `/owner/api/restaurants/${installationId}`, { modules: { payroll: true }, expectedUpdatedAt: renamedBody.restaurant.updatedAt }, { cookie });
    expect(unknown.status).toBe(400);
    expect((await unknown.json() as { error: string }).error).toBe('Unknown module "payroll"');
  });

  it("keeps the owner's choices on paid licences and issues nothing for an expired restaurant", async () => {
    await activate();
    const installation = (await getInstallation(env.DB, installationId))!;
    await upsertOwnerSettingsStatement(env.DB, installationId, null, { crm: false }, T0).run();
    const signer = await webCryptoSigner(privatePem);
    const deps = { db: env.DB, signer, now: () => Date.now(), uuid: () => randomUUID() };
    const { row } = await issueLicense(deps, { installation, plan: "basic", expiresAt: T0 + 30 * DAY, graceUntil: T0 + 37 * DAY, trial: false, reason: "charge", subscriptionId: "sub_1", paymentId: "pay_1" });
    const claims = LicenseClaims.parse(verifyLicenseSignature(row.envelope.trim(), publicPem));
    expect(claims.modules).toMatchObject({ crm: false, reservations: true, kds: false });
    expect(claims.features).toEqual({ recipes: false, qrOrdering: false, kds: false });

    // Past the trial's end nothing is re-issued; the next payment carries the change.
    vi.setSystemTime(T0 + 15 * DAY);
    const { cookie } = await login();
    const res = await send("PATCH", `/owner/api/restaurants/${installationId}`, { modules: { kds: true }, expectedUpdatedAt: T0 }, { cookie });
    expect((await res.json() as { issuedRevision: number | null }).issuedRevision).toBeNull();
  });

  it("reaches a real counter: the owner blocks a module and the counter refuses it after its next check", async () => {
    const db = openDb(":memory:"); migrate(db, MIGRATIONS);
    const counter = buildServer({ db, licensing: {
      publicKey: publicPem, installationId, installationSecret: TEST_SECRET, serviceUrl: ORIGIN, now: () => Date.now(),
      fetch: (async (input: string | URL | Request, init?: RequestInit) => worker.fetch(new Request(String(input), init), env)) as typeof fetch,
    } });
    try {
      const device = "f".repeat(64);
      const setup = await counter.inject({ method: "POST", url: "/api/setup", payload: { restaurantName: "Spice Route", adminName: "Asha", pin: "1234" }, headers: { "x-masalapos-device": device } });
      const headers = { authorization: `Bearer ${setup.json().token}`, "x-masalapos-device": device };
      expect((await counter.licensing.fetchLatest()).outcome).toBe("installed");
      expect((await counter.inject({ method: "POST", url: "/api/license/devices", payload: { name: "Counter" }, headers })).statusCode).toBe(200);
      const reservations = async () => (await counter.inject({ url: "/api/modules", headers })).json().modules.find((m: { id: string }) => m.id === "reservations");
      expect(await reservations()).toMatchObject({ allowed: true, active: true });

      const { cookie } = await login();
      expect((await send("PATCH", `/owner/api/restaurants/${installationId}`, { modules: { reservations: false }, expectedUpdatedAt: null }, { cookie })).status).toBe(200);
      expect((await counter.licensing.fetchLatest()).outcome).toBe("installed");
      expect(await reservations()).toMatchObject({ allowed: false, active: false, reason: "Not included for this restaurant" });
      const booking = await counter.inject({ method: "POST", url: "/api/reservations", headers, payload: { customerName: "Priya", phone: "9876543210", partySize: 2, startsAt: Date.now() + 86_400_000 } });
      expect(booking.statusCode).toBe(403);
      expect(booking.json().code).toBe("module_off");
      // The panel now shows the restaurant has collected the change.
      const list = await (await send("GET", "/owner/api/restaurants", undefined, { cookie })).json() as { restaurants: Array<{ licence: { delivered: boolean } }> };
      expect(list.restaurants[0]!.licence.delivered).toBe(true);
    } finally { await counter.close(); db.close(); }
  });
});
