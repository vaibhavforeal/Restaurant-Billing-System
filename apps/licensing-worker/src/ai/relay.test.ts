import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AiChatResponse, AiServiceStatus } from "@masalapos/domain/ai-wire";
import type { Env } from "../env.js";
import { INSTALLATION_HEADER } from "../live/authorize.js";
import { sha256Hex } from "../secret.js";
import { createInstallation } from "../store.js";
import { seedCustomer, seedOrder } from "../testing/fixtures.js";
import { activation, keyPair, send, testEnv, withSecret } from "../testing/harness.js";
import { TEST_SECRET } from "../testing/secret.js";
import { DEFAULT_OPENROUTER_MODEL, OPENROUTER_FALLBACK } from "./openrouter.js";

const T0 = Date.UTC(2026, 10, 4, 6, 0, 0);
const keys = keyPair();
let fingerprint: string;
let env: Env;
let installationId: string;
/** What the fake OpenRouter was sent, and what it answers next. */
let sent: Array<{ url: string; headers: Record<string, string>; body: Record<string, unknown> }>;
let answer: () => [number, unknown];

const chatBody = { system: "You help.", messages: [{ role: "user", text: "Sales today?" }], maxTokens: 800 };
const okReply = () => [200, { model: DEFAULT_OPENROUTER_MODEL, choices: [{ message: { content: "₹12,400 from 31 bills." } }], usage: { prompt_tokens: 120, completion_tokens: 30 } }] as [number, unknown];
const counter = (id = installationId, secret = TEST_SECRET) => ({ [INSTALLATION_HEADER]: id, ...withSecret({}, secret) });
const chat = (body: unknown = chatBody, headers: Record<string, string> = counter()) => send(env, "POST", "/v1/ai/chat", body, headers);
const status = (headers: Record<string, string> = counter()) => send(env, "GET", "/v1/ai/status", undefined, headers);
const switchOn = (dailyLimit = 40, id = installationId) =>
  env.DB.prepare(`INSERT INTO ai_settings (installation_id, enabled, daily_limit, updated_at) VALUES (?, 1, ?, ?)
    ON CONFLICT(installation_id) DO UPDATE SET enabled = 1, daily_limit = excluded.daily_limit`).bind(id, dailyLimit, Date.now()).run();

beforeAll(async () => { vi.useFakeTimers({ toFake: ["Date"] }); fingerprint = await keys.fingerprint(); });
beforeEach(async () => {
  vi.setSystemTime(T0);
  env = testEnv(keys.privatePem, { OPENROUTER_API_KEY: "sk-or-v1-vendor" });
  sent = []; answer = okReply;
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    sent.push({ url: String(input), headers: Object.fromEntries(new Headers(init?.headers).entries()), body: JSON.parse(String(init?.body)) });
    const [code, json] = answer();
    return new Response(JSON.stringify(json), { status: code, headers: { "content-type": "application/json" } });
  });
  const customer = await seedCustomer(env.DB, { name: "Spice Route" });
  const order = await seedOrder(env.DB, customer);
  installationId = crypto.randomUUID();
  const res = await send(env, "POST", "/v1/enroll", { activation: activation(installationId, fingerprint, { outletName: "Spice Route Baner" }), customerId: customer.code, orderId: order.code }, withSecret());
  expect(res.status).toBe(200);
});
afterEach(() => { vi.unstubAllGlobals(); });

describe("POST /v1/ai/chat", () => {
  it("forwards a switched-on counter's request with MasalaPOS's key, model and fallback, and counts it", async () => {
    await switchOn();
    const res = await chat();
    expect(res.status).toBe(200);
    expect(await res.json() as AiChatResponse).toEqual({
      reply: { text: "₹12,400 from 31 bills.", toolCalls: [], model: DEFAULT_OPENROUTER_MODEL, usage: { inputTokens: 120, outputTokens: 30 } },
      usedToday: 1, dailyLimit: 40,
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(sent[0]!.headers.authorization).toBe("Bearer sk-or-v1-vendor");
    expect(sent[0]!.body.models).toEqual([DEFAULT_OPENROUTER_MODEL, OPENROUTER_FALLBACK]);
    expect(sent[0]!.body.messages).toEqual([{ role: "system", content: "You help." }, { role: "user", content: "Sales today?" }]);
    const usage = await env.DB.prepare(`SELECT day, requests, input_tokens AS input, output_tokens AS output FROM ai_usage WHERE installation_id = ?`).bind(installationId).first();
    expect(usage).toEqual({ day: "2026-11-04", requests: 1, input: 120, output: 30 });
  });

  it("uses the model, fallback setting and address the service is configured with", async () => {
    env.OPENROUTER_MODEL = "nvidia/nemotron:free"; env.OPENROUTER_FALLBACK = "off"; env.OPENROUTER_BASE_URL = "http://127.0.0.1:4161/api/v1";
    await switchOn();
    await chat();
    expect(sent[0]!.body.model).toBe("nvidia/nemotron:free");
    expect(sent[0]!.body.models).toBeUndefined();
    expect(sent[0]!.url).toBe("http://127.0.0.1:4161/api/v1/chat/completions");
  });

  it("refuses counters it can't vouch for, before calling the provider", async () => {
    await switchOn();
    expect((await chat(chatBody, counter(installationId, "f".repeat(64)))).status).toBe(403);
    expect((await chat(chatBody, counter(crypto.randomUUID()))).status).toBe(403);
    expect((await chat(chatBody, { ...withSecret() })).status).toBe(403);
    const stray = crypto.randomUUID();
    await createInstallation(env.DB, { installationId: stray, licenseId: crypto.randomUUID(), organizationId: crypto.randomUUID(), outletId: crypto.randomUUID(), revisionFloor: 0, createdAt: Date.now(), secretHash: await sha256Hex(TEST_SECRET) });
    await switchOn(40, stray);
    const notEnrolled = await chat(chatBody, counter(stray));
    expect(notEnrolled.status).toBe(409);
    expect(await notEnrolled.json()).toMatchObject({ error: "not_enrolled" });
    vi.setSystemTime(T0 + 400 * 24 * 60 * 60_000);
    const expired = await chat();
    expect(expired.status).toBe(403);
    expect(await expired.json()).toMatchObject({ error: "licence_expired" });
    expect(sent).toHaveLength(0);
  });

  it("refuses a counter MasalaPOS hasn't switched on", async () => {
    const res = await chat();
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "ai_not_enabled" });
    await env.DB.prepare(`INSERT INTO ai_settings (installation_id, enabled, daily_limit, updated_at) VALUES (?, 0, 40, ?)`).bind(installationId, Date.now()).run();
    expect((await chat()).status).toBe(403);
    expect(sent).toHaveLength(0);
  });

  it("stops at the daily limit and starts again on the next UTC day", async () => {
    await switchOn(2);
    expect((await chat()).status).toBe(200);
    expect((await chat()).status).toBe(200);
    const over = await chat();
    expect(over.status).toBe(429);
    expect(await over.json()).toMatchObject({ error: "ai_daily_limit", limit: 2, used: 2 });
    expect(sent).toHaveLength(2);
    vi.setSystemTime(Date.UTC(2026, 10, 5, 0, 0, 1));
    expect((await chat()).status).toBe(200);
  });

  it("counts nothing when the provider fails, and says what kind of failure it was", async () => {
    await switchOn(5);
    for (const [providerStatus, status, error] of [[429, 503, "ai_limit"], [500, 503, "ai_unavailable"], [401, 502, "ai_bad_key"], [404, 502, "ai_model_gone"]] as const) {
      answer = () => [providerStatus, { error: { message: "upstream detail", code: providerStatus } }];
      const res = await chat();
      expect(res.status).toBe(status);
      const body = await res.json() as Record<string, unknown>;
      expect(body.error).toBe(error);
      expect(JSON.stringify(body)).not.toContain("upstream detail");
    }
    expect(await (await status()).json()).toMatchObject({ usedToday: 0 });
  });

  it("counts an empty reply, which the provider answered and may have charged for", async () => {
    await switchOn(5);
    answer = () => [200, { model: "m", choices: [{ message: { content: "" } }], usage: { prompt_tokens: 900, completion_tokens: 1 } }];
    expect(await (await chat()).json()).toMatchObject({ error: "ai_no_answer" });
    expect(await (await status()).json()).toMatchObject({ usedToday: 1 });
  });

  it("refuses a counter whose seat was released or handed to another computer", async () => {
    await switchOn();
    await env.DB.prepare(`UPDATE installations SET order_id = NULL WHERE installation_id = ?`).bind(installationId).run();
    const res = await chat();
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "not_enrolled" });
    expect(sent).toHaveLength(0);
  });

  it("answers 503 when the service has no provider key", async () => {
    delete env.OPENROUTER_API_KEY;
    await switchOn();
    const res = await chat();
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: "ai_unavailable" });
  });

  it("rejects oversized or malformed requests", async () => {
    await switchOn();
    expect((await chat({ ...chatBody, maxTokens: 100_000 })).status).toBe(400);
    expect((await chat({ ...chatBody, model: "openai/gpt-5" })).status).toBe(400);
    expect((await chat("not json")).status).toBe(400);
    expect(sent).toHaveLength(0);
  });
});

describe("GET /v1/ai/status", () => {
  it("says whether the counter is switched on, its limit and today's use, without calling the provider", async () => {
    expect(await (await status()).json() as AiServiceStatus).toEqual({ enabled: false, dailyLimit: 40, usedToday: 0 });
    await switchOn(25);
    await chat();
    expect(await (await status()).json() as AiServiceStatus).toEqual({ enabled: true, dailyLimit: 25, usedToday: 1 });
    expect(sent).toHaveLength(1);
    expect((await status(counter(installationId, "f".repeat(64)))).status).toBe(403);
  });
});
