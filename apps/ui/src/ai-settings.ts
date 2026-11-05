/** Mirrors of the server's AI assistant shapes (apps/server/src/ai). */
export interface AiModelInfo { id: string; name: string; contextLength: number; free: boolean; supportsTools: boolean }
export type AiFeature = "ask" | "daySummary" | "describe" | "test";
export interface AiUsageTotals { requests: number; inputTokens: number; outputTokens: number }
export interface AiSettingsView {
  settings: { enabled: boolean; provider: "openrouter"; model: string; fallback: boolean };
  keySaved: boolean; keyEnding: string | null; usage: Record<AiFeature, AiUsageTotals>; canSaveKey: boolean;
}
export interface AiCheckView { model: string; freeRequestsUsed: number | null; freeRequestsLimit: number | null }

export const DEFAULT_AI_MODEL = "google/gemma-4-31b-it:free";
const FEATURE_LABELS: Record<AiFeature, string> = { ask: "Ask MasalaPOS", daySummary: "Day summaries", describe: "Menu descriptions", test: "Tests" };

/** The model dropdown: a saved model OpenRouter no longer lists stays first and says so; the default is marked. */
export function modelOptions(models: AiModelInfo[], saved: string): Array<{ value: string; label: string }> {
  const options = models.map((m) => ({ value: m.id, label: `${m.name} · ${Math.round(m.contextLength / 1000)}K${m.id === DEFAULT_AI_MODEL ? " (recommended)" : ""}` }));
  return models.some((m) => m.id === saved) ? options : [{ value: saved, label: `${saved} (no longer offered)` }, ...options];
}

export function usageRows(usage: Record<AiFeature, AiUsageTotals>): Array<{ feature: string; requests: number; tokens: number }> {
  return (Object.keys(FEATURE_LABELS) as AiFeature[]).map((feature) => ({ feature: FEATURE_LABELS[feature], requests: usage[feature].requests, tokens: usage[feature].inputTokens + usage[feature].outputTokens }));
}
