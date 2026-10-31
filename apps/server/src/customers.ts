import {
  CustomerCreate, CustomerTypeCreate, CustomerTypeUpdate, CustomerUpdate, LoyaltyAdjust, LoyaltySettingsUpdate, OrderCustomerSet,
  bestSlabPercent, percentOf, uuidv7, type Database, type SlabRule,
} from "@masalapos/domain";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { httpError } from "./http-error.js";
import { crmEnabled, requireIntegration } from "./integrations.js";
import { currentTier, customerSpend, earnExpiry, loyaltySettings, pointsExpiringSoon, sweepExpiry } from "./loyalty.js";
import { customerJson, loadOrderJson, pointsBalance } from "./mappers.js";

export { customerJson, pointsBalance, loyaltySettings };
export type { LoyaltySettings } from "./loyalty.js";

/** Visits, spend and favourite items over a customer's whole history; void bills are left out and refunds subtracted. */
function customerStats(db: Database, id: string) {
  const visits = db.prepare(`SELECT COUNT(*) AS visits, MIN(created_at) AS firstVisitAt, MAX(created_at) AS lastVisitAt
    FROM bills WHERE customer_id = ? AND status <> 'void'`).get(id) as { visits: number; firstVisitAt: number | null; lastVisitAt: number | null };
  const spendPaise = customerSpend(db, id);
  const favourites = db.prepare(`SELECT l.name, SUM(l.qty) AS qty FROM bill_report_lines l JOIN bills b ON b.id = l.bill_id
    WHERE b.customer_id = ? AND b.status <> 'void' GROUP BY l.name ORDER BY qty DESC, l.name LIMIT 5`).all(id) as Array<{ name: string; qty: number }>;
  return { ...visits, spendPaise, averageBillPaise: visits.visits ? Math.round(spendPaise / visits.visits) : 0, favourites };
}

const slabsOf = (db: Database, typeId: string) => db.prepare(`SELECT min_bill_paise AS minBillPaise, percent, valid_from AS validFrom, valid_to AS validTo
  FROM customer_type_slabs WHERE type_id = ? ORDER BY min_bill_paise, percent`).all(typeId) as SlabRule[];

/** The slab discount an order's customer gets on this subtotal today: none without an active customer type. */
export function customerSlab(db: Database, customerId: string, subtotalPaise: number, date: string): { typeName: string; percent: number; discountPaise: number } | null {
  const type = db.prepare(`SELECT t.id, t.name FROM customers c JOIN customer_types t ON t.id = c.type_id WHERE c.id = ? AND t.is_active = 1`).get(customerId) as { id: string; name: string } | undefined;
  if (!type) return null;
  const percent = bestSlabPercent(slabsOf(db, type.id), subtotalPaise, date);
  return percent ? { typeName: type.name, percent, discountPaise: percentOf(subtotalPaise, percent) } : null;
}

/**
 * Loyalty after a credit note on a customer's bill. A void takes back every point the bill earned and returns the points it
 * redeemed. A refund takes back earned points in proportion to how much of the bill has now been credited. Balances may go
 * below zero when points were already spent. Call inside the credit note's transaction.
 */
export function reverseLoyalty(db: Database, input: { billId: string; creditNoteId: string; kind: "void" | "refund"; actorId: string; now: number }): void {
  const bill = db.prepare("SELECT customer_id, total_paise, points_redeemed FROM bills WHERE id = ?").get(input.billId) as { customer_id: string | null; total_paise: number; points_redeemed: number };
  if (!bill.customer_id) return;
  const sum = (where: string) => (db.prepare(`SELECT COALESCE(SUM(points), 0) AS n FROM loyalty_ledger WHERE bill_id = ? AND ${where}`).get(input.billId) as { n: number }).n;
  const earned = sum("kind = 'earn'");
  const takenBack = -sum("kind = 'reverse' AND points < 0");
  const returned = sum("kind = 'reverse' AND points > 0");
  const credited = (db.prepare("SELECT COALESCE(SUM(total_paise), 0) AS n FROM credit_notes WHERE bill_id = ?").get(input.billId) as { n: number }).n;
  // Earned points that have since expired are already gone; taking them back again would charge the customer twice.
  const lapsed = (db.prepare(`SELECT COALESCE(-SUM(e.points), 0) AS n FROM loyalty_ledger e JOIN loyalty_ledger l ON e.client_ref = 'expire:' || l.id
    WHERE l.bill_id = ? AND l.kind = 'earn'`).get(input.billId) as { n: number }).n;
  const share = input.kind === "void" || bill.total_paise <= 0 ? earned : Math.min(earned, Math.floor(earned * credited / bill.total_paise));
  const target = Math.max(0, share - lapsed);
  const write = (points: number, note: string) => db.prepare(`INSERT INTO loyalty_ledger (id, customer_id, kind, points, bill_id, credit_note_id, note, created_at, created_by)
    VALUES (?, ?, 'reverse', ?, ?, ?, ?, ?, ?)`).run(uuidv7(), bill.customer_id, points, input.billId, input.creditNoteId, note, input.now, input.actorId);
  if (target > takenBack) write(-(target - takenBack), input.kind === "void" ? "Bill voided" : "Bill refunded");
  if (input.kind === "void" && bill.points_redeemed > returned) write(bill.points_redeemed - returned, "Redeemed points returned on void");
}

export function registerCustomers(app: FastifyInstance): void {
  const db = app.db;
  // Every customer route needs CRM & Loyalty on in the Marketplace, after the usual permission.
  const crm = requireIntegration(app, "crm");
  const read = [app.requirePermission("customers.read"), crm];
  const manage = [app.requirePermission("customers.manage"), crm];
  const admin = [app.requirePermission("settings.manage"), crm];
  const typeExists = (id: string | null | undefined) => {
    if (id && !db.prepare("SELECT 1 FROM customer_types WHERE id = ?").get(id)) throw httpError(400, "Choose a customer type");
  };
  const phoneTaken = (phone: string, exceptId = "") => {
    const row = db.prepare("SELECT name FROM customers WHERE phone = ? AND id <> ?").get(phone, exceptId) as { name: string } | undefined;
    if (row) throw httpError(409, `This number belongs to ${row.name}`);
  };

  const saveTags = (customerId: string, tags: string[]) => {
    db.prepare("DELETE FROM customer_tags WHERE customer_id = ?").run(customerId);
    for (const tag of tags) db.prepare("INSERT INTO customer_tags (customer_id, tag) VALUES (?, ?)").run(customerId, tag);
  };

  /** Searches by phone prefix or name. Inactive customers are left out unless `inactive=1`; `tag` keeps only customers with that tag. */
  app.get("/api/customers", { preHandler: read }, async (req) => {
    const { q, inactive, tag } = z.object({
      q: z.string().trim().max(80).default(""), inactive: z.enum(["0", "1"]).default("0"), tag: z.string().trim().max(30).default(""),
    }).parse(req.query);
    const digits = q.replace(/\D/g, "").replace(/^(91|0)(?=\d{10}$)/, "");
    const where = [
      ...(q ? ["((? <> '' AND phone LIKE ? || '%') OR name LIKE '%' || ? || '%' COLLATE NOCASE)"] : []),
      ...(inactive === "1" ? [] : ["is_active = 1"]),
      ...(tag ? ["EXISTS (SELECT 1 FROM customer_tags t WHERE t.customer_id = customers.id AND t.tag = ?)"] : []),
    ];
    const params = [...(q ? [digits, digits, q] : []), ...(tag ? [tag] : [])];
    const rows = db.prepare(`SELECT id FROM customers ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY ${q ? "name COLLATE NOCASE" : "created_at DESC"} LIMIT 50`).all(...params) as Array<{ id: string }>;
    return { customers: rows.map((r) => customerJson(db, r.id)!) };
  });
  app.get("/api/customer-tags", { preHandler: read }, async () => ({
    tags: db.prepare("SELECT tag, COUNT(*) AS count FROM customer_tags GROUP BY tag COLLATE NOCASE ORDER BY tag COLLATE NOCASE").all(),
  }));
  /** The customer's profile: stats, tier progress, points expiring soon, feedback, points history and bills (paged by `billsBefore`). */
  app.get("/api/customers/:id", { preHandler: read }, async (req) => {
    const { id } = req.params as { id: string };
    const { billsBefore } = z.object({ billsBefore: z.coerce.number().int().positive().optional() }).parse(req.query);
    if (!db.prepare("SELECT 1 FROM customers WHERE id = ?").get(id)) throw httpError(404, "customer not found");
    const now = Date.now();
    db.transaction(() => sweepExpiry(db, id, now))();
    const customer = customerJson(db, id)!;
    const ledger = db.prepare(`SELECT l.id, l.kind, l.points, l.note, l.created_at AS createdAt, l.expires_at AS expiresAt, b.bill_no AS billNo, u.name AS createdByName
      FROM loyalty_ledger l LEFT JOIN bills b ON b.id = l.bill_id JOIN users u ON u.id = l.created_by WHERE l.customer_id = ? ORDER BY l.created_at DESC, l.id DESC LIMIT 100`).all(id);
    const bills = db.prepare(`SELECT id, bill_no AS billNo, created_at AS createdAt, total_paise AS totalPaise, status FROM bills
      WHERE customer_id = ? AND created_at < ? ORDER BY created_at DESC, bill_no DESC LIMIT 21`).all(id, billsBefore ?? Number.MAX_SAFE_INTEGER) as Array<{ createdAt: number }>;
    const feedback = db.prepare(`SELECT f.id, f.overall, f.food, f.service, f.ambience, f.comment, f.source, f.created_at AS createdAt, b.bill_no AS billNo
      FROM customer_feedback f JOIN bills b ON b.id = f.bill_id WHERE f.customer_id = ? ORDER BY f.created_at DESC LIMIT 20`).all(id);
    return {
      customer, stats: customerStats(db, id), tier: currentTier(db, id, now), expiringSoon: pointsExpiringSoon(db, id, now),
      ledger, bills: bills.slice(0, 20), moreBills: bills.length > 20, feedback,
    };
  });
  app.post("/api/customers", { preHandler: manage }, async (req, reply) => {
    const body = CustomerCreate.parse(req.body);
    typeExists(body.typeId); phoneTaken(body.phone);
    const id = uuidv7();
    db.transaction(() => {
      db.prepare(`INSERT INTO customers (id, name, phone, type_id, notes, email, birth_date, anniversary_date, gender, marketing_opt_in, created_at, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, body.name, body.phone, body.typeId, body.notes || null, body.email, body.birthDate,
        body.anniversaryDate, body.gender, body.marketingOptIn ? 1 : 0, Date.now(), req.user.id);
      saveTags(id, body.tags);
    })();
    return reply.status(201).send({ customer: customerJson(db, id) });
  });
  app.patch("/api/customers/:id", { preHandler: manage }, async (req) => {
    const { id } = req.params as { id: string };
    const body = CustomerUpdate.parse(req.body);
    const row = db.prepare("SELECT * FROM customers WHERE id = ?").get(id) as {
      name: string; phone: string; type_id: string | null; notes: string | null; email: string | null; birth_date: string | null;
      anniversary_date: string | null; gender: string | null; marketing_opt_in: number; is_active: number;
    } | undefined;
    if (!row) throw httpError(404, "customer not found");
    typeExists(body.typeId);
    if (body.phone) phoneTaken(body.phone, id);
    const keep = <T>(next: T | undefined, current: T) => next === undefined ? current : next;
    const flag = (next: boolean | undefined, current: number) => next === undefined ? current : next ? 1 : 0;
    db.transaction(() => {
      db.prepare(`UPDATE customers SET name = ?, phone = ?, type_id = ?, notes = ?, email = ?, birth_date = ?, anniversary_date = ?, gender = ?,
        marketing_opt_in = ?, is_active = ?, updated_at = ? WHERE id = ?`).run(body.name ?? row.name, body.phone ?? row.phone, keep(body.typeId, row.type_id),
        body.notes === undefined ? row.notes : body.notes || null, keep(body.email, row.email), keep(body.birthDate, row.birth_date),
        keep(body.anniversaryDate, row.anniversary_date), keep(body.gender, row.gender), flag(body.marketingOptIn, row.marketing_opt_in),
        flag(body.isActive, row.is_active), Date.now(), id);
      if (body.tags) saveTags(id, body.tags);
    })();
    return { customer: customerJson(db, id) };
  });
  app.post("/api/customers/:id/loyalty-adjustments", { preHandler: admin }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = LoyaltyAdjust.parse(req.body);
    const created = db.transaction(() => {
      const replay = db.prepare("SELECT customer_id, points, note FROM loyalty_ledger WHERE client_ref = ?").get(body.clientRef) as { customer_id: string; points: number; note: string } | undefined;
      if (replay) {
        if (replay.customer_id !== id || replay.points !== body.points || replay.note !== body.note) throw httpError(409, "Adjustment reference already used for a different request");
        return false;
      }
      if (!db.prepare("SELECT 1 FROM customers WHERE id = ?").get(id)) throw httpError(404, "customer not found");
      const now = Date.now();
      sweepExpiry(db, id, now);
      // Points given by hand expire like earned points; points taken away come out of the oldest points first.
      db.prepare("INSERT INTO loyalty_ledger (id, customer_id, kind, points, note, created_at, created_by, client_ref, expires_at) VALUES (?, ?, 'adjust', ?, ?, ?, ?, ?, ?)")
        .run(uuidv7(), id, body.points, body.note, now, req.user.id, body.clientRef, body.points > 0 ? earnExpiry(loyaltySettings(db), now) : null);
      return true;
    })();
    return reply.status(created ? 201 : 200).send({ customer: customerJson(db, id) });
  });

  const typeJson = (id: string) => {
    const row = db.prepare("SELECT id, name, is_active FROM customer_types WHERE id = ?").get(id) as { id: string; name: string; is_active: number };
    return { id: row.id, name: row.name, isActive: row.is_active === 1, slabs: slabsOf(db, id) };
  };
  const saveSlabs = (typeId: string, slabs: SlabRule[]) => {
    db.prepare("DELETE FROM customer_type_slabs WHERE type_id = ?").run(typeId);
    for (const s of slabs) db.prepare("INSERT INTO customer_type_slabs (id, type_id, min_bill_paise, percent, valid_from, valid_to) VALUES (?, ?, ?, ?, ?, ?)")
      .run(uuidv7(), typeId, s.minBillPaise, s.percent, s.validFrom, s.validTo);
  };
  const typeNameTaken = (name: string, exceptId = "") => {
    if (db.prepare("SELECT 1 FROM customer_types WHERE name = ? COLLATE NOCASE AND id <> ?").get(name, exceptId)) throw httpError(409, "A customer type with this name already exists");
  };
  app.get("/api/customer-types", { preHandler: read }, async () => ({
    customerTypes: (db.prepare("SELECT id FROM customer_types ORDER BY name COLLATE NOCASE").all() as Array<{ id: string }>).map((r) => typeJson(r.id)),
  }));
  app.post("/api/customer-types", { preHandler: admin }, async (req, reply) => {
    const body = CustomerTypeCreate.parse(req.body);
    typeNameTaken(body.name);
    const id = uuidv7();
    db.transaction(() => {
      db.prepare("INSERT INTO customer_types (id, name, created_at) VALUES (?, ?, ?)").run(id, body.name, Date.now());
      saveSlabs(id, body.slabs);
    })();
    return reply.status(201).send({ customerType: typeJson(id) });
  });
  app.patch("/api/customer-types/:id", { preHandler: admin }, async (req) => {
    const { id } = req.params as { id: string };
    const body = CustomerTypeUpdate.parse(req.body);
    const row = db.prepare("SELECT name, is_active FROM customer_types WHERE id = ?").get(id) as { name: string; is_active: number } | undefined;
    if (!row) throw httpError(404, "customer type not found");
    if (body.name) typeNameTaken(body.name, id);
    db.transaction(() => {
      db.prepare("UPDATE customer_types SET name = ?, is_active = ? WHERE id = ?").run(body.name ?? row.name, body.isActive === undefined ? row.is_active : body.isActive ? 1 : 0, id);
      if (body.slabs) saveSlabs(id, body.slabs);
    })();
    return { customerType: typeJson(id) };
  });

  app.get("/api/loyalty-settings", { preHandler: read }, async () => ({ settings: loyaltySettings(db) }));
  app.put("/api/loyalty-settings", { preHandler: admin }, async (req) => {
    const body = LoyaltySettingsUpdate.parse(req.body);
    const current = loyaltySettings(db);
    // A new expiry period applies to points earned from now on; points already earned keep their date.
    db.prepare(`UPDATE loyalty_settings SET enabled = ?, points_per_100 = ?, point_value_paise = ?, min_redeem_points = ?, expiry_months = ?,
      tiers_enabled = ?, tier_window_months = ?, max_redeem_percent = ?, feedback_enabled = ? WHERE id = 1`).run(
      body.enabled ? 1 : 0, body.pointsPer100, body.pointValuePaise, body.minRedeemPoints, body.expiryMonths ?? current.expiryMonths,
      (body.tiersEnabled ?? current.tiersEnabled) ? 1 : 0, body.tierWindowMonths ?? current.tierWindowMonths,
      body.maxRedeemPercent ?? current.maxRedeemPercent, (body.feedbackEnabled ?? current.feedbackEnabled) ? 1 : 0);
    return { settings: loyaltySettings(db) };
  });

  app.patch("/api/orders/:id/customer", { preHandler: app.requirePermission("orders.update") }, async (req) => {
    const { id } = req.params as { id: string };
    const body = OrderCustomerSet.parse(req.body);
    db.transaction(() => {
      const order = db.prepare("SELECT type, status FROM orders WHERE id = ?").get(id) as { type: string; status: string } | undefined;
      if (!order) throw httpError(404, "order not found");
      if (order.status !== "open") throw httpError(409, "order is not open");
      if (order.type === "zomato") throw httpError(409, "Zomato orders belong to Zomato's customer", "zomato_order");
      const chosen = body.customerId ? db.prepare("SELECT is_active FROM customers WHERE id = ?").get(body.customerId) as { is_active: number } | undefined : null;
      if (body.customerId && !crmEnabled(db)) throw httpError(409, "CRM & Loyalty is turned off in the Marketplace", "integration_off");
      if (body.customerId && !chosen) throw httpError(400, "Choose a saved customer");
      if (chosen && !chosen.is_active) throw httpError(409, "This customer is marked inactive");
      db.prepare("UPDATE orders SET customer_id = ? WHERE id = ?").run(body.customerId, id);
    })();
    const order = loadOrderJson(db, id)!;
    app.broadcast("order.updated", { order });
    return { order };
  });
}
