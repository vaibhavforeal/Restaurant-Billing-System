import { paiseToRupees } from "./money";

export interface SalesTotals {
  billCount: number; subtotalPaise: number; discountPaise: number; cgstPaise: number;
  sgstPaise: number; roundingPaise: number; totalPaise: number; outstandingPaise: number;
}
/** Collections are already net of refunds paid out (per method and in total); `refundPaise` is what was refunded. */
export interface CollectionTotals { billCount: number; cashPaise: number; upiPaise: number; cardPaise: number; refundPaise: number; totalPaise: number }
export interface SalesDay { date: string; sales: SalesTotals; creditNotePaise: number; netTotalPaise: number; collections: CollectionTotals }
export interface SalesReport {
  from: string; to: string; today: string; timezone: string; generatedAt: number;
  sales: SalesTotals; creditNotePaise: number; netTotalPaise: number; collections: CollectionTotals; daily: SalesDay[];
}
export type SalesReportKind = "sales" | "collections";
export interface ReportPeriod { from: string; to: string }
export const reportMoney = (paise: number) => `₹${paiseToRupees(paise)}`;
export function localDay(date = new Date()) { return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`; }
export function recentPeriod(days: number, end = localDay()): ReportPeriod {
  const start = new Date(`${end}T12:00:00`); start.setDate(start.getDate() - days + 1);
  return { from: localDay(start), to: end };
}

export interface SalesMetric { label: string; value: string; note: string }
/** The headline cards: net sales (issued bills less credit notes) leads, with the gross and credit notes in its note. */
export function salesMetrics(report: SalesReport): SalesMetric[] {
  return [
    { label: "Net sales", value: reportMoney(report.netTotalPaise), note: report.creditNotePaise
      ? `Gross ${reportMoney(report.sales.totalPaise)} − credit notes ${reportMoney(report.creditNotePaise)}`
      : "Includes GST and rounding · no credit notes" },
    { label: "Collections received", value: reportMoney(report.collections.totalPaise), note: "By payment date · after refunds paid out" },
    { label: "Bills issued", value: String(report.sales.billCount), note: "On the selected bill dates" },
    { label: "Still unpaid", value: reportMoney(report.sales.outstandingPaise), note: "Selected-period bills · current balance" },
  ];
}

/** Export the displayed report snapshot; money cells are decimal rupees. */
export function salesReportCsv(report: SalesReport, kind: SalesReportKind): string {
  const headings = kind === "sales"
    ? ["Bill date", "Bills issued", "Subtotal INR", "Discount INR", "CGST INR", "SGST INR", "Rounding INR", "Sales incl GST and rounding INR", "Credit notes INR", "Net sales INR", "Unpaid current INR"]
    : ["Payment date", "Bills with payments", "Cash (net) INR", "UPI (net) INR", "Card (net) INR", "Refunds INR", "Net received INR"];
  const values = (day: Pick<SalesDay, "sales" | "collections" | "creditNotePaise" | "netTotalPaise">) => kind === "sales"
    ? [day.sales.billCount, ...[day.sales.subtotalPaise, day.sales.discountPaise, day.sales.cgstPaise, day.sales.sgstPaise, day.sales.roundingPaise, day.sales.totalPaise, day.creditNotePaise, day.netTotalPaise, day.sales.outstandingPaise].map(paiseToRupees)]
    : [day.collections.billCount, ...[day.collections.cashPaise, day.collections.upiPaise, day.collections.cardPaise, day.collections.refundPaise, day.collections.totalPaise].map(paiseToRupees)];
  const rows = [["From", "To", "Server timezone", ...headings],
    ...report.daily.map((day) => [report.from, report.to, report.timezone, day.date, ...values(day)]),
    [report.from, report.to, report.timezone, "TOTAL", ...values(report)]];
  return "\uFEFF" + rows.map((row) => row.map((cell, index) => {
    const raw = String(cell);
    const text = index < 4 && /^(?:\s*[=+\-@]|[\t\r\n'])/.test(raw) ? "'" + raw : raw;
    return '"' + text.replaceAll('"', '""') + '"';
  }).join(",")).join("\r\n") + "\r\n";
}
