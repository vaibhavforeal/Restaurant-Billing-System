import { describe, expect, it } from "vitest";
import { salesMetrics, salesReportCsv, salesTrend, recentPeriod, type SalesReport } from "./sales-report";

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
    expect(csv).toContain('"Payment date"'); expect(csv).toContain('"1","50.00","55.00","0.00","5.00","100.00"');
    expect(csv).toContain('"Cash (net) INR","UPI (net) INR","Card (net) INR","Refunds INR","Net received INR"');
    expect(csv).toContain('"\'=HYPERLINK(""bad"")"'); expect(csv).not.toContain("Unpaid current");
  });
  it("headlines net sales, showing gross and credit notes in the note", () => {
    const metrics = salesMetrics(report);
    expect(metrics.map((m) => m.label)).toEqual(["Net sales", "Collections received", "Bills issued", "Still unpaid"]);
    expect(metrics[0]).toEqual({ label: "Net sales", value: "₹100.00", note: "Gross ₹105.00 − credit notes ₹5.00" });
    expect(metrics[1]!.value).toBe("₹100.00");
    expect(metrics[1]!.note).toMatch(/refunds/);
    const noCredit = salesMetrics({ ...report, creditNotePaise: 0, netTotalPaise: 10500 });
    expect(noCredit[0]).toMatchObject({ label: "Net sales", value: "₹105.00" });
    expect(noCredit[0]!.note).toMatch(/no credit notes/i);
  });
  it("plots net sales per day against net collections", () => {
    const day2 = { date: "2026-09-28", sales: { ...sales, billCount: 0, totalPaise: 0 }, creditNotePaise: 2000, netTotalPaise: -2000, collections: { ...collections, totalPaise: -2000 } };
    const trend = salesTrend({ ...report, daily: [...report.daily, day2] });
    expect(trend.points).toEqual([{ date: "2026-09-27", salesPaise: 10000, collectionsPaise: 10000 }, { date: "2026-09-28", salesPaise: -2000, collectionsPaise: -2000 }]);
    // a day with more credit notes than sales goes below zero: the scale includes it
    expect(trend.min).toBe(-2000);
    expect(trend.max).toBe(10000);
    expect(salesTrend(report).min).toBe(0);
  });
  it("builds calendar ranges across months and leap years", () => {
    expect(recentPeriod(7, "2026-10-03")).toEqual({ from: "2026-09-27", to: "2026-10-03" });
    expect(recentPeriod(7, "2024-03-01")).toEqual({ from: "2024-02-24", to: "2024-03-01" });
  });
});
