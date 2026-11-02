import { describe, expect, it } from "vitest";
import { compareRange, periodRange } from "./periods.js";

describe("dashboard periods", () => {
  it("resolves each preset against today (weeks start on Monday)", () => {
    // 2026-11-04 is a Wednesday
    expect(periodRange("today", "2026-11-04")).toEqual({ from: "2026-11-04", to: "2026-11-04" });
    expect(periodRange("yesterday", "2026-11-01")).toEqual({ from: "2026-10-31", to: "2026-10-31" });
    expect(periodRange("thisWeek", "2026-11-04")).toEqual({ from: "2026-11-02", to: "2026-11-04" });
    expect(periodRange("thisWeek", "2026-11-08")).toEqual({ from: "2026-11-02", to: "2026-11-08" }); // Sunday
    expect(periodRange("thisMonth", "2026-11-04")).toEqual({ from: "2026-11-01", to: "2026-11-04" });
    expect(periodRange("last7", "2026-11-04")).toEqual({ from: "2026-10-29", to: "2026-11-04" });
    expect(periodRange("last30", "2026-11-04")).toEqual({ from: "2026-10-06", to: "2026-11-04" });
  });
  it("compares with the previous period of the same length", () => {
    expect(compareRange("today", { from: "2026-11-04", to: "2026-11-04" }, "previous")).toEqual({ from: "2026-11-03", to: "2026-11-03" });
    expect(compareRange("thisWeek", { from: "2026-11-02", to: "2026-11-04" }, "previous")).toEqual({ from: "2026-10-26", to: "2026-10-28" });
    expect(compareRange("last7", { from: "2026-10-29", to: "2026-11-04" }, "previous")).toEqual({ from: "2026-10-22", to: "2026-10-28" });
  });
  it("compares month-to-date with the same days of last month, clipped to its end", () => {
    expect(compareRange("thisMonth", { from: "2026-11-01", to: "2026-11-04" }, "previous")).toEqual({ from: "2026-10-01", to: "2026-10-04" });
    expect(compareRange("thisMonth", { from: "2026-03-01", to: "2026-03-31" }, "previous")).toEqual({ from: "2026-02-01", to: "2026-02-28" });
    expect(compareRange("thisMonth", { from: "2028-03-01", to: "2028-03-30" }, "previous")).toEqual({ from: "2028-02-01", to: "2028-02-29" });
  });
  it("shifts by seven days for lastWeek and returns null for none", () => {
    expect(compareRange("today", { from: "2026-11-04", to: "2026-11-04" }, "lastWeek")).toEqual({ from: "2026-10-28", to: "2026-10-28" });
    expect(compareRange("today", { from: "2026-11-04", to: "2026-11-04" }, "none")).toBeNull();
  });
});
