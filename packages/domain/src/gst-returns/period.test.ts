import { describe, expect, it } from "vitest";
import { gstDate, gstPeriod } from "./period.js";

describe("gstPeriod", () => {
  it("covers one month", () => {
    expect(gstPeriod("2026-02", "month")).toEqual({ span: "month", from: "2026-02-01", to: "2026-02-28", months: ["2026-02"], fp: "022026",
      label: "February 2026", financialYear: "2025-26" });
  });
  it("covers the financial-year quarter containing the month", () => {
    expect(gstPeriod("2026-11", "quarter")).toMatchObject({ from: "2026-10-01", to: "2026-12-31", months: ["2026-10", "2026-11", "2026-12"], fp: "122026",
      label: "Q3 FY 2026-27 (Oct 2026 - Dec 2026)", financialYear: "2026-27" });
    expect(gstPeriod("2027-01", "quarter")).toMatchObject({ from: "2027-01-01", to: "2027-03-31", fp: "032027", label: "Q4 FY 2026-27 (Jan 2027 - Mar 2027)" });
    expect(gstPeriod("2026-04", "quarter")).toMatchObject({ months: ["2026-04", "2026-05", "2026-06"], label: "Q1 FY 2026-27 (Apr 2026 - Jun 2026)" });
    expect(gstPeriod("2026-09", "quarter").months).toEqual(["2026-07", "2026-08", "2026-09"]);
    expect(gstPeriod("2026-03", "quarter")).toMatchObject({ from: "2026-01-01", to: "2026-03-31", financialYear: "2025-26" });
  });
  it("rejects a malformed month", () => {
    for (const bad of ["2026-13", "2026-1", "Oct 2026", "2016-10"]) expect(() => gstPeriod(bad, "month")).toThrow();
  });
});

describe("gstDate", () => {
  it("formats a day as DD-MM-YYYY", () => expect(gstDate("2026-10-05")).toBe("05-10-2026"));
});
