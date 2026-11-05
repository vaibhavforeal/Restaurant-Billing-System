import type { ReportCell, ReportColumn, ReportTable } from "../operational-reports.js";
import { GST_STATES } from "../restaurant-profile.js";
import { gstinProblem } from "../gstin.js";
import { sumRates, type GstBillFact, type GstCreditNoteFact, type RateLine } from "./facts.js";
import { buildGstr1, type Gstr1Summary } from "./gstr1.js";
import { gstDate, type GstPeriod } from "./period.js";
import { cmp08Summary, gstr3bSummary } from "./summaries.js";

/** What the restaurant files: GSTR-1 and GSTR-3B (regular), CMP-08 (composition), or nothing (no GSTIN). */
export type GstRegime = "regular" | "composition" | "unregistered";

/** The GST returns screen: tables in the shape of the operational reports, so the same renderer and CSV export work. */
export interface GstReturnsReport {
  kind: "gst-returns"; from: string; to: string; today: string; timezone: string; generatedAt: number;
  notes: string[]; tables: ReportTable[];
  regime: GstRegime; period: GstPeriod; gstin: string;
  /** Whether the GSTR-1 JSON file can be downloaded: a regular restaurant with a valid GSTIN. */
  gstr1Available: boolean;
  warnings: string[];
}

export interface GstReturnsInput {
  regime: GstRegime; period: GstPeriod; gstin: string; stateCode: string; sacCode: string; ecoGstin: string;
  bills: GstBillFact[]; creditNotes: GstCreditNoteFact[];
  today: string; timezone: string; generatedAt: number;
}

const money = (key: string, label: string): ReportColumn => ({ key, label, format: "money" });
const text = (key: string, label: string): ReportColumn => ({ key, label });
const TAX_COLUMNS = [money("taxable", "Taxable value"), money("cgst", "CGST"), money("sgst", "SGST")];
const taxCells = (l: Pick<RateLine, "taxablePaise" | "cgstPaise" | "sgstPaise">) => ({ taxable: l.taxablePaise, cgst: l.cgstPaise, sgst: l.sgstPaise });
const rate = (r: number) => `${r}%`;
const totalsOf = (lines: RateLine[], label: Record<string, ReportCell>) => ({ ...label, ...taxCells(sumRates(lines)) });

function regularTables(s: Gstr1Summary, input: GstReturnsInput): ReportTable[] {
  const pos = `${input.stateCode}-${GST_STATES[input.stateCode] ?? ""}`;
  const g3b = gstr3bSummary(s);
  const b2bLines = s.b2b.flatMap((g) => g.invoices.flatMap((i) => i.items.map((l) => ({ g, i, l }))));
  const cdnrLines = s.cdnr.flatMap((g) => g.notes.flatMap((n) => n.items.map((l) => ({ g, n, l }))));
  const hsnTable = (title: string, rows: Gstr1Summary["hsn"]["b2b"]): ReportTable => ({
    title, columns: [text("sac", "SAC"), text("description", "Description"), text("uqc", "UQC"), text("rate", "Rate"), ...TAX_COLUMNS],
    rows: rows.map((r) => ({ sac: r.sac, description: "Restaurant service", uqc: "NA", rate: rate(r.gstRate), ...taxCells(r) })),
    totals: totalsOf(rows, { sac: "Total" }),
  });
  const doc = (label: string, ranges: Gstr1Summary["docs"]["invoices"]) => ranges.map((r) => ({
    document: label, from: r.from, to: r.to, total: r.total, cancelled: r.cancelled, net: r.total - r.cancelled,
  }));
  return [
    { title: "GSTR-3B Table 3.1: outward supplies", columns: [text("section", "Table"), text("description", "Nature of supplies"), ...TAX_COLUMNS], rows: [
      { section: "3.1(a)", description: "Outward taxable supplies (other than zero rated, nil rated and exempted)", ...taxCells(g3b.outwardTaxable) },
      { section: "3.1(c)", description: "Other outward supplies (nil rated, exempted)", taxable: g3b.nilPaise, cgst: 0, sgst: 0 },
      { section: "3.1.1(ii)", description: "Supplies through an e-commerce operator that pays the tax under section 9(5) (Zomato)", taxable: g3b.eco95Paise, cgst: null, sgst: null },
    ] },
    { title: "GSTR-1 Table 4A: B2B invoices", columns: [text("ctin", "Buyer GSTIN"), text("buyer", "Buyer"), text("invoice", "Bill no."), text("date", "Date"),
      money("value", "Bill value"), text("pos", "Place of supply"), text("rate", "Rate"), ...TAX_COLUMNS],
      rows: b2bLines.map(({ g, i, l }) => ({ ctin: g.ctin, buyer: g.buyerName, invoice: i.invoiceNo, date: gstDate(i.dateKey), value: i.valuePaise, pos, rate: rate(l.gstRate), ...taxCells(l) })),
      totals: totalsOf(b2bLines.map((x) => x.l), { ctin: "Total" }) },
    { title: "GSTR-1 Table 7: B2C (others)", columns: [text("pos", "Place of supply"), text("type", "Type"), text("rate", "Rate"), ...TAX_COLUMNS],
      rows: s.b2cs.map((l) => ({ pos, type: "OE", rate: rate(l.gstRate), ...taxCells(l) })), totals: totalsOf(s.b2cs, { pos: "Total" }) },
    { title: "GSTR-1 Table 8: nil rated supplies", columns: [text("supply", "Supply"), money("nil", "Nil rated value")], rows: [
      { supply: "Intra-state supplies to registered persons", nil: s.nil.b2bPaise },
      { supply: "Intra-state supplies to unregistered persons", nil: s.nil.b2cPaise },
    ] },
    { title: "GSTR-1 Table 9B: credit notes to registered buyers", columns: [text("ctin", "Buyer GSTIN"), text("buyer", "Buyer"), text("note", "Credit note"),
      text("bill", "Against bill"), text("date", "Date"), money("value", "Note value"), text("rate", "Rate"), ...TAX_COLUMNS],
      rows: cdnrLines.map(({ g, n, l }) => ({ ctin: g.ctin, buyer: g.buyerName, note: n.creditNoteRef, bill: n.invoiceNo, date: gstDate(n.dateKey), value: n.valuePaise, rate: rate(l.gstRate), ...taxCells(l) })),
      totals: totalsOf(cdnrLines.map((x) => x.l), { ctin: "Total" }) },
    hsnTable("GSTR-1 Table 12: HSN/SAC summary, B2B", s.hsn.b2b),
    hsnTable("GSTR-1 Table 12: HSN/SAC summary, B2C", s.hsn.b2c),
    { title: "GSTR-1 Table 13: documents issued", columns: [text("document", "Document"), text("from", "From"), text("to", "To"),
      { key: "total", label: "Total", format: "quantity" }, { key: "cancelled", label: "Cancelled", format: "quantity" }, { key: "net", label: "Net issued", format: "quantity" }],
      rows: [...doc("Invoices for outward supply", s.docs.invoices), ...doc("Credit notes", s.docs.creditNotes)] },
    { title: "GSTR-1 Table 14: supplies through Zomato (GST paid by Zomato, section 9(5))", columns: [text("eco", "Zomato GSTIN"),
      { key: "bills", label: "Bills", format: "quantity" }, money("value", "Value of supplies")],
      rows: s.eco95.billCount ? [{ eco: input.ecoGstin || "Not set: add it in Settings", bills: s.eco95.billCount, value: s.eco95.valuePaise }] : [] },
  ];
}

function compositionTables(input: GstReturnsInput): { tables: ReportTable[]; notes: string[] } {
  const c = cmp08Summary(input.bills, input.creditNotes, input.period.months);
  const columns = [text("month", "Month"), money("turnover", "Turnover"), money("credit", "Credit notes"), money("net", "Net turnover"),
    money("cgst", "CGST 2.5%"), money("sgst", "SGST 2.5%")];
  const row = (label: string, r: typeof c.total) => ({ month: label, turnover: r.turnoverPaise, credit: r.creditPaise, net: r.netPaise, cgst: r.cgstPaise, sgst: r.sgstPaise });
  return {
    tables: [
      { title: "CMP-08: composition tax on turnover", columns, rows: c.months.map((m) => row(m.month, m)), totals: row("Total", c.total) },
      { title: "Supplies through Zomato (GST paid by Zomato, section 9(5))", columns: [text("supply", "Supply"), money("value", "Value")],
        rows: c.eco95Paise ? [{ supply: "Zomato orders", value: c.eco95Paise }] : [] },
    ],
    notes: [
      `${c.billCount} bills of supply${c.cancelledCount ? `; ${c.cancelledCount} bills issued and voided in this period are left out` : ""}.`,
      "Composition tax for a restaurant is 5% of turnover: 2.5% CGST and 2.5% SGST, worked out on the period's total net turnover.",
      "Composition restaurants file CMP-08 every quarter and GSTR-4 once a year; GSTR-1 does not apply.",
    ],
  };
}

export function gstReturnsReport(input: GstReturnsInput): GstReturnsReport {
  const base = { kind: "gst-returns" as const, from: input.period.from, to: input.period.to, today: input.today, timezone: input.timezone,
    generatedAt: input.generatedAt, regime: input.regime, period: input.period, gstin: input.gstin };
  if (input.regime === "unregistered") {
    return { ...base, gstr1Available: false, warnings: [], tables: [],
      notes: ["The restaurant has no GSTIN, so it files no GST returns. Add the GSTIN in Settings once the restaurant is registered."] };
  }
  if (input.regime === "composition") return { ...base, gstr1Available: false, warnings: [], ...compositionTables(input) };
  const summary = buildGstr1({ sacCode: input.sacCode, bills: input.bills, creditNotes: input.creditNotes });
  const gstinIssue = gstinProblem(input.gstin);
  const warnings = [
    ...(gstinIssue ? [`The restaurant's GSTIN ${input.gstin}: ${gstinIssue} Fix it in Settings before downloading the GSTR-1 file.`] : []),
    ...(summary.eco95.billCount && !input.ecoGstin ? ["There are Zomato orders this period. Add Zomato's GSTIN in Settings so they are included in the GSTR-1 file (Table 14)."] : []),
    ...summary.warnings,
  ];
  return { ...base, gstr1Available: !gstinIssue, warnings, tables: regularTables(summary, input), notes: [
    "Bills count on the day they were issued; credit notes (voids and refunds) on the day they were issued.",
    "A bill issued and voided in the same period is a cancelled invoice: it has no value here and is counted as cancelled in Table 13. A bill voided in a later period is a credit note in that period.",
    "Walk-in credit notes are subtracted from Table 7. Credit notes against business (GSTIN) bills are listed in Table 9B.",
    "Restaurant service is supplied where the restaurant is, so every bill is intra-state: CGST and SGST, never IGST.",
    "GSTR-3B input tax credit, reverse charge purchases and amendments are not covered: the POS does not record purchases.",
  ] };
}
