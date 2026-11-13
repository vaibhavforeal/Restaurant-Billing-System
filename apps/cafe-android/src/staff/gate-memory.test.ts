import { describe, expect, it } from "vitest";
import { createGateMemory } from "./gate-memory";

describe("gate memory", () => {
  it("keeps an approval while the same tab stays in front, for the same person", () => {
    const g = createGateMemory();
    g.tabFocused("menu");
    g.remember("catalog.manage", "ravi");
    g.tabFocused("menu"); // back from a screen pushed over the Menu tab
    expect(g.allowed("catalog.manage", "ravi")).toBe(true);
    expect(g.allowed("catalog.manage", "asha")).toBe(false);
    expect(g.allowed("reports.read", "ravi")).toBe(false);
  });
  it("forgets approvals when another tab comes in front", () => {
    const g = createGateMemory();
    g.tabFocused("menu");
    g.remember("catalog.manage", "ravi");
    g.tabFocused("bill");
    g.tabFocused("menu");
    expect(g.allowed("catalog.manage", "ravi")).toBe(false);
  });
  it("forgets everything on clear", () => {
    const g = createGateMemory();
    g.remember("catalog.manage", "ravi");
    g.clear();
    expect(g.allowed("catalog.manage", "ravi")).toBe(false);
  });
});
