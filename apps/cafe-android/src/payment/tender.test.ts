import { describe, expect, it } from "vitest";
import { cashSuggestions, changeDue, parseAmountPaise, remaining, splitComplete } from "./tender";

describe("tender", () => {
  it.each([[3600, 3600, 0], [3600, 5000, 1400], [3600, 3500, null]])("change for %i with %i tendered is %s", (t, g, c) => expect(changeDue(t, g)).toBe(c));
  it("suggests the exact amount and round notes above it", () => {
    expect(cashSuggestions(3600)).toEqual([3600, 4000, 5000, 10000]);
    expect(cashSuggestions(10000)).toEqual([10000, 50000]);
    expect(cashSuggestions(0)).toEqual([]);
  });
  it("says what a split still has to cover", () => { expect(remaining(3600, [2000])).toBe(1600); expect(remaining(3600, [2000, 1600])).toBe(0); });
});

describe("amounts and three-way splits", () => {
  it.each([["120", 12000], ["120.5", 12050], ["120.50", 12050], [" 1,200 ", 120000], ["", null], ["12a", null], ["1.234", null], ["-5", null]] as const)(
    "parseAmountPaise(%s)", (text, paise) => { expect(parseAmountPaise(text)).toBe(paise); });

  it("needs a three-way split to add up with each mode once", () => {
    const part = (mode: "cash" | "upi" | "card", amountPaise: number) => ({ mode, amountPaise });
    expect(splitComplete(30000, [part("cash", 10000), part("upi", 10000), part("card", 10000)])).toBe(true);
    expect(splitComplete(30000, [part("cash", 20000), part("card", 10000)])).toBe(true);
    expect(splitComplete(30000, [part("cash", 10000), part("cash", 10000), part("card", 10000)])).toBe(false);
    expect(splitComplete(30000, [part("cash", 0), part("upi", 20000), part("card", 10000)])).toBe(false);
    expect(splitComplete(30000, [part("cash", 10000), part("upi", 10000)])).toBe(false);
    expect(splitComplete(30000, [part("cash", 30000)])).toBe(false);
  });
});
