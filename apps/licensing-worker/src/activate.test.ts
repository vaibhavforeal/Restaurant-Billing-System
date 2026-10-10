import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { verifyLicenseSignature } from "@forkflow/core";
import { LicenseClaims } from "@forkflow/domain/licensing";
import { webCryptoSigner } from "@forkflow/license-issuer";
import { handleActivate, type ActivateDeps, type Deps } from "./activate.js";
import type { D1Like } from "./env.js";
import { issueLicense } from "./issue.js";
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
let deps: ActivateDeps;
let logs: string[];
beforeAll(async () => { signer = await webCryptoSigner(privatePem); });
beforeEach(() => {
  db = memoryD1();
  now = T0;
  logs = [];
  deps = { db, signer, now: () => now, uuid: () => randomUUID(), log: (m) => logs.push(m) };
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
    const racing: ActivateDeps = { ...deps, now: () => T0 + n++, uuid: () => randomUUID() };
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

  it("a reported revision above 1,000,000 is refused for adoption and for a known installation", async () => {
    const ids = { licenseId: randomUUID(), organizationId: randomUUID(), outletId: randomUUID() };
    expect(await activate({ ...ids, currentRevision: 1_000_001 })).toMatchObject({ status: 400, body: { error: "bad_request" } });
    expect(await count("installations")).toBe(0);
    await activate({ ...ids, currentRevision: 1_000_000 });
    expect(await activate({ ...ids, currentRevision: 1_000_001 })).toMatchObject({ status: 400, body: { error: "bad_request" } });
    expect((await getInstallation(db, installationId))!.revisionFloor).toBe(1_000_000);
  });
});

describe("POST /v1/activate after a hand-issued licence", () => {
  const PAID_END = T0 + 30 * DAY;
  // The counter's identifiers, as a hand-issued licence for a service-known installation keeps them.
  const held = async () => {
    const i = (await getInstallation(db, installationId))!;
    return { licenseId: i.licenseId, organizationId: i.organizationId, outletId: i.outletId };
  };
  const charge = async (paymentId = "pay_1", expiresAt = PAID_END) => {
    const installation = (await getInstallation(db, installationId))!;
    const { row, statement } = await issueLicense(deps, { installation, plan: "basic", expiresAt, graceUntil: expiresAt + 7 * DAY, trial: false, reason: "charge", subscriptionId: "sub_A", paymentId });
    await statement.run();
    return row;
  };
  const licenses = async () => (await db.prepare(`SELECT revision, reason, razorpay_payment_id AS paymentId FROM licenses ORDER BY revision`).all<{ revision: number; reason: string; paymentId: string | null }>()).results;

  it("a hand-issued revision reported before the charge pushes the paid licence above it", async () => {
    await activate();
    expect((await activate({ ...(await held()), currentRevision: 2 })).body).toEqual({ license: null });
    expect((await getInstallation(db, installationId))!.revisionFloor).toBe(2);
    expect((await charge()).revision).toBe(3);
    const claims = claimsOf((await activate({ ...(await held()), currentRevision: 2 })).body.license!);
    expect(claims).toMatchObject({ revision: 3, plan: "basic", expiresAt: PAID_END, graceUntil: PAID_END + 7 * DAY });
    expect(claims.trial).toBeUndefined();
    expect((await activate({ ...(await held()), currentRevision: 3 })).body).toEqual({ license: null });
  });

  it("a charge stored at the hand-issued revision is re-signed above it, once", async () => {
    await activate();
    const paid = await charge();
    expect(paid.revision).toBe(2);
    now += DAY;
    const res = await activate({ ...(await held()), currentRevision: 2 });
    const claims = claimsOf(res.body.license!);
    expect(claims).toMatchObject({ revision: 3, plan: "basic", expiresAt: PAID_END, graceUntil: PAID_END + 7 * DAY, issuedAt: now });
    expect(claims.trial).toBeUndefined();
    expect(await licenses()).toEqual([
      { revision: 1, reason: "trial", paymentId: null }, { revision: 2, reason: "charge", paymentId: "pay_1" }, { revision: 3, reason: "charge", paymentId: null },
    ]);
    expect(await db.prepare(`SELECT razorpay_subscription_id AS s FROM licenses WHERE revision = 3`).first()).toEqual({ s: "sub_A" });
    expect((await activate({ ...(await held()), currentRevision: 3 })).body).toEqual({ license: null });
    expect((await activate({ ...(await held()), currentRevision: 2 })).body.license).toBe(res.body.license);
    expect(await count("licenses")).toBe(3);
  });

  it("a counter that received the paid licence from the service is not re-signed", async () => {
    await activate();
    const paid = await charge();
    expect((await activate({ ...(await held()), currentRevision: 1 })).body.license).toBe(paid.envelope);
    expect((await activate({ ...(await held()), currentRevision: 2 })).body).toEqual({ license: null });
    expect(await count("licenses")).toBe(2);
  });

  it("an expired charge licence is not re-signed", async () => {
    await activate();
    await charge();
    now = PAID_END + 1;
    expect((await activate({ ...(await held()), currentRevision: 2 })).body).toEqual({ license: null });
    expect(await count("licenses")).toBe(2);
  });

  it("a trial is never re-signed", async () => {
    await activate();
    expect((await activate({ ...(await held()), currentRevision: 2 })).body).toEqual({ license: null });
    expect((await activate({ ...(await held()), currentRevision: 5 })).body).toEqual({ license: null });
    expect(await count("licenses")).toBe(1);
  });

  it("identifiers that differ from the stored ones issue nothing and move no floor", async () => {
    await activate();
    await charge();
    const res = await activate({ licenseId: randomUUID(), organizationId: randomUUID(), outletId: randomUUID(), currentRevision: 2 });
    expect(res.body).toEqual({ license: null });
    expect(await count("licenses")).toBe(2);
    expect((await getInstallation(db, installationId))!.revisionFloor).toBeLessThan(2);
    expect(logs).toEqual([`activate: installation ${installationId} reported identifiers that differ from the stored ones; nothing issued`]);
    expect((await activate({ licenseId: randomUUID(), organizationId: randomUUID(), outletId: randomUUID(), currentRevision: 1 })).body.license).toBeTruthy();
  });
});
