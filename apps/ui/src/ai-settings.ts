/** Mirrors of the server's AI assistant shapes (apps/server/src/ai). */
export type AiFeature = "ask" | "daySummary" | "describe";
export interface AiUsageTotals { requests: number; inputTokens: number; outputTokens: number }
/** MasalaPOS's last answer about this restaurant: switched on or not, its daily limit and today's use. */
export interface AiServiceView { enabled: boolean; dailyLimit: number; usedToday: number; checkedAt: number }
export interface AiSettingsView { connected: boolean; localEnabled: boolean; service: AiServiceView | null; usage: Record<AiFeature, AiUsageTotals> }

const FEATURE_LABELS: Record<AiFeature, string> = { ask: "Ask MasalaPOS", daySummary: "Day summaries", describe: "Menu descriptions" };

/** One line on where the AI assistant stands for this restaurant, from MasalaPOS's side. */
export function serviceStatusText(view: AiSettingsView): string {
  if (!view.connected) return "This copy isn't connected to MasalaPOS, so the AI assistant isn't available here.";
  if (!view.service) return "Not checked with MasalaPOS yet. Press Check to see whether it's on for this restaurant.";
  if (!view.service.enabled) return "Not switched on for this restaurant. Contact MasalaPOS to add the AI assistant.";
  return `On for this restaurant · ${view.service.usedToday} of ${view.service.dailyLimit} requests used today`;
}

export function usageRows(usage: Record<AiFeature, AiUsageTotals>): Array<{ feature: string; requests: number; tokens: number }> {
  return (Object.keys(FEATURE_LABELS) as AiFeature[]).map((feature) => ({ feature: FEATURE_LABELS[feature], requests: usage[feature].requests, tokens: usage[feature].inputTokens + usage[feature].outputTokens }));
}
