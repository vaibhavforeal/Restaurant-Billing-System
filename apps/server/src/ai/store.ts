import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicJson } from "../backups.js";
import { seal, unseal } from "../secret-box.js";

export type AiProviderId = "openrouter";
export type AiFeature = "ask" | "daySummary" | "describe" | "test";
export interface AiSettings { enabled: boolean; provider: AiProviderId; model: string; fallback: boolean }
export interface AiUsageTotals { requests: number; inputTokens: number; outputTokens: number }

const FEATURES: AiFeature[] = ["ask", "daySummary", "describe", "test"];
const DEFAULTS: AiSettings = { enabled: false, provider: "openrouter", model: "google/gemma-4-31b-it:free", fallback: true };
const zero = (): AiUsageTotals => ({ requests: 0, inputTokens: 0, outputTokens: 0 });

interface FileShape { settings?: Partial<AiSettings>; keys?: Partial<Record<AiProviderId, string>>; usage?: Partial<Record<AiFeature, AiUsageTotals>> }

/**
 * The AI assistant's settings, each provider's key (sealed) and usage counters, in `ai-assistant.json` in the data
 * folder: outside the database, so a restored backup never carries a key. Without the shell's secret key nothing can
 * be sealed, so a key can't be saved.
 */
export class AiStore {
  private readonly path: string;
  constructor(dataDir: string, private readonly secretKey: Buffer | undefined) {
    this.path = join(dataDir, "ai-assistant.json");
  }

  private read(): FileShape {
    if (!existsSync(this.path)) return {};
    try { return JSON.parse(readFileSync(this.path, "utf8")) as FileShape; } catch { return {}; }
  }
  private write(file: FileShape) { atomicJson(this.path, file); }

  settings(): AiSettings { return { ...DEFAULTS, ...this.read().settings }; }

  saveSettings(patch: Partial<AiSettings>): AiSettings {
    const file = this.read();
    file.settings = { ...this.settings(), ...patch };
    this.write(file);
    return this.settings();
  }

  setKey(provider: AiProviderId, key: string | null): void {
    const file = this.read();
    const keys = { ...file.keys };
    if (key === null) delete keys[provider];
    else {
      if (!this.secretKey) throw new Error("Saving a key needs Windows credential protection");
      keys[provider] = seal(this.secretKey, key);
    }
    this.write({ ...file, keys });
  }

  /** The provider's key, or null when none is saved or it was sealed on another PC (the owner re-enters it). */
  key(provider: AiProviderId): string | null {
    const sealed = this.read().keys?.[provider];
    if (!sealed || !this.secretKey) return null;
    try { return unseal(this.secretKey, sealed); } catch { return null; }
  }

  keyEnding(provider: AiProviderId): string | null { return this.key(provider)?.slice(-4) ?? null; }

  recordUsage(feature: AiFeature, usage: { inputTokens: number; outputTokens: number }): void {
    const file = this.read();
    const totals = this.usage();
    const current = totals[feature];
    totals[feature] = { requests: current.requests + 1, inputTokens: current.inputTokens + usage.inputTokens, outputTokens: current.outputTokens + usage.outputTokens };
    this.write({ ...file, usage: totals });
  }

  usage(): Record<AiFeature, AiUsageTotals> {
    const saved = this.read().usage ?? {};
    return Object.fromEntries(FEATURES.map((feature) => [feature, { ...zero(), ...saved[feature] }])) as Record<AiFeature, AiUsageTotals>;
  }
}
