import type { TaxLine } from "@forkflow/domain";
import { paiseToRupees } from "./money";

export interface DayEndReport {
  date: string;
  timezone: string;
  sales: {
    billCount: number; subtotalPaise: number; discountPaise: number; cgstPaise: number;
    sgstPaise: number; roundingPaise: number; totalPaise: number; outstandingPaise: number;
  };
  taxes: TaxLine[];
  payments: Array<{ mode: string; amountPaise: number }>;
  cancellations: { orderCount: number };
}

/** Export the loaded snapshot so the file matches the date and totals on screen. */
export function dayEndCsv(report: DayEndReport): string {
  type Cell = string | number;
  const rows: Cell[][] = [["Business date", "Server timezone", "Section", "Metric", "GST rate (%)", "Value", "Unit"]];
  const row = (section: string, metric: string, value: number, unit: "INR" | "count", rate: number | "" = "") => {
    rows.push([report.date, report.timezone, section, metric, rate, value, unit]);
  };
  const amount = (section: string, metric: string, paise: number, rate: number | "" = "") => {
    row(section, metric, Number(paiseToRupees(paise)), "INR", rate);
  };
  const sales = "Bills issued on this date";
  row(sales, "Number of bills", report.sales.billCount, "count");
  amount(sales, "Subtotal before discount", report.sales.subtotalPaise);
  amount(sales, "Discounts", report.sales.discountPaise);
  amount(sales, "CGST", report.sales.cgstPaise);
  amount(sales, "SGST", report.sales.sgstPaise);
  amount(sales, "Round off", report.sales.roundingPaise);
  amount(sales, "Sales including GST and rounding", report.sales.totalPaise);
  amount(sales, "Still unpaid (current)", report.sales.outstandingPaise);
  row("Cancellations", "Orders cancelled on this date", report.cancellations.orderCount, "count");
  for (const tax of report.taxes) {
    amount("GST breakdown", "Taxable", tax.taxablePaise, tax.gstRate);
    amount("GST breakdown", "CGST", tax.cgstPaise, tax.gstRate);
    amount("GST breakdown", "SGST", tax.sgstPaise, tax.gstRate);
  }
  const payments = "Payments received on this date (includes older bills)";
  for (const mode of ["cash", "upi", "card"]) {
    amount(payments, mode.toUpperCase(), report.payments.find((p) => p.mode === mode)?.amountPaise ?? 0);
  }
  amount(payments, "Total received", report.payments.reduce((sum, payment) => sum + payment.amountPaise, 0));
  return "\uFEFF" + rows.map((cells) => cells.map((cell, column) => {
    // Numeric cells stay numeric, including negative rounding. Text cannot execute
    // spreadsheet formulas. INR values use two decimals; counts/rates are integers.
    const value = typeof cell === "number"
      ? (column === 5 && cells[6] === "INR" ? cell.toFixed(2) : String(cell))
      : (/^(?:\s*[=+\-@]|[\t\r\n'])/.test(cell) ? "'" + cell : cell);
    return '"' + value.replaceAll('"', '""') + '"';
  }).join(",")).join("\r\n") + "\r\n";
}
