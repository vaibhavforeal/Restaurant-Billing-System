import { describe, expect, it } from "vitest";
import { serviceStatusText, usageRows, type AiSettingsView } from "./ai-settings";

const zero = { requests: 0, inputTokens: 0, outputTokens: 0 };
const view = (over: Partial<AiSettingsView>): AiSettingsView => ({ connected: true, localEnabled: true, service: null, usage: { ask: zero, daySummary: zero, describe: zero }, ...over });

describe("serviceStatusText", () => {
  it("says when this copy can't reach MasalaPOS", () => {
    expect(serviceStatusText(view({ connected: false }))).toBe("This copy isn't connected to MasalaPOS, so the AI assistant isn't available here.");
  });

  it("says when MasalaPOS hasn't switched it on", () => {
    expect(serviceStatusText(view({ service: { enabled: false, dailyLimit: 40, usedToday: 0, checkedAt: 1 } }))).toBe("Not switched on for this restaurant. Contact MasalaPOS to add the AI assistant.");
  });

  it("shows today's use when it is on", () => {
    expect(serviceStatusText(view({ service: { enabled: true, dailyLimit: 40, usedToday: 12, checkedAt: 1 } }))).toBe("On for this restaurant · 12 of 40 requests used today");
  });

  it("asks for a check when MasalaPOS hasn't answered yet", () => {
    expect(serviceStatusText(view({ service: null }))).toBe("Not checked with MasalaPOS yet. Press Check to see whether it's on for this restaurant.");
  });
});

describe("usageRows", () => {
  it("labels usage rows", () => {
    expect(usageRows({ ask: { requests: 3, inputTokens: 1200, outputTokens: 300 }, daySummary: zero, describe: { requests: 1, inputTokens: 5, outputTokens: 2 } })).toEqual([
      { feature: "Ask MasalaPOS", requests: 3, tokens: 1500 },
      { feature: "Day summaries", requests: 0, tokens: 0 },
      { feature: "Menu descriptions", requests: 1, tokens: 7 },
    ]);
  });
});
