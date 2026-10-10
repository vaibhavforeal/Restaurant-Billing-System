import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { verifyLicenseSignature } from "@forkflow/core";
import { LicenseClaims } from "@forkflow/domain/licensing";
import { webCryptoSigner } from "@forkflow/license-issuer";
import { handleActivate, type Deps } from "./activate.js";
import type { D1Like } from "./env.js";
import { getInstallation } from "./store.js";
import { memoryD1 } from "./testing/d1.js";

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 9, 10, 10, 0, 0);
const pair = generateKeyPairSync("ed25519");
const publicPem = pair.publicKey.export({ type: "spki", format: "pem" }).toString();
const privatePem = pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const installationId = "44444444-4444-4444-8444-444444444444";

let signer: Deps["signer"];
let db: D1Like;
let now: number;
let deps: Deps;
beforeAll(async () => { signer = await webCryptoSigner(privatePem); });
beforeEach(() => {
  db = memoryD1();
  now = T0;
  deps = { db, signer, now: () => now, uuid: () => randomUUID() };
});

const request = (over: Record<string, unknown> = {}) => ({
  format: "forkflow-activation-request", version: 1, installationId, licenseId: null, organizationId: null, outletId: null,
  currentRevision: 0, generatedAt: T0, verificationKeyFingerprint: signer.fingerprint, ...over,
});
const activate = async (over: Record<string, unknown> = {}) => {
  const res = await handleActivate(deps, request(over));
  return { status: res.status, type: res.headers.get("content-type"), body: await res.json() as { license?: string | null; error?: string } };
};
const claimsOf = (envelope: string) => LicenseClaims.parse(verifyLicenseSignature(envelope.trim(), publicPem));
const count = async (table: string) => (await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>())?.n;

describe("POST /v1/activate", () => {
  it("first contact gets one 14-day Pro trial", async () => {
    const res = await activate();
    expect(res.status).toBe(200);
    expect(res.type).toContain("application/json");
    const claims = claimsOf(res.body.license!);
    expect(claims).toMatchObject({ plan: "pro", trial: true, revision: 1, installationId, issuedAt: T0 });
    expect(claims.expiresAt - claims.issuedAt).toBe(14 * DAY);
    expect(claims.graceUntil).toBe(claims.expiresAt);
    expect(await getInstallation(db, installationId)).toMatchObject({ licenseId: claims.licenseId, organizationId: claims.organizationId, outletId: claims.outletId, trialStartedAt: T0 });
  });

  it("repeat contact returns the same trial, never a new one", async () => {
    const first = await activate();
    now += DAY;
    expect((await activate({ currentRevision: 0 })).body.license).toBe(first.body.license);
    expect((await activate({ currentRevision: 1 })).body.license).toBeNull();
    expect(await count("licenses")).toBe(1);
  });

  it("an expired trial is not renewed", async () => {
    await activate();
    now += 30 * DAY;
    expect((await activate({ currentRevision: 1 })).body).toEqual({ license: null });
    expect(await count("licenses")).toBe(1);
  });

  it("concurrent first contacts create one installation", async () => {
    let n = 0;
    const racing: Deps = { ...deps, now: () => T0 + n++, uuid: () => randomUUID() };
    const [a, b] = await Promise.all([handleActivate(racing, request()), handleActivate(racing, request())]);
    const [x, y] = [await a.json() as { license: string }, await b.json() as { license: string }];
    expect(x.license).toBeTruthy();
    expect(y.license).toBe(x.license);
    expect(await count("installations")).toBe(1);
    expect(await count("licenses")).toBe(1);
  });

  it("a hand-issued installation is adopted without a trial", async () => {
    const ids = { licenseId: randomUUID(), organizationId: randomUUID(), outletId: randomUUID() };
    expect((await activate({ ...ids, currentRevision: 3 })).body).toEqual({ license: null });
    expect(await getInstallation(db, installationId)).toMatchObject({ ...ids, revisionFloor: 3, trialStartedAt: null });
    expect(await count("licenses")).toBe(0);
  });

  it("a known installation never gets a trial after adoption", async () => {
    await activate({ licenseId: randomUUID(), organizationId: randomUUID(), outletId: randomUUID(), currentRevision: 3 });
    expect((await activate({ currentRevision: 3 })).body).toEqual({ license: null });
    expect(await count("licenses")).toBe(0);
  });

  it("wrong verification key is refused", async () => {
    const res = await activate({ verificationKeyFingerprint: "0".repeat(64) });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: "wrong_key" });
    expect(await count("installations")).toBe(0);
  });

  it("malformed request is refused", async () => {
    expect((await handleActivate(deps, {})).status).toBe(400);
    expect((await handleActivate(deps, null)).status).toBe(400);
    expect(await count("installations")).toBe(0);
  });
});
