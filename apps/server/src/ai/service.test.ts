import { describe, expect, it } from "vitest";
import { createAiService } from "./service.js";
import { AiError, type AiRequest } from "./provider.js";

const SECRET = "a".repeat(64);
const ID = "11111111-1111-4111-8111-111111111111";
type Call = { url: string; method: string; headers: Record<string, string>; body: unknown; signal: AbortSignal | null | undefined };

function fakeService(answer: (call: Call) => [number, unknown]) {
  const calls: Call[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const call: Call = { url: String(input), method: init?.method ?? "GET", headers: Object.fromEntries(new Headers(init?.headers).entries()), body: init?.body ? JSON.parse(String(init.body)) : undefined, signal: init?.signal };
    calls.push(call);
    const [status, json] = answer(call);
    return new Response(JSON.stringify(json), { status, headers: { "content-type": "application/json" } });
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}
const service = (fetch: typeof globalThis.fetch) => createAiService({ serviceUrl: "https://portal.test", installationId: ID, installationSecret: SECRET, fetch });
const request: AiRequest = { system: "S", messages: [{ role: "user", text: "Hi" }], maxTokens: 100 };
const reply = { text: "Hello", toolCalls: [], model: "google/gemma-4-31b-it:free", usage: { inputTokens: 5, outputTokens: 2 } };

describe("the MasalaPOS AI service client", () => {
  it("sends the request with the counter's ID and secret, and returns the reply with today's use", async () => {
    const { fetch, calls } = fakeService(() => [200, { reply, usedToday: 7, dailyLimit: 40 }]);
    expect(await service(fetch).chat(request)).toEqual({ reply, usedToday: 7, dailyLimit: 40 });
    expect(calls[0]).toMatchObject({ url: "https://portal.test/v1/ai/chat", method: "POST", body: request });
    expect(calls[0]!.headers).toMatchObject({ "x-masalapos-installation-id": ID, "x-masalapos-installation-secret": SECRET, "content-type": "application/json" });
    expect(calls[0]!.signal).toBeInstanceOf(AbortSignal);
  });

  it("reads the status", async () => {
    const { fetch, calls } = fakeService(() => [200, { enabled: true, dailyLimit: 40, usedToday: 3 }]);
    expect(await service(fetch).status()).toEqual({ enabled: true, dailyLimit: 40, usedToday: 3 });
    expect(calls[0]).toMatchObject({ url: "https://portal.test/v1/ai/status", method: "GET" });
    expect(calls[0]!.headers["x-masalapos-installation-secret"]).toBe(SECRET);
  });

  it("turns the service's answers into the owner's messages", async () => {
    const codeFor = async (fetch: typeof globalThis.fetch) => {
      try { await service(fetch).chat(request); return "none"; } catch (error) { return error instanceof AiError ? error.code : `other: ${String(error)}`; }
    };
    const answering = (status: number, body: unknown) => fakeService(() => [status, body]).fetch;
    expect(await codeFor(answering(403, { error: "ai_not_enabled" }))).toBe("not_enabled");
    expect(await codeFor(answering(429, { error: "ai_daily_limit", limit: 40, used: 40 }))).toBe("daily_limit");
    expect(await codeFor(answering(429, { error: "rate_limited" }))).toBe("limit");
    expect(await codeFor(answering(503, { error: "ai_limit" }))).toBe("limit");
    expect(await codeFor(answering(503, { error: "ai_unavailable" }))).toBe("unavailable");
    expect(await codeFor(answering(502, { error: "ai_no_answer" }))).toBe("no_answer");
    expect(await codeFor(answering(403, { error: "licence_expired" }))).toBe("bad_key");
    expect(await codeFor(answering(500, { error: "internal" }))).toBe("unavailable");
    expect(await codeFor(answering(502, "<html>Bad gateway</html>"))).toBe("unavailable");
    expect(await codeFor(answering(200, { nothing: true }))).toBe("unavailable");
    expect(await codeFor((async () => { throw new TypeError("fetch failed"); }) as unknown as typeof globalThis.fetch)).toBe("offline");
  });

  it("explains the new codes without mentioning keys or OpenRouter", () => {
    expect(new AiError("not_enabled").message).toBe("The AI assistant isn't switched on for this restaurant. Contact MasalaPOS to turn it on.");
    expect(new AiError("daily_limit").message).toBe("Today's AI limit for this restaurant is used up. It resets at midnight (UTC).");
    for (const code of ["off", "offline", "bad_key", "limit", "model_gone", "unavailable", "no_answer", "not_enabled", "daily_limit"] as const) {
      expect(new AiError(code).message).not.toMatch(/OpenRouter|key/i);
    }
  });
});
