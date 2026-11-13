import { describe, expect, it } from "vitest";
import { errorText, formatErrorReport } from "./report";

describe("error report", () => {
  it("lists each error with its time, context and stack, newest first, under the app version", () => {
    const text = formatErrorReport([
      { at: Date.UTC(2026, 10, 13, 6, 5), message: "Cannot read property 'id' of undefined", stack: "at PaymentScreen\nat render", context: "payment" },
      { at: Date.UTC(2026, 10, 13, 6, 0), message: "first", stack: null, context: null },
    ], { appVersion: "0.1.0", tzOffsetMinutes: 330 });
    expect(text).toContain("MasalaPOS Cafe 0.1.0 error report (2 errors)");
    expect(text).toContain("2026-11-13 11:35 [payment] Cannot read property 'id' of undefined");
    expect(text).toContain("  at PaymentScreen\n  at render");
    expect(text.indexOf("11:35")).toBeLessThan(text.indexOf("11:30"));
  });
  it("says so when there are none", () => {
    expect(formatErrorReport([], { appVersion: "0.1.0", tzOffsetMinutes: 330 })).toContain("No errors recorded.");
  });
  it("turns anything thrown into a message and a stack", () => {
    const e = new TypeError("boom");
    expect(errorText(e)).toEqual({ message: "TypeError: boom", stack: e.stack ?? null });
    expect(errorText("plain text")).toEqual({ message: "plain text", stack: null });
    expect(errorText({ code: "X", message: "coded" })).toEqual({ message: "coded (X)", stack: null });
  });
});
