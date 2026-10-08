import { describe, expect, it } from "vitest";
import { createHash, generateKeyPairSync, createPublicKey, verify } from "node:crypto";
import { LicenseClaims } from "../packages/domain/src/licensing.js";
import { buildClaims, keyFingerprint, parseActivationRequest, signClaims } from "./license-claims.js";

const now = Date.UTC(2026, 9, 5, 10, 0, 0);
const DAY = 24 * 60 * 60 * 1000;
const ids = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222", "33333333-3333-4333-8333-333333333333"];
const fakeUuid = () => { let i = 0; return () => ids[i++]!; };
const installationId = "44444444-4444-4444-8444-444444444444";
const firstRequest = { format: "forkflow-activation-request", version: 1, installationId, licenseId: null, organizationId: null, outletId: null,
  currentRevision: 0, generatedAt: now, verificationKeyFingerprint: "a".repeat(64) };

describe("activation request", () => {
  it("accepts the app's activation request and rejects anything else", () => {
    expect(parseActivationRequest(JSON.stringify(firstRequest)).installationId).toBe(installationId);
    expect(parseActivationRequest("\uFEFF" + JSON.stringify(firstRequest)).installationId).toBe(installationId);
    expect(() => parseActivationRequest(JSON.stringify({ ...firstRequest, format: "other" }))).toThrow(/activation request/);
    expect(() => parseActivationRequest("not json")).toThrow(/activation request/);
  });
});

describe("buildClaims", () => {
  it("creates fresh ids at revision 1 for a first activation", () => {
    const claims = buildClaims(parseActivationRequest(JSON.stringify(firstRequest)), { plan: "pro", months: 12, graceDays: 7 }, now, fakeUuid());
    expect(claims).toMatchObject({ version: 1, licenseId: ids[0], organizationId: ids[1], outletId: ids[2], installationId, revision: 1, plan: "pro",
      maxDevices: 5, features: { recipes: true, qrOrdering: true, kds: true }, issuedAt: now });
    expect(claims.expiresAt).toBe(Date.UTC(2027, 9, 5, 10, 0, 0));
    expect(claims.graceUntil).toBe(claims.expiresAt + 7 * DAY);
    expect(LicenseClaims.parse(claims)).toEqual(claims);
  });

  it("reuses ids and bumps the revision for a renewal or plan change", () => {
    const renewal = { ...firstRequest, licenseId: ids[0], organizationId: ids[1], outletId: ids[2], currentRevision: 3 };
    const claims = buildClaims(parseActivationRequest(JSON.stringify(renewal)), { plan: "basic", months: 1, graceDays: 0 }, now, () => { throw new Error("no new ids on renewal"); });
    expect(claims).toMatchObject({ licenseId: ids[0], organizationId: ids[1], outletId: ids[2], revision: 4, plan: "basic", maxDevices: 2,
      features: { recipes: false, qrOrdering: false, kds: false } });
    expect(claims.expiresAt).toBe(Date.UTC(2026, 10, 5, 10, 0, 0));
    expect(claims.graceUntil).toBe(claims.expiresAt);
  });

  it("rejects a bad plan, length or grace period", () => {
    const request = parseActivationRequest(JSON.stringify(firstRequest));
    expect(() => buildClaims(request, { plan: "gold" as "pro", months: 12, graceDays: 7 }, now, fakeUuid())).toThrow(/plan/);
    expect(() => buildClaims(request, { plan: "pro", months: 0, graceDays: 7 }, now, fakeUuid())).toThrow(/months/);
    expect(() => buildClaims(request, { plan: "pro", months: 1.5, graceDays: 7 }, now, fakeUuid())).toThrow(/months/);
    expect(() => buildClaims(request, { plan: "pro", months: 12, graceDays: -1 }, now, fakeUuid())).toThrow(/grace/);
  });
});

describe("signing", () => {
  const pair = generateKeyPairSync("ed25519");
  const privatePem = pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const expectedFingerprint = createHash("sha256").update(pair.publicKey.export({ type: "spki", format: "der" })).digest("hex");

  it("computes the same key fingerprint as the installed app", () => {
    expect(keyFingerprint(privatePem)).toBe(expectedFingerprint);
  });

  it("signs a license the app can verify", () => {
    const claims = buildClaims(parseActivationRequest(JSON.stringify(firstRequest)), { plan: "pro", months: 12, graceDays: 7 }, now, fakeUuid());
    const license = signClaims(claims, privatePem);
    const [prefix, payload, signature] = license.trim().split(".");
    expect(prefix).toBe("ff1");
    expect(JSON.parse(Buffer.from(payload!, "base64url").toString())).toEqual(claims);
    expect(verify(null, Buffer.from(`ff1.${payload}`), createPublicKey(privatePem), Buffer.from(signature!, "base64url"))).toBe(true);
  });

  it("refuses a non-Ed25519 key", () => {
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    expect(() => keyFingerprint(rsa)).toThrow(/Ed25519/);
  });
});

describe("with the real app", () => {
  it("activates from the app's own request, then renews as the next revision", async () => {
    const { openDb, migrate, MIGRATIONS } = await import("../packages/domain/src/index.js");
    const { buildServer } = await import("../apps/server/src/server.js");
    const pair = generateKeyPairSync("ed25519");
    const privatePem = pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const db = openDb(":memory:"); migrate(db, MIGRATIONS);
    const app = buildServer({ db, licensing: { publicKey: pair.publicKey.export({ type: "spki", format: "pem" }).toString(), installationId } });
    try {
      const device = "b".repeat(64);
      const setup = await app.inject({ method: "POST", url: "/api/setup", headers: { "x-forkflow-device": device }, payload: { restaurantName: "Cafe", adminName: "Asha", pin: "1234" } });
      const headers = { authorization: `Bearer ${setup.json().token}`, "x-forkflow-device": device };
      const requestText = (await app.inject({ url: "/api/license/activation-request", headers })).body;
      const request = parseActivationRequest(requestText);
      expect(keyFingerprint(privatePem)).toBe(request.verificationKeyFingerprint);

      const first = signClaims(buildClaims(request, { plan: "pro", months: 12, graceDays: 7 }, Date.now()), privatePem);
      const applied = await app.inject({ method: "PUT", url: "/api/license", headers, payload: { license: first } });
      expect(applied.statusCode, applied.body).toBe(200);
      expect(applied.json()).toMatchObject({ plan: "pro", maxDevices: 5, revision: 1 });

      const renewalRequest = parseActivationRequest((await app.inject({ url: "/api/license/activation-request", headers })).body);
      const renewal = signClaims(buildClaims(renewalRequest, { plan: "basic", months: 1, graceDays: 0 }, Date.now()), privatePem);
      const renewed = await app.inject({ method: "PUT", url: "/api/license", headers, payload: { license: renewal } });
      expect(renewed.statusCode, renewed.body).toBe(200);
      expect(renewed.json()).toMatchObject({ plan: "basic", maxDevices: 2, revision: 2 });
    } finally { await app.close(); db.close(); }
  });
});
