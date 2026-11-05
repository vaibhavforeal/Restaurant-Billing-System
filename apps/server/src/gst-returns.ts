import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { localDateKey, type Database, type GstMode } from "@masalapos/domain";
import {
  billSupply, buildGstr1, gstPeriod, gstr1Json, gstReturnsReport,
  type GstBillFact, type GstCreditNoteFact, type GstPeriod, type GstRegime, type RateLine,
} from "@masalapos/domain/gst-returns";
import { httpError } from "./http-error.js";
import { reportRange } from "./sales-reports.js";

interface Snapshot { gstMode: GstMode | null; gstPaidBy: "zomato" | null; gstin: string | null }
const supplyOf = (s: Snapshot) => billSupply({ gstMode: s.gstMode ?? "included", gstin: s.gstin ?? "", ...(s.gstPaidBy ? { gstPaidBy: s.gstPaidBy } : {}) });

/** The period's bills and credit notes as the GST return builders see them, read on one snapshot. */
export function loadGstFacts(db: Database, bounds: readonly [number, number]): { bills: GstBillFact[]; creditNotes: GstCreditNoteFact[] } {
  return db.transaction(() => {
    const taxesOf = (sql: string) => {
      const map = new Map<string, RateLine[]>();
      for (const r of db.prepare(sql).all(...bounds) as Array<RateLine & { id: string }>) {
        const { id, ...line } = r;
        map.set(id, [...(map.get(id) ?? []), line]);
      }
      return map;
    };
    const billTaxes = taxesOf(`SELECT t.bill_id AS id, t.gst_rate AS gstRate, t.taxable_paise AS taxablePaise, t.cgst_paise AS cgstPaise, t.sgst_paise AS sgstPaise
      FROM bill_taxes t JOIN bills b ON b.id = t.bill_id WHERE b.created_at >= ? AND b.created_at < ? ORDER BY t.gst_rate`);
    const bills = (db.prepare(`SELECT b.id, b.bill_no AS billNo, COALESCE(b.invoice_no, CAST(b.bill_no AS TEXT)) AS invoiceNo, b.created_at AS createdAt, b.status, b.total_paise AS totalPaise,
        b.buyer_gstin AS buyerGstin, b.buyer_name AS buyerName, json_extract(b.receipt_json, '$.gstMode') AS gstMode,
        json_extract(b.receipt_json, '$.gstPaidBy') AS gstPaidBy, json_extract(b.receipt_json, '$.gstin') AS gstin
      FROM bills b WHERE b.created_at >= ? AND b.created_at < ? ORDER BY b.bill_no`).all(...bounds) as Array<Snapshot & {
        id: string; billNo: number; invoiceNo: string; createdAt: number; status: GstBillFact["status"]; totalPaise: number; buyerGstin: string | null; buyerName: string | null;
      }>).map((b): GstBillFact => ({
        billId: b.id, billNo: b.billNo, invoiceNo: b.invoiceNo, dateKey: localDateKey(b.createdAt), status: b.status, supply: supplyOf(b),
        buyerGstin: b.buyerGstin, buyerName: b.buyerName, totalPaise: b.totalPaise, taxes: billTaxes.get(b.id) ?? [],
      }));
    const noteTaxes = taxesOf(`SELECT t.credit_note_id AS id, t.gst_rate AS gstRate, t.taxable_paise AS taxablePaise, t.cgst_paise AS cgstPaise, t.sgst_paise AS sgstPaise
      FROM credit_note_taxes t JOIN credit_notes c ON c.id = t.credit_note_id WHERE c.created_at >= ? AND c.created_at < ? ORDER BY t.gst_rate`);
    const creditNotes = (db.prepare(`SELECT c.id, c.cn_no AS cnNo, COALESCE(c.credit_note_ref, 'CN-' || c.cn_no) AS creditNoteRef, c.bill_id AS billId, b.bill_no AS billNo,
        COALESCE(b.invoice_no, CAST(b.bill_no AS TEXT)) AS invoiceNo, c.kind, c.created_at AS createdAt,
        c.taxable_paise AS taxablePaise, c.total_paise AS totalPaise, b.buyer_gstin AS buyerGstin, b.buyer_name AS buyerName,
        json_extract(b.receipt_json, '$.gstMode') AS gstMode, json_extract(b.receipt_json, '$.gstPaidBy') AS gstPaidBy, json_extract(b.receipt_json, '$.gstin') AS gstin
      FROM credit_notes c JOIN bills b ON b.id = c.bill_id WHERE c.created_at >= ? AND c.created_at < ? ORDER BY c.cn_no`).all(...bounds) as Array<Snapshot & {
        id: string; cnNo: number; creditNoteRef: string; billId: string; billNo: number; invoiceNo: string; kind: "void" | "refund"; createdAt: number; taxablePaise: number; totalPaise: number;
        buyerGstin: string | null; buyerName: string | null;
      }>).map((n): GstCreditNoteFact => ({
        cnNo: n.cnNo, creditNoteRef: n.creditNoteRef, billId: n.billId, billNo: n.billNo, invoiceNo: n.invoiceNo, kind: n.kind, dateKey: localDateKey(n.createdAt), supply: supplyOf(n),
        buyerGstin: n.buyerGstin, buyerName: n.buyerName, totalPaise: n.totalPaise,
        // A credit note on a bill without GST may carry no per-rate lines: its value is all it reduces.
        taxes: noteTaxes.get(n.id) ?? [{ gstRate: 0, taxablePaise: n.taxablePaise, cgstPaise: 0, sgstPaise: 0 }],
      }));
    return { bills, creditNotes };
  })();
}

interface GstProfile { gstin: string; gstMode: GstMode; stateCode: string; sacCode: string; zomatoGstin: string }
const readProfile = (db: Database) => db.prepare(`SELECT gstin, gst_mode AS gstMode, state_code AS stateCode, sac_code AS sacCode,
  zomato_gstin AS zomatoGstin FROM settings WHERE id = 1`).get() as GstProfile;
/** Today's settings decide which return the restaurant files; each bill is still reported by its own snapshot. */
const regimeOf = (p: GstProfile): GstRegime => !p.gstin.trim() ? "unregistered" : p.gstMode === "none" ? "composition" : "regular";

const PeriodQuery = z.object({
  period: z.string().regex(/^\d{4}-\d{2}$/, "Choose a month like 2026-10"),
  span: z.enum(["month", "quarter"]).default("month"),
});

function periodOf(query: unknown): { period: GstPeriod; bounds: readonly [number, number] } {
  const q = PeriodQuery.parse(query);
  let period: GstPeriod;
  try { period = gstPeriod(q.period, q.span); } catch (err) { throw httpError(400, err instanceof Error ? err.message : "Invalid period"); }
  return { period, bounds: reportRange({ from: period.from, to: period.to }).bounds };
}

export function registerGstReturns(app: FastifyInstance) {
  const db = app.db;
  // GST returns are a legal duty, so they need only the report permission, never a paid module.
  const read = app.requirePermission("reports.read");

  app.get("/api/reports/gst-returns", { preHandler: read }, async (req, reply) => {
    const { period, bounds } = periodOf(req.query);
    const profile = readProfile(db);
    const generatedAt = Date.now();
    reply.header("Cache-Control", "no-store");
    return { report: gstReturnsReport({
      regime: regimeOf(profile), period, gstin: profile.gstin, stateCode: profile.stateCode, sacCode: profile.sacCode, ecoGstin: profile.zomatoGstin,
      ...loadGstFacts(db, bounds), today: localDateKey(generatedAt), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, generatedAt,
    }) };
  });

  app.get("/api/reports/gst-returns/gstr1.json", { preHandler: read }, async (req, reply) => {
    const { period, bounds } = periodOf(req.query);
    const profile = readProfile(db);
    const report = gstReturnsReport({ regime: regimeOf(profile), period, gstin: profile.gstin, stateCode: profile.stateCode, sacCode: profile.sacCode,
      ecoGstin: profile.zomatoGstin, bills: [], creditNotes: [], today: "", timezone: "", generatedAt: 0 });
    if (report.regime !== "regular") throw httpError(409, "GSTR-1 is filed only by restaurants that charge GST on their bills", "gstr1_not_applicable");
    if (!report.gstr1Available) throw httpError(409, "Fix the restaurant's GSTIN in Settings before downloading the GSTR-1 file", "gstin_invalid");
    const summary = buildGstr1({ sacCode: profile.sacCode, ...loadGstFacts(db, bounds) });
    const json = gstr1Json(summary, { gstin: profile.gstin, fp: period.fp, stateCode: profile.stateCode, ecoGstin: profile.zomatoGstin });
    return reply.header("Cache-Control", "no-store")
      .header("Content-Disposition", `attachment; filename="GSTR1_${profile.gstin}_${period.fp}.json"`)
      .type("application/json").send(JSON.stringify(json));
  });
}
