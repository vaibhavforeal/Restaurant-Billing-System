import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { addMonths, DAY_MS, GRACE_MS } from "./dates.js";
import type { Env } from "./env.js";
import { sha256Hex } from "./secret.js";
import { getInstallation, getOwnerSettings, latestLicense } from "./store.js";
import { seedCustomer, seedOrder, type Seeded } from "./testing/fixtures.js";
import { activation, keyPair, send, testEnv, withSecret } from "./testing/harness.js";
import { OTHER_SECRET, TEST_SECRET } from "./testing/secret.js";
// Test-only: the Worker source never imports the counter server or the domain index.
import { MIGRATIONS, migrate, openDb } from "../../../packages/domain/src/index.js";
import { buildServer } from "../../server/src/server.js";

const T0 = Date.UTC(2026, 9, 10, 10, 0, 0);
const keys = keyPair();
const A = "11111111-1111-4111-8111-111111111111", B = "22222222-2222-4222-8222-222222222222";

let env: Env;
let fingerprint: string;
let customer: Seeded;
beforeAll(async () => { vi.useFakeTimers({ toFake: ["Date"] }); fingerprint = await keys.fingerprint(); });
beforeEach(async () => {
  vi.setSystemTime(T0);
  env = testEnv(keys.privatePem);
  customer = await seedCustomer(env.DB, { name: "Spice Route" });
});
afterEach(() => { vi.restoreAllMocks(); });

interface Reply { license: string | null; customer: { code: string; name: string }; order: { code: string; plan: string; trial: boolean; expiresAt: number | null } }
const enroll = (installationId: string, customerId: string, orderId: string, over: Record<string, unknown> = {}, secret = TEST_SECRET) =>
  send(env, "POST", "/v1/enroll", { activation: activation(installationId, fingerprint, over), customerId, orderId }, withSecret({}, secret));
const enrolled = async (installationId: string, order: Seeded, over: Record<string, unknown> = {}) => {
  const res = await enroll(installationId, customer.code, order.code, over);
  expect(res.status).toBe(200);
  return await res.json() as Reply;
};
const seats = async (order: Seeded) => (await env.DB.prepare(`SELECT seats_used AS n FROM orders WHERE id = ?`).bind(order.id).first<{ n: number }>())!.n;
const rows = async (table: string) => (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>())!.n;

describe("POST /v1/enroll", () => {
  it("a paid order activates a counter with the order's plan, devices, modules and codes, counted from now", async () => {
    const order = await seedOrder(env.DB, customer, { plan: "basic", maxDevices: 3, termMonths: 12, modules: { kds: true } });
    const reply = await enrolled(A, order, { outletName: "Spice Route, Baner", appVersion: "0.7.0" });
    const claims = keys.claims(reply.license!);
    expect(claims).toMatchObject({
      installationId: A, revision: 1, plan: "basic", maxDevices: 3, customerCode: customer.code, orderCode: order.code,
      expiresAt: addMonths(T0, 12), graceUntil: addMonths(T0, 12) + GRACE_MS,
    });
    expect(claims.trial).toBeUndefined();
    expect(claims.modules.kds).toBe(true);
    expect(reply.customer).toEqual({ code: customer.code, name: "Spice Route" });
    expect(reply.order).toEqual({ code: order.code, plan: "basic", trial: false, expiresAt: addMonths(T0, 12) });
    expect(JSON.stringify(reply)).not.toMatch(/phone|email|gstin/);
    expect(await getInstallation(env.DB, A)).toMatchObject({
      customerId: customer.id, orderId: order.id, maxDevices: 3, activatedAt: T0, lastSeenAt: T0, outletName: "Spice Route, Baner", appVersion: "0.7.0",
      revisionFloor: 1, secretHash: await sha256Hex(TEST_SECRET),
    });
    expect((await getOwnerSettings(env.DB, A)).overrides).toEqual({ kds: true });
    expect(await seats(order)).toBe(1);
    const log = await env.DB.prepare(`SELECT action, customer_id AS customerId, summary FROM activity_log`).all();
    expect(log.results).toEqual([{ action: "installation.enrolled", customerId: customer.id, summary: `Spice Route, Baner activated with order ${order.code}` }]);
  });

  it("accepts the IDs as people type them", async () => {
    const order = await seedOrder(env.DB, customer);
    const res = await enroll(A, ` ${customer.code.toLowerCase().replace(/-/g, "")} `, order.code.slice(3).replace("-", " "));
    expect(res.status).toBe(200);
  });

  it("enrolling again on the same order hands back the same licence and takes no second seat", async () => {
    const order = await seedOrder(env.DB, customer);
    const first = await enrolled(A, order);
    const again = await enrolled(A, order);
    expect(again.license).toBe(first.license);
    expect(keys.claims(again.license!).revision).toBe(1);
    expect((await enrolled(A, order, { ...heldBy(first.license!), currentRevision: 1 })).license).toBeNull();
    expect(await seats(order)).toBe(1);
    expect(await rows("licenses")).toBe(1);
  });

  it("gives one answer for a typo, an unknown customer or order, and another customer's order, and writes nothing", async () => {
    const order = await seedOrder(env.DB, customer);
    const other = await seedCustomer(env.DB, { name: "Other" });
    const otherOrder = await seedOrder(env.DB, other);
    const unknownOrder = (await seedOrder(env.DB, customer)).code;
    await env.DB.prepare(`DELETE FROM orders WHERE code = ?`).bind(unknownOrder).run();
    const bodies = new Set<string>();
    for (const [c, o] of [["FC-0000-001", order.code], [customer.code, unknownOrder], [customer.code, otherOrder.code], [other.code, order.code], ["nonsense", order.code]] as const) {
      const res = await enroll(A, c, o);
      expect(res.status).toBe(404);
      bodies.add(await res.text());
    }
    expect(bodies.size).toBe(1);
    expect(await rows("installations")).toBe(0);
  });

  it("refuses orders that cannot activate yet, in plain words, before writing anything", async () => {
    const cases = [
      [{ status: "draft" }, "order_not_ready"], [{ status: "cancelled" }, "order_cancelled"], [{ status: "confirmed" }, "not_paid"],
      [{ status: "confirmed", creditUntil: T0 - 1 }, "not_paid"], [{ kind: "renewal", status: "paid" }, "renewal_order"],
    ] as const;
    for (const [over, error] of cases) {
      const res = await enroll(A, customer.code, (await seedOrder(env.DB, customer, over)).code);
      expect(res.status).toBe(409);
      const body = await res.json() as { error: string; message: string };
      expect(body.error).toBe(error);
      expect(body.message).toMatch(/\w+ \w+/);
    }
    expect(await rows("installations")).toBe(0);
  });

  it("an order on credit licenses only to its credit date", async () => {
    const creditUntil = T0 + 10 * DAY_MS;
    const order = await seedOrder(env.DB, customer, { status: "confirmed", creditUntil });
    const claims = keys.claims((await enrolled(A, order)).license!);
    expect(claims).toMatchObject({ expiresAt: creditUntil, graceUntil: creditUntil + GRACE_MS });
  });

  it("a trial order gives seven days with no grace", async () => {
    const order = await seedOrder(env.DB, customer, { kind: "trial" });
    const reply = await enrolled(A, order);
    expect(keys.claims(reply.license!)).toMatchObject({ trial: true, expiresAt: T0 + 7 * DAY_MS, graceUntil: T0 + 7 * DAY_MS });
    expect(reply.order.trial).toBe(true);
  });

  it("a full order turns the next counter away and gives it no licence", async () => {
    const order = await seedOrder(env.DB, customer, { outlets: 1 });
    await enrolled(A, order);
    const res = await enroll(B, customer.code, order.code);
    expect(res.status).toBe(409);
    expect((await res.json() as { error: string }).error).toBe("seats_full");
    expect(await latestLicense(env.DB, B)).toBeNull();
    expect(await seats(order)).toBe(1);
  });

  it("two counters racing for the last seat: exactly one gets it", async () => {
    const order = await seedOrder(env.DB, customer, { outlets: 1 });
    const results = await Promise.all([enroll(A, customer.code, order.code), enroll(B, customer.code, order.code)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await seats(order)).toBe(1);
    expect(await rows("licenses")).toBe(1);
  });

  it("one counter enrolling twice at once takes one seat", async () => {
    const order = await seedOrder(env.DB, customer, { outlets: 2 });
    const results = await Promise.all([enroll(A, customer.code, order.code), enroll(A, customer.code, order.code)]);
    expect(results.map((r) => r.status)).toEqual([200, 200]);
    expect(await seats(order)).toBe(1);
  });

  it("a trial counter moves to the customer's paid order, freeing the trial seat", async () => {
    const trial = await seedOrder(env.DB, customer, { kind: "trial" });
    const paid = await seedOrder(env.DB, customer, { plan: "basic" });
    const first = await enrolled(A, trial);
    vi.setSystemTime(T0 + 3 * DAY_MS);
    const moved = await enrolled(A, paid, { ...heldBy(first.license!), currentRevision: 1 });
    const claims = keys.claims(moved.license!);
    expect(claims).toMatchObject({ revision: 2, plan: "basic", orderCode: paid.code, expiresAt: addMonths(T0 + 3 * DAY_MS, 12) });
    expect(claims.trial).toBeUndefined();
    expect([await seats(trial), await seats(paid)]).toEqual([0, 1]);
    expect(await getInstallation(env.DB, A)).toMatchObject({ orderId: paid.id, activatedAt: T0 + 3 * DAY_MS });
  });

  it("a paid counter cannot drop back to a trial, and never moves to another customer", async () => {
    const paid = await seedOrder(env.DB, customer);
    const first = await enrolled(A, paid);
    const trial = await seedOrder(env.DB, customer, { kind: "trial" });
    const held = { ...heldBy(first.license!), currentRevision: 1 };
    const back = await enroll(A, customer.code, trial.code, held);
    expect((await back.json() as { error: string }).error).toBe("already_licensed");
    const other = await seedCustomer(env.DB, { name: "Other" });
    const theirs = await seedOrder(env.DB, other);
    const res = await enroll(A, other.code, theirs.code, held);
    expect(res.status).toBe(409);
    expect((await res.json() as { error: string }).error).toBe("other_customer");
    expect(await seats(theirs)).toBe(0);
  });

  it("keeps the identifiers a counter already holds from a hand-issued licence", async () => {
    const order = await seedOrder(env.DB, customer);
    const held = { licenseId: "33333333-3333-4333-8333-333333333333", organizationId: "44444444-4444-4444-8444-444444444444", outletId: "55555555-5555-4555-8555-555555555555" };
    const claims = keys.claims((await enrolled(A, order, { ...held, currentRevision: 3 })).license!);
    expect(claims).toMatchObject({ ...held, revision: 4 });
  });

  it("checks the body, the key and the secret, and a wrong secret changes nothing", async () => {
    const order = await seedOrder(env.DB, customer);
    expect((await send(env, "POST", "/v1/enroll", { customerId: customer.code }, withSecret())).status).toBe(400);
    expect((await enroll(A, customer.code, order.code, { verificationKeyFingerprint: "0".repeat(64) })).status).toBe(409);
    expect((await send(env, "POST", "/v1/enroll", { activation: activation(A, fingerprint), customerId: customer.code, orderId: order.code })).status).toBe(401);
    await enrolled(A, order);
    const before = await getInstallation(env.DB, A);
    const wrong = await enroll(A, customer.code, order.code, {}, OTHER_SECRET);
    expect(wrong.status).toBe(401);
    expect(await getInstallation(env.DB, A)).toEqual(before);
  });

  it("is rate limited like activation", async () => {
    env.LIMITER = { limit: async () => ({ success: false }) };
    expect((await enroll(A, customer.code, (await seedOrder(env.DB, customer)).code)).status).toBe(429);
  });

  it("produces a licence a real counter installs, with the devices and codes it shows", async () => {
    const order = await seedOrder(env.DB, customer, { plan: "basic", maxDevices: 4 });
    const envelope = (await enrolled(A, order)).license!.trim();
    const db = openDb(":memory:"); migrate(db, MIGRATIONS);
    const app = buildServer({ db, licensing: { publicKey: keys.publicPem, installationId: A, now: () => Date.now() } });
    try {
      app.licensing.activate(envelope);
      expect(app.licensing.status()).toMatchObject({ state: "active", plan: "basic", maxDevices: 4 });
    } finally { await app.close(); db.close(); }
  });
});

/** The identifiers a counter holding this licence reports. */
function heldBy(envelope: string) {
  const { licenseId, organizationId, outletId } = keys.claims(envelope);
  return { licenseId, organizationId, outletId };
}
