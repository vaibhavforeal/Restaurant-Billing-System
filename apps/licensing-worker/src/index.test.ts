import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { webCryptoSigner } from "@forkflow/license-issuer";
import type { Env } from "./env.js";
import worker from "./index.js";
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
const RECONNECT = "Open ForkFlow once while connected to the internet, then try again.";

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
  format: "forkflow-activation-request", version: 1, installationId, licenseId: null, organizationId: null, outletId: null,
  currentRevision: 0, generatedAt: T0, verificationKeyFingerprint: fingerprint, ...over,
});
const checkout = (over: Record<string, unknown> = {}) => ({ installationId, plan: "pro", period: "yearly", email: "owner@example.com", ...over });
const knownInstallation = async () => { expect((await send("POST", "/v1/activate", await activationRequest())).status).toBe(200); };

describe("routing", () => {
  it("routes activate and returns a trial", async () => {
    const res = await send("POST", "/v1/activate", await activationRequest(), { "cf-connecting-ip": "203.0.113.7" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect((await res.json() as { license: string }).license).toMatch(/^ff1\./);
    expect(limited).toEqual(["203.0.113.7"]);
    expect(await getInstallation(env.DB, installationId)).toMatchObject({ trialStartedAt: T0 });
  });

  it("unknown route is 404", async () => {
    expect((await send("GET", "/nope")).status).toBe(404);
    expect((await send("GET", "/v1/activate")).status).toBe(404);
    expect((await send("DELETE", "/subscribe")).status).toBe(404);
  });

  it("rate limit returns 429", async () => {
    allowed = false;
    expect((await send("POST", "/v1/activate", await activationRequest())).status).toBe(429);
    expect((await send("POST", "/v1/subscriptions", checkout())).status).toBe(429);
    expect(limited).toEqual(["unknown", "unknown"]);
    expect(await getInstallation(env.DB, installationId)).toBeNull();
  });

  it("invalid JSON or schema is 400", async () => {
    for (const body of ["{not json", "[]"]) {
      const res = await send("POST", "/v1/activate", body);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "bad_request" });
    }
    expect((await send("POST", "/v1/subscriptions", "nope")).status).toBe(400);
  });

  it("an unexpected throw is a JSON 500 that logs no body", async () => {
    const logged: unknown[][] = [];
    vi.spyOn(console, "error").mockImplementation((...args) => { logged.push(args); });
    env.DB = { prepare: () => { throw new Error("db exploded"); }, batch: async () => [] };
    const res = await send("POST", "/v1/activate", await activationRequest({ currentRevision: 424242 }));
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
    expect((await send("POST", "/v1/activate", await activationRequest({ verificationKeyFingerprint: otherFingerprint }))).status).toBe(500);
    expect((await send("POST", "/v1/activate", await activationRequest({ verificationKeyFingerprint: otherFingerprint }))).status).toBe(200);
  });
});

describe("GET /subscribe", () => {
  it("subscribe page for an unknown installation shows the reconnect message", async () => {
    const res = await send("GET", `/subscribe?installation=${installationId}`);
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(await res.text()).toContain(RECONNECT);
  });

  it("subscribe page escapes the installation id", async () => {
    for (const query of ["installation=%3Cscript%3Ealert(1)%3C/script%3E", "installation=%22%3E%3Cimg%20src%3Dx%3E", ""]) {
      const res = await send("GET", `/subscribe?${query}`);
      const html = await res.text();
      expect(res.status).toBe(404);
      expect(html).not.toContain("alert(1)");
      expect(html).not.toContain("<img");
      expect(html).toContain(RECONNECT);
    }
  });

  it("a known installation gets the checkout form", async () => {
    await knownInstallation();
    const res = await send("GET", `/subscribe?installation=${installationId}`);
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(html).toContain(installationId);
    expect(html).toContain("https://checkout.razorpay.com/v1/checkout.js");
    expect(html).toContain("/v1/subscriptions");
    expect(html).toContain("Payment received. Return to ForkFlow and press Check for renewal.");
    expect(html).not.toMatch(/₹|Rs\.?\s?\d|INR/);
  });
});

describe("POST /v1/subscriptions", () => {
  it("create subscription tags notes and stores the row", async () => {
    await knownInstallation();
    const res = await send("POST", "/v1/subscriptions", checkout());
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(await res.json()).toEqual({ subscriptionId: "sub_NEW", keyId: "rzp_test_key" });
    expect(razorpayCalls).toHaveLength(1);
    expect(razorpayCalls[0]).toMatchObject({ url: "https://api.razorpay.com/v1/subscriptions", authorization: `Basic ${btoa("rzp_test_key:rzp_secret")}` });
    expect(razorpayCalls[0]!.body).toEqual({ plan_id: "plan_py", total_count: 10, customer_notify: true, notes: { installationId, plan: "pro", period: "yearly" } });
    expect(await getSubscription(env.DB, "sub_NEW")).toEqual({ razorpaySubscriptionId: "sub_NEW", installationId, plan: "pro", period: "yearly", status: "created", currentPeriodEnd: null, createdAt: T0 });
    expect((await getInstallation(env.DB, installationId))?.contactEmail).toBe("owner@example.com");
  });

  it("create subscription for an unknown installation is 404", async () => {
    const res = await send("POST", "/v1/subscriptions", checkout());
    expect(res.status).toBe(404);
    expect(razorpayCalls).toHaveLength(0);
  });

  it("invalid email is 400", async () => {
    await knownInstallation();
    for (const email of ["not-an-email", "", "a@b", 5]) {
      const res = await send("POST", "/v1/subscriptions", checkout({ email }));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "bad_request" });
    }
    expect((await send("POST", "/v1/subscriptions", checkout({ plan: "gold" }))).status).toBe(400);
    expect((await send("POST", "/v1/subscriptions", checkout({ installationId: "x" }))).status).toBe(400);
    expect(razorpayCalls).toHaveLength(0);
  });

  it("a Razorpay failure is 502 and writes nothing", async () => {
    await knownInstallation();
    vi.spyOn(console, "error").mockImplementation(() => {});
    razorpayResponse = () => new Response(JSON.stringify({ error: { description: "The plan id provided is invalid." } }), { status: 400 });
    const res = await send("POST", "/v1/subscriptions", checkout());
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "payment_provider" });
    expect((await getInstallation(env.DB, installationId))?.contactEmail).toBeNull();
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM subscriptions").first<{ n: number }>()).toEqual({ n: 0 });
  });

  it("a malformed 2xx Razorpay reply is also 502", async () => {
    await knownInstallation();
    vi.spyOn(console, "error").mockImplementation(() => {});
    razorpayResponse = () => new Response("<html>", { status: 200 });
    expect((await send("POST", "/v1/subscriptions", checkout())).status).toBe(502);
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
    const envelope = (await (await send("POST", "/v1/activate", await activationRequest())).json() as { license: string }).license.trim();
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
