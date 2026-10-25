import {
  CustomerCreate, CustomerTypeCreate, CustomerTypeUpdate, CustomerUpdate, LoyaltyAdjust, LoyaltySettingsUpdate, OrderCustomerSet,
  bestSlabPercent, percentOf, uuidv7, type Database, type SlabRule,
} from "@forkflow/domain";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { httpError } from "./http-error.js";
import { customerJson, loadOrderJson, pointsBalance } from "./mappers.js";

export { customerJson, pointsBalance };

export interface LoyaltySettings { enabled: boolean; pointsPer100: number; pointValuePaise: number; minRedeemPoints: number }

export function loyaltySettings(db: Database): LoyaltySettings {
  const r = db.prepare("SELECT enabled, points_per_100, point_value_paise, min_redeem_points FROM loyalty_settings WHERE id = 1").get() as
    { enabled: number; points_per_100: number; point_value_paise: number; min_redeem_points: number };
  return { enabled: r.enabled === 1, pointsPer100: r.points_per_100, pointValuePaise: r.point_value_paise, minRedeemPoints: r.min_redeem_points };
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
  const target = input.kind === "void" || bill.total_paise <= 0 ? earned : Math.min(earned, Math.floor(earned * credited / bill.total_paise));
  const write = (points: number, note: string) => db.prepare(`INSERT INTO loyalty_ledger (id, customer_id, kind, points, bill_id, credit_note_id, note, created_at, created_by)
    VALUES (?, ?, 'reverse', ?, ?, ?, ?, ?, ?)`).run(uuidv7(), bill.customer_id, points, input.billId, input.creditNoteId, note, input.now, input.actorId);
  if (target > takenBack) write(-(target - takenBack), input.kind === "void" ? "Bill voided" : "Bill refunded");
  if (input.kind === "void" && bill.points_redeemed > returned) write(bill.points_redeemed - returned, "Redeemed points returned on void");
}

export function registerCustomers(app: FastifyInstance): void {
  const db = app.db;
  const read = app.requirePermission("customers.read");
  const manage = app.requirePermission("customers.manage");
  const admin = app.requirePermission("settings.manage");
  const typeExists = (id: string | null | undefined) => {
    if (id && !db.prepare("SELECT 1 FROM customer_types WHERE id = ?").get(id)) throw httpError(400, "Choose a customer type");
  };
  const phoneTaken = (phone: string, exceptId = "") => {
    const row = db.prepare("SELECT name FROM customers WHERE phone = ? AND id <> ?").get(phone, exceptId) as { name: string } | undefined;
    if (row) throw httpError(409, `This number belongs to ${row.name}`);
  };

  app.get("/api/customers", { preHandler: read }, async (req) => {
    const { q } = z.object({ q: z.string().trim().max(80).default("") }).parse(req.query);
    const digits = q.replace(/\D/g, "").replace(/^(91|0)(?=\d{10}$)/, "");
    const rows = (q ? db.prepare(`SELECT id FROM customers WHERE (? <> '' AND phone LIKE ? || '%') OR name LIKE '%' || ? || '%' COLLATE NOCASE
      ORDER BY name COLLATE NOCASE LIMIT 50`).all(digits, digits, q) : db.prepare("SELECT id FROM customers ORDER BY created_at DESC LIMIT 50").all()) as Array<{ id: string }>;
    return { customers: rows.map((r) => customerJson(db, r.id)!) };
  });
  app.get("/api/customers/:id", { preHandler: read }, async (req) => {
    const { id } = req.params as { id: string };
    const customer = customerJson(db, id);
    if (!customer) throw httpError(404, "customer not found");
    const ledger = db.prepare(`SELECT l.id, l.kind, l.points, l.note, l.created_at AS createdAt, b.bill_no AS billNo, u.name AS createdByName
      FROM loyalty_ledger l LEFT JOIN bills b ON b.id = l.bill_id JOIN users u ON u.id = l.created_by WHERE l.customer_id = ? ORDER BY l.created_at DESC, l.id DESC LIMIT 100`).all(id);
    const bills = db.prepare(`SELECT id, bill_no AS billNo, created_at AS createdAt, total_paise AS totalPaise, status FROM bills WHERE customer_id = ? ORDER BY created_at DESC LIMIT 20`).all(id);
    return { customer, ledger, bills };
  });
  app.post("/api/customers", { preHandler: manage }, async (req, reply) => {
    const body = CustomerCreate.parse(req.body);
    typeExists(body.typeId); phoneTaken(body.phone);
    const id = uuidv7();
    db.prepare("INSERT INTO customers (id, name, phone, type_id, notes, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(id, body.name, body.phone, body.typeId, body.notes || null, Date.now(), req.user.id);
    return reply.status(201).send({ customer: customerJson(db, id) });
  });
  app.patch("/api/customers/:id", { preHandler: manage }, async (req) => {
    const { id } = req.params as { id: string };
    const body = CustomerUpdate.parse(req.body);
    const row = db.prepare("SELECT * FROM customers WHERE id = ?").get(id) as { name: string; phone: string; type_id: string | null; notes: string | null } | undefined;
    if (!row) throw httpError(404, "customer not found");
    typeExists(body.typeId);
    if (body.phone) phoneTaken(body.phone, id);
    db.prepare("UPDATE customers SET name = ?, phone = ?, type_id = ?, notes = ? WHERE id = ?").run(body.name ?? row.name, body.phone ?? row.phone,
      body.typeId === undefined ? row.type_id : body.typeId, body.notes === undefined ? row.notes : body.notes || null, id);
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
      db.prepare("INSERT INTO loyalty_ledger (id, customer_id, kind, points, note, created_at, created_by, client_ref) VALUES (?, ?, 'adjust', ?, ?, ?, ?, ?)")
        .run(uuidv7(), id, body.points, body.note, Date.now(), req.user.id, body.clientRef);
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
    db.prepare("UPDATE loyalty_settings SET enabled = ?, points_per_100 = ?, point_value_paise = ?, min_redeem_points = ? WHERE id = 1")
      .run(body.enabled ? 1 : 0, body.pointsPer100, body.pointValuePaise, body.minRedeemPoints);
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
      if (body.customerId && !db.prepare("SELECT 1 FROM customers WHERE id = ?").get(body.customerId)) throw httpError(400, "Choose a saved customer");
      db.prepare("UPDATE orders SET customer_id = ? WHERE id = ?").run(body.customerId, id);
    })();
    const order = loadOrderJson(db, id)!;
    app.broadcast("order.updated", { order });
    return { order };
  });
}
