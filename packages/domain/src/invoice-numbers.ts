import { z } from "zod";
import type { Database } from "./db.js";
import { nextSequence } from "./sequences.js";

/** Highest counter in one financial year; keeps "ABCD/25-26/99999" at the 16 characters GST allows. */
export const INVOICE_COUNTER_MAX = 99_999;

/** Optional restaurant prefix: up to 4 letters or digits, stored upper-case. "CN" is reserved for credit notes. */
export const InvoicePrefix = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9]{0,4}$/, "Use up to 4 letters or digits")
  .refine((v) => v !== "CN", "CN is kept for credit notes; choose another prefix");

/** Indian financial year (1 April to 31 March) of a timestamp, in local time. */
export function financialYear(ms: number): { key: string; short: string } {
  const d = new Date(ms);
  const start = d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1;
  const a = String(start % 100).padStart(2, "0");
  const b = String((start + 1) % 100).padStart(2, "0");
  return { key: `${start}-${b}`, short: `${a}-${b}` };
}

function checkCounter(n: number): void {
  if (n > INVOICE_COUNTER_MAX) {
    throw new Error(`Invoice counter exceeded ${INVOICE_COUNTER_MAX.toLocaleString("en-US")} for this financial year`);
  }
}

export function formatInvoiceNo(prefix: string, fyShort: string, n: number): string {
  checkCounter(n);
  const head = prefix ? `${prefix}/${fyShort}` : fyShort;
  return `${head}/${String(n).padStart(4, "0")}`;
}

export function formatCreditNoteNo(fyShort: string, n: number): string {
  checkCounter(n);
  return `CN/${fyShort}/${String(n).padStart(3, "0")}`;
}

/** Call inside the caller's transaction, like nextSequence. The counter is per financial year and ignores the prefix. */
export function nextInvoiceNo(db: Database, prefix: string, ms: number): string {
  const fy = financialYear(ms);
  return formatInvoiceNo(prefix, fy.short, nextSequence(db, `invoice:${fy.key}`));
}

export function nextCreditNoteNo(db: Database, ms: number): string {
  const fy = financialYear(ms);
  return formatCreditNoteNo(fy.short, nextSequence(db, `credit_note:${fy.key}`));
}

/** Splits at the last "/": "MP/25-26/0007" gives series "MP/25-26" and n 7. A legacy "12" has no series. */
export function invoiceSeries(no: string): { series: string; n: number } {
  const i = no.lastIndexOf("/");
  return { series: i < 0 ? "" : no.slice(0, i), n: Number(no.slice(i + 1)) };
}

export function invoiceFileName(no: string): string {
  return `Bill-${no.replace(/\//g, "-")}.html`;
}
