import { describe, expect, it } from "vitest";
import { businessDate, cafeFinancialYear } from "./time.js";

describe("cafe time", () => {
  it("puts a bill in the device's calendar day", () => {
    const justAfterMidnightIst = Date.UTC(2026, 10, 12, 18, 31); // 13 Nov 00:01 IST
    expect(businessDate(justAfterMidnightIst, 330)).toBe("2026-11-13");
    expect(businessDate(justAfterMidnightIst, 0)).toBe("2026-11-12");
  });
  it("starts the financial year on 1 April in the device's time zone", () => {
    expect(cafeFinancialYear(Date.UTC(2027, 2, 31, 18, 29), 330)).toEqual({ key: "2026-27", short: "26-27" }); // 31 Mar 23:59 IST
    expect(cafeFinancialYear(Date.UTC(2027, 2, 31, 18, 30), 330)).toEqual({ key: "2027-28", short: "27-28" }); // 1 Apr 00:00 IST
  });
});
