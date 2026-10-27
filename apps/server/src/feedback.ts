import { FeedbackSubmit, uuidv7, type Database } from "@forkflow/domain";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { httpError } from "./http-error.js";
import { loyaltySettings } from "./loyalty.js";
import { lanUrls } from "./system.js";

/** How long after the bill a guest may still rate the visit through the receipt's QR code. */
export const FEEDBACK_WINDOW_MS = 7 * 86_400_000;
const TOKEN = /^[A-Za-z0-9_-]{32}$/;

let serverPort = 4100;
/**
 * The link a receipt's QR code opens: this server's first LAN address, so it works for guests on the restaurant's Wi-Fi.
 * Worked out when the receipt is printed, so a changed IP address is picked up on the next print.
 */
export function feedbackUrl(token: string): string {
  const origin = lanUrls(serverPort)[0] ?? `http://localhost:${serverPort}`;
  return `${origin}/feedback/${token}`;
}

/** The feedback link for a bill, when feedback is on and the bill can still be rated. */
export function billFeedbackUrl(db: Database, billId: string): string | undefined {
  const row = db.prepare("SELECT feedback_token, status FROM bills WHERE id = ?").get(billId) as { feedback_token: string | null; status: string } | undefined;
  if (!row?.feedback_token || row.status === "void" || !loyaltySettings(db).feedbackEnabled) return undefined;
  return feedbackUrl(row.feedback_token);
}

interface TokenBill { id: string; bill_no: number; created_at: number; status: string; customer_id: string | null; restaurant_name: string }

export function registerFeedback(app: FastifyInstance, port = 4100): void {
  serverPort = port;
  const db = app.db;
  const billFor = (token: string) => {
    if (!TOKEN.test(token) || !loyaltySettings(db).feedbackEnabled) return undefined;
    return db.prepare(`SELECT b.id, b.bill_no, b.created_at, b.status, b.customer_id, s.restaurant_name FROM bills b, settings s
      WHERE s.id = 1 AND b.feedback_token = ?`).get(token) as TokenBill | undefined;
  };
  const submitted = (billId: string) => db.prepare("SELECT 1 FROM customer_feedback WHERE bill_id = ?").get(billId) !== undefined;

  // A restaurant Wi-Fi shares one IP, so the limits allow a busy dining room; tokens are unguessable either way.
  const rates = new Map<string, { until: number; count: number }>();
  function rate(req: FastifyRequest, action: string, limit: number) {
    const now = Date.now(), key = `${action}:${req.ip}`;
    if (rates.size >= 10_000) for (const [k, value] of rates) if (value.until <= now) rates.delete(k);
    let value = rates.get(key);
    if (!value || value.until <= now) { value = { until: now + 60_000, count: 0 }; rates.set(key, value); }
    if (++value.count > limit) throw httpError(429, "Please wait a minute and try again");
  }

  app.get("/api/guest/feedback/:token", async (req, reply) => {
    reply.header("Cache-Control", "no-store"); rate(req, "feedback-read", 240);
    const { token } = req.params as { token: string };
    const bill = billFor(token);
    if (!bill || bill.status === "void") throw httpError(404, "This feedback link is not valid");
    return {
      restaurantName: bill.restaurant_name, billNo: bill.bill_no, billedAt: bill.created_at,
      submitted: submitted(bill.id), open: Date.now() - bill.created_at <= FEEDBACK_WINDOW_MS,
    };
  });
  app.post("/api/guest/feedback/:token", { bodyLimit: 4_096 }, async (req, reply) => {
    reply.header("Cache-Control", "no-store"); rate(req, "feedback-submit", 30);
    const { token } = req.params as { token: string };
    const bill = billFor(token);
    if (!bill || bill.status === "void") throw httpError(404, "This feedback link is not valid");
    if (Date.now() - bill.created_at > FEEDBACK_WINDOW_MS) throw httpError(410, "Feedback for this bill has closed");
    const body = FeedbackSubmit.parse(req.body);
    const res = db.prepare(`INSERT OR IGNORE INTO customer_feedback (id, bill_id, customer_id, overall, food, service, ambience, comment, source, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'qr', ?)`).run(uuidv7(), bill.id, bill.customer_id, body.overall, body.food, body.service, body.ambience, body.comment, Date.now());
    if (!res.changes) throw httpError(409, "Thank you, this visit has already been rated");
    app.broadcast("feedback.created", { billId: bill.id });
    return reply.status(201).send({ ok: true });
  });

  /** Staff record a guest's rating for a bill, for example from a paper card. */
  app.post("/api/bills/:id/feedback", { preHandler: app.requirePermission("customers.manage") }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = FeedbackSubmit.parse(req.body);
    const bill = db.prepare("SELECT id, customer_id, status FROM bills WHERE id = ?").get(id) as { id: string; customer_id: string | null; status: string } | undefined;
    if (!bill) throw httpError(404, "bill not found");
    if (bill.status === "void") throw httpError(409, "This bill is void");
    const res = db.prepare(`INSERT OR IGNORE INTO customer_feedback (id, bill_id, customer_id, overall, food, service, ambience, comment, source, created_at, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'staff', ?, ?)`).run(uuidv7(), bill.id, bill.customer_id, body.overall, body.food, body.service, body.ambience, body.comment, Date.now(), req.user.id);
    if (!res.changes) throw httpError(409, "This bill already has feedback");
    app.broadcast("feedback.created", { billId: bill.id });
    return reply.status(201).send({ ok: true });
  });

  app.get("/api/feedback", { preHandler: app.requirePermission("customers.read") }, async (req) => {
    const q = z.object({
      from: z.coerce.number().int().min(0).optional(), to: z.coerce.number().int().min(0).optional(),
      maxRating: z.coerce.number().int().min(1).max(5).optional(), limit: z.coerce.number().int().min(1).max(500).default(200),
    }).parse(req.query);
    const rows = db.prepare(`SELECT f.id, f.overall, f.food, f.service, f.ambience, f.comment, f.source, f.created_at AS createdAt,
        b.id AS billId, b.bill_no AS billNo, c.id AS customerId, c.name AS customerName, c.phone AS customerPhone, u.name AS recordedBy
      FROM customer_feedback f JOIN bills b ON b.id = f.bill_id LEFT JOIN customers c ON c.id = f.customer_id LEFT JOIN users u ON u.id = f.created_by
      WHERE f.created_at >= ? AND f.created_at < ? AND f.overall <= ? ORDER BY f.created_at DESC LIMIT ?`)
      .all(q.from ?? 0, q.to ?? Number.MAX_SAFE_INTEGER, q.maxRating ?? 5, q.limit);
    const summary = db.prepare(`SELECT COUNT(*) AS count, AVG(overall) AS average, AVG(food) AS food, AVG(service) AS service, AVG(ambience) AS ambience
      FROM customer_feedback WHERE created_at >= ? AND created_at < ?`).get(q.from ?? 0, q.to ?? Number.MAX_SAFE_INTEGER);
    return { feedback: rows, summary };
  });
}
