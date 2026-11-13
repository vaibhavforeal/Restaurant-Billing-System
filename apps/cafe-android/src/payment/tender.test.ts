import { describe, expect, it } from "vitest";
import { cashSuggestions, changeDue, remaining } from "./tender";

describe("tender", () => {
  it.each([[3600, 3600, 0], [3600, 5000, 1400], [3600, 3500, null]])("change for %i with %i tendered is %s", (t, g, c) => expect(changeDue(t, g)).toBe(c));
  it("suggests the exact amount and round notes above it", () => {
    expect(cashSuggestions(3600)).toEqual([3600, 4000, 5000, 10000]);
    expect(cashSuggestions(10000)).toEqual([10000, 50000]);
    expect(cashSuggestions(0)).toEqual([]);
  });
  it("says what a split still has to cover", () => { expect(remaining(3600, [2000])).toBe(1600); expect(remaining(3600, [2000, 1600])).toBe(0); });
});
