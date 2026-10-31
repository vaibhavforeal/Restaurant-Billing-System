import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { webCryptoSigner } from "@masalapos/license-issuer";
import type { Env } from "./env.js";
import { getInstallation } from "./store.js";
import { seedCustomer, seedOrder } from "./testing/fixtures.js";
import { activation, keyPair, send as sendTo, testEnv, withSecret } from "./testing/harness.js";
// Test-only: the Worker source never imports the counter server or the domain index.
import { MIGRATIONS, migrate, openDb } from "../../../packages/domain/src/index.js";
import { buildServer } from "../../server/src/server.js";

const T0 = Date.UTC(2026, 9, 10, 10, 0, 0);
const keys = keyPair();
const installationId = "66666666-6666-4666-8666-666666666666";

let env: Env;
let limited: string[];
let allowed: boolean;
let fingerprint: string;
beforeAll(async () => { vi.useFakeTimers({ toFake: ["Date"] }); fingerprint = await keys.fingerprint(); });
beforeEach(() => {
  vi.setSystemTime(T0);
  limited = [];
  allowed = true;
  env = testEnv(keys.privatePem, { LIMITER: { limit: async ({ key }) => { limited.push(key); return { success: allowed }; } } });
});
afterEach(() => { vi.restoreAllMocks(); });

const send = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => sendTo(env, method, path, body, headers);
const activationRequest = (over: Record<string, unknown> = {}) => activation(installationId, fingerprint, over);
/** Enrols the test installation on a paid order and returns the enrol reply's licence. */
async function enrolled(): Promise<string> {
  const customer = await seedCustomer(env.DB);
  const order = await seedOrder(env.DB, customer);
  const res = await send("POST", "/v1/enroll", { activation: activationRequest(), customerId: customer.code, orderId: order.code }, withSecret());
  expect(res.status).toBe(200);
  return (await res.json() as { license: string }).license;
}

describe("routing", () => {
  it("routes activate and enroll, rate limited by the caller's address", async () => {
    const licence = await enrolled();
    const res = await send("POST", "/v1/activate", activationRequest(), withSecret({ "cf-connecting-ip": "203.0.113.7" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(await res.json()).toEqual({ license: licence, enrolled: true });
    expect(limited).toEqual(["unknown", "203.0.113.7"]);
  });

  it("activate without the secret header is 401, with a wrong one 401, and neither writes", async () => {
    await enrolled();
    const before = await getInstallation(env.DB, installationId);
    for (const headers of [{}, withSecret({}, "not-a-secret"), withSecret({}, "b".repeat(64))]) {
      const res = await send("POST", "/v1/activate", activationRequest({ currentRevision: 5 }), headers);
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "unauthorized" });
    }
    expect(await getInstallation(env.DB, installationId)).toEqual(before);
  });

  it("the old self-serve and owner routes are gone", async () => {
    for (const [method, path] of [["GET", "/nope"], ["GET", "/v1/activate"], ["GET", "/subscribe"], ["POST", "/v1/subscribe-sessions"], ["POST", "/v1/subscriptions"], ["GET", "/owner"]] as const) {
      expect((await send(method, path)).status).toBe(404);
    }
  });

  it("rate limit returns 429 and writes nothing", async () => {
    allowed = false;
    expect((await send("POST", "/v1/activate", activationRequest(), withSecret())).status).toBe(429);
    expect((await send("POST", "/v1/enroll", { activation: activationRequest(), customerId: "x", orderId: "y" }, withSecret())).status).toBe(429);
    expect(limited).toEqual(["unknown", "unknown"]);
    expect(await getInstallation(env.DB, installationId)).toBeNull();
  });

  it("a failing rate limiter fails open and logs only a fixed message and the error text", async () => {
    const logged: unknown[][] = [];
    vi.spyOn(console, "error").mockImplementation((...args) => { logged.push(args); });
    env.LIMITER = { limit: async () => { throw new Error("internal error; reference = abc"); } };
    const licence = await enrolled();
    const activate = await send("POST", "/v1/activate", activationRequest(), withSecret({ "cf-connecting-ip": "203.0.113.9", "x-secret": "hunter2" }));
    expect(await activate.json()).toEqual({ license: licence, enrolled: true });
    expect(logged).toHaveLength(2);
    expect(logged[0]).toEqual(["licensing-worker: rate limiter unavailable:", "internal error; reference = abc"]);
    expect(JSON.stringify(logged)).not.toMatch(/203\.0\.113\.9|hunter2|ff1\./);
  });

  it("a rate limiter that throws synchronously also fails open", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    env.LIMITER = { limit: () => { throw new Error("sync failure"); } };
    expect((await send("POST", "/v1/activate", activationRequest(), withSecret())).status).toBe(200);
  });

  it("invalid JSON or schema is 400", async () => {
    for (const path of ["/v1/activate", "/v1/enroll"]) {
      for (const body of ["{not json", "[]"]) {
        const res = await send("POST", path, body, withSecret());
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({ error: "bad_request" });
      }
    }
  });

  it("an unexpected throw is a JSON 500 that logs no body", async () => {
    const logged: unknown[][] = [];
    vi.spyOn(console, "error").mockImplementation((...args) => { logged.push(args); });
    env.DB = { prepare: () => { throw new Error("db exploded"); }, batch: async () => [] };
    const res = await send("POST", "/v1/activate", activationRequest({ currentRevision: 424242 }), withSecret());
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
    expect((await send("POST", "/v1/activate", activationRequest({ verificationKeyFingerprint: otherFingerprint }), withSecret())).status).toBe(500);
    expect((await send("POST", "/v1/activate", activationRequest({ verificationKeyFingerprint: otherFingerprint }), withSecret())).status).toBe(200);
  });

  it("routes the Razorpay webhook and rejects a bad signature", async () => {
    const res = await send("POST", "/webhooks/razorpay", "{}", { "x-razorpay-signature": "00", "x-razorpay-event-id": "evt_1" });
    expect(res.status).toBe(400);
  });
});

describe("counter clock skew", () => {
  it("a licence from a fast service clock is rejected by a counter 10 minutes behind, and the saved state is untouched", async () => {
    // The counter's route trims the pasted/fetched text before it reaches Licensing.activate.
    const envelope = (await enrolled()).trim();
    const db = openDb(":memory:"); migrate(db, MIGRATIONS);
    let counterNow = T0 - 10 * 60_000;
    const app = buildServer({ db, licensing: { publicKey: keys.publicPem, installationId, now: () => counterNow } });
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
