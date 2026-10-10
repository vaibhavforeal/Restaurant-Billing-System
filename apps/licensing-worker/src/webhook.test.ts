import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHmac, generateKeyPairSync, randomUUID } from "node:crypto";
import { verifyLicenseSignature } from "@forkflow/core";
import { LicenseClaims } from "@forkflow/domain/licensing";
import { webCryptoSigner } from "@forkflow/license-issuer";
import { handleActivate } from "./activate.js";
import type { D1Like } from "./env.js";
import type { RazorpayApi } from "./razorpay.js";
import { getSubscription, latestLicense } from "./store.js";
import { memoryD1 } from "./testing/d1.js";
import { handleWebhook, type WebhookDeps } from "./webhook.js";

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 9, 10, 10, 0, 0);
const SECRET = "whsec_test";
const pair = generateKeyPairSync("ed25519");
const publicPem = pair.publicKey.export({ type: "spki", format: "pem" }).toString();
const privatePem = pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const installationId = "55555555-5555-4555-8555-555555555555";

let signer: WebhookDeps["signer"];
let db: D1Like;
let now: number;
let cancelled: string[];
let failCancel: boolean;
let logs: string[];
let deps: WebhookDeps;
let seq: number;
beforeAll(async () => { signer = await webCryptoSigner(privatePem); });
beforeEach(() => {
  db = memoryD1();
  now = T0;
  cancelled = [];
  failCancel = false;
  logs = [];
  seq = 0;
  const razorpay: RazorpayApi = {
    async createSubscription() { throw new Error("not used"); },
    async cancelSubscription(id) { if (failCancel) throw new Error("Razorpay 400: already cancelled"); cancelled.push(id); },
  };
  deps = { db, signer, now: () => now, uuid: () => randomUUID(), razorpay, webhookSecret: SECRET, log: (m) => logs.push(m) };
});

const sign = (raw: string, secret = SECRET) => createHmac("sha256", secret).update(raw).digest("hex");
const post = (raw: string, headers: Record<string, string>) => new Request("https://licensing.test/v1/webhook", { method: "POST", body: raw, headers });
const send = async (body: unknown, { eventId = `evt_${++seq}`, signature, omitEventId = false }: { eventId?: string; signature?: string; omitEventId?: boolean } = {}) => {
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  const headers: Record<string, string> = { "x-razorpay-signature": signature ?? sign(raw) };
  if (!omitEventId) headers["x-razorpay-event-id"] = eventId;
  const res = await handleWebhook(deps, post(raw, headers));
  return { status: res.status, type: res.headers.get("content-type"), body: await res.json() as { outcome?: string; error?: string } };
};

interface ChargeOver { event?: string; subId?: string; paymentId?: string; currentEnd?: number | null | "omit"; notes?: unknown; status?: string }
const subscriptionEvent = ({ event = "subscription.charged", subId = "sub_A", paymentId = `pay_${seq + 1}`, currentEnd = Math.floor((T0 + 30 * DAY) / 1000), notes, status = "active" }: ChargeOver = {}) => {
  const entity: Record<string, unknown> = { id: subId, status, notes: notes === undefined ? { installationId, plan: "pro", period: "monthly" } : notes };
  if (currentEnd !== "omit") entity.current_end = currentEnd;
  const payload: Record<string, unknown> = { subscription: { entity } };
  if (event === "subscription.charged" || event === "subscription.completed") payload.payment = { entity: { id: paymentId } };
  return { entity: "event", event, payload };
};
const charged = (over: ChargeOver = {}) => subscriptionEvent(over);
const endOf = (daysFromT0: number) => Math.floor((T0 + daysFromT0 * DAY) / 1000);

const activate = async (currentRevision = 0) => {
  const res = await handleActivate(deps, {
    format: "forkflow-activation-request", version: 1, installationId, licenseId: null, organizationId: null, outletId: null,
    currentRevision, generatedAt: now, verificationKeyFingerprint: signer.fingerprint,
  });
  return (await res.json() as { license: string | null }).license;
};
const claimsOf = (envelope: string) => LicenseClaims.parse(verifyLicenseSignature(envelope.trim(), publicPem));
const count = async (table: string) => (await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>())?.n;
const outcomes = async () => (await db.prepare(`SELECT event_id AS id, outcome FROM webhook_events ORDER BY received_at, rowid`).all<{ id: string; outcome: string }>()).results;
const chargeLicenses = async () => (await db.prepare(`SELECT revision FROM licenses WHERE reason = 'charge'`).all<{ revision: number }>()).results.length;

describe("POST /v1/webhook", () => {
  it("a charge issues the next revision with the payload's period end", async () => {
    await activate();
    const end = endOf(30);
    const res = await send(charged({ currentEnd: end }));
    expect(res).toMatchObject({ status: 200, body: { outcome: "issued" } });
    expect(res.type).toContain("application/json");
    const latest = (await latestLicense(db, installationId))!;
    expect(latest).toMatchObject({ revision: 2, reason: "charge", plan: "pro", razorpaySubscriptionId: "sub_A", razorpayPaymentId: "pay_1" });
    const claims = claimsOf(latest.envelope);
    const trial = claimsOf((await db.prepare(`SELECT envelope FROM licenses WHERE revision = 1`).first<{ envelope: string }>())!.envelope);
    expect(claims).toMatchObject({ revision: 2, plan: "pro", installationId, issuedAt: T0 });
    expect(claims.trial).toBeUndefined();
    expect([claims.licenseId, claims.organizationId, claims.outletId]).toEqual([trial.licenseId, trial.organizationId, trial.outletId]);
    expect(claims.expiresAt).toBe(end * 1000);
    expect(claims.graceUntil).toBe(claims.expiresAt + 7 * DAY);
    expect(await getSubscription(db, "sub_A")).toMatchObject({ status: "active", installationId, plan: "pro", period: "monthly", currentPeriodEnd: end * 1000 });
    expect(await activate(1)).toBe(latest.envelope);
    expect(await activate(2)).toBeNull();
  });

  it("duplicate event id is a no-op", async () => {
    await activate();
    expect((await send(charged(), { eventId: "evt_same" })).status).toBe(200);
    const again = await send(charged({ paymentId: "pay_other", currentEnd: endOf(60) }), { eventId: "evt_same" });
    expect(again.status).toBe(200);
    expect(await chargeLicenses()).toBe(1);
    expect(await count("webhook_events")).toBe(1);
  });

  it("same payment under a new event id is ignored", async () => {
    await activate();
    await send(charged({ paymentId: "pay_x" }));
    const again = await send(charged({ paymentId: "pay_x", currentEnd: endOf(60) }));
    expect(again).toMatchObject({ status: 200, body: { outcome: "ignored" } });
    expect(await chargeLicenses()).toBe(1);
  });

  it("a late charge for an earlier period is ignored", async () => {
    await activate();
    await send(charged({ paymentId: "pay_2", currentEnd: endOf(60) }));
    const late = await send(charged({ paymentId: "pay_1", currentEnd: endOf(30) }));
    expect(late.body.outcome).toBe("ignored");
    expect(await chargeLicenses()).toBe(1);
    expect((await latestLicense(db, installationId))!.expiresAt).toBe(endOf(60) * 1000);
  });

  it("switching yearly to monthly still issues", async () => {
    await activate();
    await send(charged({ subId: "sub_A", notes: { installationId, plan: "pro", period: "yearly" }, currentEnd: endOf(365) }));
    const switched = await send(charged({ subId: "sub_B", notes: { installationId, plan: "basic", period: "monthly" }, currentEnd: endOf(30) }));
    expect(switched.body.outcome).toBe("issued");
    const latest = (await latestLicense(db, installationId))!;
    expect(latest).toMatchObject({ revision: 3, plan: "basic", razorpaySubscriptionId: "sub_B", expiresAt: endOf(30) * 1000 });
  });

  it("a new subscription's first charge cancels the older one, its second charge cancels nothing", async () => {
    await activate();
    await send(charged({ subId: "sub_A" }));
    expect(cancelled).toEqual([]);
    now += DAY;
    expect((await send(charged({ subId: "sub_B", currentEnd: endOf(31) }))).body.outcome).toBe("issued");
    expect(cancelled).toEqual(["sub_A"]);
    cancelled = [];
    now += DAY;
    await send(charged({ subId: "sub_B", currentEnd: endOf(61) }));
    expect(cancelled).toEqual([]);
    expect(await chargeLicenses()).toBe(3);
  });

  it("an old subscription's renewal never cancels a newer one still awaiting its first charge", async () => {
    await activate();
    await send(charged({ subId: "sub_A" }));
    now += DAY;
    await send(subscriptionEvent({ event: "subscription.authenticated", subId: "sub_B", status: "created", currentEnd: null }));
    expect((await getSubscription(db, "sub_B"))!.status).toBe("created");
    now += DAY;
    expect((await send(charged({ subId: "sub_A", paymentId: "pay_renew", currentEnd: endOf(60) }))).body.outcome).toBe("issued");
    expect(cancelled).toEqual([]);
    now += DAY;
    await send(charged({ subId: "sub_B", currentEnd: endOf(65) }));
    expect(cancelled).toEqual(["sub_A"]);
  });

  it("a halted older subscription is cancelled on the new one's first charge", async () => {
    await activate();
    await send(charged({ subId: "sub_A" }));
    await send(subscriptionEvent({ event: "subscription.halted", subId: "sub_A", status: "halted", currentEnd: null }));
    now += DAY;
    await send(charged({ subId: "sub_B", currentEnd: endOf(40) }));
    expect(cancelled).toEqual(["sub_A"]);
  });

  it("finished subscriptions are never cancelled, and another installation's subscriptions are never touched", async () => {
    await activate();
    const other = "66666666-6666-4666-8666-666666666666";
    const otherNotes = { installationId: other, plan: "pro", period: "monthly" };
    await handleActivate(deps, {
      format: "forkflow-activation-request", version: 1, installationId: other, licenseId: null, organizationId: null, outletId: null,
      currentRevision: 0, generatedAt: now, verificationKeyFingerprint: signer.fingerprint,
    });
    await send(charged({ subId: "sub_other", notes: otherNotes }));
    await send(charged({ subId: "sub_done" }));
    await send(subscriptionEvent({ event: "subscription.completed", subId: "sub_done", status: "completed", paymentId: "pay_done", currentEnd: null }));
    now += DAY;
    await send(charged({ subId: "sub_B", currentEnd: endOf(40) }));
    expect(cancelled).toEqual([]);
    now += DAY;
    await send(charged({ subId: "sub_other_2", notes: otherNotes, currentEnd: endOf(41) }));
    expect(cancelled).toEqual(["sub_other"]);
  });

  it("a failed cancel is logged without failing the webhook", async () => {
    await activate();
    await send(charged({ subId: "sub_A" }));
    now += DAY;
    failCancel = true;
    const res = await send(charged({ subId: "sub_B", currentEnd: endOf(31) }));
    expect(res).toMatchObject({ status: 200, body: { outcome: "issued" } });
    expect(cancelled).toEqual([]);
    expect(logs.some((l) => l.includes("could not cancel superseded subscription sub_A") && l.includes("already cancelled"))).toBe(true);
  });

  it("a charge on the same subscription again cancels nothing", async () => {
    await activate();
    await send(charged({ paymentId: "pay_1" }));
    await send(charged({ paymentId: "pay_2", currentEnd: endOf(60) }));
    expect(cancelled).toEqual([]);
    expect(await chargeLicenses()).toBe(2);
  });

  it("charge before the subscription row exists issues from the notes and creates the row", async () => {
    await activate();
    expect(await getSubscription(db, "sub_A")).toBeNull();
    const res = await send(charged({ notes: { installationId, plan: "basic", period: "yearly" }, currentEnd: endOf(365) }));
    expect(res.body.outcome).toBe("issued");
    expect(await getSubscription(db, "sub_A")).toMatchObject({ plan: "basic", period: "yearly", status: "active", installationId });
    expect(claimsOf((await latestLicense(db, installationId))!.envelope)).toMatchObject({ plan: "basic", revision: 2 });
  });

  it("bad signature is 400 and writes nothing", async () => {
    await activate();
    const res = await send(charged(), { signature: sign(JSON.stringify(charged()), "wrong") });
    expect(res.status).toBe(400);
    expect(await chargeLicenses()).toBe(0);
    expect(await count("webhook_events")).toBe(0);
    expect(await count("subscriptions")).toBe(0);
    expect((await send(charged(), { signature: "zz" })).status).toBe(400);
  });

  it("a missing event id is 400 and writes nothing", async () => {
    await activate();
    expect((await send(charged(), { omitEventId: true })).status).toBe(400);
    expect(await chargeLicenses()).toBe(0);
    expect(await count("webhook_events")).toBe(0);
  });

  it("unknown installation is 200 unmatched", async () => {
    const res = await send(charged());
    expect(res).toMatchObject({ status: 200, body: { outcome: "unmatched" } });
    expect(await count("licenses")).toBe(0);
    expect(await count("subscriptions")).toBe(0);
    expect(await outcomes()).toEqual([{ id: "evt_1", outcome: "unmatched" }]);
    expect(logs.length).toBeGreaterThan(0);
  });

  it.each([
    ["no notes key", { notes: undefined as unknown, omitNotes: true }],
    ["empty array notes", { notes: [] as unknown }],
    ["array notes with entries", { notes: [{ installationId, plan: "pro", period: "monthly" }] as unknown }],
    ["string notes", { notes: "installationId" as unknown }],
    ["missing installationId", { notes: { plan: "pro", period: "monthly" } as unknown }],
    ["invalid plan", { notes: { installationId, plan: "platinum", period: "monthly" } as unknown }],
    ["invalid period", { notes: { installationId, plan: "pro", period: "weekly" } as unknown }],
  ])("%s is unmatched with 200", async (_name, over) => {
    await activate();
    const event = charged() as unknown as { payload: { subscription: { entity: Record<string, unknown> } } };
    if ("omitNotes" in over) delete event.payload.subscription.entity.notes; else event.payload.subscription.entity.notes = over.notes;
    const res = await send(event);
    expect(res).toMatchObject({ status: 200, body: { outcome: "unmatched" } });
    expect(await chargeLicenses()).toBe(0);
    expect(await count("subscriptions")).toBe(0);
  });

  it.each([["null", null], ["omitted", "omit" as const], ["a string", "1790000000" as unknown as number]])("a charge whose current_end is %s is unmatched with 200", async (_name, currentEnd) => {
    await activate();
    const res = await send(charged({ currentEnd }));
    expect(res).toMatchObject({ status: 200, body: { outcome: "unmatched" } });
    expect(await chargeLicenses()).toBe(0);
  });

  it("a charge without a payment id is unmatched, and a non-JSON body is ignored safely", async () => {
    await activate();
    const noPayment = charged() as unknown as { payload: Record<string, unknown> };
    delete noPayment.payload.payment;
    expect((await send(noPayment)).body.outcome).toBe("unmatched");
    expect((await send("not json")).body.outcome).toBe("ignored");
    expect((await send({ event: "payment.captured", payload: { payment: { entity: { id: "pay_z" } } } })).body.outcome).toBe("ignored");
    expect(await chargeLicenses()).toBe(0);
  });

  it("status events update the subscription only", async () => {
    await activate();
    await send(charged());
    const res = await send(subscriptionEvent({ event: "subscription.halted", status: "halted", currentEnd: null }));
    expect(res).toMatchObject({ status: 200, body: { outcome: "status" } });
    expect(await getSubscription(db, "sub_A")).toMatchObject({ status: "halted", currentPeriodEnd: endOf(30) * 1000 });
    expect(await chargeLicenses()).toBe(1);
    expect((await outcomes()).at(-1)).toMatchObject({ outcome: "status" });
    expect(cancelled).toEqual([]);
  });

  it("a status event for an unseen subscription creates it, and a pending event with no end is fine", async () => {
    await activate();
    const res = await send(subscriptionEvent({ event: "subscription.authenticated", status: "authenticated", currentEnd: null }));
    expect(res.body.outcome).toBe("status");
    expect(await getSubscription(db, "sub_A")).toMatchObject({ status: "authenticated", currentPeriodEnd: null });
    expect(await chargeLicenses()).toBe(0);
  });

  it("a completed event carries a payment id but never issues a licence", async () => {
    await activate();
    await send(charged());
    const res = await send(subscriptionEvent({ event: "subscription.completed", status: "completed", paymentId: "pay_last", currentEnd: endOf(60) }));
    expect(res.body.outcome).toBe("status");
    expect(await chargeLicenses()).toBe(1);
  });

  it("a store failure returns 500, writes nothing, and a retry then succeeds", async () => {
    await activate();
    await send(charged({ subId: "sub_A" }));
    now += DAY;
    const real = db;
    let failing = true;
    deps = { ...deps, db: { prepare: (sql) => real.prepare(sql), batch: (s) => { if (failing) throw new Error("D1 unavailable"); return real.batch(s); } } };
    const second = () => charged({ subId: "sub_B", currentEnd: endOf(31) });
    const res = await send(second(), { eventId: "evt_retry" });
    expect(res.status).toBe(500);
    expect(cancelled).toEqual([]);
    expect(await chargeLicenses()).toBe(1);
    expect(await count("webhook_events")).toBe(1);
    failing = false;
    expect(await send(second(), { eventId: "evt_retry" })).toMatchObject({ status: 200, body: { outcome: "issued" } });
    expect(cancelled).toEqual(["sub_A"]);
  });

  it("an unexpected throw before the signature check (an unreadable body) is a JSON 500", async () => {
    const request = { headers: new Headers({ "x-razorpay-event-id": "evt_x" }), text: async () => { throw new Error("stream broke"); } } as unknown as Request;
    const res = await handleWebhook(deps, request);
    expect(res.status).toBe(500);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(logs.some((l) => l.includes("stream broke"))).toBe(true);
  });
});
