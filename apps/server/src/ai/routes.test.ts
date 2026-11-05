import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { localDateKey, MIGRATIONS, migrate, openDb } from "@masalapos/domain";
import { buildServer } from "../server.js";
import { makeFakeSink } from "../print/sinks.js";
import { auth, createUser, setupAdmin } from "../test-helpers.js";

const SERVICE = { serviceUrl: "https://portal.test", installationId: "11111111-1111-4111-8111-111111111111", installationSecret: "b".repeat(64) };
const answer = (text: string, extra: object = {}) => ({ reply: { text, toolCalls: [], model: "google/gemma-4-31b-it:free", usage: { inputTokens: 5, outputTokens: 2 } }, usedToday: 1, dailyLimit: 40, ...extra });

/** A fake MasalaPOS AI service: `status` is what /v1/ai/status says, `chat` answers /v1/ai/chat. */
function fakeService() {
  const state = {
    status: { enabled: true, dailyLimit: 40, usedToday: 0 },
    chat: (_body: Record<string, unknown>): [number, unknown] => [200, answer("Fine.")],
    calls: [] as Array<{ path: string; headers: Record<string, string>; body: string }>,
  };
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    state.calls.push({ path, headers: Object.fromEntries(new Headers(init?.headers).entries()), body: String(init?.body ?? "") });
    const [status, json]: [number, unknown] = path === "/v1/ai/status" ? [200, state.status] : state.chat(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response(JSON.stringify(json), { status, headers: { "content-type": "application/json" } });
  }) as typeof globalThis.fetch;
  return { fetch, state };
}

async function until(done: () => boolean, what: string) {
  for (let tries = 0; !done(); tries++) {
    if (tries > 200) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("AI assistant routes", () => {
  let app: FastifyInstance, token: string, dir: string, service: ReturnType<typeof fakeService>;
  const call = (method: "GET" | "POST" | "PUT", url: string, payload?: object, as = token) =>
    app.inject({ method, url, headers: auth(as), ...(payload ? { payload } : {}) });
  const start = async (connected = true) => {
    const db = openDb(":memory:"); migrate(db, MIGRATIONS);
    app = buildServer({ db, sinkSend: makeFakeSink().send, ai: { dataDir: dir, fetch: service.fetch, ...(connected ? { service: SERVICE } : {}) } });
    ({ token } = await setupAdmin(app));
  };
  /** Settings → Test: asks the service for this counter's status now. */
  const check = () => call("POST", "/api/ai/test");

  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "ai-routes-")); service = fakeService(); });
  afterEach(async () => { await app.close(); app.db.close(); rmSync(dir, { recursive: true, force: true }); });

  it("a copy that isn't connected to MasalaPOS says so, and every AI route answers off", async () => {
    await start(false);
    expect((await call("GET", "/api/ai/status")).json()).toEqual({ enabled: false, connected: false, canAsk: true, canDescribe: true, canManage: true });
    expect((await call("GET", "/api/ai/settings")).json()).toMatchObject({ connected: false, localEnabled: true, service: null });
    for (const [method, url, body] of [["POST", "/api/ai/ask", { question: "Hi" }], ["POST", "/api/ai/test", undefined], ["POST", "/api/ai/describe", { name: "Dal", category: "Mains", isVeg: true, sizes: [] }]] as const) {
      const res = await call(method, url, body);
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ code: "ai_off" });
    }
    expect(service.state.calls).toEqual([]);
  });

  it("checks with the service on start, sending the counter's ID and secret", async () => {
    await start();
    await app.ready();
    await until(() => service.state.calls.some((c) => c.path === "/v1/ai/status"), "the start-up status check");
    expect(service.state.calls[0]!.headers).toMatchObject({ "x-masalapos-installation-id": SERVICE.installationId, "x-masalapos-installation-secret": SERVICE.installationSecret });
  });

  it("is on only while MasalaPOS has switched it on and the restaurant's own switch is on", async () => {
    await start();
    service.state.status = { enabled: false, dailyLimit: 40, usedToday: 0 };
    await check();
    expect((await call("GET", "/api/ai/status")).json()).toMatchObject({ enabled: false, connected: true });
    service.state.status = { enabled: true, dailyLimit: 40, usedToday: 0 };
    const tested = await check();
    expect(tested.json()).toMatchObject({ connected: true, localEnabled: true, service: { enabled: true, dailyLimit: 40, usedToday: 0 } });
    expect((await call("GET", "/api/ai/status")).json()).toMatchObject({ enabled: true });
    expect((await call("PUT", "/api/ai/settings", { enabled: false })).json()).toMatchObject({ localEnabled: false });
    expect((await call("GET", "/api/ai/status")).json()).toMatchObject({ enabled: false });
    expect((await call("POST", "/api/ai/ask", { question: "Hi" })).json()).toMatchObject({ code: "ai_off" });
    await call("PUT", "/api/ai/settings", { enabled: true });
    const cashier = await createUser(app, token, { name: "Ravi", pin: "2345", role: "cashier" });
    expect((await call("GET", "/api/ai/status", undefined, cashier.token)).json()).toMatchObject({ enabled: true, canAsk: false, canManage: false });
  });

  it("takes no key or model, and has no models list", async () => {
    await start();
    expect((await call("PUT", "/api/ai/settings", { key: "sk-or-v1-secret9876" })).statusCode).toBe(400);
    expect((await call("PUT", "/api/ai/settings", { model: "x" })).statusCode).toBe(400);
    expect((await call("GET", "/api/ai/models")).statusCode).toBe(404);
    const settings = await call("GET", "/api/ai/settings");
    expect(settings.headers["cache-control"]).toBe("no-store");
    expect(settings.body).not.toMatch(/key|model/i);
  });

  it("only admins manage settings and ask; dish editors may describe", async () => {
    await start(); await check();
    const cashier = await createUser(app, token, { name: "Ravi", pin: "2345", role: "cashier" });
    expect((await call("GET", "/api/ai/settings", undefined, cashier.token)).statusCode).toBe(403);
    expect((await call("POST", "/api/ai/ask", { question: "Top dish?" }, cashier.token)).statusCode).toBe(403);
    app.db.prepare("INSERT INTO user_permissions (user_id, permission, allowed, updated_at, updated_by) VALUES (?, 'catalog.manage', 1, 0, ?)").run(cashier.id, cashier.id);
    const described = await call("POST", "/api/ai/describe", { name: "Paneer tikka", category: "Starters", isVeg: true, sizes: [] }, cashier.token);
    expect(described.statusCode, described.body).toBe(200);
    expect(described.json()).toEqual({ text: "Fine.", model: "google/gemma-4-31b-it:free" });
  });

  it("ask returns the answer and figures used, counts usage, and keeps today's use from the service", async () => {
    await start(); await check();
    let step = 0;
    service.state.chat = () => step++ === 0
      ? [200, { reply: { text: "", toolCalls: [{ id: "c1", name: "today", arguments: "{}" }], model: "m", usage: { inputTokens: 4, outputTokens: 1 } }, usedToday: 6, dailyLimit: 40 }]
      : [200, { reply: { text: "It is today.", toolCalls: [], model: "m", usage: { inputTokens: 6, outputTokens: 3 } }, usedToday: 7, dailyLimit: 40 }];
    const res = await call("POST", "/api/ai/ask", { question: "What day is it?", history: [{ role: "system", text: "x" }] });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ answer: "It is today.", figuresUsed: ["Today's date"], model: "m" });
    const settings = (await call("GET", "/api/ai/settings")).json();
    expect(settings.usage.ask).toEqual({ requests: 2, inputTokens: 10, outputTokens: 4 });
    expect(settings.service).toMatchObject({ usedToday: 7, dailyLimit: 40 });
  });

  it("day summary returns text", async () => {
    await start(); await check();
    expect((await call("POST", "/api/ai/day-summary", { date: localDateKey(Date.now()) })).json()).toEqual({ text: "Fine.", model: "google/gemma-4-31b-it:free" });
    expect((await call("POST", "/api/ai/day-summary", { date: "yesterday" })).statusCode).toBe(400);
  });

  it("service refusals reach the owner as plain messages; one saying it's not switched on hides the AI buttons", async () => {
    await start(); await check();
    service.state.chat = () => [429, { error: "ai_daily_limit", limit: 40, used: 40 }];
    const limited = await call("POST", "/api/ai/ask", { question: "Hi" });
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toEqual({ code: "ai_daily_limit", error: "Today's AI limit for this restaurant is used up. It resets at midnight (UTC)." });
    expect((await call("GET", "/api/ai/settings")).json().service).toMatchObject({ usedToday: 40 });
    service.state.chat = () => { throw new TypeError("fetch failed"); };
    const offline = await call("POST", "/api/ai/ask", { question: "Hi" });
    expect(offline.statusCode).toBe(503);
    expect(offline.json()).toMatchObject({ code: "ai_offline", error: "The AI assistant needs internet. Everything else keeps working." });
    service.state.chat = () => [403, { error: "ai_not_enabled" }];
    const off = await call("POST", "/api/ai/describe", { name: "Dal", category: "Mains", isVeg: true, sizes: [] });
    expect(off.statusCode).toBe(403);
    expect(off.json()).toMatchObject({ code: "ai_not_enabled" });
    expect((await call("GET", "/api/ai/status")).json()).toMatchObject({ enabled: false });
  });

  it("re-checks with the service when its last answer is old", async () => {
    await start();
    await check();
    const before = service.state.calls.length;
    writeFileSync(join(dir, "ai-assistant.json"), JSON.stringify({ service: { enabled: true, dailyLimit: 40, usedToday: 0, checkedAt: Date.now() - 60 * 60_000 } }));
    await call("GET", "/api/ai/status");
    await until(() => service.state.calls.length > before, "a fresh status check");
  });

  it("shows no use today when the service's last count was from an earlier UTC day", async () => {
    await start();
    writeFileSync(join(dir, "ai-assistant.json"), JSON.stringify({ service: { enabled: true, dailyLimit: 40, usedToday: 31, checkedAt: Date.now() - 2 * 24 * 60 * 60_000 } }));
    expect((await call("GET", "/api/ai/settings")).json().service).toMatchObject({ usedToday: 0 });
  });
});
