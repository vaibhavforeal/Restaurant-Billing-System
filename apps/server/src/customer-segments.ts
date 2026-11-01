import {
  SEGMENT_CSV_COLUMNS, SegmentFilter, SegmentSave, addMonths, catalogCsv, localDateKey, matchesSegment, tierFor, uuidv7,
  type Database, type SavedSegment, type SegmentCustomer, type SegmentFilterValue,
} from "@masalapos/domain";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { httpError } from "./http-error.js";
import { requireIntegration } from "./integrations.js";
import { loyaltySettings, loyaltyTiers, sweepAllExpiry } from "./loyalty.js";

const TAG_SEPARATOR = "\u001f";

/**
 * One summary row per customer for segment rules: lifetime visits and spend (void bills left out, refunds subtracted),
 * last visit, points balance and the tier their spend in the tier window reaches. Expired points are swept first so the
 * balance is what they can spend.
 */
export function segmentCustomers(db: Database, now = Date.now()): SegmentCustomer[] {
  sweepAllExpiry(db, now);
  const settings = loyaltySettings(db);
  const tiers = settings.tiersEnabled ? loyaltyTiers(db).filter((t) => t.isActive) : [];
  const windowStart = addMonths(now, -settings.tierWindowMonths);
  const net = (where: string) => `COALESCE((SELECT SUM(b.total_paise) FROM bills b WHERE b.customer_id = c.id AND b.status <> 'void'${where}), 0)
    - COALESCE((SELECT SUM(cn.total_paise) FROM credit_notes cn JOIN bills b ON b.id = cn.bill_id WHERE b.customer_id = c.id AND b.status <> 'void'${where}), 0)`;
  const rows = db.prepare(`SELECT c.id, c.name, c.phone, c.email, c.type_id, t.name AS type_name, c.created_at, c.birth_date, c.anniversary_date,
      c.marketing_opt_in, c.is_active,
      (SELECT group_concat(tag, '${TAG_SEPARATOR}') FROM customer_tags g WHERE g.customer_id = c.id) AS tags,
      (SELECT COUNT(*) FROM bills b WHERE b.customer_id = c.id AND b.status <> 'void') AS visits,
      (SELECT MAX(b.created_at) FROM bills b WHERE b.customer_id = c.id AND b.status <> 'void') AS last_visit,
      ${net("")} AS spend, ${net(" AND b.created_at >= @windowStart")} AS window_spend,
      COALESCE((SELECT SUM(points) FROM loyalty_ledger l WHERE l.customer_id = c.id), 0) AS points
    FROM customers c LEFT JOIN customer_types t ON t.id = c.type_id ORDER BY c.name COLLATE NOCASE, c.id`).all({ windowStart }) as Array<{
      id: string; name: string; phone: string; email: string | null; type_id: string | null; type_name: string | null; created_at: number;
      birth_date: string | null; anniversary_date: string | null; marketing_opt_in: number; is_active: number; tags: string | null;
      visits: number; last_visit: number | null; spend: number; window_spend: number; points: number;
    }>;
  return rows.map((r) => {
    const tier = tierFor(tiers, r.window_spend);
    return {
      id: r.id, name: r.name, phone: r.phone, email: r.email, typeId: r.type_id, typeName: r.type_name, tierId: tier?.id ?? null, tierName: tier?.name ?? null,
      tags: r.tags ? r.tags.split(TAG_SEPARATOR) : [], visits: r.visits, spendPaise: r.spend, lastVisitAt: r.last_visit, createdAt: r.created_at,
      points: r.points, birthDate: r.birth_date, anniversaryDate: r.anniversary_date, marketingOptIn: r.marketing_opt_in === 1, isActive: r.is_active === 1,
    };
  });
}

export function runSegment(db: Database, filter: SegmentFilterValue, now = Date.now()): SegmentCustomer[] {
  const today = localDateKey(now);
  return segmentCustomers(db, now).filter((c) => matchesSegment(c, filter, now, today));
}

const day = (ms: number | null) => ms === null ? "" : localDateKey(ms);
export function segmentCsv(customers: SegmentCustomer[]): string {
  return catalogCsv([[...SEGMENT_CSV_COLUMNS], ...customers.map((c) => [
    c.name, c.phone, c.email ?? "", c.typeName ?? "", c.tierName ?? "", c.tags.join("; "), String(c.visits), (c.spendPaise / 100).toFixed(2),
    day(c.lastVisitAt), String(c.points), c.birthDate ?? "", c.anniversaryDate ?? "", c.marketingOptIn ? "Yes" : "No",
  ])]);
}

export function registerCustomerSegments(app: FastifyInstance): void {
  const db = app.db;
  const crm = requireIntegration(app, "crm");
  const read = [app.requirePermission("customers.read"), crm];
  const manage = [app.requirePermission("customers.manage"), crm];
  const exporter = [app.requirePermission("crm.export"), crm];
  const segmentJson = (row: { id: string; name: string; filter_json: string; created_at: number; updated_at: number }): SavedSegment =>
    ({ id: row.id, name: row.name, filter: SegmentFilter.parse(JSON.parse(row.filter_json)), createdAt: row.created_at, updatedAt: row.updated_at });
  const getSegment = (id: string) => {
    const row = db.prepare("SELECT * FROM customer_segments WHERE id = ?").get(id) as Parameters<typeof segmentJson>[0] | undefined;
    if (!row) throw httpError(404, "segment not found");
    return segmentJson(row);
  };
  const nameTaken = (name: string, exceptId = "") => {
    if (db.prepare("SELECT 1 FROM customer_segments WHERE name = ? COLLATE NOCASE AND id <> ?").get(name, exceptId)) throw httpError(409, "A segment with this name already exists");
  };

  app.post("/api/customer-segments/preview", { preHandler: read }, async (req) => {
    const { filter } = z.object({ filter: SegmentFilter }).parse(req.body);
    const customers = runSegment(db, filter);
    return { count: customers.length, optedIn: customers.filter((c) => c.marketingOptIn).length, customers: customers.slice(0, 200) };
  });
  /** CSV of the segment's customers. Only those who opted in to marketing unless `all` is set: the restaurant decides, the file says which. */
  app.post("/api/customer-segments/export", { preHandler: exporter }, async (req, reply) => {
    const { filter, all } = z.object({ filter: SegmentFilter, all: z.boolean().default(false) }).parse(req.body);
    const customers = runSegment(db, all ? filter : { ...filter, optedInOnly: true });
    reply.header("Cache-Control", "no-store").type("text/csv; charset=utf-8");
    return segmentCsv(customers);
  });

  app.get("/api/customer-segments", { preHandler: read }, async () => ({
    segments: (db.prepare("SELECT * FROM customer_segments ORDER BY name COLLATE NOCASE").all() as Array<Parameters<typeof segmentJson>[0]>).map(segmentJson),
  }));
  app.post("/api/customer-segments", { preHandler: manage }, async (req, reply) => {
    const body = SegmentSave.parse(req.body);
    nameTaken(body.name);
    const id = uuidv7(), now = Date.now();
    db.prepare("INSERT INTO customer_segments (id, name, filter_json, created_at, updated_at, created_by) VALUES (?, ?, ?, ?, ?, ?)")
      .run(id, body.name, JSON.stringify(body.filter), now, now, req.user.id);
    return reply.status(201).send({ segment: getSegment(id) });
  });
  app.put("/api/customer-segments/:id", { preHandler: manage }, async (req) => {
    const { id } = req.params as { id: string };
    const body = SegmentSave.parse(req.body);
    getSegment(id);
    nameTaken(body.name, id);
    db.prepare("UPDATE customer_segments SET name = ?, filter_json = ?, updated_at = ? WHERE id = ?").run(body.name, JSON.stringify(body.filter), Date.now(), id);
    return { segment: getSegment(id) };
  });
  app.delete("/api/customer-segments/:id", { preHandler: manage }, async (req, reply) => {
    const { id } = req.params as { id: string };
    getSegment(id);
    db.prepare("DELETE FROM customer_segments WHERE id = ?").run(id);
    return reply.status(204).send();
  });
}
