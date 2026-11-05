// MasalaPOS's AI service, on the licensing service: the counter sends its AI requests there with its installation ID and secret, and the
// service forwards them to the model with MasalaPOS's own key, within the restaurant's daily limit.
import { AI_SERVICE_ERRORS, type AiChatResponse, type AiRequest, type AiServiceStatus } from "@masalapos/domain/ai-wire";
import { AiError } from "./provider.js";

export interface AiServiceOptions { serviceUrl: string; installationId: string; installationSecret: string; fetch?: typeof fetch; timeoutMs?: number }
export interface AiServiceClient { chat(request: AiRequest): Promise<AiChatResponse>; status(): Promise<AiServiceStatus> }

/** Longer than the service's own wait on the model (65 s), so the service's answer arrives first. Ask's 100 s budget allows for it. */
const TIMEOUT_MS = 75_000;

/** A failed answer's code; anything unrecognised (a proxy's HTML page, a crash) counts as the service being unavailable. */
function failure(status: number, body: unknown): AiError {
  const error = body && typeof body === "object" ? (body as { error?: unknown }).error : undefined;
  const code = typeof error === "string" ? AI_SERVICE_ERRORS[error] : undefined;
  if (code) return new AiError(code, `service ${status} ${String(error)}`);
  if (status === 429) return new AiError("limit", "service rate limit");
  return new AiError("unavailable", `service ${status}`);
}

export function createAiService(opts: AiServiceOptions): AiServiceClient {
  const doFetch = opts.fetch ?? fetch;
  const base = opts.serviceUrl.replace(/\/+$/, "");
  const headers = { "x-masalapos-installation-id": opts.installationId, "x-masalapos-installation-secret": opts.installationSecret };

  async function call(path: string, body?: unknown): Promise<unknown> {
    let res: Response;
    try {
      res = await doFetch(`${base}${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: { ...headers, ...(body === undefined ? {} : { "content-type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(opts.timeoutMs ?? TIMEOUT_MS),
      });
    } catch (error) {
      throw new AiError("offline", error instanceof Error ? error.message : String(error));
    }
    const json: unknown = await res.json().catch(() => undefined);
    if (!res.ok) throw failure(res.status, json);
    return json;
  }

  return {
    async chat(request) {
      const json = await call("/v1/ai/chat", request) as Partial<AiChatResponse> | undefined;
      if (!json?.reply || typeof json.reply.text !== "string" || !Array.isArray(json.reply.toolCalls)) throw new AiError("unavailable", "unexpected reply");
      return { reply: json.reply, usedToday: Number(json.usedToday) || 0, dailyLimit: Number(json.dailyLimit) || 0 };
    },
    async status() {
      const json = await call("/v1/ai/status") as Partial<AiServiceStatus> | undefined;
      if (typeof json?.enabled !== "boolean") throw new AiError("unavailable", "unexpected status");
      return { enabled: json.enabled, dailyLimit: Number(json.dailyLimit) || 0, usedToday: Number(json.usedToday) || 0 };
    },
  };
}
