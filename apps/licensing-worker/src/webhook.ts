import type { Deps } from "./issue.js";
import { cancelOpenLinks, settlementStatements } from "./portal/payments.js";
import { formatPaise } from "./portal/shared.js";
import { verifyWebhookSignature, type RazorpayApi } from "./razorpay.js";
import { activityStatement, eventSeen, recordEventStatement } from "./store.js";

export type WebhookDeps = Deps & { webhookSecret: string; razorpay: RazorpayApi | null; log: (msg: string) => void };

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const child = (v: unknown, key: string): unknown => (isRecord(v) ? v[key] : undefined);

/**
 * Razorpay webhooks. Every signed event is recorded once by its event id, so a replay is answered `duplicate` and changes nothing.
 * payment_link.paid (and partially_paid) records the payment against the link's order, once per Razorpay payment id, and completes the
 * order when it is paid in full: its licences, its tax invoice and its other open links. cancelled and expired only update the link.
 * Anything that fails is a 500, so Razorpay delivers the event again.
 */
export async function handleWebhook(deps: WebhookDeps, request: Request): Promise<Response> {
  const { db, log } = deps;
  const eventId = request.headers.get("x-razorpay-event-id");
  try {
    const rawBody = await request.text();
    if (!(await verifyWebhookSignature(rawBody, request.headers.get("x-razorpay-signature"), deps.webhookSecret))) return json({ error: "bad_signature" }, 400);
    if (!eventId) return json({ error: "missing_event_id" }, 400);
    if (await eventSeen(db, eventId)) return json({ outcome: "duplicate" });
    let body: unknown = null;
    try { body = JSON.parse(rawBody); } catch { /* signed but not JSON: nothing to act on */ }
    const type = typeof child(body, "event") === "string" ? child(body, "event") as string : "unknown";
    const now = deps.now();
    const record = async (outcome: string, detail?: string) => {
      if (detail) log(`webhook ${eventId} (${type}) ${outcome}: ${detail}`);
      await recordEventStatement(db, eventId, type, outcome, now).run();
      return json({ outcome });
    };

    const payload = child(body, "payload");
    const linkEntity = child(child(payload, "payment_link"), "entity");
    if (!type.startsWith("payment_link.") || typeof child(linkEntity, "id") !== "string") return await record("ignored");
    const linkId = child(linkEntity, "id") as string;
    const link = await db.prepare(`SELECT l.id, l.order_id AS orderId, o.code, o.customer_id AS customerId FROM payment_links l JOIN orders o ON o.id = l.order_id WHERE l.id = ?`)
      .bind(linkId).first<{ id: string; orderId: string; code: string; customerId: string }>();
    if (!link) return await record("unmatched", `unknown payment link ${linkId}`);
    const linkStatus = typeof child(linkEntity, "status") === "string" ? child(linkEntity, "status") as string : type.slice("payment_link.".length);
    const updateLink = db.prepare(`UPDATE payment_links SET status = ?, updated_at = ? WHERE id = ?`).bind(linkStatus, now, link.id);

    if (type !== "payment_link.paid" && type !== "payment_link.partially_paid") {
      await db.batch([updateLink, recordEventStatement(db, eventId, type, "status", now)]);
      return json({ outcome: "status" });
    }
    const payment = child(child(payload, "payment"), "entity");
    const paymentId = child(payment, "id"), amount = child(payment, "amount");
    if (typeof paymentId !== "string" || typeof amount !== "number" || !Number.isSafeInteger(amount) || amount <= 0) {
      return await record("unmatched", `${linkId} paid without a payment id or amount`);
    }
    if (await db.prepare(`SELECT 1 AS hit FROM payments WHERE razorpay_payment_id = ?`).bind(paymentId).first()) {
      await db.batch([updateLink, recordEventStatement(db, eventId, type, "duplicate_payment", now)]);
      return json({ outcome: "duplicate_payment" });
    }
    const method = typeof child(payment, "method") === "string" ? child(payment, "method") as string : "online";
    const settle = await settlementStatements(deps, link.orderId, null, amount);
    await db.batch([
      db.prepare(`INSERT INTO payments (id, order_id, amount_paise, method, reference, status, received_at, note, razorpay_payment_id, created_at, updated_at)
        VALUES (?, ?, ?, 'razorpay', ?, 'cleared', ?, ?, ?, ?, ?)`).bind(deps.uuid(), link.orderId, amount, paymentId, now, `Payment link, by ${method}`, paymentId, now, now),
      updateLink,
      activityStatement(db, now, { actorId: null, action: "payment.received", entityType: "order", entityId: link.orderId, customerId: link.customerId,
        summary: `Received ${formatPaise(amount)} through the payment link for order ${link.code}` }),
      ...settle,
      recordEventStatement(db, eventId, type, settle.length ? "paid" : "recorded", now),
    ]);
    // A link paid while another was still open: the other is cancelled so the customer can't pay twice. A failure only leaves it to expire.
    if (settle.length && deps.razorpay) await cancelOpenLinks(deps, deps.razorpay, link.orderId, log);
    return json({ outcome: settle.length ? "paid" : "recorded" });
  } catch (error) {
    log(`webhook ${eventId} failed: ${error instanceof Error ? error.message : String(error)}`);
    return json({ error: "unavailable" }, 500);
  }
}
