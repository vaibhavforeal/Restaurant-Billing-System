import { describe, expect, it } from "vitest";
import { buildGstr1 } from "./gstr1.js";
import { gstr1Json } from "./gstr1-json.js";
import { gstReturnsReport } from "./report.js";
import { gstPeriod } from "./period.js";
import { billSupply, cancelledInPeriod, sumRates, type GstBillFact, type GstCreditNoteFact, type RateLine } from "./facts.js";

const ACME = "29AABCU9603R1ZJ";
/** ₹105 at 5%: taxable 10000, CGST 250, SGST 250. */
const five = (n = 1): RateLine => ({ gstRate: 5, taxablePaise: 10000 * n, cgstPaise: 250 * n, sgstPaise: 250 * n });
const eighteen: RateLine = { gstRate: 18, taxablePaise: 10000, cgstPaise: 900, sgstPaise: 900 };
const nil: RateLine = { gstRate: 0, taxablePaise: 2000, cgstPaise: 0, sgstPaise: 0 };
const total = (taxes: RateLine[]) => taxes.reduce((s, t) => s + t.taxablePaise + t.cgstPaise + t.sgstPaise, 0);

let no = 0;
function bill(over: Partial<GstBillFact> & { taxes?: RateLine[] } = {}): GstBillFact {
  const taxes = over.taxes ?? [five()];
  no++;
  return { billId: `b${no}`, billNo: no, invoiceNo: String(no), dateKey: "2026-10-05", status: "paid", supply: "regular", buyerGstin: null, buyerName: null, totalPaise: total(taxes), ...over, taxes };
}
let cn = 0;
function note(of: GstBillFact, over: Partial<GstCreditNoteFact> = {}): GstCreditNoteFact {
  const taxes = over.taxes ?? of.taxes;
  return { cnNo: ++cn, creditNoteRef: `CN-${cn}`, billId: of.billId, billNo: of.billNo, invoiceNo: of.invoiceNo, kind: "refund", dateKey: "2026-10-06", supply: of.supply,
    buyerGstin: of.buyerGstin, buyerName: of.buyerName, totalPaise: total(taxes), ...over, taxes };
}
const build = (bills: GstBillFact[], creditNotes: GstCreditNoteFact[] = []) => buildGstr1({ sacCode: "996331", bills, creditNotes });

describe("billSupply", () => {
  it("reads the bill's own snapshot", () => {
    expect(billSupply({ gstMode: "included", gstin: ACME })).toBe("regular");
    expect(billSupply({ gstMode: "none", gstin: ACME })).toBe("composition");
    expect(billSupply({ gstMode: "included", gstin: "" })).toBe("unregistered");
    expect(billSupply({ gstMode: "exclusive", gstin: ACME })).toBe("regular");
    expect(billSupply({ gstMode: "exclusive", gstin: "" })).toBe("unregistered");
    expect(billSupply({ gstMode: "none", gstin: ACME, gstPaidBy: "zomato" })).toBe("eco95");
  });
});

describe("buildGstr1", () => {
  it("puts walk-in bills in B2CS per rate and business bills in B2B per invoice", () => {
    const s = build([
      bill(), bill({ taxes: [five(2), eighteen] }),
      bill({ buyerGstin: ACME, buyerName: "Acme", taxes: [five(), nil] }),
    ]);
    expect(s.b2cs).toEqual([five(3), eighteen]);
    expect(s.b2b).toEqual([{ ctin: ACME, buyerName: "Acme", invoices: [{ billNo: 3, invoiceNo: "3", dateKey: "2026-10-05", valuePaise: 12500, items: [five()] }] }]);
    expect(s.nil).toEqual({ b2bPaise: 2000, b2cPaise: 0 });
    expect(s.hsn.b2c).toEqual([{ ...five(3), sac: "996331" }, { ...eighteen, sac: "996331" }]);
    expect(s.hsn.b2b).toEqual([{ ...nil, sac: "996331" }, { ...five(), sac: "996331" }]);
    expect(s.docs.invoices).toEqual([{ from: "1", to: "3", total: 3, cancelled: 0 }]);
    expect(s.warnings).toEqual([]);
  });

  it("nets a walk-in refund into B2CS and lists a business refund in CDNR", () => {
    const walkIn = bill({ taxes: [five(3)] });
    const business = bill({ buyerGstin: ACME, buyerName: "Acme", taxes: [five(2)] });
    const s = build([walkIn, business], [note(walkIn, { taxes: [five()] }), note(business, { taxes: [five()] })]);
    expect(s.b2cs).toEqual([five(2)]);
    expect(s.cdnr).toEqual([{ ctin: ACME, buyerName: "Acme", notes: [{ cnNo: cn, creditNoteRef: `CN-${cn}`, billNo: business.billNo, invoiceNo: String(business.billNo), dateKey: "2026-10-06", valuePaise: 10500, items: [five()] }] }]);
    expect(s.hsn.b2b).toEqual([{ ...five(), sac: "996331" }]);
    expect(s.docs.creditNotes).toEqual([{ from: `CN-${cn - 1}`, to: `CN-${cn}`, total: 2, cancelled: 0 }]);
  });

  it("reports a bill voided in the same period as a cancelled invoice, with no values", () => {
    const kept = bill();
    const voided = bill({ status: "void", buyerGstin: ACME, buyerName: "Acme" });
    const s = build([kept, voided], [note(voided, { kind: "void" })]);
    expect(cancelledInPeriod([kept, voided], [note(voided, { kind: "void" })])).toEqual(new Set([voided.billId]));
    expect(s.b2b).toEqual([]);
    expect(s.cdnr).toEqual([]);
    expect(s.b2cs).toEqual([five()]);
    expect(s.docs.invoices).toMatchObject([{ total: 2, cancelled: 1 }]);
    expect(s.docs.creditNotes).toMatchObject([{ total: 1 }]);
  });

  it("treats a void of an earlier period's bill as a credit note", () => {
    const earlier = bill();
    const current = bill();
    const s = build([current], [note(earlier, { kind: "void" })]);
    // The current bill and the earlier bill's void cancel out at 5%.
    expect(s.b2cs).toEqual([]);
    expect(s.docs.invoices).toMatchObject([{ total: 1, cancelled: 0 }]);
  });

  it("warns when credit notes make a rate negative", () => {
    const old = bill({ taxes: [five(2)] });
    const s = build([bill()], [note(old)]);
    expect(s.b2cs).toEqual([five(-1)]);
    expect(s.warnings[0]).toMatch(/negative/);
  });

  it("keeps Zomato bills out of the value tables and totals them for Table 14", () => {
    const zomato = bill({ supply: "eco95", taxes: [{ gstRate: 5, taxablePaise: 40000, cgstPaise: 0, sgstPaise: 0 }] });
    const s = build([bill(), zomato]);
    expect(s.b2cs).toEqual([five()]);
    expect(s.eco95).toEqual({ valuePaise: 40000, billCount: 1 });
    expect(s.docs.invoices).toMatchObject([{ total: 2 }]);
  });

  it("warns about bills without GST and gaps in the bill numbers", () => {
    const first = bill();
    bill(); // issued in another period
    const s = build([first, bill({ supply: "composition" })]);
    expect(s.warnings.join(" ")).toMatch(/1 bill number/);
    expect(s.warnings.join(" ")).toMatch(/without GST/);
  });

  it("balances: B2B + B2CS + nil - CDNR equals the regular bills less their credit notes", () => {
    const bills = [bill({ taxes: [five(2), nil] }), bill({ buyerGstin: ACME, buyerName: "Acme", taxes: [eighteen, nil] }), bill({ taxes: [eighteen] })];
    const notes = [note(bills[0]!, { taxes: [five()] }), note(bills[1]!, { taxes: [nil] })];
    const s = build(bills, notes);
    const reported = s.b2b.flatMap((g) => g.invoices.flatMap((i) => i.items)).reduce((t, l) => t + l.taxablePaise, 0)
      + s.b2cs.reduce((t, l) => t + l.taxablePaise, 0) + s.nil.b2bPaise + s.nil.b2cPaise
      - s.cdnr.flatMap((g) => g.notes.flatMap((n) => n.items)).reduce((t, l) => t + l.taxablePaise, 0);
    const expected = sumRates(bills.flatMap((b) => b.taxes)).taxablePaise - sumRates(notes.flatMap((n) => n.taxes)).taxablePaise;
    expect(reported).toBe(expected);
    const hsn = [...s.hsn.b2b, ...s.hsn.b2c].reduce((t, l) => t + l.taxablePaise, 0);
    expect(hsn).toBe(expected);
  });
});

describe("invoice numbers and series", () => {
  const inv = (invoiceNo: string, over: Partial<GstBillFact> = {}) => bill({ invoiceNo, ...over });
  const cnote = (of: GstBillFact, creditNoteRef: string, over: Partial<GstCreditNoteFact> = {}) => note(of, { creditNoteRef, ...over });

  it("reports one range per series, sorted, counting cancelled invoices", () => {
    const a = inv("MP/25-26/0001");
    const b = inv("MP/25-26/0002", { status: "void" });
    const c = inv("MP/25-26/0003");
    const x = inv("X1/25-26/0004");
    const s = build([x, c, b, a], [cnote(b, "CN/25-26/001", { kind: "void" })]);
    expect(s.docs.invoices).toEqual([
      { from: "MP/25-26/0001", to: "MP/25-26/0003", total: 3, cancelled: 1 },
      { from: "X1/25-26/0004", to: "X1/25-26/0004", total: 1, cancelled: 0 },
    ]);
    expect(s.warnings).toEqual([]);
  });

  it("keeps a legacy number in its own range", () => {
    const s = build([inv("MP/25-26/0001"), inv("12")]);
    expect(s.docs.invoices).toEqual([
      { from: "12", to: "12", total: 1, cancelled: 0 },
      { from: "MP/25-26/0001", to: "MP/25-26/0001", total: 1, cancelled: 0 },
    ]);
  });

  it("warns about a real gap in the yearly counter, naming its ends", () => {
    const s = build([inv("MP/25-26/0001"), inv("MP/25-26/0004"), inv("X1/25-26/0005")]);
    expect(s.warnings).toHaveLength(1);
    expect(s.warnings[0]).toContain("2 bill number(s)");
    expect(s.warnings[0]).toContain("MP/25-26/0001");
    expect(s.warnings[0]).toContain("X1/25-26/0005");
  });

  it("does not warn when a prefix is switched and switched back within a year", () => {
    const s = build([inv("MP/25-26/0001"), inv("MP/25-26/0002"), inv("MP/25-26/0003"), inv("X1/25-26/0004"), inv("MP/25-26/0005"), inv("MP/25-26/0006")]);
    expect(s.docs.invoices).toEqual([
      { from: "MP/25-26/0001", to: "MP/25-26/0006", total: 5, cancelled: 0 },
      { from: "X1/25-26/0004", to: "X1/25-26/0004", total: 1, cancelled: 0 },
    ]);
    expect(s.warnings).toEqual([]);
  });

  it("ranges credit notes by series, and orders a legacy CN-n note by its number", () => {
    const base = inv("MP/25-26/0001");
    const s = build([base], [cnote(base, "CN/25-26/001"), cnote(base, "CN/25-26/002"), cnote(base, "CN-9", { cnNo: 9 }), cnote(base, "CN-10", { cnNo: 10 })]);
    expect(s.docs.creditNotes).toEqual([
      { from: "CN-9", to: "CN-10", total: 2, cancelled: 0 },
      { from: "CN/25-26/001", to: "CN/25-26/002", total: 2, cancelled: 0 },
    ]);
    expect(s.warnings.join(" ")).not.toMatch(/bill number/);
  });

  it("writes the stored numbers into the JSON and the report", () => {
    const a = inv("MP/25-26/0001", { buyerGstin: ACME, buyerName: "Acme" });
    const b = inv("X1/25-26/0002");
    const s = build([a, b], [cnote(a, "CN/25-26/001"), cnote(a, "CN/25-26/002")]);
    const json = gstr1Json(s, { gstin: ACME, fp: "102026", stateCode: "29", ecoGstin: "" }) as any;
    expect(json.b2b[0].inv[0].inum).toBe("MP/25-26/0001");
    expect(json.cdnr[0].nt.map((n: any) => n.nt_num)).toEqual(["CN/25-26/001", "CN/25-26/002"]);
    expect(json.doc_issue.doc_det[0].doc_num).toBe(1);
    expect(json.doc_issue.doc_det[0].docs.map((d: any) => d.num)).toEqual([1, 2]);
    expect(json.doc_issue.doc_det[0].docs[0]).toMatchObject({ from: "MP/25-26/0001", to: "MP/25-26/0001", totnum: 1 });
    expect(json.doc_issue.doc_det[1]).toMatchObject({ doc_num: 5, docs: [{ num: 1, from: "CN/25-26/001", to: "CN/25-26/002", totnum: 2 }] });

    const report = gstReturnsReport({ regime: "regular", period: gstPeriod("2026-10", "month")!, gstin: ACME, stateCode: "29", sacCode: "996331", ecoGstin: "",
      bills: [a, b], creditNotes: [cnote(a, "CN/25-26/003")], today: "2026-10-31", timezone: "Asia/Kolkata", generatedAt: 0 });
    const t = (part: string) => report.tables.find((x) => x.title.includes(part))!;
    expect(t("Table 4A").rows[0]).toMatchObject({ invoice: "MP/25-26/0001" });
    expect(t("Table 9B").rows[0]).toMatchObject({ note: "CN/25-26/003", bill: "MP/25-26/0001" });
    expect(t("Table 13").rows.map((r) => r.from)).toEqual(["MP/25-26/0001", "X1/25-26/0002", "CN/25-26/003"]);
  });
});
