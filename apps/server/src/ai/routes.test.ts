import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { localDateKey, MIGRATIONS, migrate, openDb } from "@masalapos/domain";
import { buildServer } from "../server.js";
import { makeFakeSink } from "../print/sinks.js";
import { auth, createUser, setupAdmin } from "../test-helpers.js";

/** A fake OpenRouter: chat replies come from `chat`, models and key are fixed. */
function fakeOpenRouter() {
  const state = { chat: (_body: Record<string, unknown>): [number, unknown] => [200, { model: "google/gemma-4-31b-it:free", choices: [{ message: { content: "Fine." } }], usage: { prompt_tokens: 5, completion_tokens: 2 } }] };
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const [status, json]: [number, unknown] = url.endsWith("/models") ? [200, { data: [{ id: "google/gemma-4-31b-it:free", name: "Gemma 4 31B", context_length: 262144, pricing: { prompt: "0", completion: "0" }, supported_parameters: ["tools"] }] }]
      : url.endsWith("/key") ? [200, { data: { free_model_daily_requests: { used: 3, limit: 50 } } }]
      : state.chat(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response(JSON.stringify(json), { status, headers: { "content-type": "application/json" } });
  }) as typeof globalThis.fetch;
  return { fetch, state };
}

describe("AI assistant routes", () => {
  let app: FastifyInstance, token: string, dir: string, openrouter: ReturnType<typeof fakeOpenRouter>;
  const call = (method: "GET" | "POST" | "PUT", url: string, payload?: object, as = token) =>
    app.inject({ method, url, headers: auth(as), ...(payload ? { payload } : {}) });
  const turnOn = () => call("PUT", "/api/ai/settings", { key: "sk-or-v1-secret9876", enabled: true });

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "ai-routes-"));
    openrouter = fakeOpenRouter();
    const db = openDb(":memory:"); migrate(db, MIGRATIONS);
    app = buildServer({ db, sinkSend: makeFakeSink().send, ai: { dataDir: dir, secretKey: randomBytes(32), fetch: openrouter.fetch, baseUrl: "https://fake.test/api/v1" } });
    ({ token } = await setupAdmin(app));
  });
  afterEach(async () => { await app.close(); app.db.close(); rmSync(dir, { recursive: true, force: true }); });

  it("status hides the assistant until it is switched on with a key", async () => {
    expect((await call("GET", "/api/ai/status")).json()).toEqual({ enabled: false, canAsk: true, canDescribe: true, canManage: true });
    await turnOn();
    expect((await call("GET", "/api/ai/status")).json()).toMatchObject({ enabled: true });
    const cashier = await createUser(app, token, { name: "Ravi", pin: "2345", role: "cashier" });
    expect((await call("GET", "/api/ai/status", undefined, cashier.token)).json()).toMatchObject({ enabled: true, canAsk: false, canManage: false });
  });

  it("settings never return the key", async () => {
    const saved = await turnOn();
    expect(saved.statusCode, saved.body).toBe(200);
    const res = await call("GET", "/api/ai/settings");
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.body).not.toContain("secret");
    expect(res.json()).toMatchObject({ keySaved: true, keyEnding: "9876", canSaveKey: true, settings: { enabled: true, model: "google/gemma-4-31b-it:free", fallback: true } });
    expect((await call("PUT", "/api/ai/settings", { key: null })).json()).toMatchObject({ keySaved: false, keyEnding: null });
    expect((await call("PUT", "/api/ai/settings", { model: "" })).statusCode).toBe(400);
  });

  it("only admins manage settings and ask; dish editors may describe", async () => {
    await turnOn();
    const cashier = await createUser(app, token, { name: "Ravi", pin: "2345", role: "cashier" });
    expect((await call("GET", "/api/ai/settings", undefined, cashier.token)).statusCode).toBe(403);
    expect((await call("POST", "/api/ai/ask", { question: "Top dish?" }, cashier.token)).statusCode).toBe(403);
    app.db.prepare("INSERT INTO user_permissions (user_id, permission, allowed, updated_at, updated_by) VALUES (?, 'catalog.manage', 1, 0, ?)").run(cashier.id, cashier.id);
    const described = await call("POST", "/api/ai/describe", { name: "Paneer tikka", category: "Starters", isVeg: true, sizes: [] }, cashier.token);
    expect(described.statusCode, described.body).toBe(200);
    expect(described.json()).toEqual({ text: "Fine.", model: "google/gemma-4-31b-it:free" });
  });

  it("lists models and tests the connection", async () => {
    await turnOn();
    expect((await call("GET", "/api/ai/models")).json().models[0]).toMatchObject({ id: "google/gemma-4-31b-it:free", contextLength: 262144 });
    expect((await call("POST", "/api/ai/test")).json()).toEqual({ model: "google/gemma-4-31b-it:free", freeRequestsUsed: 3, freeRequestsLimit: 50 });
    expect((await call("GET", "/api/ai/settings")).json().usage.test).toEqual({ requests: 1, inputTokens: 5, outputTokens: 2 });
  });

  it("Test works with a saved key while the assistant is switched off", async () => {
    await turnOn();
    await call("PUT", "/api/ai/settings", { enabled: false });
    const res = await call("POST", "/api/ai/test");
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ model: "google/gemma-4-31b-it:free" });
  });

  it("ask returns the answer and figures used, and counts usage", async () => {
    await turnOn();
    let step = 0;
    openrouter.state.chat = () => step++ === 0
      ? [200, { model: "m", choices: [{ message: { content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "today", arguments: "{}" } }] } }], usage: { prompt_tokens: 4, completion_tokens: 1 } }]
      : [200, { model: "m", choices: [{ message: { content: "It is today." } }], usage: { prompt_tokens: 6, completion_tokens: 3 } }];
    const res = await call("POST", "/api/ai/ask", { question: "What day is it?", history: [{ role: "system", text: "x" }] });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ answer: "It is today.", figuresUsed: ["Today's date"], model: "m" });
    expect((await call("GET", "/api/ai/settings")).json().usage.ask).toEqual({ requests: 2, inputTokens: 10, outputTokens: 4 });
  });

  it("day summary and describe return text", async () => {
    await turnOn();
    expect((await call("POST", "/api/ai/day-summary", { date: localDateKey(Date.now()) })).json()).toEqual({ text: "Fine.", model: "google/gemma-4-31b-it:free" });
    expect((await call("POST", "/api/ai/day-summary", { date: "yesterday" })).statusCode).toBe(400);
  });

  it("provider failures map to statuses and the spec's messages", async () => {
    await turnOn();
    openrouter.state.chat = () => [429, { error: { message: "Rate limit", code: 429 } }];
    const limited = await call("POST", "/api/ai/ask", { question: "Hi" });
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toMatchObject({ code: "ai_limit", error: expect.stringContaining("free limit is used up") });
    openrouter.state.chat = () => { throw new TypeError("fetch failed"); };
    const offline = await call("POST", "/api/ai/ask", { question: "Hi" });
    expect(offline.statusCode).toBe(503);
    expect(offline.json()).toMatchObject({ code: "ai_offline", error: "The AI assistant needs internet. Everything else keeps working." });
    openrouter.state.chat = () => [401, { error: { message: "No auth" } }];
    expect((await call("POST", "/api/ai/describe", { name: "Dal", category: "Mains", isVeg: true, sizes: [] })).json()).toMatchObject({ code: "ai_bad_key" });
  });

  it("routes answer 409 off while the assistant is off or has no key", async () => {
    expect((await call("POST", "/api/ai/ask", { question: "Hi" })).json()).toMatchObject({ code: "ai_off" });
    await call("PUT", "/api/ai/settings", { enabled: true });
    const res = await call("POST", "/api/ai/describe", { name: "Dal", category: "Mains", isVeg: true, sizes: [] });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "ai_off" });
  });
});
