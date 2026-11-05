// MasalaPOS's own OpenRouter account, called only from the licensing service: counters never hold the key.
import type { AiErrorCode, AiMessage, AiReply, AiRequest, AiToolCall } from "@masalapos/domain/ai-wire";

/** A provider failure; `detail` is for the service's log, never for the counter. */
export class ProviderError extends Error {
  /** `mayBeCharged`: the provider may have done (and billed) the work: it timed out mid-request, or answered with nothing usable. */
  constructor(readonly code: AiErrorCode, readonly detail = "", readonly mayBeCharged = false) { super(`${code}${detail ? `: ${detail}` : ""}`); this.name = "ProviderError"; }
}
export interface ChatProvider { chat(request: AiRequest): Promise<AiReply> }

export const DEFAULT_OPENROUTER_MODEL = "google/gemma-4-31b-it:free";
export const OPENROUTER_FALLBACK = "openrouter/free";
const DEFAULT_BASE = "https://openrouter.ai/api/v1";

interface WireReply {
  model?: string;
  error?: { message?: string; code?: number | string };
  choices?: Array<{ message?: { content?: unknown; tool_calls?: unknown } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

const toWire = (message: AiMessage) => message.role === "user" ? { role: "user", content: message.text }
  : message.role === "tool" ? { role: "tool", tool_call_id: message.toolCallId, content: message.content }
  : message.toolCalls?.length
    ? { role: "assistant", content: message.text || null, tool_calls: message.toolCalls.map((call) => ({ id: call.id, type: "function", function: { name: call.name, arguments: call.arguments } })) }
    : { role: "assistant", content: message.text };

/** Reply text, whether a string or (some providers) a list of `{type: "text", text}` parts; anything else is no text. */
function textOf(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) return content.map((part) => part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string" ? (part as { text: string }).text : "").join("").trim();
  return "";
}

/** Well-formed tool calls only; a malformed entry is dropped rather than crashing the request. */
function toolCallsOf(calls: unknown): AiToolCall[] {
  if (!Array.isArray(calls)) return [];
  return calls.flatMap((call, index) => {
    const fn = call && typeof call === "object" ? (call as { function?: { name?: unknown; arguments?: unknown } }).function : undefined;
    if (!fn || typeof fn.name !== "string") return [];
    const raw = (call as { id?: unknown }).id;
    const id = typeof raw === "string" && raw.trim() && raw.length <= 200 ? raw : `call-${index}`;
    const args = typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments ?? {});
    // Echoed back in the next round, so it must fit the wire limits; cut arguments fail as bad JSON, which the lookup reports.
    return [{ id, name: fn.name.slice(0, 100), arguments: args.slice(0, 4_000) }];
  });
}

/** HTTP status (or an error code inside a 200 body) to what the owner is told. */
function failure(status: number, detail: string): ProviderError {
  if (status === 401 || status === 403) return new ProviderError("bad_key", detail);
  if (status === 429) return new ProviderError("limit", detail);
  if (status === 404) return new ProviderError("model_gone", detail);
  if (status >= 500) return new ProviderError("unavailable", detail);
  return new ProviderError("no_answer", detail);
}

/**
 * OpenRouter's OpenAI-style chat completions. With `fallback`, the request names a second model (`openrouter/free`) and
 * OpenRouter moves to it on rate limits or downtime; the reply says which model answered.
 */
export function createOpenRouter(opts: { apiKey: string; model: string; fallback: boolean; fetch?: typeof fetch; baseUrl?: string; timeoutMs?: number }): ChatProvider {
  const base = opts.baseUrl ?? DEFAULT_BASE;
  const doFetch = opts.fetch ?? fetch;
  const timeout = opts.timeoutMs ?? 60_000;
  const auth = { authorization: `Bearer ${opts.apiKey}`, "http-referer": "https://billnroll.in", "x-title": "MasalaPOS" };

  async function call(path: string, init: { method?: string; body?: unknown }): Promise<unknown> {
    let res: Response;
    try {
      res = await doFetch(`${base}${path}`, {
        method: init.method ?? "GET",
        headers: { ...auth, ...(init.body ? { "content-type": "application/json" } : {}) },
        ...(init.body ? { body: JSON.stringify(init.body) } : {}),
        signal: AbortSignal.timeout(timeout),
      });
    } catch (error) {
      // A connection that never opened costs nothing; one that timed out may have been worked on.
      const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
      throw new ProviderError("offline", error instanceof Error ? error.message : String(error), timedOut);
    }
    const json = await res.json().catch(() => ({})) as WireReply;
    if (!res.ok) throw failure(res.status, json.error?.message ?? res.statusText);
    if (json.error) throw failure(Number(json.error.code) || 500, json.error.message ?? "error");
    return json;
  }

  async function chat(request: AiRequest): Promise<AiReply> {
    const json = await call("/chat/completions", { method: "POST", body: {
      ...(opts.fallback ? { models: [opts.model, OPENROUTER_FALLBACK] } : { model: opts.model }),
      messages: [{ role: "system", content: request.system }, ...request.messages.map(toWire)],
      ...(request.tools?.length ? { tools: request.tools.map((tool) => ({ type: "function", function: tool })) } : {}),
      max_tokens: request.maxTokens,
    } }) as WireReply;
    const message = Array.isArray(json.choices) ? json.choices[0]?.message : undefined;
    const text = textOf(message?.content);
    const toolCalls = toolCallsOf(message?.tool_calls);
    if (!text && !toolCalls.length) throw new ProviderError("no_answer", "empty reply", true);
    return { text, toolCalls, model: json.model ?? opts.model, usage: { inputTokens: json.usage?.prompt_tokens ?? 0, outputTokens: json.usage?.completion_tokens ?? 0 } };
  }

  return { chat };
}
