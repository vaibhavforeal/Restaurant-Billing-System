import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { webCryptoSigner } from "@masalapos/license-issuer";
import type { Env } from "./env.js";
import worker from "./index.js";
import { OTHER_SECRET, TEST_SECRET } from "./testing/secret.js";
import { SECRET_HEADER, sha256Hex } from "./secret.js";
import { getInstallation, getSubscription } from "./store.js";
import { memoryD1 } from "./testing/d1.js";
// Test-only: the Worker source never imports the counter server or the domain index.
import { MIGRATIONS, migrate, openDb } from "../../../packages/domain/src/index.js";
import { buildServer } from "../../server/src/server.js";

const T0 = Date.UTC(2026, 9, 10, 10, 0, 0);
const pair = generateKeyPairSync("ed25519");
const publicPem = pair.publicKey.export({ type: "spki", format: "pem" }).toString();
const privatePem = pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const installationId = "66666666-6666-4666-8666-666666666666";
// As it appears in the page source: the ">" is escaped.
const EXPIRED = "This payment link has expired. In MasalaPOS, open Settings &gt; Plan and devices and press Subscribe again.";
const UNKNOWN_SESSION = "A".repeat(43);

let env: Env;
let limited: string[];
let allowed: boolean;
let razorpayCalls: { url: string; body: Record<string, unknown>; authorization: string }[];
let razorpayResponse: () => Response;
let fingerprint: string;
beforeAll(async () => { vi.useFakeTimers({ toFake: ["Date"] }); fingerprint = (await webCryptoSigner(privatePem)).fingerprint; });
beforeEach(() => {
  vi.setSystemTime(T0);
  limited = [];
  allowed = true;
  razorpayCalls = [];
  razorpayResponse = () => new Response(JSON.stringify({ id: "sub_NEW", status: "created" }), { status: 200 });
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    razorpayCalls.push({ url, body: JSON.parse(init.body as string), authorization: (init.headers as Record<string, string>).authorization! });
    return razorpayResponse();
  });
  env = {
    DB: memoryD1(), LIMITER: { limit: async ({ key }) => { limited.push(key); return { success: allowed }; } },
    RAZORPAY_KEY_ID: "rzp_test_key", RAZORPAY_KEY_SECRET: "rzp_secret", RAZORPAY_WEBHOOK_SECRET: "whsec", LICENSE_SIGNING_KEY: privatePem,
    RAZORPAY_PLAN_BASIC_MONTHLY: "plan_bm", RAZORPAY_PLAN_BASIC_YEARLY: "plan_by", RAZORPAY_PLAN_PRO_MONTHLY: "plan_pm", RAZORPAY_PLAN_PRO_YEARLY: "plan_py",
  };
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const send = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
  const init: RequestInit = { method, headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers } };
  if (body !== undefined) init.body = typeof body === "string" ? body : JSON.stringify(body);
  return worker.fetch(new Request(`https://licensing.test${path}`, init), env);
};
const activationRequest = async (over: Record<string, unknown> = {}) => ({
  format: "masalapos-activation-request", version: 1, installationId, licenseId: null, organizationId: null, outletId: null,
  currentRevision: 0, generatedAt: T0, verificationKeyFingerprint: fingerprint, ...over,
});
const checkout = (session: string, over: Record<string, unknown> = {}) => ({ session, plan: "pro", period: "yearly", email: "owner@example.com", ...over });
const withSecret = (headers: Record<string, string> = {}) => ({ [SECRET_HEADER]: TEST_SECRET, ...headers });
const knownInstallation = async () => { expect((await send("POST", "/v1/activate", await activationRequest(), withSecret())).status).toBe(200); };
const mintSession = async (): Promise<string> => {
  const res = await send("POST", "/v1/subscribe-sessions", { installationId }, withSecret());
  expect(res.status).toBe(200);
  return (await res.json() as { session: string }).session;
};
const sessionCount = async () => (await env.DB.prepare("SELECT COUNT(*) AS n FROM subscribe_sessions").first<{ n: number }>())!.n;

describe("routing", () => {
  it("routes activate and returns a trial", async () => {
    const res = await send("POST", "/v1/activate", await activationRequest(), withSecret({ "cf-connecting-ip": "203.0.113.7" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect((await res.json() as { license: string }).license).toMatch(/^ff1\./);
    expect(limited).toEqual(["203.0.113.7"]);
    expect(await getInstallation(env.DB, installationId)).toMatchObject({ trialStartedAt: T0, secretHash: await sha256Hex(TEST_SECRET) });
  });

  it("activate without the secret header is 401, with a wrong one 401, and neither writes", async () => {
    for (const headers of [{}, { [SECRET_HEADER]: "not-a-secret" }]) {
      const res = await send("POST", "/v1/activate", await activationRequest(), headers);
      expect(res.status).toBe(401);
      expect(res.headers.get("content-type")).toBe("application/json");
      expect(await res.json()).toEqual({ error: "unauthorized" });
    }
    expect(await getInstallation(env.DB, installationId)).toBeNull();
    await knownInstallation();
    const before = await getInstallation(env.DB, installationId);
    const wrong = await send("POST", "/v1/activate", await activationRequest({ currentRevision: 5 }), { [SECRET_HEADER]: OTHER_SECRET });
    expect(wrong.status).toBe(401);
    expect(await getInstallation(env.DB, installationId)).toEqual(before);
  });

  it("unknown route is 404", async () => {
    expect((await send("GET", "/nope")).status).toBe(404);
    expect((await send("GET", "/v1/activate")).status).toBe(404);
    expect((await send("DELETE", "/subscribe")).status).toBe(404);
  });

  it("rate limit returns 429", async () => {
    allowed = false;
    expect((await send("POST", "/v1/activate", await activationRequest(), withSecret())).status).toBe(429);
    expect((await send("POST", "/v1/subscriptions", checkout(UNKNOWN_SESSION))).status).toBe(429);
    expect((await send("POST", "/v1/subscribe-sessions", { installationId }, withSecret())).status).toBe(429);
    expect(limited).toEqual(["unknown", "unknown", "unknown"]);
    expect(await getInstallation(env.DB, installationId)).toBeNull();
  });

  it("a failing rate limiter fails open and logs only a fixed message and the error text", async () => {
    const logged: unknown[][] = [];
    vi.spyOn(console, "error").mockImplementation((...args) => { logged.push(args); });
    env.LIMITER = { limit: async () => { throw new Error("internal error; reference = abc"); } };
    const activate = await send("POST", "/v1/activate", await activationRequest(), withSecret({ "cf-connecting-ip": "203.0.113.9", "x-secret": "hunter2" }));
    expect(activate.status).toBe(200);
    expect((await activate.json() as { license: string }).license).toMatch(/^ff1\./);
    const minted = await send("POST", "/v1/subscribe-sessions", { installationId }, withSecret({ "cf-connecting-ip": "203.0.113.9" }));
    expect(minted.status).toBe(200);
    const { session } = await minted.json() as { session: string };
    const subscribe = await send("POST", "/v1/subscriptions", checkout(session), { "cf-connecting-ip": "203.0.113.9" });
    expect(subscribe.status).toBe(200);
    expect(await subscribe.json()).toMatchObject({ subscriptionId: "sub_NEW" });
    expect(logged).toHaveLength(3);
    expect(logged[0]).toEqual(["licensing-worker: rate limiter unavailable:", "internal error; reference = abc"]);
    expect(JSON.stringify(logged)).not.toMatch(/203\.0\.113\.9|hunter2|owner@example\.com|ff1\./);
    expect(JSON.stringify(logged)).not.toContain(session);
  });

  it("a rate limiter that throws synchronously also fails open", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    env.LIMITER = { limit: () => { throw new Error("sync failure"); } };
    expect((await send("POST", "/v1/activate", await activationRequest(), withSecret())).status).toBe(200);
  });

  it("invalid JSON or schema is 400", async () => {
    for (const body of ["{not json", "[]"]) {
      const res = await send("POST", "/v1/activate", body, withSecret());
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "bad_request" });
    }
    expect((await send("POST", "/v1/subscriptions", "nope")).status).toBe(400);
    expect((await send("POST", "/v1/subscribe-sessions", "nope", withSecret())).status).toBe(400);
  });

  it("an unexpected throw is a JSON 500 that logs no body", async () => {
    const logged: unknown[][] = [];
    vi.spyOn(console, "error").mockImplementation((...args) => { logged.push(args); });
    env.DB = { prepare: () => { throw new Error("db exploded"); }, batch: async () => [] };
    const res = await send("POST", "/v1/activate", await activationRequest({ currentRevision: 424242 }), withSecret());
    expect(res.status).toBe(500);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(await res.json()).toEqual({ error: "internal" });
    expect(logged).toHaveLength(1);
    expect(JSON.stringify(logged)).not.toContain("424242");
  });

  it("a signer failure is a 500 and the next request retries", async () => {
    const other = generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const otherFingerprint = (await webCryptoSigner(other)).fingerprint;
    env.LICENSE_SIGNING_KEY = other;
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(crypto.subtle, "importKey").mockRejectedValueOnce(new Error("transient"));
    expect((await send("POST", "/v1/activate", await activationRequest({ verificationKeyFingerprint: otherFingerprint }), withSecret())).status).toBe(500);
    expect((await send("POST", "/v1/activate", await activationRequest({ verificationKeyFingerprint: otherFingerprint }), withSecret())).status).toBe(200);
  });
});

describe("POST /v1/subscribe-sessions", () => {
  it("mints a session for the installation holding the secret and is rate limited like activate", async () => {
    await knownInstallation();
    limited = [];
    const res = await send("POST", "/v1/subscribe-sessions", { installationId }, withSecret({ "cf-connecting-ip": "203.0.113.7" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(await res.json()).toEqual({ session: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/), expiresAt: T0 + 30 * 60_000 });
    expect(limited).toEqual(["203.0.113.7"]);
    allowed = false;
    expect((await send("POST", "/v1/subscribe-sessions", { installationId }, withSecret())).status).toBe(429);
    expect(await sessionCount()).toBe(1);
  });

  it("is 404 for an unknown installation, 401 for a missing or wrong secret, 400 for bad JSON", async () => {
    expect((await send("POST", "/v1/subscribe-sessions", { installationId }, withSecret())).status).toBe(404);
    await knownInstallation();
    expect(await (await send("POST", "/v1/subscribe-sessions", { installationId })).json()).toEqual({ error: "unauthorized" });
    expect((await send("POST", "/v1/subscribe-sessions", { installationId }, { [SECRET_HEADER]: OTHER_SECRET })).status).toBe(401);
    expect((await send("POST", "/v1/subscribe-sessions", "{nope", withSecret())).status).toBe(400);
    expect(await sessionCount()).toBe(0);
    expect((await send("GET", "/v1/subscribe-sessions")).status).toBe(404);
  });
});

describe("GET /subscribe", () => {
  it("a valid session gets the checkout form with the session embedded and no installation id", async () => {
    await knownInstallation();
    const session = await mintSession();
    const res = await send("GET", `/subscribe?session=${session}`);
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(html).toContain(`data-session="${session}"`);
    expect(html).not.toContain(installationId);
    expect(html).toContain("https://checkout.razorpay.com/v1/checkout.js");
    expect(html).toContain("/v1/subscriptions");
    expect(html).toContain("Payment received. Return to MasalaPOS and press Check for renewal.");
    expect(html).toContain(EXPIRED);
    expect(html).not.toMatch(/₹|Rs\.?\s?\d|INR/);
  });

  it("the same session opens the page twice within its lifetime", async () => {
    await knownInstallation();
    const session = await mintSession();
    expect((await send("GET", `/subscribe?session=${session}`)).status).toBe(200);
    vi.setSystemTime(T0 + 29 * 60_000);
    expect((await send("GET", `/subscribe?session=${session}`)).status).toBe(200);
  });

  it("an expired, unknown, malformed or missing session gets the expired copy and no form", async () => {
    await knownInstallation();
    const session = await mintSession();
    vi.setSystemTime(T0 + 30 * 60_000);
    for (const query of [`session=${session}`, `session=${UNKNOWN_SESSION}`, "session=short", "session=", "", `installation=${installationId}`, `installation=${installationId}&session=${UNKNOWN_SESSION}`]) {
      const res = await send("GET", `/subscribe?${query}`);
      const html = await res.text();
      expect(res.status).toBe(404);
      expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
      expect(html).toContain(EXPIRED);
      expect(html).not.toContain("<form");
      expect(html).not.toContain(installationId);
    }
  });

  it("a hostile session value is never echoed", async () => {
    for (const query of ["session=%3Cscript%3Ealert(1)%3C/script%3E", "session=%22%3E%3Cimg%20src%3Dx%3E"]) {
      const html = await (await send("GET", `/subscribe?${query}`)).text();
      expect(html).not.toContain("alert(1)");
      expect(html).not.toContain("<img");
    }
  });
});

describe("POST /v1/subscriptions", () => {
  it("create subscription tags notes with the session's installation and stores the row", async () => {
    await knownInstallation();
    const res = await send("POST", "/v1/subscriptions", checkout(await mintSession()));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(await res.json()).toEqual({ subscriptionId: "sub_NEW", keyId: "rzp_test_key" });
    expect(razorpayCalls).toHaveLength(1);
    expect(razorpayCalls[0]).toMatchObject({ url: "https://api.razorpay.com/v1/subscriptions", authorization: `Basic ${btoa("rzp_test_key:rzp_secret")}` });
    expect(razorpayCalls[0]!.body).toEqual({ plan_id: "plan_py", total_count: 10, customer_notify: true, notes: { installationId, plan: "pro", period: "yearly" } });
    expect(await getSubscription(env.DB, "sub_NEW")).toEqual({ razorpaySubscriptionId: "sub_NEW", installationId, plan: "pro", period: "yearly", status: "created", currentPeriodEnd: null, createdAt: T0 });
    expect((await getInstallation(env.DB, installationId))?.contactEmail).toBe("owner@example.com");
  });

  it("one session can start checkout twice within its lifetime", async () => {
    await knownInstallation();
    const session = await mintSession();
    expect((await send("POST", "/v1/subscriptions", checkout(session))).status).toBe(200);
    vi.setSystemTime(T0 + 20 * 60_000);
    razorpayResponse = () => new Response(JSON.stringify({ id: "sub_TWO", status: "created" }), { status: 200 });
    expect(await (await send("POST", "/v1/subscriptions", checkout(session, { plan: "basic" }))).json()).toMatchObject({ subscriptionId: "sub_TWO" });
    expect(razorpayCalls).toHaveLength(2);
  });

  it("an expired, unknown or malformed session is 401 session_expired and nothing is created", async () => {
    await knownInstallation();
    const session = await mintSession();
    vi.setSystemTime(T0 + 30 * 60_000);
    for (const token of [session, UNKNOWN_SESSION, "short", ""]) {
      const res = await send("POST", "/v1/subscriptions", checkout(token));
      expect(res.status).toBe(401);
      expect(res.headers.get("content-type")).toBe("application/json");
      expect(await res.json()).toEqual({ error: "session_expired" });
    }
    expect(razorpayCalls).toHaveLength(0);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM subscriptions").first<{ n: number }>()).toEqual({ n: 0 });
    expect((await getInstallation(env.DB, installationId))?.contactEmail).toBeNull();
  });

  it("the old installationId body is rejected, and an installationId next to a session is not accepted", async () => {
    await knownInstallation();
    const session = await mintSession();
    const old = { installationId, plan: "pro", period: "yearly", email: "owner@example.com" };
    expect((await send("POST", "/v1/subscriptions", old)).status).toBe(400);
    expect((await send("POST", "/v1/subscriptions", checkout(session, { installationId: "99999999-9999-4999-8999-999999999999" }))).status).toBe(400);
    expect(razorpayCalls).toHaveLength(0);
  });

  it("invalid email, plan or missing session is 400", async () => {
    await knownInstallation();
    const session = await mintSession();
    for (const email of ["not-an-email", "", "a@b", 5]) {
      const res = await send("POST", "/v1/subscriptions", checkout(session, { email }));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "bad_request" });
    }
    expect((await send("POST", "/v1/subscriptions", checkout(session, { plan: "gold" }))).status).toBe(400);
    expect((await send("POST", "/v1/subscriptions", checkout(session, { session: undefined }))).status).toBe(400);
    expect(razorpayCalls).toHaveLength(0);
  });

  it("a Razorpay failure is 502 and writes nothing", async () => {
    await knownInstallation();
    const session = await mintSession();
    vi.spyOn(console, "error").mockImplementation(() => {});
    razorpayResponse = () => new Response(JSON.stringify({ error: { description: "The plan id provided is invalid." } }), { status: 400 });
    const res = await send("POST", "/v1/subscriptions", checkout(session));
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "payment_provider" });
    expect((await getInstallation(env.DB, installationId))?.contactEmail).toBeNull();
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM subscriptions").first<{ n: number }>()).toEqual({ n: 0 });
  });

  it("a malformed 2xx Razorpay reply is also 502", async () => {
    await knownInstallation();
    const session = await mintSession();
    vi.spyOn(console, "error").mockImplementation(() => {});
    razorpayResponse = () => new Response("<html>", { status: 200 });
    expect((await send("POST", "/v1/subscriptions", checkout(session))).status).toBe(502);
  });
});

describe("POST /webhooks/razorpay", () => {
  it("is routed and rejects a bad signature", async () => {
    const res = await send("POST", "/webhooks/razorpay", "{}", { "x-razorpay-signature": "00", "x-razorpay-event-id": "evt_1" });
    expect(res.status).toBe(400);
  });
});

describe("counter clock skew", () => {
  it("a licence from a fast service clock is rejected by a counter 10 minutes behind, and the saved state is untouched", async () => {
    // The counter's route trims the pasted/fetched text before it reaches Licensing.activate.
    const envelope = (await (await send("POST", "/v1/activate", await activationRequest(), withSecret())).json() as { license: string }).license.trim();
    const db = openDb(":memory:"); migrate(db, MIGRATIONS);
    let counterNow = T0 - 10 * 60_000;
    const app = buildServer({ db, licensing: { publicKey: publicPem, installationId, now: () => counterNow } });
    try {
      const saved = () => db.prepare("SELECT * FROM license_state WHERE id = 1").get();
      const before = saved();
      expect(() => app.licensing.activate(envelope)).toThrow(/not currently valid/);
      expect(saved()).toEqual(before);
      // Within the 5-minute tolerance the same licence installs.
      counterNow = T0 - 4 * 60_000;
      app.licensing.activate(envelope);
      expect(saved()).toMatchObject({ envelope, revision: 1 });
    } finally { await app.close(); db.close(); }
  });
});
