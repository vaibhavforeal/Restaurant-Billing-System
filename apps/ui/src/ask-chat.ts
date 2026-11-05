import { ApiError } from "./api";

export type ChatTurn = { role: "user" | "assistant"; text: string };
export const AI_OFFLINE_TEXT = "The AI assistant needs internet. Everything else keeps working.";

export const appendTurn = (turns: ChatTurn[], role: ChatTurn["role"], text: string): ChatTurn[] => [...turns, { role, text }];

/** The hub keeps at most the last 10 turns, so send no more. */
export const historyForRequest = (turns: ChatTurn[]): ChatTurn[] => turns.slice(-10);

/** The hub's own message for an AI failure (limit, bad key, …), or the offline copy when the request never arrived. */
export function aiErrorText(error: unknown): string {
  return error instanceof ApiError && error.message ? error.message : AI_OFFLINE_TEXT;
}
