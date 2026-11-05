import { describe, expect, it } from "vitest";
import { createOpenRouter, DEFAULT_OPENROUTER_MODEL, OPENROUTER_FALLBACK } from "./openrouter.js";
import { AiError, type AiRequest } from "./provider.js";

const BASE = "https://openrouter.test/api/v1";
type Call = { url: string; method: string; headers: Record<string, string>; body: unknown };

/** A fetch that records each call and answers with `reply(call)`: a [status, json] pair, or throws. */
function fakeFetch(reply: (call: Call) => [number, unknown]) {
  const calls: Call[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const call: Call = { url: String(input), method: init?.method ?? "GET", headers, body: init?.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    const [status, json] = reply(call);
    return new Response(JSON.stringify(json), { status, headers: { "content-type": "application/json" } });
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}
const reply = (message: object, extra: object = {}) => ({ model: DEFAULT_OPENROUTER_MODEL, choices: [{ message }], usage: { prompt_tokens: 10, completion_tokens: 3 }, ...extra });
const provider = (fetch: typeof globalThis.fetch, fallback = true) => createOpenRouter({ apiKey: "sk", model: DEFAULT_OPENROUTER_MODEL, fallback, fetch, baseUrl: BASE });
const request: AiRequest = {
  system: "S", maxTokens: 500,
  messages: [
    { role: "user", text: "Top dish?" },
    { role: "assistant", text: "", toolCalls: [{ id: "c1", name: "item_sales", arguments: "{}" }] },
    { role: "tool", toolCallId: "c1", name: "item_sales", content: "{\"items\":[]}" },
  ],
  tools: [{ name: "item_sales", description: "Dish sales", parameters: { type: "object", properties: {} } }],
};

describe("OpenRouter provider", () => {
  it("sends the system prompt, mapped messages, tools and the fallback list", async () => {
    const { fetch, calls } = fakeFetch(() => [200, reply({ content: "Paneer" })]);
    await provider(fetch).chat(request);
    const call = calls[0]!;
    expect(call.url).toBe(`${BASE}/chat/completions`);
    expect(call.method).toBe("POST");
    expect(call.headers).toMatchObject({ authorization: "Bearer sk", "http-referer": "https://billnroll.in", "x-title": "MasalaPOS" });
    const body = call.body as Record<string, unknown>;
    expect(body.models).toEqual([DEFAULT_OPENROUTER_MODEL, OPENROUTER_FALLBACK]);
    expect(body.model).toBeUndefined();
    expect(body.max_tokens).toBe(500);
    expect(body.messages).toEqual([
      { role: "system", content: "S" },
      { role: "user", content: "Top dish?" },
      { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "item_sales", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "c1", content: "{\"items\":[]}" },
    ]);
    expect(body.tools).toEqual([{ type: "function", function: { name: "item_sales", description: "Dish sales", parameters: { type: "object", properties: {} } } }]);
  });

  it("sends model alone when fallback is off", async () => {
    const { fetch, calls } = fakeFetch(() => [200, reply({ content: "ok" })]);
    await provider(fetch, false).chat({ system: "S", messages: [{ role: "user", text: "hi" }], maxTokens: 10 });
    const body = calls[0]!.body as Record<string, unknown>;
    expect(body.model).toBe(DEFAULT_OPENROUTER_MODEL);
    expect(body.models).toBeUndefined();
    expect(body.tools).toBeUndefined();
  });

  it("maps a reply with text, tool calls, the answering model and usage", async () => {
    const { fetch } = fakeFetch(() => [200, reply({ content: null, tool_calls: [{ id: "t9", type: "function", function: { name: "today", arguments: "{}" } }] }, { model: "openrouter/free" })]);
    expect(await provider(fetch).chat(request)).toEqual({ text: "", toolCalls: [{ id: "t9", name: "today", arguments: "{}" }], model: "openrouter/free", usage: { inputTokens: 10, outputTokens: 3 } });
  });

  it("maps failures to codes", async () => {
    const codeFor = async (fetch: typeof globalThis.fetch) => {
      try { await provider(fetch).chat(request); return "none"; } catch (error) { return error instanceof AiError ? error.code : `other: ${String(error)}`; }
    };
    const throwing = (error: Error) => (async () => { throw error; }) as unknown as typeof globalThis.fetch;
    expect(await codeFor(throwing(new TypeError("fetch failed")))).toBe("offline");
    expect(await codeFor(throwing(Object.assign(new Error("timed out"), { name: "TimeoutError" })))).toBe("offline");
    for (const [status, code] of [[401, "bad_key"], [403, "bad_key"], [429, "limit"], [404, "model_gone"], [500, "unavailable"], [503, "unavailable"]] as const) {
      expect(await codeFor(fakeFetch(() => [status, { error: { message: "x", code: status } }]).fetch)).toBe(code);
    }
    expect(await codeFor(fakeFetch(() => [200, { error: { message: "Rate limit exceeded", code: 429 } }]).fetch)).toBe("limit");
    expect(await codeFor(fakeFetch(() => [200, reply({ content: "" })]).fetch)).toBe("no_answer");
  });

  it("lists only free models that support tools", async () => {
    const model = (id: string, prompt: string, tools: boolean) => ({ id, name: id.toUpperCase(), context_length: 262144, pricing: { prompt, completion: prompt }, supported_parameters: tools ? ["tools", "max_tokens"] : ["max_tokens"] });
    const { fetch, calls } = fakeFetch(() => [200, { data: [model("a/free-tools:free", "0", true), model("b/free-plain:free", "0", false), model("c/paid", "0.000001", true), model("openrouter/free", "0", true)] }]);
    const models = await provider(fetch).listModels();
    expect(models.map((m) => m.id)).toEqual(["a/free-tools:free", "openrouter/free"]);
    expect(models[0]).toEqual({ id: "a/free-tools:free", name: "A/FREE-TOOLS:FREE", contextLength: 262144, free: true, supportsTools: true });
    expect(calls[0]!.url).toBe(`${BASE}/models`);
    expect(calls[0]!.headers.authorization).toBeUndefined();
  });

  it("check reports the answering model and today's free requests", async () => {
    const { fetch, calls } = fakeFetch((call) => call.url.endsWith("/key") ? [200, { data: { free_model_daily_requests: { used: 12, limit: 50, remaining: 38 } } }] : [200, reply({ content: "OK" })]);
    expect(await provider(fetch).check()).toEqual({ model: DEFAULT_OPENROUTER_MODEL, freeRequestsUsed: 12, freeRequestsLimit: 50 });
    expect(calls.map((c) => c.url)).toEqual([`${BASE}/chat/completions`, `${BASE}/key`]);
    expect(calls[1]!.headers.authorization).toBe("Bearer sk");
    const bare = fakeFetch((call) => call.url.endsWith("/key") ? [200, { data: {} }] : [200, reply({ content: "OK" })]);
    expect(await provider(bare.fetch).check()).toEqual({ model: DEFAULT_OPENROUTER_MODEL, freeRequestsUsed: null, freeRequestsLimit: null });
  });
});
