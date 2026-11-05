import { describe, expect, it } from "vitest";
import { DEFAULT_AI_MODEL, modelOptions, usageRows, type AiModelInfo } from "./ai-settings";

const gemma: AiModelInfo = { id: DEFAULT_AI_MODEL, name: "Gemma 4 31B", contextLength: 262144, free: true, supportsTools: true };
const nemo: AiModelInfo = { id: "nvidia/nemotron-3-ultra-550b-a55b:free", name: "Nemotron 3 Ultra", contextLength: 1000000, free: true, supportsTools: true };

describe("modelOptions", () => {
  it("keeps a saved model that is no longer offered", () => {
    const options = modelOptions([gemma], "old/model:free");
    expect(options[0]).toEqual({ value: "old/model:free", label: "old/model:free (no longer offered)" });
    expect(options).toHaveLength(2);
  });

  it("marks the default as recommended", () => {
    expect(modelOptions([nemo, gemma], DEFAULT_AI_MODEL).find((o) => o.value === DEFAULT_AI_MODEL)!.label).toBe("Gemma 4 31B · 262K (recommended)");
  });

  it("shows the context length in K", () => {
    expect(modelOptions([nemo], nemo.id)).toEqual([{ value: nemo.id, label: "Nemotron 3 Ultra · 1000K" }]);
  });
});

describe("usageRows", () => {
  it("labels usage rows", () => {
    const zero = { requests: 0, inputTokens: 0, outputTokens: 0 };
    expect(usageRows({ ask: { requests: 3, inputTokens: 1200, outputTokens: 300 }, daySummary: zero, describe: zero, test: { requests: 1, inputTokens: 5, outputTokens: 2 } })).toEqual([
      { feature: "Ask MasalaPOS", requests: 3, tokens: 1500 },
      { feature: "Day summaries", requests: 0, tokens: 0 },
      { feature: "Menu descriptions", requests: 0, tokens: 0 },
      { feature: "Tests", requests: 1, tokens: 7 },
    ]);
  });
});
