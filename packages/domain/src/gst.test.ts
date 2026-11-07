import { describe, expect, it } from "vitest";
import { billChargesGst, effectiveGstRate } from "./gst.js";

describe("effectiveGstRate", () => {
  it("uses the restaurant default when an item has no override", () => {
    expect(effectiveGstRate(null, 5)).toBe(5);
  });
  it("lets an item override win over the default", () => {
    expect(effectiveGstRate(18, 5)).toBe(18);
  });
  it("treats a 0% override as a real override, not as no override", () => {
    expect(effectiveGstRate(0, 12)).toBe(0);
  });
});

describe("billChargesGst", () => {
  it("is true for both taxed modes and false for no GST", () => {
    expect(billChargesGst({ gstMode: "included" })).toBe(true);
    expect(billChargesGst({ gstMode: "exclusive" })).toBe(true);
    expect(billChargesGst({ gstMode: "none" })).toBe(false);
  });
  it("is false when Zomato pays the GST, whatever the mode", () => {
    expect(billChargesGst({ gstMode: "included", gstPaidBy: "zomato" })).toBe(false);
  });
});
