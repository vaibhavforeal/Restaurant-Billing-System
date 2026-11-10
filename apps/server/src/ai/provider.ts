/**
 * The AI assistant's features talk to the model only through this interface, in MasalaPOS's neutral message and tool format
 * (`@masalapos/domain/ai-wire`). The model itself is reached through MasalaPOS's AI service (./service.ts), which holds the provider key.
 */
import type { AiErrorCode, AiReply, AiRequest } from "@masalapos/domain/ai-wire";

export type { AiErrorCode, AiMessage, AiReply, AiRequest, AiTool, AiToolCall, AiUsage } from "@masalapos/domain/ai-wire";

export interface AiProvider { chat(request: AiRequest): Promise<AiReply> }

/** What the owner reads for each failure. None mentions keys or the provider: the restaurant has neither. */
export const AI_MESSAGES: Record<AiErrorCode, string> = {
  off: "The AI assistant is switched off, or isn't available on this copy of MasalaPOS. See Settings → AI assistant.",
  offline: "The AI assistant needs internet. Everything else keeps working.",
  bad_key: "MasalaPOS couldn't verify this counter for the AI assistant. Check the licence in Settings → Plan.",
  limit: "The AI service is busy right now. Try again in a few minutes.",
  model_gone: "The AI service isn't responding right now. Try again in a minute.",
  unavailable: "The AI service isn't responding right now. Try again in a minute.",
  no_answer: "The AI couldn't answer that. Try asking more simply.",
  not_enabled: "The AI assistant isn't switched on for this restaurant. Contact MasalaPOS to turn it on.",
  daily_limit: "Today's AI limit for this restaurant is used up. It resets at midnight (UTC).",
};

export class AiError extends Error {
  constructor(readonly code: AiErrorCode, detail?: string) {
    super(detail ? `${AI_MESSAGES[code]} (${detail})` : AI_MESSAGES[code]);
    this.name = "AiError";
  }
}
