import { isModuleId, MODULE_IDS, type ModuleOverrides } from "@forkflow/domain/modules";
import { parseVendorCode } from "@forkflow/domain/vendor-codes";
import { z } from "zod";
import { DAY_MS } from "../dates.js";
import type { D1StatementLike } from "../env.js";
import { reissueLicense } from "../issue.js";
import { orderById, orderTerms } from "../orders.js";
import { INSTALLATION_COLUMNS, latestLicense, parseOverrides, type InstallationRow } from "../store.js";
import type { InvoiceSummary, OrderDetail, OrderLine, OrderSummary, PaymentLinkRecord, PaymentRecord } from "./api-types.js";
import { withFreshCode } from "./codes.js";
import { logBy, path, queryInt, type Ctx, type Route } from "./context.js";
import { fulfilmentStatements } from "./fulfil.js";
import { cancelOpenLinks, razorpayFor } from "./payments.js";
import { conflict, HttpError, json, notFound, readBody } from "./http.js";
import { installationsWhere } from "./installations.js";
import { ownedBy, visibleCustomer } from "./scope.js";
import { loadSettings, type PortalSettings } from "./settings.js";
import { buyerState, computeTotals, draftLines, PLAN_NAMES, termLabel, type DraftLine, type PricedLine } from "./shared.js";

const PAGE = 50;
const Extra = z.object({
  description: z.string().trim().min(1, "Describe the extra line").max(200), sac: z.string().trim().regex(/^\d{4,8}$/, "Enter a 4 to 8 digit SAC or HSN"),
  quantity: z.number().int().min(1).max(10_000), unitPricePaise: z.number().int().min(0).max(1_000_000_000),
}).strict();
const OrderBody = z.object({
  customerId: z.string().uuid(), kind: z.enum(["new", "renewal", "trial"]), plan: z.enum(["basic", "pro"]),
  termMonths: z.number().int().min(1).max(60), outlets: z.number().int().min(0).max(500), maxDevices: z.number().int().min(1).max(100),
  modules: z.record(z.string(), z.boolean()).refine((m) => Object.keys(m).every(isModuleId), "Unknown module"),
  pricePerOutletPaise: z.number().int().min(0).max(1_000_000_000), discountPaise: z.number().int().min(0).max(1_000_000_000),
  extras: z.array(Extra).max(20), installationIds: z.array(z.string().uuid()).max(500), notes: z.string().trim().max(2000),
}).strict();
type OrderBody = z.infer<typeof OrderBody>;

type LineRow = DraftLine;

/** The order's terms and lines; refuses choices that make no sense. Trials cost nothing and run the settings' trial length. */
function build(body: OrderBody, settings: PortalSettings): { termMonths: number | null; termDays: number | null; outlets: number; lines: LineRow[] } {
  if (body.kind === "trial") {
    if (body.outlets < 1) throw new HttpError(400, "A trial needs at least one outlet");
    return { termMonths: null, termDays: settings.trialDays, outlets: body.outlets, lines: [] };
  }
  const renewal = body.kind === "renewal";
  const quantity = renewal ? body.installationIds.length : body.outlets;
  if (quantity < 1) throw new HttpError(400, renewal ? "Choose the counters this order renews" : "An order needs at least one outlet");
  if (body.discountPaise > quantity * body.pricePerOutletPaise) throw new HttpError(400, "The discount is more than the licence price");
  return { termMonths: body.termMonths, termDays: null, outlets: renewal ? 0 : body.outlets, lines: draftLines(body, settings) };
}

/** CGST and SGST when ForkFlow and the customer are in the same state; null while either state is unknown. */
export const intraStateFor = (settings: PortalSettings, customer: { gstin: string | null; stateCode: string | null }) => {
  const buyer = buyerState(customer);
  return settings.seller.stateCode && buyer ? settings.seller.stateCode === buyer : null;
};

const SUMMARY = `o.id, o.code, o.kind, o.status, o.plan, o.term_months AS termMonths, o.term_days AS termDays, o.outlets, o.seats_used AS seatsUsed,
  o.total_paise AS totalPaise, (SELECT COALESCE(SUM(p.amount_paise), 0) FROM payments p WHERE p.order_id = o.id AND p.status = 'cleared') AS paidPaise,
  c.id AS customerId, c.business_name AS customerName, c.code AS customerCode, o.owner_id AS ownerId, u.name AS ownerName, o.created_at AS createdAt,
  o.credit_until AS creditUntil`;
type SummaryRow = Omit<OrderSummary, "customer" | "owner"> & { customerId: string; customerName: string; customerCode: string; ownerId: string | null; ownerName: string | null };
const toSummary = ({ customerId, customerName, customerCode, ownerId, ownerName, ...r }: SummaryRow): OrderSummary =>
  ({ ...r, customer: { id: customerId, name: customerName, code: customerCode }, owner: ownerId ? { id: ownerId, name: ownerName ?? "Former staff" } : null });

/** The order when the staff member may see it (through its customer); otherwise a 404. */
export async function visibleOrder(ctx: Ctx, id: string): Promise<SummaryRow & { customerGstin: string | null; customerState: string | null }> {
  const scope = ownedBy(ctx.user, "c.owner_id");
  const row = await ctx.deps.db.prepare(`SELECT ${SUMMARY}, c.gstin AS customerGstin, c.state_code AS customerState FROM orders o JOIN customers c ON c.id = o.customer_id
    LEFT JOIN staff_users u ON u.id = o.owner_id WHERE o.id = ? AND ${scope.sql}`).bind(id, ...scope.binds).first<SummaryRow & { customerGstin: string | null; customerState: string | null }>();
  if (!row) throw notFound("That order");
  return row;
}

export async function orderDetail(ctx: Ctx, id: string): Promise<OrderDetail> {
  const row = await visibleOrder(ctx, id);
  const { db } = ctx.deps;
  const [extra, lines, payments, links, invoices, settings, seats, targets] = await Promise.all([
    db.prepare(`SELECT o.max_devices AS maxDevices, o.modules, o.notes, o.confirmed_at AS confirmedAt, o.paid_at AS paidAt, o.cancelled_at AS cancelledAt,
        o.credit_approved_by AS creditApprovedBy, u.name AS creditApprovedByName FROM orders o LEFT JOIN staff_users u ON u.id = o.credit_approved_by WHERE o.id = ?`).bind(id)
      .first<{ maxDevices: number; modules: string; notes: string | null; confirmedAt: number | null; paidAt: number | null; cancelledAt: number | null; creditApprovedBy: string | null; creditApprovedByName: string | null }>(),
    db.prepare(`SELECT id, kind, description, sac, quantity, unit_price_paise AS unitPricePaise, discount_paise AS discountPaise, gst_rate_bp AS gstRateBp
      FROM order_lines WHERE order_id = ? ORDER BY position`).bind(id).all<Omit<OrderLine, "taxablePaise" | "cgstPaise" | "sgstPaise" | "igstPaise">>(),
    db.prepare(`SELECT p.id, p.amount_paise AS amountPaise, p.method, p.reference, p.status, p.received_at AS receivedAt, p.note, p.recorded_by AS recordedById, u.name AS recordedByName
      FROM payments p LEFT JOIN staff_users u ON u.id = p.recorded_by WHERE p.order_id = ? ORDER BY p.received_at`).bind(id)
      .all<Omit<PaymentRecord, "recordedBy"> & { recordedById: string | null; recordedByName: string | null }>(),
    db.prepare(`SELECT id, short_url AS shortUrl, amount_paise AS amountPaise, status, created_at AS createdAt, expire_by AS expireBy FROM payment_links WHERE order_id = ? ORDER BY attempt DESC`)
      .bind(id).all<PaymentLinkRecord>(),
    db.prepare(`SELECT i.id, i.number, i.issued_at AS issuedAt, i.total_paise AS totalPaise, i.cancelled_at AS cancelledAt, i.order_id AS orderId FROM invoices i WHERE i.order_id = ? ORDER BY i.issued_at`)
      .bind(id).all<Omit<InvoiceSummary, "customer" | "orderCode">>(),
    loadSettings(db),
    installationsWhere(ctx, "i.order_id = ?", [id]),
    installationsWhere(ctx, "i.installation_id IN (SELECT installation_id FROM order_installations WHERE order_id = ?)", [id]),
  ]);
  const intraState = intraStateFor(settings, { gstin: row.customerGstin, stateCode: row.customerState });
  const totals = computeTotals(lines.results, intraState ?? true);
  const { customerGstin, customerState, ...summary } = row;
  void customerGstin; void customerState;
  return {
    ...toSummary(summary), maxDevices: extra!.maxDevices, modules: parseOverrides(extra!.modules) as Record<string, boolean>, notes: extra!.notes,
    subtotalPaise: totals.subtotalPaise, taxPaise: totals.taxPaise, cgstPaise: totals.cgstPaise, sgstPaise: totals.sgstPaise, igstPaise: totals.igstPaise, intraState,
    lines: lines.results.map((l, i) => ({ ...l, ...totals.lines[i]! })),
    confirmedAt: extra!.confirmedAt, paidAt: extra!.paidAt, cancelledAt: extra!.cancelledAt,
    creditApprovedBy: extra!.creditApprovedBy ? { id: extra!.creditApprovedBy, name: extra!.creditApprovedByName ?? "" } : null,
    seats, renewalTargets: targets,
    payments: payments.results.map(({ recordedById, recordedByName, ...p }) => ({ ...p, recordedBy: recordedById ? { id: recordedById, name: recordedByName ?? "" } : null })),
    links: links.results,
    invoices: invoices.results.map((i) => ({ ...i, customer: { id: row.customerId, name: row.customerName }, orderCode: row.code })),
  };
}

/** Counters a renewal may extend: the customer's own, holding a seat. */
async function checkTargets(ctx: Ctx, customerId: string, ids: string[]): Promise<void> {
  if (!ids.length) return;
  const { results } = await ctx.deps.db.prepare(`SELECT installation_id AS id FROM installations WHERE customer_id = ? AND order_id IS NOT NULL AND installation_id IN (${ids.map(() => "?").join(", ")})`)
    .bind(customerId, ...ids).all<{ id: string }>();
  if (results.length !== new Set(ids).size) throw new HttpError(400, "Renew only this customer's counters that hold a seat");
}

function writeStatements(ctx: Ctx, orderId: string, body: OrderBody, built: ReturnType<typeof build>, intra: boolean): D1StatementLike[] {
  const { db } = ctx.deps;
  const totals = computeTotals(built.lines, intra);
  const modules: ModuleOverrides = Object.fromEntries(MODULE_IDS.filter((id) => body.modules[id] !== undefined).map((id) => [id, body.modules[id]]));
  return [
    db.prepare(`UPDATE orders SET kind = ?, plan = ?, term_months = ?, term_days = ?, outlets = ?, max_devices = ?, modules = ?, subtotal_paise = ?, tax_paise = ?, total_paise = ?,
      notes = ?, updated_at = ? WHERE id = ?`)
      .bind(body.kind, body.plan, built.termMonths, built.termDays, built.outlets, body.maxDevices, JSON.stringify(modules), totals.subtotalPaise, totals.taxPaise, totals.totalPaise,
        body.notes || null, ctx.deps.now(), orderId),
    db.prepare(`DELETE FROM order_lines WHERE order_id = ?`).bind(orderId),
    ...built.lines.map((l, i) => db.prepare(`INSERT INTO order_lines (order_id, position, kind, description, sac, quantity, unit_price_paise, discount_paise, gst_rate_bp) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(orderId, i, l.kind, l.description, l.sac, l.quantity, l.unitPricePaise, l.discountPaise, l.gstRateBp)),
    db.prepare(`DELETE FROM order_installations WHERE order_id = ?`).bind(orderId),
    ...(body.kind === "renewal" ? [...new Set(body.installationIds)].map((id) => db.prepare(`INSERT INTO order_installations (order_id, installation_id) VALUES (?, ?)`).bind(orderId, id)) : []),
  ];
}

async function customerTax(ctx: Ctx, customerId: string) {
  return (await ctx.deps.db.prepare(`SELECT gstin, state_code AS stateCode FROM customers WHERE id = ?`).bind(customerId).first<{ gstin: string | null; stateCode: string | null }>())!;
}

export const orderRoutes: Route[] = [
  { method: "GET", path: path("/orders"), permission: "orders.read", handler: async (ctx) => {
    const q = ctx.url.searchParams, scope = ownedBy(ctx.user, "c.owner_id");
    const where = [scope.sql], binds: unknown[] = [...scope.binds];
    const status = q.get("status");
    if (status && ["draft", "confirmed", "paid", "cancelled"].includes(status)) { where.push("o.status = ?"); binds.push(status); }
    if (q.get("kind")) { where.push("o.kind = ?"); binds.push(q.get("kind")); }
    if (q.get("customerId")) { where.push("o.customer_id = ?"); binds.push(q.get("customerId")); }
    const search = q.get("q")?.trim();
    if (search) {
      const code = parseVendorCode("order", search);
      if (code) { where.push("o.code = ?"); binds.push(code); }
      else { where.push("c.business_name LIKE ?"); binds.push(`%${search.replace(/[%_]/g, "")}%`); }
    }
    const offset = Math.max(0, queryInt(ctx.url, "offset", 0)!);
    const from = `FROM orders o JOIN customers c ON c.id = o.customer_id LEFT JOIN staff_users u ON u.id = o.owner_id WHERE ${where.join(" AND ")}`;
    const counts = await ctx.deps.db.prepare(`SELECT o.status, COUNT(*) AS n FROM orders o JOIN customers c ON c.id = o.customer_id WHERE ${[scope.sql, ...(q.get("customerId") ? ["o.customer_id = ?"] : [])].join(" AND ")} GROUP BY o.status`)
      .bind(...scope.binds, ...(q.get("customerId") ? [q.get("customerId")] : [])).all<{ status: string; n: number }>();
    const [{ results }, total] = await Promise.all([
      ctx.deps.db.prepare(`SELECT ${SUMMARY} ${from} ORDER BY o.created_at DESC LIMIT ? OFFSET ?`).bind(...binds, PAGE, offset).all<SummaryRow>(),
      ctx.deps.db.prepare(`SELECT COUNT(*) AS n ${from}`).bind(...binds).first<{ n: number }>(),
    ]);
    return json({ orders: results.map(toSummary), total: total!.n, offset, pageSize: PAGE, counts: Object.fromEntries(counts.results.map((c) => [c.status, c.n])) });
  } },

  { method: "POST", path: path("/orders"), permission: "orders.write", handler: async (ctx) => {
    const body = await readBody(ctx.request, OrderBody);
    const customer = await visibleCustomer(ctx, body.customerId);
    const settings = await loadSettings(ctx.deps.db);
    const built = build(body, settings);
    if (body.kind === "renewal") await checkTargets(ctx, customer.id, body.installationIds);
    const intra = intraStateFor(settings, await customerTax(ctx, customer.id)) ?? true;
    const { db } = ctx.deps, now = ctx.deps.now(), id = ctx.deps.uuid(), trial = body.kind === "trial";
    // The rep the customer belongs to owns its orders, so a rep's sales follow the customer.
    const owner = customer.ownerId ?? ctx.user.id;
    const code = await withFreshCode("order", async (code) => {
      await db.batch([
        db.prepare(`INSERT INTO orders (id, code, customer_id, owner_id, kind, plan, term_months, term_days, outlets, max_devices, status, created_by, created_at, updated_at, confirmed_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .bind(id, code, customer.id, owner, body.kind, body.plan, built.termMonths, built.termDays, built.outlets, body.maxDevices, trial ? "confirmed" : "draft", ctx.user.id, now, now, trial ? now : null),
        ...writeStatements(ctx, id, body, built, intra),
        logBy(ctx, { action: "order.created", entityType: "order", entityId: id, customerId: customer.id,
          summary: trial ? `Started a ${built.termDays}-day ${PLAN_NAMES[body.plan]} trial, order ${code}` : `Drafted order ${code}: ${PLAN_NAMES[body.plan]}, ${termLabel(built)}` }),
      ]);
      return code;
    });
    return json({ order: await orderDetail(ctx, id), code }, 201);
  } },

  { method: "GET", path: path("/orders/:id"), permission: "orders.read", handler: async (ctx) => json({ order: await orderDetail(ctx, ctx.params[0]!) }) },

  { method: "PATCH", path: path("/orders/:id"), permission: "orders.write", handler: async (ctx) => {
    const before = await visibleOrder(ctx, ctx.params[0]!);
    if (before.status !== "draft") throw conflict("Only a draft can be changed. Its lines are fixed once it is confirmed.", "not_draft");
    const body = await readBody(ctx.request, OrderBody);
    if (body.customerId !== before.customerId) throw new HttpError(400, "An order stays with its customer. Draft a new one instead.");
    if (body.kind === "trial") throw new HttpError(400, "Start a trial as its own order.");
    const settings = await loadSettings(ctx.deps.db);
    const built = build(body, settings);
    if (body.kind === "renewal") await checkTargets(ctx, before.customerId, body.installationIds);
    const intra = intraStateFor(settings, await customerTax(ctx, before.customerId)) ?? true;
    await ctx.deps.db.batch([
      ...writeStatements(ctx, before.id, body, built, intra),
      logBy(ctx, { action: "order.changed", entityType: "order", entityId: before.id, customerId: before.customerId, summary: `Edited draft order ${before.code}` }),
    ]);
    return json({ order: await orderDetail(ctx, before.id) });
  } },

  // Fixes the lines and the price. An order worth nothing (a free licence) is paid at once.
  { method: "POST", path: path("/orders/:id/confirm"), permission: "orders.write", handler: async (ctx) => {
    const before = await visibleOrder(ctx, ctx.params[0]!);
    if (before.status !== "draft") throw conflict("This order is already confirmed.", "not_draft");
    const { db } = ctx.deps, now = ctx.deps.now();
    const settings = await loadSettings(db);
    const lines = (await db.prepare(`SELECT quantity, unit_price_paise AS unitPricePaise, discount_paise AS discountPaise, gst_rate_bp AS gstRateBp FROM order_lines WHERE order_id = ?`)
      .bind(before.id).all<PricedLine>()).results;
    const intra = intraStateFor(settings, { gstin: before.customerGstin, stateCode: before.customerState });
    const totals = computeTotals(lines, intra ?? true);
    if (totals.totalPaise > 0) {
      if (!settings.seller.legalName || !settings.seller.stateCode) throw conflict("An admin must fill in the seller details in Settings before orders can be confirmed.", "seller_missing");
      if (intra === null) throw conflict("Add the customer's state or GSTIN first: it decides CGST and SGST or IGST.", "buyer_state_missing");
    }
    if (before.kind === "renewal" && !(await db.prepare(`SELECT 1 AS hit FROM order_installations WHERE order_id = ?`).bind(before.id).first())) {
      throw conflict("Choose the counters this order renews.", "no_targets");
    }
    const statements: D1StatementLike[] = [
      db.prepare(`UPDATE orders SET status = 'confirmed', confirmed_at = ?, subtotal_paise = ?, tax_paise = ?, total_paise = ?, updated_at = ? WHERE id = ? AND status = 'draft'`)
        .bind(now, totals.subtotalPaise, totals.taxPaise, totals.totalPaise, now, before.id),
      logBy(ctx, { action: "order.confirmed", entityType: "order", entityId: before.id, customerId: before.customerId, summary: `Confirmed order ${before.code}` }),
    ];
    if (totals.totalPaise === 0) {
      // The statements read the order as confirmed, which it is once the first statement above has run in the same batch.
      const order = { ...(await orderById(db, before.id))!, status: "confirmed" as const };
      statements.push(...await fulfilmentStatements(ctx.deps, order, ctx.user.id));
    }
    await db.batch(statements);
    return json({ order: await orderDetail(ctx, before.id) });
  } },

  // An admin lets a confirmed order activate counters before it is paid, until a date. Their licences end on that date unless it is paid.
  { method: "POST", path: path("/orders/:id/credit"), permission: "orders.approve", handler: async (ctx) => {
    const before = await visibleOrder(ctx, ctx.params[0]!);
    const { until } = await readBody(ctx.request, z.object({ until: z.number().int().positive() }).strict());
    const now = ctx.deps.now();
    if (before.status !== "confirmed" || before.kind === "trial") throw conflict("Only a confirmed order waiting for payment can go on credit.", "not_confirmed");
    if (until <= now || until > now + 180 * DAY_MS) throw new HttpError(400, "Choose a credit date within the next 180 days");
    const { db } = ctx.deps;
    const order = { ...(await orderById(db, before.id))!, creditUntil: until };
    // Counters already running on credit get the new date (never past the order's full term).
    const statements: D1StatementLike[] = [];
    if (order.kind === "new") {
      const { results } = await db.prepare(`SELECT ${INSTALLATION_COLUMNS} FROM installations WHERE order_id = ?`).bind(order.id).all<InstallationRow>();
      for (const installation of results) {
        const latest = await latestLicense(db, installation.installationId);
        const terms = orderTerms(order, installation.activatedAt ?? now);
        if (!latest || latest.expiresAt === terms.expiresAt) continue;
        const issued = await reissueLicense(ctx.deps, installation, "manual", { expiresAt: terms.expiresAt, graceUntil: terms.graceUntil });
        if (issued) statements.push(issued.statement);
      }
    }
    await db.batch([
      db.prepare(`UPDATE orders SET credit_until = ?, credit_approved_by = ?, credit_approved_at = ?, updated_at = ? WHERE id = ?`).bind(until, ctx.user.id, now, now, before.id),
      ...statements,
      logBy(ctx, { action: "order.credit", entityType: "order", entityId: before.id, customerId: before.customerId,
        summary: `Approved order ${before.code} on credit until ${new Date(until).toISOString().slice(0, 10)}` }),
    ]);
    return json({ order: await orderDetail(ctx, before.id) });
  } },

  { method: "POST", path: path("/orders/:id/cancel"), permission: "orders.approve", handler: async (ctx) => {
    const before = await visibleOrder(ctx, ctx.params[0]!);
    const { reason } = await readBody(ctx.request, z.object({ reason: z.string().trim().min(3, "Say why, for the activity log").max(300) }).strict());
    if (before.status === "paid" || before.status === "cancelled") throw conflict(`A ${before.status} order can't be cancelled.`, "not_cancellable");
    if (before.paidPaise > 0) throw conflict("This order has payments. Refund them before cancelling it.", "has_payments");
    const { db } = ctx.deps, now = ctx.deps.now();
    await db.batch([
      db.prepare(`UPDATE orders SET status = 'cancelled', cancelled_at = ?, updated_at = ? WHERE id = ?`).bind(now, now, before.id),
      logBy(ctx, { action: "order.cancelled", entityType: "order", entityId: before.id, customerId: before.customerId, summary: `Cancelled order ${before.code} (${reason})` }),
    ]);
    const razorpay = razorpayFor(ctx.env);
    if (razorpay) await cancelOpenLinks(ctx.deps, razorpay, before.id, (m) => console.warn(m));
    return json({ order: await orderDetail(ctx, before.id) });
  } },
];
