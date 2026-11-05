import { describe, expect, it } from "vitest";
import { describeRequest, summaryClipboardText } from "./ai-buttons";

describe("AI button helpers", () => {
  it("omits current for an empty description", () => {
    expect(describeRequest({ name: "Paneer tikka", categoryName: "Starters", isVeg: true, variantNames: ["Half", "Full"], description: "   " }))
      .toEqual({ name: "Paneer tikka", category: "Starters", isVeg: true, sizes: ["Half", "Full"] });
  });

  it("uses Rewrite input when text exists", () => {
    expect(describeRequest({ name: "Dal", categoryName: "Mains", isVeg: true, variantNames: [], description: " Slow-cooked lentils. " }))
      .toEqual({ name: "Dal", category: "Mains", isVeg: true, sizes: [], current: "Slow-cooked lentils." });
  });

  it("formats the clipboard text", () => {
    expect(summaryClipboardText("2026-11-04", "Cafe Test", "• Sales were steady.")).toBe("Cafe Test · 2026-11-04\n• Sales were steady.");
  });
});
