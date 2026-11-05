/**
 * The AI assistant talks to providers only through this interface, in MasalaPOS's own message and tool format. Each
 * provider (OpenRouter now; OpenAI or Anthropic later) is one adapter that translates it.
 */

/** A lookup the model may call; `parameters` is a JSON schema object. */
export interface AiTool { name: string; description: string; parameters: Record<string, unknown> }
/** A lookup the model asked for; `arguments` is the raw JSON text it sent. */
export interface AiToolCall { id: string; name: string; arguments: string }
export type AiMessage =
  | { role: "user"; text: string }
  | { role: "assistant"; text: string; toolCalls?: AiToolCall[] }
  | { role: "tool"; toolCallId: string; name: string; content: string };
export interface AiRequest { system: string; messages: AiMessage[]; tools?: AiTool[]; maxTokens: number }
/** Tokens used; `requests` counts provider calls when a feature made more than one. */
export interface AiUsage { inputTokens: number; outputTokens: number; requests?: number }
export interface AiReply { text: string; toolCalls: AiToolCall[]; model: string; usage: AiUsage }
export interface AiModel { id: string; name: string; contextLength: number; free: boolean; supportsTools: boolean }
export interface AiCheck { model: string; freeRequestsUsed: number | null; freeRequestsLimit: number | null; usage?: AiUsage }

export interface AiProvider {
  listModels(): Promise<AiModel[]>;
  chat(request: AiRequest): Promise<AiReply>;
  check(): Promise<AiCheck>;
}

export type AiErrorCode = "off" | "offline" | "bad_key" | "limit" | "model_gone" | "unavailable" | "no_answer";

/** What the owner reads for each failure (spec section 7). */
export const AI_MESSAGES: Record<AiErrorCode, string> = {
  off: "Set up the AI assistant in Settings → AI assistant.",
  offline: "The AI assistant needs internet. Everything else keeps working.",
  bad_key: "OpenRouter didn't accept the key. Check it in Settings → AI assistant.",
  limit: "OpenRouter's free limit is used up for today (it resets at midnight UTC), or there were too many requests in the last minute. Adding $10 of credit to the OpenRouter account raises the free limit to 1,000 requests a day.",
  model_gone: "The chosen model is no longer available. Pick another in Settings.",
  unavailable: "The AI service isn't responding right now. Try again in a minute.",
  no_answer: "The AI couldn't answer that. Try asking more simply.",
};

export class AiError extends Error {
  constructor(readonly code: AiErrorCode, detail?: string) {
    super(detail ? `${AI_MESSAGES[code]} (${detail})` : AI_MESSAGES[code]);
    this.name = "AiError";
  }
}
