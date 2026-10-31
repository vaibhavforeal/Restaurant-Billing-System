import { z } from "zod";
import type { D1StatementLike } from "../env.js";
import type { Deps } from "../issue.js";
import { activityStatement } from "../store.js";
import type { InvoiceBuyer, InvoiceDetail, InvoiceLine, InvoiceSeller, InvoiceSummary } from "./api-types.js";
import { logBy, path, queryInt, type Ctx, type Route } from "./context.js";
import { conflict, HttpError, json, notFound, readBody, SECURITY_HEADERS } from "./http.js";
import { invoicePdf } from "./invoice-pdf.js";
import { visibleOrder } from "./order-routes.js";
import { ownedBy } from "./scope.js";
import { loadSettings } from "./settings.js";
import { buyerState, computeTotals, GST_STATES } from "./shared.js";
import { financialYear, rupeesInWords } from "./words.js";

const PAGE = 50;

/**
 * The statements that issue an order's tax invoice, for the batch that makes it due (full payment) or for an invoice issued by hand.
 * The seller, the buyer and the lines are copied in as they are now, so the invoice never changes afterwards. Its number is the next
 * in this financial year, worked out by the INSERT itself, so two invoices issued at once cannot share a number or leave a gap (the
 * (fy, seq) pair is unique and the losing batch fails). The partial unique index allows one live invoice per order.
 */
export async function invoiceStatements(deps: Deps, orderId: string, actorId: string | null): Promise<D1StatementLike[]> {
  const { db } = deps, now = deps.now();
  const settings = await loadSettings(db);
  const order = (await db.prepare(`SELECT o.code, o.customer_id AS customerId, c.code AS customerCode, c.business_name AS name, c.gstin, c.address, c.city, c.state_code AS stateCode,
      c.pincode, c.email, c.phone FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.id = ?`).bind(orderId)
    .first<{ code: string; customerId: string; customerCode: string; name: string; gstin: string | null; address: string | null; city: string | null; stateCode: string | null; pincode: string | null; email: string | null; phone: string | null }>())!;
  const buyerCode = buyerState(order), sellerCode = settings.seller.stateCode;
  if (!buyerCode || !sellerCode || !settings.seller.legalName) throw conflict("The seller's or the customer's state is missing, so the invoice can't be issued.", "state_missing");
  const intra = buyerCode === sellerCode;
  const rows = (await db.prepare(`SELECT description, sac, quantity, unit_price_paise AS unitPricePaise, discount_paise AS discountPaise, gst_rate_bp AS gstRateBp
    FROM order_lines WHERE order_id = ? ORDER BY position`).bind(orderId).all<Omit<InvoiceLine, "taxablePaise" | "cgstPaise" | "sgstPaise" | "igstPaise">>()).results;
  const totals = computeTotals(rows, intra);
  const lines: InvoiceLine[] = rows.map((r, i) => ({ ...r, ...totals.lines[i]! }));
  const s = settings.seller;
  const seller: InvoiceSeller = {
    name: s.legalName, gstin: s.gstin || null, address: [s.address, s.city, s.pincode].filter(Boolean).join(", "), stateCode: s.stateCode, stateName: GST_STATES[s.stateCode] ?? null,
    email: s.email || null, phone: s.phone || null, bankDetails: settings.invoice.bankDetails, terms: settings.invoice.terms,
  };
  const buyer: InvoiceBuyer = {
    name: order.name, code: order.customerCode, gstin: order.gstin, address: [order.address, order.city, order.pincode].filter(Boolean).join(", "),
    stateCode: buyerCode, stateName: GST_STATES[buyerCode] ?? null, email: order.email, phone: order.phone,
  };
  const fy = financialYear(now), id = deps.uuid();
  return [
    db.prepare(`INSERT INTO invoices (id, order_id, customer_id, fy, seq, number, issued_at, seller, buyer, lines, place_of_supply, intra_state,
        subtotal_paise, cgst_paise, sgst_paise, igst_paise, total_paise, issued_by)
      SELECT ?, ?, ?, ?, COALESCE(MAX(seq), 0) + 1, ? || '/' || ? || '/' || printf('%05d', COALESCE(MAX(seq), 0) + 1), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      FROM invoices WHERE fy = ?`)
      .bind(id, orderId, order.customerId, fy, settings.invoice.prefix, fy, now, JSON.stringify(seller), JSON.stringify(buyer), JSON.stringify(lines),
        `${GST_STATES[buyerCode] ?? buyerCode} (${buyerCode})`, intra ? 1 : 0, totals.subtotalPaise, totals.cgstPaise, totals.sgstPaise, totals.igstPaise, totals.totalPaise, actorId, fy),
    activityStatement(db, now, { actorId, action: "invoice.issued", entityType: "invoice", entityId: id, customerId: order.customerId, summary: `Issued the tax invoice for order ${order.code}` }),
  ];
}

export async function liveInvoiceExists(deps: Deps, orderId: string): Promise<boolean> {
  return (await deps.db.prepare(`SELECT 1 AS hit FROM invoices WHERE order_id = ? AND cancelled_at IS NULL`).bind(orderId).first()) !== null;
}

interface Row {
  id: string; number: string; issuedAt: number; totalPaise: number; cancelledAt: number | null; customerId: string; customerName: string; orderId: string; orderCode: string;
}
const SUMMARY = `i.id, i.number, i.issued_at AS issuedAt, i.total_paise AS totalPaise, i.cancelled_at AS cancelledAt, i.customer_id AS customerId,
  c.business_name AS customerName, i.order_id AS orderId, o.code AS orderCode`;
const toSummary = ({ customerId, customerName, ...r }: Row): InvoiceSummary => ({ ...r, customer: { id: customerId, name: customerName } });

async function visibleInvoice(ctx: Ctx, id: string): Promise<InvoiceDetail> {
  const scope = ownedBy(ctx.user, "c.owner_id");
  const row = await ctx.deps.db.prepare(`SELECT ${SUMMARY}, i.seller, i.buyer, i.lines, i.place_of_supply AS placeOfSupply, i.intra_state AS intraState,
      i.subtotal_paise AS subtotalPaise, i.cgst_paise AS cgstPaise, i.sgst_paise AS sgstPaise, i.igst_paise AS igstPaise, i.cancel_reason AS cancelReason,
      i.issued_by AS issuedById, u.name AS issuedByName
    FROM invoices i JOIN customers c ON c.id = i.customer_id JOIN orders o ON o.id = i.order_id LEFT JOIN staff_users u ON u.id = i.issued_by
    WHERE i.id = ? AND ${scope.sql}`).bind(id, ...scope.binds)
    .first<Row & { seller: string; buyer: string; lines: string; placeOfSupply: string; intraState: number; subtotalPaise: number; cgstPaise: number; sgstPaise: number; igstPaise: number;
      cancelReason: string | null; issuedById: string | null; issuedByName: string | null }>();
  if (!row) throw notFound("That invoice");
  const { seller, buyer, lines, intraState, issuedById, issuedByName, ...rest } = row;
  return {
    ...toSummary(rest), seller: JSON.parse(seller), buyer: JSON.parse(buyer), lines: JSON.parse(lines), intraState: intraState === 1,
    placeOfSupply: rest.placeOfSupply, subtotalPaise: rest.subtotalPaise, cgstPaise: rest.cgstPaise, sgstPaise: rest.sgstPaise, igstPaise: rest.igstPaise,
    amountInWords: rupeesInWords(rest.totalPaise), cancelReason: rest.cancelReason, issuedBy: issuedById ? { id: issuedById, name: issuedByName ?? "" } : null,
  };
}

export const invoiceRoutes: Route[] = [
  { method: "GET", path: path("/invoices"), permission: "orders.read", handler: async (ctx) => {
    const scope = ownedBy(ctx.user, "c.owner_id"), where = [scope.sql], binds: unknown[] = [...scope.binds];
    const q = ctx.url.searchParams.get("q")?.trim();
    if (q) { where.push("(i.number LIKE ? OR c.business_name LIKE ?)"); binds.push(`%${q}%`, `%${q.replace(/[%_]/g, "")}%`); }
    if (ctx.url.searchParams.get("customerId")) { where.push("i.customer_id = ?"); binds.push(ctx.url.searchParams.get("customerId")); }
    const from = queryInt(ctx.url, "from"), to = queryInt(ctx.url, "to");
    if (from !== null) { where.push("i.issued_at >= ?"); binds.push(from); }
    if (to !== null) { where.push("i.issued_at < ?"); binds.push(to); }
    const offset = Math.max(0, queryInt(ctx.url, "offset", 0)!);
    const sql = `FROM invoices i JOIN customers c ON c.id = i.customer_id JOIN orders o ON o.id = i.order_id WHERE ${where.join(" AND ")}`;
    const [{ results }, total] = await Promise.all([
      ctx.deps.db.prepare(`SELECT ${SUMMARY} ${sql} ORDER BY i.issued_at DESC, i.seq DESC LIMIT ? OFFSET ?`).bind(...binds, PAGE, offset).all<Row>(),
      ctx.deps.db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(CASE WHEN i.cancelled_at IS NULL THEN i.total_paise END), 0) AS value ${sql}`).bind(...binds).first<{ n: number; value: number }>(),
    ]);
    return json({ invoices: results.map(toSummary), total: total!.n, valuePaise: total!.value, offset, pageSize: PAGE });
  } },
  { method: "GET", path: path("/invoices/:id"), permission: "orders.read", handler: async (ctx) => json({ invoice: await visibleInvoice(ctx, ctx.params[0]!) }) },
  { method: "GET", path: path("/invoices/:id/pdf"), permission: "orders.read", handler: async (ctx) => {
    const invoice = await visibleInvoice(ctx, ctx.params[0]!);
    const bytes = await invoicePdf(invoice);
    return new Response(bytes, { headers: { ...SECURITY_HEADERS, "content-type": "application/pdf", "cache-control": "no-store",
      "content-disposition": `attachment; filename="ForkFlow-invoice-${invoice.number.replace(/\//g, "-")}.pdf"` } });
  } },
  // Before payment, for a customer on credit who needs the invoice to pay it. A paid order gets its invoice on its own.
  { method: "POST", path: path("/orders/:id/invoice"), permission: "invoices.issue", handler: async (ctx) => {
    const order = await visibleOrder(ctx, ctx.params[0]!);
    if (order.status !== "confirmed" && order.status !== "paid") throw conflict("Confirm the order before invoicing it.", "not_confirmed");
    if (order.totalPaise === 0) throw conflict("This order costs nothing, so it has no tax invoice.", "free");
    if (await liveInvoiceExists(ctx.deps, order.id)) throw conflict("This order already has an invoice. Cancel it first to issue a new one.", "invoiced");
    try { await ctx.deps.db.batch(await invoiceStatements(ctx.deps, order.id, ctx.user.id)); }
    catch (error) { if (await liveInvoiceExists(ctx.deps, order.id)) throw conflict("This order already has an invoice.", "invoiced"); throw error; }
    const id = (await ctx.deps.db.prepare(`SELECT id FROM invoices WHERE order_id = ? AND cancelled_at IS NULL`).bind(order.id).first<{ id: string }>())!.id;
    return json({ invoice: await visibleInvoice(ctx, id) }, 201);
  } },
  // Only before the invoice is reported in a GST return; a correction after that needs a credit note, which the portal does not issue yet.
  { method: "POST", path: path("/invoices/:id/cancel"), permission: "invoices.cancel", handler: async (ctx) => {
    const invoice = await visibleInvoice(ctx, ctx.params[0]!);
    const { reason } = await readBody(ctx.request, z.object({ reason: z.string().trim().min(3, "Say why").max(300) }).strict());
    if (invoice.cancelledAt) throw new HttpError(409, "This invoice is already cancelled.");
    const { db } = ctx.deps, now = ctx.deps.now();
    await db.batch([
      db.prepare(`UPDATE invoices SET cancelled_at = ?, cancelled_by = ?, cancel_reason = ? WHERE id = ?`).bind(now, ctx.user.id, reason, invoice.id),
      logBy(ctx, { action: "invoice.cancelled", entityType: "invoice", entityId: invoice.id, customerId: invoice.customer.id, summary: `Cancelled invoice ${invoice.number} (${reason})` }),
    ]);
    return json({ invoice: await visibleInvoice(ctx, invoice.id) });
  } },
];
