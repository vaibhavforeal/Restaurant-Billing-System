import { AiError, type AiCheck, type AiMessage, type AiModel, type AiProvider, type AiReply, type AiRequest } from "./provider.js";

export const DEFAULT_OPENROUTER_MODEL = "google/gemma-4-31b-it:free";
export const OPENROUTER_FALLBACK = "openrouter/free";
const DEFAULT_BASE = "https://openrouter.ai/api/v1";

interface WireReply {
  model?: string;
  error?: { message?: string; code?: number | string };
  choices?: Array<{ message?: { content?: string | null; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

const toWire = (message: AiMessage) => message.role === "user" ? { role: "user", content: message.text }
  : message.role === "tool" ? { role: "tool", tool_call_id: message.toolCallId, content: message.content }
  : message.toolCalls?.length
    ? { role: "assistant", content: message.text || null, tool_calls: message.toolCalls.map((call) => ({ id: call.id, type: "function", function: { name: call.name, arguments: call.arguments } })) }
    : { role: "assistant", content: message.text };

/** HTTP status (or an error code inside a 200 body) to what the owner is told. */
function failure(status: number, detail: string): AiError {
  if (status === 401 || status === 403) return new AiError("bad_key", detail);
  if (status === 429) return new AiError("limit", detail);
  if (status === 404) return new AiError("model_gone", detail);
  if (status >= 500) return new AiError("unavailable", detail);
  return new AiError("no_answer", detail);
}

/**
 * OpenRouter's OpenAI-style chat completions. With `fallback`, the request names a second model (`openrouter/free`) and
 * OpenRouter moves to it on rate limits or downtime; the reply says which model answered.
 */
export function createOpenRouter(opts: { apiKey: string; model: string; fallback: boolean; fetch?: typeof fetch; baseUrl?: string; timeoutMs?: number }): AiProvider {
  const base = opts.baseUrl ?? DEFAULT_BASE;
  const doFetch = opts.fetch ?? fetch;
  const timeout = opts.timeoutMs ?? 60_000;
  const auth = { authorization: `Bearer ${opts.apiKey}`, "http-referer": "https://billnroll.in", "x-title": "MasalaPOS" };

  async function call(path: string, init: { method?: string; body?: unknown; authed?: boolean }): Promise<unknown> {
    let res: Response;
    try {
      res = await doFetch(`${base}${path}`, {
        method: init.method ?? "GET",
        headers: { ...(init.authed === false ? {} : auth), ...(init.body ? { "content-type": "application/json" } : {}) },
        ...(init.body ? { body: JSON.stringify(init.body) } : {}),
        signal: AbortSignal.timeout(timeout),
      });
    } catch (error) {
      throw new AiError("offline", error instanceof Error ? error.message : String(error));
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
    const message = json.choices?.[0]?.message;
    const text = message?.content?.trim() ?? "";
    const toolCalls = (message?.tool_calls ?? []).map((tc) => ({ id: tc.id, name: tc.function.name, arguments: tc.function.arguments }));
    if (!text && !toolCalls.length) throw new AiError("no_answer", "empty reply");
    return { text, toolCalls, model: json.model ?? opts.model, usage: { inputTokens: json.usage?.prompt_tokens ?? 0, outputTokens: json.usage?.completion_tokens ?? 0 } };
  }

  return {
    chat,
    async listModels(): Promise<AiModel[]> {
      const json = await call("/models", { authed: false }) as { data?: Array<{ id: string; name?: string; context_length?: number; pricing?: { prompt?: string; completion?: string }; supported_parameters?: string[] }> };
      return (json.data ?? [])
        .filter((m) => m.pricing?.prompt === "0" && m.pricing?.completion === "0" && (m.supported_parameters ?? []).includes("tools"))
        .map((m) => ({ id: m.id, name: m.name ?? m.id, contextLength: m.context_length ?? 0, free: true, supportsTools: true }));
    },
    async check(): Promise<AiCheck> {
      const reply = await chat({ system: "You are a connection test.", messages: [{ role: "user", text: "Reply with OK." }], maxTokens: 10 });
      const key = await call("/key", {}) as { data?: { free_model_daily_requests?: { used?: number; limit?: number } } };
      const daily = key.data?.free_model_daily_requests;
      return { model: reply.model, freeRequestsUsed: daily?.used ?? null, freeRequestsLimit: daily?.limit ?? null };
    },
  };
}
