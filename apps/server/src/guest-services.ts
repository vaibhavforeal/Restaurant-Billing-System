import { createHash } from "node:crypto";
import { ServiceSubmission, uuidv7, type ServiceReceipt, type ServiceRequest } from "@forkflow/domain";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { httpError } from "./http-error.js";

const TTL = 10 * 60 * 1000;
const COOLDOWN = 60 * 1000;
const idParams = z.object({ id: z.string().uuid() });
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const credential = (value: unknown) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value) ? value : null;
interface ServiceRow {
  id: string; client_ref: string; table_id: string; table_name: string; kind: ServiceReceipt["kind"];
  receipt_hash: string; fingerprint: string; status: ServiceReceipt["status"];
  created_at: number; expires_at: number; resolved_at: number | null; resolved_by: string | null; resolved_by_name: string | null;
}
const receiptJson = (row: ServiceRow): ServiceReceipt => ({ id: row.id, kind: row.kind, status: row.status,
  tableName: row.table_name, createdAt: row.created_at, expiresAt: row.expires_at, resolvedAt: row.resolved_at });
const requestJson = (row: ServiceRow): ServiceRequest => ({ ...receiptJson(row), tableId: row.table_id, resolvedByName: row.resolved_by_name });

/** Calls and bill requests only notify staff; these routes never mutate a sale. */
export function registerGuestServices(app: FastifyInstance) {
  const db = app.db;
  const noStore = async (_req: FastifyRequest, reply: FastifyReply) => { reply.header("Cache-Control", "no-store"); };
  const requestSql = "SELECT r.*, u.name AS resolved_by_name FROM guest_service_requests r LEFT JOIN users u ON u.id = r.resolved_by";
  const getRequest = (id: string) => db.prepare(`${requestSql} WHERE r.id = ?`).get(id) as ServiceRow | undefined;
  const changed = () => app.broadcast("service-request.changed", {});
  function expire() {
    const result = db.prepare("UPDATE guest_service_requests SET status = 'expired' WHERE status = 'pending' AND expires_at <= ?").run(Date.now());
    if (result.changes) changed();
  }

  const rates = new Map<string, { until: number; count: number }>();
  function rate(req: FastifyRequest, action: "submit" | "status", limit: number) {
    const now = Date.now(), key = `${action}:${req.ip}`;
    if (rates.size >= 10_000) {
      for (const [entry, value] of rates) if (value.until <= now) rates.delete(entry);
      if (rates.size >= 10_000 && !rates.has(key)) throw httpError(429, "Please wait a minute and try again");
    }
    let value = rates.get(key);
    if (!value || value.until <= now) { value = { until: now + 60_000, count: 0 }; rates.set(key, value); }
    if (++value.count > limit) throw httpError(429, "Please wait a minute and try again");
  }
  function requireGuestPlan() {
    const status = app.licensing.status();
    if (!["development", "active", "grace"].includes(status.state)) throw httpError(403, "The restaurant is temporarily unavailable. Please ask a member of staff.");
    if (!status.features.qrOrdering) throw httpError(403, "Please ask a member of staff for assistance.");
  }

  app.post("/api/guest/service-requests", { bodyLimit: 4096, onRequest: noStore }, async (req, reply) => {
    rate(req, "submit", 30);
    const body = ServiceSubmission.parse(req.body), token = credential(req.headers["x-qr-token"]);
    const fingerprint = hash(JSON.stringify({ ...body, qrToken: token }));
    expire();
    const result = db.transaction(() => {
      // Recovery uses the original capability and receipt secret, so a lost
      // response remains recoverable after a downgrade, rotation or expiry.
      const existing = db.prepare(`${requestSql} WHERE r.client_ref = ?`).get(body.clientRef) as ServiceRow | undefined;
      if (existing) {
        if (existing.receipt_hash !== hash(body.receiptToken)) throw httpError(404, "Request not found");
        if (existing.fingerprint !== fingerprint) throw httpError(409, "This request reference was already used. Check its status before calling again.");
        return { id: existing.id, created: false };
      }
      requireGuestPlan();
      const table = token ? db.prepare(`SELECT t.id, t.name FROM dining_tables t JOIN table_qr q ON q.table_id = t.id
        WHERE q.token = ? AND q.enabled = 1 AND t.is_active = 1`).get(token) as { id: string; name: string } | undefined : undefined;
      if (!table) throw httpError(404, "This table is unavailable. Please ask a member of staff.");
      if (db.prepare("SELECT id FROM guest_service_requests WHERE table_id = ? AND kind = ? AND status = 'pending'").get(table.id, body.kind)) {
        throw httpError(409, "A request for this service is already waiting for staff.");
      }
      const now = Date.now();
      const recent = db.prepare("SELECT created_at FROM guest_service_requests WHERE table_id = ? AND kind = ? ORDER BY created_at DESC LIMIT 1")
        .get(table.id, body.kind) as { created_at: number } | undefined;
      if (recent && now < recent.created_at + COOLDOWN) throw httpError(429, "Please wait a minute before requesting this service again.");
      const id = uuidv7();
      db.prepare(`INSERT INTO guest_service_requests (id, client_ref, table_id, table_name, kind, receipt_hash, fingerprint, created_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, body.clientRef, table.id, table.name, body.kind, hash(body.receiptToken), fingerprint, now, now + TTL);
      return { id, created: true };
    }).immediate();
    if (result.created) changed();
    return reply.status(result.created ? 201 : 200).send({ request: receiptJson(getRequest(result.id)!) });
  });

  app.get("/api/guest/service-requests/:id", { onRequest: noStore }, async (req) => {
    rate(req, "status", 600);
    const { id } = idParams.parse(req.params), token = credential(req.headers["x-guest-receipt"]);
    expire();
    const row = getRequest(id);
    if (!row || !token || row.receipt_hash !== hash(token)) throw httpError(404, "Request not found");
    return { request: receiptJson(row) };
  });

  app.get("/api/qr/service-requests", { onRequest: noStore, preHandler: app.requirePermission("orders.read") }, async (req) => {
    expire();
    const { status } = z.object({ status: z.enum(["pending", "resolved", "expired", "all"]).default("pending") }).strict().parse(req.query);
    const rows = status === "all" ? db.prepare(`${requestSql} ORDER BY r.created_at DESC, r.id DESC LIMIT 100`).all()
      : db.prepare(`${requestSql} WHERE r.status = ? ORDER BY r.created_at DESC, r.id DESC LIMIT 100`).all(status);
    return { requests: (rows as ServiceRow[]).map(requestJson) };
  });

  app.post("/api/qr/service-requests/:id/resolve", { bodyLimit: 4096, onRequest: noStore, preHandler: app.requirePermission("orders.update") }, async (req) => {
    const { id } = idParams.parse(req.params);
    z.object({}).strict().parse(req.body ?? {});
    expire();
    const didResolve = db.transaction(() => {
      const row = getRequest(id);
      if (!row) throw httpError(404, "Request not found");
      if (row.status === "resolved") return false;
      if (row.status !== "pending") throw httpError(409, "This request has expired");
      db.prepare("UPDATE guest_service_requests SET status = 'resolved', resolved_at = ?, resolved_by = ? WHERE id = ?")
        .run(Date.now(), req.user.id, id);
      return true;
    }).immediate();
    if (didResolve) changed();
    return { request: requestJson(getRequest(id)!) };
  });
}
