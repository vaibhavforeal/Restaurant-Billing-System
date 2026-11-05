import { describe, expect, it } from "vitest";
import { buildGstr1 } from "./gstr1.js";
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
  return { billId: `b${no}`, billNo: no, dateKey: "2026-10-05", status: "paid", supply: "regular", buyerGstin: null, buyerName: null, totalPaise: total(taxes), ...over, taxes };
}
let cn = 0;
function note(of: GstBillFact, over: Partial<GstCreditNoteFact> = {}): GstCreditNoteFact {
  const taxes = over.taxes ?? of.taxes;
  return { cnNo: ++cn, billId: of.billId, billNo: of.billNo, kind: "refund", dateKey: "2026-10-06", supply: of.supply,
    buyerGstin: of.buyerGstin, buyerName: of.buyerName, totalPaise: total(taxes), ...over, taxes };
}
const build = (bills: GstBillFact[], creditNotes: GstCreditNoteFact[] = []) => buildGstr1({ sacCode: "996331", bills, creditNotes });

describe("billSupply", () => {
  it("reads the bill's own snapshot", () => {
    expect(billSupply({ gstMode: "included", gstin: ACME })).toBe("regular");
    expect(billSupply({ gstMode: "none", gstin: ACME })).toBe("composition");
    expect(billSupply({ gstMode: "included", gstin: "" })).toBe("unregistered");
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
    expect(s.b2b).toEqual([{ ctin: ACME, buyerName: "Acme", invoices: [{ billNo: 3, dateKey: "2026-10-05", valuePaise: 12500, items: [five()] }] }]);
    expect(s.nil).toEqual({ b2bPaise: 2000, b2cPaise: 0 });
    expect(s.hsn.b2c).toEqual([{ ...five(3), sac: "996331" }, { ...eighteen, sac: "996331" }]);
    expect(s.hsn.b2b).toEqual([{ ...nil, sac: "996331" }, { ...five(), sac: "996331" }]);
    expect(s.docs.invoices).toEqual({ from: 1, to: 3, total: 3, cancelled: 0 });
    expect(s.warnings).toEqual([]);
  });

  it("nets a walk-in refund into B2CS and lists a business refund in CDNR", () => {
    const walkIn = bill({ taxes: [five(3)] });
    const business = bill({ buyerGstin: ACME, buyerName: "Acme", taxes: [five(2)] });
    const s = build([walkIn, business], [note(walkIn, { taxes: [five()] }), note(business, { taxes: [five()] })]);
    expect(s.b2cs).toEqual([five(2)]);
    expect(s.cdnr).toEqual([{ ctin: ACME, buyerName: "Acme", notes: [{ cnNo: cn, billNo: business.billNo, dateKey: "2026-10-06", valuePaise: 10500, items: [five()] }] }]);
    expect(s.hsn.b2b).toEqual([{ ...five(), sac: "996331" }]);
    expect(s.docs.creditNotes).toEqual({ from: cn - 1, to: cn, total: 2, cancelled: 0 });
  });

  it("reports a bill voided in the same period as a cancelled invoice, with no values", () => {
    const kept = bill();
    const voided = bill({ status: "void", buyerGstin: ACME, buyerName: "Acme" });
    const s = build([kept, voided], [note(voided, { kind: "void" })]);
    expect(cancelledInPeriod([kept, voided], [note(voided, { kind: "void" })])).toEqual(new Set([voided.billId]));
    expect(s.b2b).toEqual([]);
    expect(s.cdnr).toEqual([]);
    expect(s.b2cs).toEqual([five()]);
    expect(s.docs.invoices).toMatchObject({ total: 2, cancelled: 1 });
    expect(s.docs.creditNotes).toMatchObject({ total: 1 });
  });

  it("treats a void of an earlier period's bill as a credit note", () => {
    const earlier = bill();
    const current = bill();
    const s = build([current], [note(earlier, { kind: "void" })]);
    // The current bill and the earlier bill's void cancel out at 5%.
    expect(s.b2cs).toEqual([]);
    expect(s.docs.invoices).toMatchObject({ total: 1, cancelled: 0 });
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
    expect(s.docs.invoices).toMatchObject({ total: 2 });
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
