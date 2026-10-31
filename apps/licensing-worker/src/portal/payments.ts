import { z } from "zod";
import type { D1StatementLike, Env } from "../env.js";
import type { Deps } from "../issue.js";
import { orderById } from "../orders.js";
import { razorpayApi, type RazorpayApi } from "../razorpay.js";
import type { OrderDetail } from "./api-types.js";
import { logBy, path, type Ctx, type Route } from "./context.js";
import { fulfilmentStatements } from "./fulfil.js";
import { conflict, HttpError, json, notFound, readBody } from "./http.js";
import { invoiceStatements, liveInvoiceExists } from "./invoices.js";
import { orderDetail, visibleOrder } from "./order-routes.js";
import { ownedBy } from "./scope.js";
import { formatPaise } from "./shared.js";

/** Payment links stay open this long; Razorpay accepts 15 minutes to 6 months. */
const LINK_DAYS = 15;

/** Cleared payments on an order. */
export async function clearedPaise(deps: Deps, orderId: string): Promise<number> {
  return (await deps.db.prepare(`SELECT COALESCE(SUM(amount_paise), 0) AS paid FROM payments WHERE order_id = ? AND status = 'cleared'`).bind(orderId).first<{ paid: number }>())!.paid;
}

/**
 * Completes a confirmed order once its cleared payments cover it: fulfilment (licences) and the tax invoice, in one batch. Call it AFTER
 * the payment is recorded: it reads the payments on file, so two payments landing together are both counted and neither decides alone.
 * The batch fails when another request completed the order first (see fulfilmentStatements), so an order completes once. A missing
 * seller or customer state stops only the invoice, never the payment or the licences; issue the invoice from the order once it is fixed.
 * Returns whether this call completed the order.
 */
export async function settleOrder(deps: Deps, orderId: string, actorId: string | null, log: (message: string) => void): Promise<boolean> {
  const order = await orderById(deps.db, orderId);
  const row = await deps.db.prepare(`SELECT total_paise AS total FROM orders WHERE id = ?`).bind(orderId).first<{ total: number }>();
  if (!order || !row || order.status !== "confirmed") return false;
  if ((await clearedPaise(deps, orderId)) < row.total) return false;
  let invoice: D1StatementLike[] = [];
  if (row.total > 0 && !(await liveInvoiceExists(deps, orderId))) {
    try { invoice = await invoiceStatements(deps, orderId, actorId); }
    catch (error) {
      if (!(error instanceof HttpError)) throw error;
      log(`order ${order.code} is paid but its invoice was not issued: ${error.message}`);
    }
  }
  try { await deps.db.batch([...await fulfilmentStatements(deps, order, actorId), ...invoice]); }
  catch (error) {
    // Another request completed the order at the same moment.
    if ((await orderById(deps.db, orderId))?.status === "paid") return false;
    throw error;
  }
  return true;
}

/** Open payment links of an order are cancelled once it is paid some other way. Failures are left for a person: the link only expires. */
export async function cancelOpenLinks(deps: Deps, razorpay: RazorpayApi, orderId: string, log: (message: string) => void): Promise<void> {
  const { results } = await deps.db.prepare(`SELECT id FROM payment_links WHERE order_id = ? AND status = 'created'`).bind(orderId).all<{ id: string }>();
  for (const link of results) {
    try {
      await razorpay.cancelPaymentLink(link.id);
      await deps.db.prepare(`UPDATE payment_links SET status = 'cancelled', updated_at = ? WHERE id = ?`).bind(deps.now(), link.id).run();
    } catch (error) { log(`could not cancel payment link ${link.id}: ${error instanceof Error ? error.message : String(error)}`); }
  }
}

export const razorpayFor = (env: Env): RazorpayApi | null => (env.RAZORPAY_KEY_ID && env.RAZORPAY_KEY_SECRET ? razorpayApi(env.RAZORPAY_KEY_ID, env.RAZORPAY_KEY_SECRET) : null);

/** Razorpay wants a phone number with its country code; Indian numbers are usually written without it. */
export function razorpayContact(phone: string | null): string | null {
  const digits = phone?.replace(/[^\d+]/g, "") ?? "";
  if (/^[6-9]\d{9}$/.test(digits)) return `+91${digits}`;
  return /^\+?\d{8,14}$/.test(digits) ? digits : null;
}

const Payment = z.object({
  amountPaise: z.number().int().min(1).max(1_000_000_000),
  method: z.enum(["cash", "bank", "upi", "cheque", "card"]),
  reference: z.string().trim().max(100).transform((v) => v || null),
  receivedAt: z.number().int().positive(),
  note: z.string().trim().max(500).transform((v) => v || null),
  /** A cheque counts only once it clears; everything else is received when recorded. */
  pending: z.boolean().default(false),
}).strict();

async function afterPaid(ctx: Ctx, orderId: string): Promise<void> {
  const razorpay = razorpayFor(ctx.env);
  const order = await orderById(ctx.deps.db, orderId);
  if (razorpay && order?.status === "paid") await cancelOpenLinks(ctx.deps, razorpay, orderId, (m) => console.warn(m));
}

export const paymentRoutes: Route[] = [
  { method: "POST", path: path("/orders/:id/payments"), permission: "payments.record", handler: async (ctx) => {
    const order = await visibleOrder(ctx, ctx.params[0]!);
    const body = await readBody(ctx.request, Payment);
    if (order.status !== "confirmed" || order.kind === "trial") throw conflict(order.status === "paid" ? "This order is already paid." : "Confirm the order before recording a payment.", "not_payable");
    const now = ctx.deps.now();
    if (body.receivedAt > now + 86_400_000) throw new HttpError(400, "The payment date can't be in the future");
    const pending = body.pending && body.method === "cheque", id = ctx.deps.uuid(), { db } = ctx.deps;
    await db.batch([
        db.prepare(`INSERT INTO payments (id, order_id, amount_paise, method, reference, status, received_at, note, recorded_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .bind(id, order.id, body.amountPaise, body.method, body.reference, pending ? "pending" : "cleared", body.receivedAt, body.note, ctx.user.id, now, now),
        logBy(ctx, { action: "payment.recorded", entityType: "payment", entityId: id, customerId: order.customerId,
          summary: `Recorded ${formatPaise(body.amountPaise)} by ${body.method}${pending ? " (cheque not cleared yet)" : ""} for order ${order.code}` }),
    ]);
    // The payment is on file whatever happens next; a payment that lands with this one is counted too.
    if (!pending) await settleOrder(ctx.deps, order.id, ctx.user.id, (m) => console.warn(m));
    await afterPaid(ctx, order.id);
    return json({ order: await orderDetail(ctx, order.id) }, 201);
  } },

  { method: "POST", path: path("/payments/:id/status"), permission: "payments.record", handler: async (ctx) => {
    const { status } = await readBody(ctx.request, z.object({ status: z.enum(["cleared", "bounced"]) }).strict());
    const scope = ownedBy(ctx.user, "c.owner_id");
    const payment = await ctx.deps.db.prepare(`SELECT p.id, p.order_id AS orderId, p.amount_paise AS amountPaise, p.status, o.code, o.customer_id AS customerId FROM payments p
      JOIN orders o ON o.id = p.order_id JOIN customers c ON c.id = o.customer_id WHERE p.id = ? AND ${scope.sql}`).bind(ctx.params[0], ...scope.binds)
      .first<{ id: string; orderId: string; amountPaise: number; status: string; code: string; customerId: string }>();
    if (!payment) throw notFound("That payment");
    if (payment.status !== "pending") throw conflict("Only a cheque that hasn't cleared can change.", "not_pending");
    const { db } = ctx.deps, now = ctx.deps.now();
    await db.batch([
      db.prepare(`UPDATE payments SET status = ?, updated_at = ? WHERE id = ? AND status = 'pending'`).bind(status, now, payment.id),
      logBy(ctx, { action: `payment.${status}`, entityType: "payment", entityId: payment.id, customerId: payment.customerId,
        summary: `Cheque of ${formatPaise(payment.amountPaise)} for order ${payment.code} ${status === "cleared" ? "cleared" : "bounced"}` }),
    ]);
    if (status === "cleared") await settleOrder(ctx.deps, payment.orderId, ctx.user.id, (m) => console.warn(m));
    await afterPaid(ctx, payment.orderId);
    return json({ order: await orderDetail(ctx, payment.orderId) });
  } },

  // Razorpay sends the link to the customer by SMS and email; paying it records the payment and completes the order through the webhook.
  { method: "POST", path: path("/orders/:id/payment-link"), permission: "orders.write", handler: async (ctx) => {
    const order: OrderDetail = await orderDetail(ctx, ctx.params[0]!);
    if (order.status !== "confirmed" || order.kind === "trial") throw conflict("Only a confirmed order waiting for payment gets a payment link.", "not_payable");
    const owing = order.totalPaise - order.paidPaise;
    if (owing < 100) throw conflict("Nothing is left to pay on this order.", "nothing_owed");
    const razorpay = razorpayFor(ctx.env);
    if (!razorpay) throw new HttpError(503, "Razorpay isn't set up on this portal yet. Record the payment when it arrives instead.", "razorpay_missing");
    const { db } = ctx.deps, now = ctx.deps.now();
    const customer = (await db.prepare(`SELECT business_name AS name, email, phone FROM customers WHERE id = ?`).bind(order.customer.id).first<{ name: string; email: string | null; phone: string | null }>())!;
    const contact = razorpayContact(customer.phone);
    if (!customer.email && !contact) throw conflict("Add the customer's phone or email first, so Razorpay can send the link.", "no_contact");
    const attempt = ((await db.prepare(`SELECT MAX(attempt) AS top FROM payment_links WHERE order_id = ?`).bind(order.id).first<{ top: number | null }>())?.top ?? 0) + 1;
    const referenceId = `${order.code}-${attempt}`, expireBy = now + LINK_DAYS * 86_400_000;
    let link;
    try {
      link = await razorpay.createPaymentLink({
        amountPaise: owing, referenceId, expireBy, description: `ForkFlow order ${order.code}`,
        customer: { name: customer.name, email: customer.email, contact }, notes: { orderId: order.id, orderCode: order.code },
      });
    } catch (error) {
      console.warn(`payment link for ${order.code} failed: ${error instanceof Error ? error.message : String(error)}`);
      throw new HttpError(502, "Razorpay didn't create the link. Try again in a minute.", "razorpay_failed");
    }
    await db.batch([
      db.prepare(`INSERT INTO payment_links (id, order_id, attempt, reference_id, short_url, amount_paise, status, expire_by, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(link.id, order.id, attempt, referenceId, link.shortUrl, owing, link.status, expireBy, ctx.user.id, now, now),
      logBy(ctx, { action: "payment.link_sent", entityType: "order", entityId: order.id, customerId: order.customer.id,
        summary: `Sent a payment link for ${formatPaise(owing)} on order ${order.code}${[customer.email, contact].filter(Boolean).length ? ` to ${[customer.email, contact].filter(Boolean).join(" and ")}` : ""}` }),
    ]);
    return json({ order: await orderDetail(ctx, order.id), link: { id: link.id, shortUrl: link.shortUrl } }, 201);
  } },

  { method: "POST", path: path("/payment-links/(plink_[A-Za-z0-9]{6,40})/cancel"), permission: "orders.write", handler: async (ctx) => {
    const scope = ownedBy(ctx.user, "c.owner_id");
    const link = await ctx.deps.db.prepare(`SELECT l.id, l.order_id AS orderId, l.status, o.code, o.customer_id AS customerId FROM payment_links l JOIN orders o ON o.id = l.order_id
      JOIN customers c ON c.id = o.customer_id WHERE l.id = ? AND ${scope.sql}`).bind(ctx.params[0], ...scope.binds).first<{ id: string; orderId: string; status: string; code: string; customerId: string }>();
    if (!link) throw notFound("That payment link");
    if (link.status !== "created") throw conflict("Only an unpaid, open link can be cancelled.", "not_open");
    const razorpay = razorpayFor(ctx.env);
    if (!razorpay) throw new HttpError(503, "Razorpay isn't set up on this portal.", "razorpay_missing");
    try { await razorpay.cancelPaymentLink(link.id); }
    catch { throw new HttpError(502, "Razorpay didn't cancel the link. Try again in a minute.", "razorpay_failed"); }
    const { db } = ctx.deps, now = ctx.deps.now();
    await db.batch([
      db.prepare(`UPDATE payment_links SET status = 'cancelled', updated_at = ? WHERE id = ?`).bind(now, link.id),
      logBy(ctx, { action: "payment.link_cancelled", entityType: "order", entityId: link.orderId, customerId: link.customerId, summary: `Cancelled a payment link on order ${link.code}` }),
    ]);
    return json({ order: await orderDetail(ctx, link.orderId) });
  } },
];
