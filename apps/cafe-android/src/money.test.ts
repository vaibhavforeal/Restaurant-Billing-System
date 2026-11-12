import { describe, expect, it } from "vitest";
import { formatRupees, parseRupees } from "./money";

describe("money on screen", () => {
  it.each([[0, "₹0.00"], [5, "₹0.05"], [1800, "₹18.00"], [123450, "₹1,234.50"], [12345678, "₹1,23,456.78"]])("formats %i as %s", (p, s) => expect(formatRupees(p)).toBe(s));
  it("formats a negative amount with the sign first", () => expect(formatRupees(-500)).toBe("-₹5.00"));
  it.each([["12", 1200], ["12.5", 1250], ["12.50", 1250], ["1,234.50", 123450], [" 7 ", 700], ["", null], ["abc", null], ["-1", null], ["1.234", null]])("parses %s", (t, p) => expect(parseRupees(t)).toBe(p));
});
