import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { webCryptoSigner } from "@masalapos/license-issuer";
import { handleActivate, type ActivateDeps, type Deps } from "./activate.js";
import { DAY_MS, GRACE_MS } from "./dates.js";
import { handleEnroll } from "./enroll.js";
import type { D1Like } from "./env.js";
import { issueLicense } from "./issue.js";
import { sha256Hex } from "./secret.js";
import { claimSecretStatement, getInstallation } from "./store.js";
import { memoryD1 } from "./testing/d1.js";
import { seedCustomer, seedOrder, type OrderSeed } from "./testing/fixtures.js";
import { keyPair } from "./testing/harness.js";
import { OTHER_SECRET, TEST_SECRET } from "./testing/secret.js";

const T0 = Date.UTC(2026, 9, 10, 10, 0, 0);
const keys = keyPair();
const installationId = "44444444-4444-4444-8444-444444444444";

let signer: Deps["signer"];
let db: D1Like;
let now: number;
let deps: ActivateDeps;
let logs: string[];
beforeAll(async () => { signer = await webCryptoSigner(keys.privatePem); });
beforeEach(() => {
  db = memoryD1();
  now = T0;
  logs = [];
  deps = { db, signer, now: () => now, uuid: () => randomUUID(), log: (m) => logs.push(m) };
});

const request = (over: Record<string, unknown> = {}) => ({
  format: "masalapos-activation-request", version: 1, installationId, licenseId: null, organizationId: null, outletId: null,
  currentRevision: 0, generatedAt: T0, verificationKeyFingerprint: signer.fingerprint, ...over,
});
const activate = async (over: Record<string, unknown> = {}, secret: string | null = TEST_SECRET) => {
  const res = await handleActivate(deps, request(over), secret);
  return { status: res.status, type: res.headers.get("content-type"), body: await res.json() as { license?: string | null; enrolled?: boolean; error?: string } };
};
/** Enrols the installation on a fresh order and returns its first licence. */
async function enrol(order: OrderSeed = {}): Promise<string> {
  const customer = await seedCustomer(db, { at: now });
  const seeded = await seedOrder(db, customer, { at: now, ...order });
  const res = await handleEnroll(deps, { activation: request(), customerId: customer.code, orderId: seeded.code }, TEST_SECRET);
  expect(res.status).toBe(200);
  return (await res.json() as { license: string }).license;
}
const held = async () => {
  const i = (await getInstallation(db, installationId))!;
  return { licenseId: i.licenseId, organizationId: i.organizationId, outletId: i.outletId };
};
const count = async (table: string) => (await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>())?.n;

describe("POST /v1/activate", () => {
  it("an unknown counter gets no licence and no trial, and nothing is written", async () => {
    expect((await activate()).body).toEqual({ license: null, enrolled: false });
    expect(await count("installations")).toBe(0);
    expect(await count("licenses")).toBe(0);
  });

  it("an enrolled counter gets its licence until it holds it, and reports when it was last seen and what it runs", async () => {
    const first = await enrol();
    expect((await activate()).body).toEqual({ license: first, enrolled: true });
    now += DAY_MS;
    expect((await activate({ ...(await held()), currentRevision: 1, appVersion: "0.7.1", outletName: "Spice Route, Baner" })).body).toEqual({ license: null, enrolled: true });
    expect(await getInstallation(db, installationId)).toMatchObject({ lastSeenAt: T0 + DAY_MS, appVersion: "0.7.1", outletName: "Spice Route, Baner" });
    // A check that reports neither keeps what is stored.
    await activate({ ...(await held()), currentRevision: 1 });
    expect(await getInstallation(db, installationId)).toMatchObject({ appVersion: "0.7.1", outletName: "Spice Route, Baner" });
  });

  it("a counter whose seat was released is no longer enrolled", async () => {
    await enrol();
    await db.prepare(`UPDATE installations SET order_id = NULL WHERE installation_id = ?`).bind(installationId).run();
    expect((await activate({ ...(await held()), currentRevision: 1 })).body).toEqual({ license: null, enrolled: false });
  });

  it("wrong verification key is refused", async () => {
    expect((await activate({ verificationKeyFingerprint: "0".repeat(64) })).body).toEqual({ error: "wrong_key" });
  });

  it("malformed request and a reported revision above 1,000,000 are refused", async () => {
    expect((await handleActivate(deps, { nope: true }, TEST_SECRET)).status).toBe(400);
    await enrol();
    expect((await activate({ ...(await held()), currentRevision: 1_000_001 })).status).toBe(400);
  });
});

describe("POST /v1/activate after a hand-issued licence", () => {
  const PAID_END = T0 + 30 * DAY_MS;
  const paid = async (expiresAt = PAID_END) => {
    const installation = (await getInstallation(db, installationId))!;
    const { row, statement } = await issueLicense(deps, { installation, plan: "basic", expiresAt, graceUntil: expiresAt + GRACE_MS, trial: false, reason: "manual", orderId: null });
    await statement.run();
    return row;
  };
  const licenses = async () => (await db.prepare(`SELECT revision, reason FROM licenses ORDER BY revision`).all<{ revision: number; reason: string }>()).results;

  it("a hand-issued revision reported before a paid licence pushes the paid licence above it", async () => {
    await enrol({ kind: "trial" });
    expect((await activate({ ...(await held()), currentRevision: 2 })).body).toEqual({ license: null, enrolled: true });
    expect((await getInstallation(db, installationId))!.revisionFloor).toBe(2);
    expect((await paid()).revision).toBe(3);
    const claims = keys.claims((await activate({ ...(await held()), currentRevision: 2 })).body.license!);
    expect(claims).toMatchObject({ revision: 3, plan: "basic", expiresAt: PAID_END, graceUntil: PAID_END + GRACE_MS });
    expect((await activate({ ...(await held()), currentRevision: 3 })).body.license).toBeNull();
  });

  it("a paid licence stored at the hand-issued revision is re-signed above it, once, keeping its order and devices", async () => {
    await enrol({ maxDevices: 4 });
    now += DAY_MS;
    const res = await activate({ ...(await held()), currentRevision: 1 });
    expect(res.body.license).toBeNull();
    // The counter now reports a hand-issued revision 2 over the service's revision 1.
    const resigned = await activate({ ...(await held()), currentRevision: 2 });
    const claims = keys.claims(resigned.body.license!);
    expect(claims).toMatchObject({ revision: 3, maxDevices: 4, issuedAt: now });
    expect(claims.orderCode).toMatch(/^FO-/);
    expect(await licenses()).toEqual([{ revision: 1, reason: "order" }, { revision: 3, reason: "manual" }]);
    expect((await activate({ ...(await held()), currentRevision: 3 })).body.license).toBeNull();
    expect((await activate({ ...(await held()), currentRevision: 2 })).body.license).toBe(resigned.body.license);
    expect(await count("licenses")).toBe(2);
  });

  it("an expired licence and a trial are never re-signed", async () => {
    await enrol({ kind: "trial" });
    expect((await activate({ ...(await held()), currentRevision: 5 })).body.license).toBeNull();
    await paid();
    now = PAID_END + 1;
    expect((await activate({ ...(await held()), currentRevision: 9 })).body.license).toBeNull();
    expect(await count("licenses")).toBe(2);
  });

  it("identifiers that differ from the stored ones issue nothing and move no floor", async () => {
    await enrol();
    const before = (await getInstallation(db, installationId))!.revisionFloor;
    const res = await activate({ licenseId: randomUUID(), organizationId: randomUUID(), outletId: randomUUID(), currentRevision: 2 });
    expect(res.body).toEqual({ license: null, enrolled: true });
    expect((await getInstallation(db, installationId))!.revisionFloor).toBe(before);
    expect(logs).toEqual([`activate: installation ${installationId} reported identifiers that differ from the stored ones; nothing issued`]);
  });
});

describe("POST /v1/activate installation secret", () => {
  const rows = async () => ({
    installations: (await db.prepare(`SELECT * FROM installations ORDER BY installation_id`).all()).results,
    licenses: (await db.prepare(`SELECT * FROM licenses ORDER BY installation_id, revision`).all()).results,
  });

  it("enrolment stores the SHA-256 of the secret and never the secret itself", async () => {
    await enrol();
    const row = await getInstallation(db, installationId);
    expect(row!.secretHash).toBe(await sha256Hex(TEST_SECRET));
    expect(JSON.stringify(await rows())).not.toContain(TEST_SECRET);
  });

  it("no secret or a malformed one is 401 with the exact body", async () => {
    const res = await activate({}, null);
    expect(res).toMatchObject({ status: 401, body: { error: "unauthorized" } });
    expect(res.type).toContain("application/json");
    expect(JSON.stringify(res.body)).toBe(`{"error":"unauthorized"}`);
    await enrol();
    for (const bad of ["", "short", "A".repeat(64), "a".repeat(65), "g".repeat(64)]) expect(await activate({}, bad)).toMatchObject({ status: 401, body: { error: "unauthorized" } });
  });

  it("checks run in order: bad body (400), wrong key (409), then secret (401)", async () => {
    expect((await handleActivate(deps, {}, null)).status).toBe(400);
    expect((await activate({ verificationKeyFingerprint: "0".repeat(64) }, null)).status).toBe(409);
    expect((await activate({}, null)).status).toBe(401);
  });

  it("a wrong secret leaves the floor, licences and installation row byte for byte unchanged", async () => {
    await enrol();
    const before = await rows();
    now += DAY_MS;
    // Each would raise the floor, re-sign or hand out a licence, or record the counter as seen, if the secret were right.
    for (const over of [{ ...(await held()), currentRevision: 2 }, { currentRevision: 0, appVersion: "9.9.9" }, { licenseId: randomUUID(), organizationId: randomUUID(), outletId: randomUUID(), currentRevision: 5 }])
      expect(await activate(over, OTHER_SECRET)).toMatchObject({ status: 401, body: { error: "unauthorized" } });
    expect(await rows()).toEqual(before);
    expect(logs).toEqual([]);
  });

  it("after support resets the pairing, the first well-formed secret claims the counter; a later wrong one gets 401", async () => {
    const first = await enrol();
    await db.prepare(`UPDATE installations SET secret_hash = NULL`).run();
    const claimed = await activate({}, OTHER_SECRET);
    expect(claimed.body.license).toBe(first);
    expect((await getInstallation(db, installationId))!.secretHash).toBe(await sha256Hex(OTHER_SECRET));
    expect((await activate({}, TEST_SECRET)).status).toBe(401);
  });

  it("claimSecretStatement only sets a NULL hash", async () => {
    await enrol();
    expect((await claimSecretStatement(db, installationId, await sha256Hex(OTHER_SECRET)).run()).meta.changes).toBe(0);
    expect((await getInstallation(db, installationId))!.secretHash).toBe(await sha256Hex(TEST_SECRET));
  });
});
