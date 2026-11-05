import { addRates, byRate, cancelledInPeriod, type GstBillFact, type GstCreditNoteFact, type RateLine } from "./facts.js";

export interface B2bInvoice { billNo: number; dateKey: string; valuePaise: number; items: RateLine[] }
export interface CreditNoteEntry { cnNo: number; billNo: number; dateKey: string; valuePaise: number; items: RateLine[] }
export interface HsnLine extends RateLine { sac: string }
export interface DocRange { from: number; to: number; total: number; cancelled: number }
export interface Gstr1Summary {
  /** Table 4A: tax invoices to registered buyers, per buyer. */
  b2b: Array<{ ctin: string; buyerName: string; invoices: B2bInvoice[] }>;
  /** Table 7: all other (walk-in) supplies per rate, net of their credit notes. */
  b2cs: RateLine[];
  /** Table 9B: credit notes against B2B invoices, per buyer. */
  cdnr: Array<{ ctin: string; buyerName: string; notes: CreditNoteEntry[] }>;
  /** Table 8: 0% items, net of credit notes. */
  nil: { b2bPaise: number; b2cPaise: number };
  /** Table 12: per SAC and rate, net of credit notes, split by B2B and B2C. */
  hsn: { b2b: HsnLine[]; b2c: HsnLine[] };
  /** Table 13: invoice and credit-note number ranges. */
  docs: { invoices: DocRange | null; creditNotes: DocRange | null };
  /** Table 14: supplies through Zomato, where Zomato pays the GST (section 9(5)). */
  eco95: { valuePaise: number; billCount: number };
  warnings: string[];
}

const hasValue = (l: RateLine) => l.taxablePaise !== 0 || l.cgstPaise !== 0 || l.sgstPaise !== 0;
const taxed = (lines: RateLine[]) => lines.filter((l) => l.gstRate > 0 && hasValue(l));
const nilOf = (lines: RateLine[]) => lines.filter((l) => l.gstRate === 0).reduce((sum, l) => sum + l.taxablePaise, 0);
const rupees = (paise: number) => `₹${(paise / 100).toFixed(2)}`;

function range(numbers: number[], cancelled: number): DocRange | null {
  if (!numbers.length) return null;
  return { from: Math.min(...numbers), to: Math.max(...numbers), total: numbers.length, cancelled };
}

function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) map.set(key(item), [...(map.get(key(item)) ?? []), item]);
  return map;
}

/**
 * GSTR-1 for a regular (tax invoice) restaurant. Only regular bills and their credit notes carry values; Zomato bills go to
 * Table 14. Restaurant service is supplied where the restaurant is (IGST Act s.12(4)), so every supply is intra-state.
 */
export function buildGstr1(input: { sacCode: string; bills: GstBillFact[]; creditNotes: GstCreditNoteFact[] }): Gstr1Summary {
  const cancelled = cancelledInPeriod(input.bills, input.creditNotes);
  const bills = input.bills.filter((b) => b.supply === "regular" && !cancelled.has(b.billId));
  const notes = input.creditNotes.filter((n) => n.supply === "regular" && !cancelled.has(n.billId));
  const warnings: string[] = [];

  const b2bBills = bills.filter((b) => b.buyerGstin);
  const b2cBills = bills.filter((b) => !b.buyerGstin);
  const b2bNotes = notes.filter((n) => n.buyerGstin);
  const b2cNotes = notes.filter((n) => !n.buyerGstin);

  const b2b = [...groupBy(b2bBills.filter((b) => taxed(b.taxes).length), (b) => b.buyerGstin!)].map(([ctin, list]) => ({
    ctin, buyerName: list[0]!.buyerName ?? "",
    invoices: list.sort((a, b) => a.billNo - b.billNo).map((b) => ({ billNo: b.billNo, dateKey: b.dateKey, valuePaise: b.totalPaise, items: taxed(b.taxes) })),
  })).sort((a, b) => a.ctin.localeCompare(b.ctin));
  const cdnr = [...groupBy(b2bNotes.filter((n) => taxed(n.taxes).length), (n) => n.buyerGstin!)].map(([ctin, list]) => ({
    ctin, buyerName: list[0]!.buyerName ?? "",
    notes: list.sort((a, b) => a.cnNo - b.cnNo).map((n) => ({ cnNo: n.cnNo, billNo: n.billNo, dateKey: n.dateKey, valuePaise: n.totalPaise, items: taxed(n.taxes) })),
  })).sort((a, b) => a.ctin.localeCompare(b.ctin));

  const b2cRates = new Map<number, RateLine>();
  for (const b of b2cBills) addRates(b2cRates, b.taxes);
  for (const n of b2cNotes) addRates(b2cRates, n.taxes, -1);
  const b2cs = taxed(byRate(b2cRates));
  for (const row of b2cs) {
    if (row.taxablePaise < 0) warnings.push(`B2C supplies at ${row.gstRate}% are negative (${rupees(row.taxablePaise)}): credit notes this period are more than its sales. Ask your accountant how to report them (usually as an amendment in Table 10, B2CSA).`);
  }

  const b2bRates = new Map<number, RateLine>();
  for (const b of b2bBills) addRates(b2bRates, b.taxes);
  for (const n of b2bNotes) addRates(b2bRates, n.taxes, -1);
  const hsnRows = (rates: Map<number, RateLine>) => byRate(rates).filter(hasValue).map((r) => ({ ...r, sac: input.sacCode }));

  const nil = {
    b2bPaise: b2bBills.reduce((s, b) => s + nilOf(b.taxes), 0) - b2bNotes.reduce((s, n) => s + nilOf(n.taxes), 0),
    b2cPaise: b2cBills.reduce((s, b) => s + nilOf(b.taxes), 0) - b2cNotes.reduce((s, n) => s + nilOf(n.taxes), 0),
  };

  // Every bill and credit note issued in the period is a document, whatever its supply: bills share one numbering series.
  const invoices = range(input.bills.map((b) => b.billNo), cancelled.size);
  if (invoices && invoices.to - invoices.from + 1 !== invoices.total) {
    warnings.push(`${invoices.to - invoices.from + 1 - invoices.total} bill number(s) between ${invoices.from} and ${invoices.to} are not in this period. Check the computer's date was right when they were issued.`);
  }
  const creditNotes = range(input.creditNotes.map((n) => n.cnNo), 0);

  const ecoBills = input.bills.filter((b) => b.supply === "eco95");
  const eco95 = { valuePaise: ecoBills.reduce((s, b) => s + b.taxes.reduce((t, l) => t + l.taxablePaise, 0), 0), billCount: ecoBills.length };

  const other = input.bills.filter((b) => b.supply === "composition" || b.supply === "unregistered").length;
  if (other) warnings.push(`${other} bill(s) in this period were issued without GST (composition, or before the GSTIN was added) and are not in GSTR-1. Check the restaurant's GST settings for this period.`);

  return { b2b, b2cs, cdnr, nil, hsn: { b2b: hsnRows(b2bRates), b2c: hsnRows(b2cRates) }, docs: { invoices, creditNotes }, eco95, warnings };
}
