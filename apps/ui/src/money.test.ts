import { describe, expect, it } from "vitest";
import { paiseToRupees, rupeesToPaise } from "./money";

describe("money helpers", () => {
  it("formats paise as rupees with two decimals", () => {
    expect(paiseToRupees(25000)).toBe("250.00");
    expect(paiseToRupees(999)).toBe("9.99");
    expect(paiseToRupees(0)).toBe("0.00");
  });

  it("parses rupee strings to integer paise, rounding half-up float dust", () => {
    expect(rupeesToPaise("250")).toBe(25000);
    expect(rupeesToPaise("9.99")).toBe(999);
    expect(rupeesToPaise("0.1")).toBe(10);
    expect(rupeesToPaise("19.999")).toBe(2000); // Math.round(1999.9)
  });

  it("returns null for junk and negatives", () => {
    expect(rupeesToPaise("")).toBeNull();
    expect(rupeesToPaise("abc")).toBeNull();
    expect(rupeesToPaise("-5")).toBeNull();
  });
});
