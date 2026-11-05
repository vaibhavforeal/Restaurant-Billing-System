import { describe, expect, it } from "vitest";
import { buildGstr1, cmp08Summary, gstPeriod, gstr1Json, gstr3bSummary, gstReturnsReport, type GstBillFact, type GstCreditNoteFact, type RateLine } from "./index.js";

const OWN = "29AAPFU0939F1ZR";
const ACME = "29AABCU9603R1ZJ";
const ZOMATO = "27AABCU9603R1ZN";
const five = (n = 1): RateLine => ({ gstRate: 5, taxablePaise: 10000 * n, cgstPaise: 250 * n, sgstPaise: 250 * n });
const total = (taxes: RateLine[]) => taxes.reduce((s, t) => s + t.taxablePaise + t.cgstPaise + t.sgstPaise, 0);
const bill = (billNo: number, over: Partial<GstBillFact> = {}): GstBillFact => {
  const taxes = over.taxes ?? [five()];
  return { billId: `b${billNo}`, billNo, dateKey: "2026-10-05", status: "paid", supply: "regular", buyerGstin: null, buyerName: null, totalPaise: total(taxes), ...over, taxes };
};
const note = (cnNo: number, of: GstBillFact, over: Partial<GstCreditNoteFact> = {}): GstCreditNoteFact => {
  const taxes = over.taxes ?? of.taxes;
  return { cnNo, billId: of.billId, billNo: of.billNo, kind: "refund", dateKey: "2026-10-20", supply: of.supply, buyerGstin: of.buyerGstin,
    buyerName: of.buyerName, totalPaise: total(taxes), ...over, taxes };
};

describe("gstr1Json", () => {
  it("writes the GSTN field names, rupees and DD-MM-YYYY dates", () => {
    const business = bill(2, { buyerGstin: ACME, buyerName: "Acme", taxes: [five(2), { gstRate: 0, taxablePaise: 5000, cgstPaise: 0, sgstPaise: 0 }] });
    const bills = [bill(1), business, bill(3, { status: "void" }), bill(4, { supply: "eco95", taxes: [{ gstRate: 5, taxablePaise: 20000, cgstPaise: 0, sgstPaise: 0 }] })];
    const notes = [note(1, bills[2]!, { kind: "void" }), note(2, business, { taxes: [five()] })];
    const json = gstr1Json(buildGstr1({ sacCode: "996331", bills, creditNotes: notes }), { gstin: OWN, fp: "102026", stateCode: "29", ecoGstin: ZOMATO });
    expect(json).toEqual({
      gstin: OWN, fp: "102026",
      b2b: [{ ctin: ACME, inv: [{ inum: "2", idt: "05-10-2026", val: 260, pos: "29", rchrg: "N", inv_typ: "R",
        itms: [{ num: 501, itm_det: { rt: 5, txval: 200, iamt: 0, camt: 5, samt: 5, csamt: 0 } }] }] }],
      b2cs: [{ sply_ty: "INTRA", pos: "29", typ: "OE", rt: 5, txval: 100, iamt: 0, camt: 2.5, samt: 2.5, csamt: 0 }],
      cdnr: [{ ctin: ACME, nt: [{ ntty: "C", nt_num: "CN-2", nt_dt: "20-10-2026", val: 105, pos: "29", rchrg: "N", inv_typ: "R",
        itms: [{ num: 501, itm_det: { rt: 5, txval: 100, iamt: 0, camt: 2.5, samt: 2.5, csamt: 0 } }] }] }],
      nil: { inv: [{ sply_ty: "INTRAB2B", nil_amt: 50, expt_amt: 0, ngsup_amt: 0 }] },
      hsn: {
        hsn_b2b: [
          { num: 1, hsn_sc: "996331", user_desc: "Restaurant service", uqc: "NA", qty: 0, rt: 0, txval: 50, iamt: 0, camt: 0, samt: 0, csamt: 0 },
          { num: 2, hsn_sc: "996331", user_desc: "Restaurant service", uqc: "NA", qty: 0, rt: 5, txval: 100, iamt: 0, camt: 2.5, samt: 2.5, csamt: 0 },
        ],
        hsn_b2c: [{ num: 1, hsn_sc: "996331", user_desc: "Restaurant service", uqc: "NA", qty: 0, rt: 5, txval: 100, iamt: 0, camt: 2.5, samt: 2.5, csamt: 0 }],
      },
      doc_issue: { doc_det: [
        { doc_num: 1, docs: [{ num: 1, from: "1", to: "4", totnum: 4, cancel: 1, net_issue: 3 }] },
        { doc_num: 5, docs: [{ num: 1, from: "CN-1", to: "CN-2", totnum: 2, cancel: 0, net_issue: 2 }] },
      ] },
      supeco: { paytx: [{ etin: ZOMATO, suppval: 200, igst: 0, cgst: 5, sgst: 5, cess: 0, flag: "N" }] },
    });
  });

  it("leaves out empty sections and Table 14 without Zomato's GSTIN", () => {
    const json = gstr1Json(buildGstr1({ sacCode: "996331", bills: [bill(1, { supply: "eco95" })], creditNotes: [] }), { gstin: OWN, fp: "102026", stateCode: "29", ecoGstin: "" });
    expect(Object.keys(json)).toEqual(["gstin", "fp", "doc_issue"]);
  });
});

describe("gstr3bSummary", () => {
  it("adds B2B and B2C sales, less registered credit notes", () => {
    const business = bill(2, { buyerGstin: ACME, buyerName: "Acme", taxes: [five(2)] });
    const s = buildGstr1({ sacCode: "996331", bills: [bill(1), business, bill(3, { supply: "eco95" })], creditNotes: [note(1, business, { taxes: [five()] })] });
    expect(gstr3bSummary(s)).toEqual({ outwardTaxable: { gstRate: 0, ...{ taxablePaise: 20000, cgstPaise: 500, sgstPaise: 500 } }, nilPaise: 0, eco95Paise: 10000 });
  });
});

describe("cmp08Summary", () => {
  it("charges 2.5% + 2.5% on net turnover by month", () => {
    const flat = (paise: number): RateLine[] => [{ gstRate: 5, taxablePaise: paise, cgstPaise: 0, sgstPaise: 0 }];
    const oct = bill(1, { supply: "composition", taxes: flat(100000) });
    const nov = bill(2, { supply: "composition", dateKey: "2026-11-02", taxes: flat(50000) });
    const c = cmp08Summary([oct, nov, bill(3, { supply: "eco95", taxes: flat(7000) })], [note(1, oct, { taxes: flat(10000) })], ["2026-10", "2026-11", "2026-12"]);
    expect(c.months[0]).toEqual({ month: "2026-10", turnoverPaise: 100000, creditPaise: 10000, netPaise: 90000, cgstPaise: 2250, sgstPaise: 2250 });
    expect(c.total).toEqual({ turnoverPaise: 150000, creditPaise: 10000, netPaise: 140000, cgstPaise: 3500, sgstPaise: 3500 });
    expect(c.eco95Paise).toBe(7000);
  });
});

describe("gstReturnsReport", () => {
  const base = { period: gstPeriod("2026-10", "month"), stateCode: "29", sacCode: "996331", ecoGstin: "", creditNotes: [], today: "2026-11-05", timezone: "Asia/Kolkata", generatedAt: 0 };
  it("shows the GSTR-1 tables for a regular restaurant and offers the JSON", () => {
    const r = gstReturnsReport({ ...base, regime: "regular", gstin: OWN, bills: [bill(1), bill(2, { buyerGstin: ACME, buyerName: "Acme" })] });
    expect(r.gstr1Available).toBe(true);
    expect(r.tables.map((t) => t.title)).toContain("GSTR-1 Table 7: B2C (others)");
    const b2b = r.tables.find((t) => t.title.includes("4A"))!;
    expect(b2b.rows[0]).toMatchObject({ ctin: ACME, invoice: "2", date: "05-10-2026", pos: "29-Karnataka", rate: "5%", taxable: 10000 });
    expect(r.warnings).toEqual([]);
  });
  it("blocks the JSON for a GSTIN that fails the check, and asks for Zomato's GSTIN", () => {
    const r = gstReturnsReport({ ...base, regime: "regular", gstin: "29ABCDE1234F1Z5", bills: [bill(1, { supply: "eco95" })] });
    expect(r.gstr1Available).toBe(false);
    expect(r.warnings.join(" ")).toMatch(/check-character.*Zomato's GSTIN/s);
  });
  it("shows CMP-08 for a composition restaurant and nothing for an unregistered one", () => {
    const composition = gstReturnsReport({ ...base, regime: "composition", gstin: OWN, bills: [bill(1, { supply: "composition" })] });
    expect(composition.gstr1Available).toBe(false);
    expect(composition.tables[0]!.title).toMatch(/CMP-08/);
    const none = gstReturnsReport({ ...base, regime: "unregistered", gstin: "", bills: [] });
    expect(none.tables).toEqual([]);
    expect(none.notes[0]).toMatch(/no GSTIN/);
  });
});
