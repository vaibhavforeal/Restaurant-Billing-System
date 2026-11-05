import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicJson } from "../backups.js";

export type AiFeature = "ask" | "daySummary" | "describe";
export interface AiUsageTotals { requests: number; inputTokens: number; outputTokens: number }
/** The last answer from MasalaPOS's AI service about this counter. `usedToday` counts the UTC day `checkedAt` falls on. */
export interface AiServiceCache { enabled: boolean; dailyLimit: number; usedToday: number; checkedAt: number }

const FEATURES: AiFeature[] = ["ask", "daySummary", "describe"];
const zero = (): AiUsageTotals => ({ requests: 0, inputTokens: 0, outputTokens: 0 });

interface FileShape { localEnabled?: boolean; service?: AiServiceCache | null; usage?: Partial<Record<AiFeature, AiUsageTotals>> }

/**
 * The AI assistant's state on this counter, in `ai-assistant.json` in the data folder: the restaurant's own on/off switch, the service's
 * last status, and usage per feature. No key is kept here: MasalaPOS's AI service holds it. Fields from older versions (a sealed key, a
 * model choice) are dropped on the next write.
 */
export class AiStore {
  private readonly path: string;
  constructor(dataDir: string) { this.path = join(dataDir, "ai-assistant.json"); }

  private read(): FileShape {
    if (!existsSync(this.path)) return {};
    try {
      const file = JSON.parse(readFileSync(this.path, "utf8")) as FileShape;
      return { ...(typeof file.localEnabled === "boolean" ? { localEnabled: file.localEnabled } : {}), service: file.service ?? null, ...(file.usage ? { usage: file.usage } : {}) };
    } catch { return {}; }
  }
  private update(patch: FileShape) { atomicJson(this.path, { ...this.read(), ...patch }); }

  /** The restaurant's own switch, "Use the AI assistant"; on until an admin turns it off. */
  localEnabled(): boolean { return this.read().localEnabled ?? true; }
  setLocalEnabled(enabled: boolean): void { this.update({ localEnabled: enabled }); }

  service(): AiServiceCache | null { return this.read().service ?? null; }
  setService(service: AiServiceCache): void { this.update({ service }); }

  /** Adds one feature use: `requests` is how many AI requests it made (default 1). */
  recordUsage(feature: AiFeature, usage: { inputTokens: number; outputTokens: number; requests?: number }): void {
    const totals = this.usage();
    const current = totals[feature];
    totals[feature] = { requests: current.requests + (usage.requests ?? 1), inputTokens: current.inputTokens + usage.inputTokens, outputTokens: current.outputTokens + usage.outputTokens };
    this.update({ usage: totals });
  }

  usage(): Record<AiFeature, AiUsageTotals> {
    const saved = this.read().usage ?? {};
    return Object.fromEntries(FEATURES.map((feature) => [feature, { ...zero(), ...saved[feature] }])) as Record<AiFeature, AiUsageTotals>;
  }
}
