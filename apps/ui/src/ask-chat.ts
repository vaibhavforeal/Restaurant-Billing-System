import { ApiError } from "./api";
import { timeoutSignal } from "./abort-signal";

export type ChatTurn = { role: "user" | "assistant"; text: string };
export const AI_OFFLINE_TEXT = "The AI assistant needs internet. Everything else keeps working.";

export const appendTurn = (turns: ChatTurn[], role: ChatTurn["role"], text: string): ChatTurn[] => [...turns, { role, text }];

/** The hub keeps at most the last 10 turns, so send no more. */
export const historyForRequest = (turns: ChatTurn[]): ChatTurn[] => turns.slice(-10);

/** The hub's own message for an AI failure (limit, bad key, …), or the offline copy when the request never arrived. */
export function aiErrorText(error: unknown): string {
  return error instanceof ApiError && error.message ? error.message : AI_OFFLINE_TEXT;
}

/**
 * AI requests wait far longer than the usual 15 s: a free model can take a while, and an Ask makes several calls on the
 * hub (bounded there just under this). Giving up early would show "needs internet" while the hub still spends quota.
 */
export const AI_TIMEOUT_MS = { ask: 180_000, other: 90_000 } as const;

export function aiRequestInit(kind: keyof typeof AI_TIMEOUT_MS, body?: unknown): RequestInit {
  return { method: "POST", ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: timeoutSignal(AI_TIMEOUT_MS[kind]) };
}

/** Reports → More reports: Ask MasalaPOS when the assistant is on, a set-up note for admins while it is off, else nothing. */
export function askEntry(status: { enabled: boolean; canAsk: boolean; canDescribe?: boolean; canManage: boolean } | null): "ask" | "setup" | "hidden" {
  if (!status) return "hidden";
  if (status.enabled) return status.canAsk ? "ask" : "hidden";
  return status.canManage ? "setup" : "hidden";
}
