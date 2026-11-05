import { describe, expect, it } from "vitest";
import { gstinCheckChar, gstinProblem, isValidGstin } from "./gstin.js";

const VALID = ["27AAPFU0939F1ZV", "29AAPFU0939F1ZR", "29AABCU9603R1ZJ", "27AABCU9603R1ZN"];

describe("gstinCheckChar", () => {
  it("computes the check character of known GSTINs", () => {
    for (const gstin of VALID) expect(gstinCheckChar(gstin.slice(0, 14))).toBe(gstin[14]);
  });
  it("returns null for input that is not 14 base-36 characters", () => {
    expect(gstinCheckChar("27AAPFU0939F1")).toBeNull();
    expect(gstinCheckChar("27AAPFU0939F1#")).toBeNull();
  });
});

describe("isValidGstin", () => {
  it("accepts real GSTINs, ignoring case and surrounding spaces", () => {
    for (const gstin of VALID) expect(isValidGstin(gstin)).toBe(true);
    expect(isValidGstin(" 27aapfu0939f1zv ")).toBe(true);
  });
  it("rejects a wrong check character", () => {
    expect(isValidGstin("27AAPFU0939F1ZW")).toBe(false);
    expect(isValidGstin("29ABCDE1234F1Z5")).toBe(false);
  });
  it("rejects an unknown state code and a malformed shape", () => {
    const body = "AAPFU0939F1Z";
    const forState = (code: string) => code + body + gstinCheckChar(code + body);
    expect(isValidGstin(forState("27"))).toBe(true);
    expect(isValidGstin(forState("97"))).toBe(true);
    expect(isValidGstin(forState("00"))).toBe(false);
    expect(isValidGstin(forState("39"))).toBe(false);
    expect(isValidGstin("27AAPFU0939F1V")).toBe(false);
    expect(isValidGstin("")).toBe(false);
  });
});

describe("gstinProblem", () => {
  it("explains what is wrong, or returns null", () => {
    expect(gstinProblem("27AAPFU0939F1ZV")).toBeNull();
    expect(gstinProblem("")).toMatch(/Enter/);
    expect(gstinProblem("27AAPFU0939F")).toMatch(/15 characters/);
    expect(gstinProblem("27AAPFU0939F1ZW")).toMatch(/check/i);
  });
});
