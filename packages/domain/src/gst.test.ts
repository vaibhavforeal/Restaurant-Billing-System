import { describe, expect, it } from "vitest";
import { effectiveGstRate, receiptGstMode } from "./gst.js";

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

describe("receiptGstMode", () => {
  it("reads gstMode when the snapshot has it", () => {
    expect(receiptGstMode({ gstMode: "none" })).toBe("none");
    expect(receiptGstMode({ gstMode: "included" })).toBe("included");
  });
  it("maps legacy composition and Zomato-paid snapshots to none", () => {
    expect(receiptGstMode({ gstScheme: "composition" })).toBe("none");
    expect(receiptGstMode({ gstPaidBy: "zomato", taxInclusive: false })).toBe("none");
  });
  it("maps other legacy snapshots to included", () => {
    expect(receiptGstMode({ taxInclusive: false })).toBe("included");
    expect(receiptGstMode({ taxInclusive: true })).toBe("included");
  });
});
