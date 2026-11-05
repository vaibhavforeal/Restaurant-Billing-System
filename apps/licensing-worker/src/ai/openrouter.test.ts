import { describe, expect, it } from "vitest";
import type { AiRequest } from "@masalapos/domain/ai-wire";
import { createOpenRouter, DEFAULT_OPENROUTER_MODEL, OPENROUTER_FALLBACK, ProviderError } from "./openrouter.js";

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
      try { await provider(fetch).chat(request); return "none"; } catch (error) { return error instanceof ProviderError ? error.code : `other: ${String(error)}`; }
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

  it("gives a tool call without an id one, and trims oversized arguments, so the next round stays valid", async () => {
    const { fetch } = fakeFetch(() => [200, reply({ content: null, tool_calls: [{ id: "", type: "function", function: { name: "today", arguments: "x".repeat(5000) } }] })]);
    const [call] = (await provider(fetch).chat(request)).toolCalls;
    expect(call!.id).toBe("call-0");
    expect(call!.arguments.length).toBeLessThanOrEqual(4000);
  });

  it("reads text sent as parts and turns badly shaped replies into no_answer", async () => {
    const parts = fakeFetch(() => [200, reply({ content: [{ type: "text", text: "Paneer " }, { type: "text", text: "tikka." }] })]);
    expect((await provider(parts.fetch).chat(request)).text).toBe("Paneer tikka.");
    for (const body of [reply({ content: null, tool_calls: [{ id: "x" }] }), { model: "m" }, { model: "m", choices: [{}] }, "not json"]) {
      const odd = fakeFetch(() => [200, body]);
      await expect(provider(odd.fetch).chat(request)).rejects.toMatchObject({ code: "no_answer" });
    }
  });
});
