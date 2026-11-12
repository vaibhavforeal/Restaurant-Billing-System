import type { DaySummary } from "@masalapos/cafe-data";
import type { PrintProfileInput } from "@masalapos/domain/printer-schemas";
import { CHARS_PER_LINE, EscPos, finishSlip, money, slipWriter } from "@masalapos/print";
import { longDate } from "../dates";

/** The day report on paper: sales, payment modes, tax by rate, items sold and voids. */
export function daySummarySlip(summary: DaySummary, cafeName: string, paperWidth: 58 | 80, profile: PrintProfileInput): Uint8Array {
  const width = CHARS_PER_LINE[paperWidth];
  const pos = new EscPos().init();
  const { line, pair } = slipWriter(pos, width);
  const rule = () => line("-".repeat(width));
  const heading = (text: string) => { pos.bold(true); line(text); pos.bold(false); };

  pos.align("center").bold(true);
  line(cafeName);
  line("DAY SUMMARY");
  pos.bold(false);
  line(longDate(summary.date));
  pos.align("left");
  rule();
  pair("Bills", String(summary.billCount));
  pair("Gross sales", money(summary.grossPaise));
  pair("Discounts", money(summary.discountPaise));
  if (summary.roundingPaise) pair("Round off", money(summary.roundingPaise));
  pos.bold(true);
  pair("Net sales", money(summary.netPaise));
  pos.bold(false);
  rule();
  heading("Payments");
  pair("Cash", money(summary.byMode.cash));
  pair("UPI", money(summary.byMode.upi));
  pair("Card", money(summary.byMode.card));
  if (summary.taxes.length) {
    rule();
    heading("Tax");
    for (const t of summary.taxes) {
      pair(`Taxable @ ${t.gstRate}%`, money(t.taxablePaise));
      if (t.cgstPaise || t.sgstPaise) {
        pair(`CGST ${t.gstRate / 2}%`, money(t.cgstPaise));
        pair(`SGST ${t.gstRate / 2}%`, money(t.sgstPaise));
      }
    }
  }
  if (summary.items.length) {
    rule();
    heading("Items");
    for (const item of summary.items) pair(`${item.qty} x ${item.name}`, money(item.amountPaise));
  }
  rule();
  heading(`Voids (${summary.voidCount})`);
  for (const v of summary.voids) {
    pair(v.invoiceNo, money(v.totalPaise));
    line(`  Token ${v.token}: ${v.reason}`);
  }
  if (!summary.voids.length) line("None");
  return finishSlip(pos, profile);
}
