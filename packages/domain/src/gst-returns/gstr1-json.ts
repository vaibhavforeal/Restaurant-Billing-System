import { gstDate } from "./period.js";
import type { Gstr1Summary, HsnLine } from "./gstr1.js";
import type { RateLine } from "./facts.js";

/**
 * GSTR-1 as the JSON the GST offline tool and portal import, using the GSTN "Save GSTR-1" field names (API v4.x, with the
 * Table 12 split into hsn_b2b and hsn_b2c from 2025). Amounts are in rupees, dates DD-MM-YYYY. Empty sections are left out.
 * Every supply is intra-state (CGST + SGST): restaurant service is supplied where the restaurant is.
 */
export interface Gstr1JsonHeader {
  gstin: string;
  /** MMYYYY of the return period's last month. */
  fp: string;
  /** The restaurant's state code: the place of supply of every bill. */
  stateCode: string;
  /** Zomato's GSTIN for Table 14; empty leaves Table 14 out. */
  ecoGstin: string;
}

/** The GST rate on supplies through an e-commerce operator that pays the tax under section 9(5) (restaurant service). */
export const ECO_95_RATE = 5;

export const rupees = (paise: number) => paise / 100;
/** Item numbers as the offline tool writes them: rate × 100 + 1 (e.g. 501 for 5%). */
const itemNo = (rate: number) => Math.round(rate * 100) + 1;
const itemDetail = (l: RateLine) => ({ rt: l.gstRate, txval: rupees(l.taxablePaise), iamt: 0, camt: rupees(l.cgstPaise), samt: rupees(l.sgstPaise), csamt: 0 });
const items = (lines: RateLine[]) => lines.map((l) => ({ num: itemNo(l.gstRate), itm_det: itemDetail(l) }));
const hsn = (rows: HsnLine[]) => rows.map((r, i) => ({
  num: i + 1, hsn_sc: r.sac, user_desc: "Restaurant service", uqc: "NA", qty: 0, rt: r.gstRate,
  txval: rupees(r.taxablePaise), iamt: 0, camt: rupees(r.cgstPaise), samt: rupees(r.sgstPaise), csamt: 0,
}));

export function gstr1Json(s: Gstr1Summary, h: Gstr1JsonHeader): Record<string, unknown> {
  const pos = h.stateCode;
  const out: Record<string, unknown> = { gstin: h.gstin, fp: h.fp };
  if (s.b2b.length) out.b2b = s.b2b.map((g) => ({
    ctin: g.ctin,
    inv: g.invoices.map((i) => ({ inum: String(i.billNo), idt: gstDate(i.dateKey), val: rupees(i.valuePaise), pos, rchrg: "N", inv_typ: "R", itms: items(i.items) })),
  }));
  if (s.b2cs.length) out.b2cs = s.b2cs.map((l) => ({ sply_ty: "INTRA", pos, typ: "OE", rt: l.gstRate, txval: rupees(l.taxablePaise), iamt: 0, camt: rupees(l.cgstPaise), samt: rupees(l.sgstPaise), csamt: 0 }));
  if (s.cdnr.length) out.cdnr = s.cdnr.map((g) => ({
    ctin: g.ctin,
    nt: g.notes.map((n) => ({ ntty: "C", nt_num: `CN-${n.cnNo}`, nt_dt: gstDate(n.dateKey), val: rupees(n.valuePaise), pos, rchrg: "N", inv_typ: "R", itms: items(n.items) })),
  }));
  const nil = [
    ...(s.nil.b2bPaise ? [{ sply_ty: "INTRAB2B", nil_amt: rupees(s.nil.b2bPaise), expt_amt: 0, ngsup_amt: 0 }] : []),
    ...(s.nil.b2cPaise ? [{ sply_ty: "INTRAB2C", nil_amt: rupees(s.nil.b2cPaise), expt_amt: 0, ngsup_amt: 0 }] : []),
  ];
  if (nil.length) out.nil = { inv: nil };
  if (s.hsn.b2b.length || s.hsn.b2c.length) out.hsn = { ...(s.hsn.b2b.length ? { hsn_b2b: hsn(s.hsn.b2b) } : {}), ...(s.hsn.b2c.length ? { hsn_b2c: hsn(s.hsn.b2c) } : {}) };
  const docs = [
    ...(s.docs.invoices ? [{ doc_num: 1, docs: [{ num: 1, from: String(s.docs.invoices.from), to: String(s.docs.invoices.to), totnum: s.docs.invoices.total, cancel: s.docs.invoices.cancelled, net_issue: s.docs.invoices.total - s.docs.invoices.cancelled }] }] : []),
    ...(s.docs.creditNotes ? [{ doc_num: 5, docs: [{ num: 1, from: `CN-${s.docs.creditNotes.from}`, to: `CN-${s.docs.creditNotes.to}`, totnum: s.docs.creditNotes.total, cancel: 0, net_issue: s.docs.creditNotes.total }] }] : []),
  ];
  if (docs.length) out.doc_issue = { doc_det: docs };
  if (h.ecoGstin && s.eco95.valuePaise) {
    const half = Math.round(s.eco95.valuePaise * ECO_95_RATE / 200);
    out.supeco = { paytx: [{ etin: h.ecoGstin, suppval: rupees(s.eco95.valuePaise), igst: 0, cgst: rupees(half), sgst: rupees(half), cess: 0, flag: "N" }] };
  }
  return out;
}
