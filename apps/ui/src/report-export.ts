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
  /** Voids and refunds dated this day. `taxes` are the credited GST per rate. */
  creditNotes: { count: number; taxablePaise: number; cgstPaise: number; sgstPaise: number; totalPaise: number; taxes: TaxLine[] };
  refunds: Array<{ mode: string; amountPaise: number }>;
  net: { totalPaise: number; taxablePaise: number; cgstPaise: number; sgstPaise: number };
  netPayments: Array<{ mode: string; amountPaise: number }>;
}

/** GST per rate after credit notes (the server does not return it): gross minus credited, for every rate on either side. */
export function netTaxes(gross: TaxLine[], credited: TaxLine[]): TaxLine[] {
  const byRate = new Map<number, TaxLine>();
  for (const t of gross) byRate.set(t.gstRate, { ...t });
  for (const c of credited) {
    const t = byRate.get(c.gstRate) ?? { gstRate: c.gstRate, taxablePaise: 0, cgstPaise: 0, sgstPaise: 0 };
    byRate.set(c.gstRate, { gstRate: c.gstRate, taxablePaise: t.taxablePaise - c.taxablePaise, cgstPaise: t.cgstPaise - c.cgstPaise, sgstPaise: t.sgstPaise - c.sgstPaise });
  }
  return [...byRate.values()].sort((a, b) => a.gstRate - b.gstRate);
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
  const credits = "Credit notes (voids and refunds)";
  row(credits, "Credit notes issued", report.creditNotes.count, "count");
  amount(credits, "Taxable", report.creditNotes.taxablePaise);
  amount(credits, "CGST", report.creditNotes.cgstPaise);
  amount(credits, "SGST", report.creditNotes.sgstPaise);
  amount(credits, "Credit note total", report.creditNotes.totalPaise);
  for (const tax of report.creditNotes.taxes) {
    amount("Credit notes GST breakdown", "Taxable", tax.taxablePaise, tax.gstRate);
    amount("Credit notes GST breakdown", "CGST", tax.cgstPaise, tax.gstRate);
    amount("Credit notes GST breakdown", "SGST", tax.sgstPaise, tax.gstRate);
  }
  const refunds = "Refunds paid on this date";
  for (const mode of ["cash", "upi", "card"]) amount(refunds, mode.toUpperCase(), report.refunds.find((r) => r.mode === mode)?.amountPaise ?? 0);
  amount(refunds, "Total refunded", report.refunds.reduce((sum, refund) => sum + refund.amountPaise, 0));
  const net = "Net sales (after credit notes)";
  amount(net, "Net taxable", report.net.taxablePaise);
  amount(net, "Net CGST", report.net.cgstPaise);
  amount(net, "Net SGST", report.net.sgstPaise);
  amount(net, "Net sales including GST and rounding", report.net.totalPaise);
  for (const tax of netTaxes(report.taxes, report.creditNotes.taxes)) {
    amount("Net GST breakdown", "Taxable", tax.taxablePaise, tax.gstRate);
    amount("Net GST breakdown", "CGST", tax.cgstPaise, tax.gstRate);
    amount("Net GST breakdown", "SGST", tax.sgstPaise, tax.gstRate);
  }
  const netPay = "Net payments received (after refunds)";
  for (const mode of ["cash", "upi", "card"]) amount(netPay, mode.toUpperCase(), report.netPayments.find((p) => p.mode === mode)?.amountPaise ?? 0);
  amount(netPay, "Total received", report.netPayments.reduce((sum, payment) => sum + payment.amountPaise, 0));
  return "\uFEFF" + rows.map((cells) => cells.map((cell, column) => {
    // Numeric cells stay numeric, including negative rounding. Text cannot execute
    // spreadsheet formulas. INR values use two decimals; counts/rates are integers.
    const value = typeof cell === "number"
      ? (column === 5 && cells[6] === "INR" ? cell.toFixed(2) : String(cell))
      : (/^(?:\s*[=+\-@]|[\t\r\n'])/.test(cell) ? "'" + cell : cell);
    return '"' + value.replaceAll('"', '""') + '"';
  }).join(",")).join("\r\n") + "\r\n";
}
