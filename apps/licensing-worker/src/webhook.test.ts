import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHmac, randomUUID } from "node:crypto";
import { webCryptoSigner } from "@forkflow/license-issuer";
import type { D1Like } from "./env.js";
import { memoryD1 } from "./testing/d1.js";
import { keyPair } from "./testing/harness.js";
import { handleWebhook, type WebhookDeps } from "./webhook.js";

const T0 = Date.UTC(2026, 9, 10, 10, 0, 0);
const SECRET = "whsec_test";
const keys = keyPair();

let db: D1Like;
let deps: WebhookDeps;
let logs: string[];
let signer: WebhookDeps["signer"];
beforeAll(async () => { signer = await webCryptoSigner(keys.privatePem); });
beforeEach(() => {
  db = memoryD1();
  logs = [];
  deps = { db, signer, now: () => T0, uuid: () => randomUUID(), webhookSecret: SECRET, log: (m) => logs.push(m) };
});

const deliver = (body: string, eventId: string | null = "evt_1", signature = createHmac("sha256", SECRET).update(body).digest("hex")) =>
  handleWebhook(deps, new Request("https://licensing.test/webhooks/razorpay", {
    method: "POST", body, headers: { "x-razorpay-signature": signature, ...(eventId ? { "x-razorpay-event-id": eventId } : {}) },
  }));
const events = async () => (await db.prepare(`SELECT event_id AS id, type, outcome FROM webhook_events`).all()).results;

describe("POST /webhooks/razorpay", () => {
  it("refuses a bad signature or a missing event id and records nothing", async () => {
    expect((await deliver("{}", "evt_1", "00")).status).toBe(400);
    expect((await deliver("{}", null)).status).toBe(400);
    expect(await events()).toEqual([]);
  });

  it("records each signed event once; a replay is a duplicate", async () => {
    const body = JSON.stringify({ event: "subscription.charged", payload: {} });
    expect(await (await deliver(body)).json()).toEqual({ outcome: "ignored" });
    expect(await (await deliver(body)).json()).toEqual({ outcome: "duplicate" });
    expect(await (await deliver("not json", "evt_2")).json()).toEqual({ outcome: "ignored" });
    expect(await events()).toEqual([{ id: "evt_1", type: "subscription.charged", outcome: "ignored" }, { id: "evt_2", type: "unknown", outcome: "ignored" }]);
  });

  it("a store failure is a 500 so Razorpay retries", async () => {
    deps.db = { prepare: () => { throw new Error("db down"); }, batch: async () => [] };
    expect((await deliver("{}")).status).toBe(500);
    expect(logs).toEqual(["webhook evt_1 failed: db down"]);
  });
});
