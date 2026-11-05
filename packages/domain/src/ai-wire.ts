/**
 * The AI assistant's wire contract, shared by the restaurant's hub (which builds requests) and MasalaPOS's licensing service (which forwards
 * them to the AI provider with MasalaPOS's own key). Messages and tools are in MasalaPOS's neutral format; each provider adapter translates.
 */
import { z } from "zod";

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

/**
 * Why an AI request failed. `off`: not available on this counter. `not_enabled`: MasalaPOS hasn't switched it on for the restaurant.
 * `daily_limit`: the restaurant's requests for today are used up. `bad_key`: the service didn't accept the counter, or the provider didn't
 * accept MasalaPOS's key. The rest are provider or network trouble.
 */
export type AiErrorCode = "off" | "offline" | "bad_key" | "limit" | "model_gone" | "unavailable" | "no_answer" | "not_enabled" | "daily_limit";

/** What one chat request may carry, so a counter can't spend MasalaPOS's AI budget on oversized requests. */
export const AI_CHAT_LIMITS = { messages: 60, textChars: 60_000, systemChars: 8_000, tools: 12, maxTokens: 4_000 } as const;

const text = z.string().max(AI_CHAT_LIMITS.textChars);
const ToolCall = z.object({ id: z.string().min(1).max(200), name: z.string().min(1).max(100), arguments: z.string().max(4_000) }).strict();
const Message = z.discriminatedUnion("role", [
  z.object({ role: z.literal("user"), text }).strict(),
  z.object({ role: z.literal("assistant"), text, toolCalls: z.array(ToolCall).max(20).optional() }).strict(),
  z.object({ role: z.literal("tool"), toolCallId: z.string().min(1).max(200), name: z.string().min(1).max(100), content: text }).strict(),
]);
const Tool = z.object({ name: z.string().min(1).max(100), description: z.string().max(2_000), parameters: z.record(z.string(), z.unknown()) }).strict();

/** POST /v1/ai/chat body: the request only. The service picks the model and provider options. */
export const AiChatRequest = z.object({
  system: z.string().max(AI_CHAT_LIMITS.systemChars),
  messages: z.array(Message).min(1).max(AI_CHAT_LIMITS.messages),
  tools: z.array(Tool).max(AI_CHAT_LIMITS.tools).optional(),
  maxTokens: z.number().int().min(1).max(AI_CHAT_LIMITS.maxTokens),
}).strict();

/** POST /v1/ai/chat success: the reply, and where the restaurant stands against its daily limit afterwards. */
export interface AiChatResponse { reply: AiReply; usedToday: number; dailyLimit: number }
/** GET /v1/ai/status: whether MasalaPOS has switched the AI assistant on for this counter, and today's use. Costs no AI request. */
export interface AiServiceStatus { enabled: boolean; dailyLimit: number; usedToday: number }
/** Error codes the service answers with (`{ error, message? }`), and what the hub reads them as. */
export const AI_SERVICE_ERRORS: Record<string, AiErrorCode> = {
  ai_not_enabled: "not_enabled", ai_daily_limit: "daily_limit", unknown_installation: "bad_key", not_enrolled: "bad_key", licence_expired: "bad_key",
  ai_limit: "limit", ai_unavailable: "unavailable", ai_offline: "unavailable", ai_no_answer: "no_answer", ai_model_gone: "unavailable", ai_bad_key: "unavailable",
};
