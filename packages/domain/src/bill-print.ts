import { z } from "zod";
import type { ReceiptSnapshot } from "./billing.js";

/** Which optional lines a bill prints. GSTIN is never hideable, so it has no toggle. */
export interface BillShow { fssai: boolean; customer: boolean; table: boolean; servedBy: boolean; itemGst: boolean }

export const DEFAULT_BILL_SHOW: BillShow = { fssai: true, customer: true, table: true, servedBy: false, itemGst: false };

export const BILL_TEXT_MAX_LINES = 3;
export const BILL_TEXT_MAX_CHARS = 48;

/** The printable lines of a header or footer: each trimmed, blank lines dropped. */
export function billTextLines(text: string): string[] {
  return text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== "");
}

export const BillTextLines = z.string().trim().refine((value) => {
  const lines = billTextLines(value);
  return lines.length <= BILL_TEXT_MAX_LINES && lines.every((line) => line.length <= BILL_TEXT_MAX_CHARS);
}, `Use up to ${BILL_TEXT_MAX_LINES} lines of ${BILL_TEXT_MAX_CHARS} characters each`);

/** A snapshot's toggles; bills issued before Bill settings fall back to the defaults. */
export function billShowOf(r: Pick<ReceiptSnapshot, "billShow">): BillShow {
  return { ...DEFAULT_BILL_SHOW, ...r.billShow };
}
