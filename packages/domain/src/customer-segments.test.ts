import { describe, expect, it } from "vitest";
import { matchesSegment, SEGMENT_PRESETS, SegmentFilter, type SegmentCustomer } from "./customer-segments.js";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 27);
const base: SegmentCustomer = {
  id: "c", name: "Priya", phone: "9876543210", email: null, typeId: null, typeName: null, tierId: null, tierName: null, tags: ["Vegan"],
  visits: 6, spendPaise: 500_000, lastVisitAt: NOW - 70 * DAY, createdAt: NOW - 400 * DAY, points: 120,
  birthDate: "--10-30", anniversaryDate: null, marketingOptIn: true, isActive: true,
};
const match = (filter: unknown, c: Partial<SegmentCustomer> = {}) => matchesSegment({ ...base, ...c }, SegmentFilter.parse(filter), NOW, "2026-10-27");

describe("customer segments", () => {
  it("matches everyone active when no condition is set", () => {
    expect(match({})).toBe(true);
    expect(match({}, { isActive: false })).toBe(false);
    expect(match({ includeInactive: true }, { isActive: false })).toBe(true);
  });

  it("filters on visits, spend, points and recency", () => {
    expect(match({ notVisitedForDays: 60 })).toBe(true);
    expect(match({ notVisitedForDays: 90 })).toBe(false);
    expect(match({ notVisitedForDays: 60 }, { lastVisitAt: null })).toBe(false);
    expect(match({ visitedWithinDays: 30 })).toBe(false);
    expect(match({ minVisits: 7 })).toBe(false);
    expect(match({ minSpendPaise: 500_000, minPoints: 120 })).toBe(true);
    expect(match({ joinedWithinDays: 30 })).toBe(false);
  });

  it("filters on tier, type, tags, opt-in and occasions", () => {
    expect(match({ tierIds: ["none"] })).toBe(true);
    expect(match({ tierIds: ["gold"] }, { tierId: "gold" })).toBe(true);
    expect(match({ typeIds: ["staff"] })).toBe(false);
    expect(match({ tags: ["vegan", "jain"] })).toBe(true);
    expect(match({ optedInOnly: true }, { marketingOptIn: false })).toBe(false);
    expect(match({ occasion: { kind: "birthday", withinDays: 3 } })).toBe(true);
    expect(match({ occasion: { kind: "birthday", withinDays: 2 } })).toBe(false);
    expect(match({ occasion: { kind: "either", withinDays: 7 } }, { birthDate: null, anniversaryDate: "2019-10-27" })).toBe(true);
  });

  it("ships presets that parse", () => {
    for (const preset of SEGMENT_PRESETS) expect(() => SegmentFilter.parse(preset.filter)).not.toThrow();
  });
});
