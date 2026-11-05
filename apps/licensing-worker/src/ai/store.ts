// The AI assistant's rows: which counters MasalaPOS has switched on, their daily limits, and each day's use.
import type { D1Like, D1StatementLike } from "../env.js";

export const DEFAULT_AI_DAILY_LIMIT = 40;
export interface AiSettingsRow { enabled: boolean; dailyLimit: number; updatedAt: number | null }
export interface AiUsageDay { day: string; requests: number; inputTokens: number; outputTokens: number }

/** The UTC day (YYYY-MM-DD) limits are counted in. */
export const aiDay = (at: number) => new Date(at).toISOString().slice(0, 10);

/**
 * Whether the AI assistant is on for this counter in its current seat (`orderId`, null when it holds none), and its limit. A counter with
 * no row is off with the default limit; a switch set for another seat (or none) counts as off.
 */
export async function getAiSettings(db: D1Like, installationId: string, orderId: string | null): Promise<AiSettingsRow> {
  const row = await db.prepare(`SELECT enabled, order_id AS orderId, daily_limit AS dailyLimit, updated_at AS updatedAt FROM ai_settings WHERE installation_id = ?`)
    .bind(installationId).first<{ enabled: number; orderId: string | null; dailyLimit: number; updatedAt: number }>();
  if (!row) return { enabled: false, dailyLimit: DEFAULT_AI_DAILY_LIMIT, updatedAt: null };
  return { enabled: row.enabled === 1 && orderId !== null && row.orderId === orderId, dailyLimit: row.dailyLimit, updatedAt: row.updatedAt };
}

/** Sets the switch for the counter's current seat (`orderId`). */
export const setAiSettingsStatement = (db: D1Like, installationId: string, orderId: string | null, enabled: boolean, dailyLimit: number, at: number, by: string): D1StatementLike =>
  db.prepare(`INSERT INTO ai_settings (installation_id, order_id, enabled, daily_limit, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(installation_id) DO UPDATE SET order_id = excluded.order_id, enabled = excluded.enabled, daily_limit = excluded.daily_limit,
      updated_at = excluded.updated_at, updated_by = excluded.updated_by`)
    .bind(installationId, orderId, enabled ? 1 : 0, dailyLimit, at, by);

export async function usedOn(db: D1Like, installationId: string, day: string): Promise<number> {
  const row = await db.prepare(`SELECT requests FROM ai_usage WHERE installation_id = ? AND day = ?`).bind(installationId, day).first<{ requests: number }>();
  return row?.requests ?? 0;
}

/**
 * Takes one of today's requests, only while fewer than `limit` are taken, in a single statement so two requests at once can't both take
 * the last one. Returns whether it was taken.
 */
export async function reserveRequest(db: D1Like, installationId: string, day: string, limit: number): Promise<boolean> {
  const result = await db.prepare(`INSERT INTO ai_usage (installation_id, day, requests) VALUES (?, ?, 1)
    ON CONFLICT(installation_id, day) DO UPDATE SET requests = requests + 1 WHERE requests < ?`).bind(installationId, day, limit).run();
  return result.meta.changes > 0;
}

/** Gives a reserved request back when the provider failed, so failures never count against the restaurant. */
export const releaseRequest = (db: D1Like, installationId: string, day: string) =>
  db.prepare(`UPDATE ai_usage SET requests = MAX(requests - 1, 0) WHERE installation_id = ? AND day = ?`).bind(installationId, day).run();

export const addTokens = (db: D1Like, installationId: string, day: string, input: number, output: number) =>
  db.prepare(`UPDATE ai_usage SET input_tokens = input_tokens + ?, output_tokens = output_tokens + ? WHERE installation_id = ? AND day = ?`)
    .bind(input, output, installationId, day).run();

/** The last `days` UTC days ending today, newest first, with zero rows for days without use. */
export async function usageHistory(db: D1Like, installationId: string, today: string, days: number): Promise<AiUsageDay[]> {
  const list = Array.from({ length: days }, (_, i) => aiDay(Date.parse(`${today}T00:00:00Z`) - i * 86_400_000));
  const { results } = await db.prepare(`SELECT day, requests, input_tokens AS inputTokens, output_tokens AS outputTokens FROM ai_usage
    WHERE installation_id = ? AND day >= ? AND day <= ?`).bind(installationId, list.at(-1), today).all<AiUsageDay>();
  return list.map((day) => results.find((r) => r.day === day) ?? { day, requests: 0, inputTokens: 0, outputTokens: 0 });
}
