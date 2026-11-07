import type { GstMode } from "../gst.js";

/**
 * How a bill is reported, read from the bill's own snapshot so a later change of settings never re-labels an issued bill:
 * - regular: a tax invoice from a GST-registered restaurant (GSTR-1)
 * - composition: a bill of supply from a composition restaurant (CMP-08)
 * - eco95: a Zomato order, where Zomato pays the GST under section 9(5) (GSTR-1 Table 14, GSTR-3B 3.1.1(ii))
 * - unregistered: the restaurant had no GSTIN; outside GST returns
 */
export type BillSupply = "regular" | "composition" | "eco95" | "unregistered";

export function billSupply(r: { gstMode: GstMode; gstPaidBy?: "zomato"; gstin: string }): BillSupply {
  if (r.gstPaidBy === "zomato") return "eco95";
  if (!r.gstin.trim()) return "unregistered";
  return r.gstMode === "none" ? "composition" : "regular";
}

export interface RateLine { gstRate: number; taxablePaise: number; cgstPaise: number; sgstPaise: number }
/** A bill issued in the period. */
export interface GstBillFact {
  billId: string; billNo: number; invoiceNo: string; dateKey: string; status: "unpaid" | "paid" | "void"; supply: BillSupply;
  buyerGstin: string | null; buyerName: string | null; totalPaise: number; taxes: RateLine[];
}
/** A credit note (void or refund) issued in the period, with the bill it credits. */
export interface GstCreditNoteFact {
  cnNo: number; creditNoteRef: string; billId: string; billNo: number; invoiceNo: string; kind: "void" | "refund"; dateKey: string; supply: BillSupply;
  buyerGstin: string | null; buyerName: string | null; totalPaise: number; taxes: RateLine[];
}

/**
 * Bills issued and voided within the same period. They are reported as cancelled invoices: left out of every value table, with
 * their credit notes, and counted as cancelled in the documents-issued table. A bill voided in a later period stays issued, and
 * its void is a credit note in that later period.
 */
export function cancelledInPeriod(bills: GstBillFact[], notes: GstCreditNoteFact[]): Set<string> {
  const voided = new Set(notes.filter((n) => n.kind === "void").map((n) => n.billId));
  return new Set(bills.filter((b) => b.status === "void" && voided.has(b.billId)).map((b) => b.billId));
}

/** Adds `lines` (or subtracts them, with sign -1) into per-rate totals. */
export function addRates(into: Map<number, RateLine>, lines: RateLine[], sign = 1): Map<number, RateLine> {
  for (const l of lines) {
    const row = into.get(l.gstRate) ?? { gstRate: l.gstRate, taxablePaise: 0, cgstPaise: 0, sgstPaise: 0 };
    row.taxablePaise += sign * l.taxablePaise; row.cgstPaise += sign * l.cgstPaise; row.sgstPaise += sign * l.sgstPaise;
    into.set(l.gstRate, row);
  }
  return into;
}
export const byRate = (rows: Map<number, RateLine>) => [...rows.values()].sort((a, b) => a.gstRate - b.gstRate);
export const sumRates = (lines: RateLine[]) => lines.reduce((t, l) => ({
  gstRate: 0, taxablePaise: t.taxablePaise + l.taxablePaise, cgstPaise: t.cgstPaise + l.cgstPaise, sgstPaise: t.sgstPaise + l.sgstPaise,
}), { gstRate: 0, taxablePaise: 0, cgstPaise: 0, sgstPaise: 0 });
