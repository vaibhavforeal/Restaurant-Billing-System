import { describe, expect, it } from "vitest";
import { salesReportCsv, recentPeriod, type SalesReport } from "./sales-report";

const sales = { billCount: 2, subtotalPaise: 10001, discountPaise: 0, cgstPaise: 250, sgstPaise: 250, roundingPaise: -1, totalPaise: 10500, outstandingPaise: 10500 };
const collections = { billCount: 1, cashPaise: 5000, upiPaise: 5500, cardPaise: 0, refundPaise: 500, totalPaise: 10000 };
const report: SalesReport = { from: "2026-09-27", to: "2026-09-27", today: "2026-09-30", generatedAt: 0, timezone: "Asia/Calcutta", sales, collections, creditNotePaise: 500, netTotalPaise: 10000, daily: [{ date: "2026-09-27", sales, creditNotePaise: 500, netTotalPaise: 10000, collections }] };
describe("sales and collections CSV", () => {
  it("keeps exact decimal rupees, negative rounding and displayed range totals", () => {
    const csv = salesReportCsv(report, "sales");
    expect(csv.startsWith("\uFEFF")).toBe(true); expect(csv).toContain('"2","100.01","0.00","2.50","2.50","-0.01","105.00","5.00","100.00","105.00"');
    expect(csv).toContain('"Credit notes INR","Net sales INR"');
    expect(csv).toContain('"TOTAL","2","100.01"');
    expect(csv).toContain('"2026-09-27","2026-09-27","Asia/Calcutta"');
  });
  it("exports collection dates and tender amounts separately, escaping text metadata", () => {
    const csv = salesReportCsv({ ...report, timezone: '=HYPERLINK("bad")' }, "collections");
    expect(csv).toContain('"Payment date"'); expect(csv).toContain('"1","50.00","55.00","0.00","5.00","100.00"'); expect(csv).toContain('"Refunds INR","Net received INR"');
    expect(csv).toContain('"\'=HYPERLINK(""bad"")"'); expect(csv).not.toContain("Unpaid current");
  });
  it("builds calendar ranges across months and leap years", () => {
    expect(recentPeriod(7, "2026-10-03")).toEqual({ from: "2026-09-27", to: "2026-10-03" });
    expect(recentPeriod(7, "2024-03-01")).toEqual({ from: "2024-02-24", to: "2024-03-01" });
  });
});
