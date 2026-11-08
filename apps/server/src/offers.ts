import { OfferInput, uuidv7, type Database, type Offer, type OfferInputValue } from "@masalapos/domain";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { httpError } from "./http-error.js";
import { requireModule } from "./modules.js";

interface OfferRow {
  id: string; name: string; active: number; kind: Offer["kind"]; buy_qty: number | null; get_qty: number | null; same_item_only: number;
  percent_bp: number | null; amount_paise: number | null; min_bill_paise: number; max_discount_paise: number | null;
  valid_from: string | null; valid_until: string | null; days_mask: number; time_from: number | null; time_until: number | null; created_at: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEKDAYS = [0, 1, 2, 3, 4, 5, 6];
/** Bit i of `days_mask` is weekday i, 0 = Monday to 6 = Sunday. */
const daysToMask = (days: number[]): number => days.reduce((mask, day) => mask | (1 << day), 0);
const maskToDays = (mask: number): number[] => WEEKDAYS.filter((day) => (mask & (1 << day)) !== 0);

function append(map: Map<string, string[]>, key: string, value: string): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

/** Every offer, switched off ones too, each with its item set and order types, oldest first. */
export function loadOffers(db: Database): Offer[] {
  const categoryIds = new Map<string, string[]>(), productIds = new Map<string, string[]>(), orderTypeIds = new Map<string, string[]>();
  for (const t of db.prepare("SELECT offer_id, category_id, product_id FROM offer_targets ORDER BY rowid").all() as Array<{ offer_id: string; category_id: string | null; product_id: string | null }>) {
    if (t.category_id !== null) append(categoryIds, t.offer_id, t.category_id);
    if (t.product_id !== null) append(productIds, t.offer_id, t.product_id);
  }
  for (const t of db.prepare("SELECT offer_id, order_type_id FROM offer_order_types ORDER BY rowid").all() as Array<{ offer_id: string; order_type_id: string }>) {
    append(orderTypeIds, t.offer_id, t.order_type_id);
  }
  return (db.prepare("SELECT * FROM offers ORDER BY created_at, id").all() as OfferRow[]).map((r) => ({
    id: r.id, name: r.name, active: r.active === 1, kind: r.kind,
    buyQty: r.buy_qty, getQty: r.get_qty, sameItemOnly: r.same_item_only === 1,
    percentBp: r.percent_bp, amountPaise: r.amount_paise, minBillPaise: r.min_bill_paise, maxDiscountPaise: r.max_discount_paise,
    categoryIds: categoryIds.get(r.id) ?? [], productIds: productIds.get(r.id) ?? [],
    validFrom: r.valid_from, validUntil: r.valid_until, days: maskToDays(r.days_mask), timeFrom: r.time_from, timeUntil: r.time_until,
    orderTypeIds: orderTypeIds.get(r.id) ?? [], createdAt: r.created_at,
  }));
}

const offerJson = (db: Database, id: string): Offer => loadOffers(db).find((o) => o.id === id)!;
const offerExists = (db: Database, id: string): boolean => db.prepare("SELECT 1 FROM offers WHERE id = ?").get(id) !== undefined;

/** The category, item and order type ids must exist, and Zomato (aggregator) orders take no offers. Throws a 400 naming the problem. */
function checkReferences(db: Database, offer: OfferInputValue): void {
  const known = (table: "categories" | "products", ids: string[]) => ids.every((id) => db.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(id) !== undefined);
  if (!known("categories", offer.categoryIds) || !known("products", offer.productIds)) throw httpError(400, "Pick categories and items from the menu");
  for (const id of offer.orderTypeIds) {
    const type = db.prepare("SELECT kind FROM order_types WHERE id = ?").get(id) as { kind: string } | undefined;
    if (!type) throw httpError(400, "Pick order types from the list");
    if (type.kind === "aggregator") throw httpError(400, "Zomato orders can't have offers");
  }
}

/** The offer's own columns, in the order the INSERT and UPDATE below list them. */
const columnValues = (offer: OfferInputValue) => [
  offer.name, offer.active ? 1 : 0, offer.kind, offer.buyQty, offer.getQty, offer.sameItemOnly ? 1 : 0, offer.percentBp, offer.amountPaise,
  offer.minBillPaise, offer.maxDiscountPaise, offer.validFrom, offer.validUntil, daysToMask(offer.days), offer.timeFrom, offer.timeUntil,
];

/** Replaces the item set and order types. Call inside a transaction. */
function saveLinks(db: Database, id: string, offer: OfferInputValue): void {
  db.prepare("DELETE FROM offer_targets WHERE offer_id = ?").run(id);
  db.prepare("DELETE FROM offer_order_types WHERE offer_id = ?").run(id);
  for (const categoryId of offer.categoryIds) db.prepare("INSERT INTO offer_targets (offer_id, category_id, product_id) VALUES (?, ?, NULL)").run(id, categoryId);
  for (const productId of offer.productIds) db.prepare("INSERT INTO offer_targets (offer_id, category_id, product_id) VALUES (?, NULL, ?)").run(id, productId);
  for (const orderTypeId of offer.orderTypeIds) db.prepare("INSERT INTO offer_order_types (offer_id, order_type_id) VALUES (?, ?)").run(id, orderTypeId);
}

const ActiveBody = z.object({ active: z.boolean() });

export function registerOffers(app: FastifyInstance): void {
  const db = app.db;
  const read = [app.requirePermission("catalog.read"), requireModule(app, "offers")];
  const manage = [app.requirePermission("catalog.manage"), requireModule(app, "offers")];

  app.get("/api/offers", { preHandler: read }, async () => {
    // A bill row is kept forever, so an offer with one is "used"; the 30-day count leaves out void bills.
    const since = Date.now() - 30 * DAY_MS;
    const usage = new Map((db.prepare(`SELECT bo.offer_id AS id, SUM(b.created_at >= ? AND b.status != 'void') AS recent
      FROM bill_offers bo JOIN bills b ON b.id = bo.bill_id GROUP BY bo.offer_id`).all(since) as Array<{ id: string; recent: number }>).map((r) => [r.id, r.recent]));
    return { offers: loadOffers(db).map((offer) => ({ ...offer, bills30d: usage.get(offer.id) ?? 0, used: usage.has(offer.id) })) };
  });

  app.post("/api/offers", { preHandler: manage }, async (req, reply) => {
    const body = OfferInput.parse(req.body);
    checkReferences(db, body);
    const id = uuidv7(), now = Date.now();
    db.transaction(() => {
      db.prepare(`INSERT INTO offers (name, active, kind, buy_qty, get_qty, same_item_only, percent_bp, amount_paise, min_bill_paise, max_discount_paise,
        valid_from, valid_until, days_mask, time_from, time_until, id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(...columnValues(body), id, now, now);
      saveLinks(db, id, body);
    })();
    return reply.status(201).send({ offer: offerJson(db, id) });
  });

  app.put("/api/offers/:id", { preHandler: manage }, async (req) => {
    const { id } = req.params as { id: string };
    const body = OfferInput.parse(req.body);
    if (!offerExists(db, id)) throw httpError(404, "offer not found");
    checkReferences(db, body);
    db.transaction(() => {
      db.prepare(`UPDATE offers SET name = ?, active = ?, kind = ?, buy_qty = ?, get_qty = ?, same_item_only = ?, percent_bp = ?, amount_paise = ?,
        min_bill_paise = ?, max_discount_paise = ?, valid_from = ?, valid_until = ?, days_mask = ?, time_from = ?, time_until = ?, updated_at = ? WHERE id = ?`)
        .run(...columnValues(body), Date.now(), id);
      saveLinks(db, id, body);
    })();
    return { offer: offerJson(db, id) };
  });

  app.patch("/api/offers/:id/active", { preHandler: manage }, async (req) => {
    const { id } = req.params as { id: string };
    const { active } = ActiveBody.parse(req.body);
    if (db.prepare("UPDATE offers SET active = ?, updated_at = ? WHERE id = ?").run(active ? 1 : 0, Date.now(), id).changes === 0) throw httpError(404, "offer not found");
    return { offer: offerJson(db, id) };
  });

  app.delete("/api/offers/:id", { preHandler: manage }, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!offerExists(db, id)) throw httpError(404, "offer not found");
    if (db.prepare("SELECT 1 FROM bill_offers WHERE offer_id = ? LIMIT 1").get(id) !== undefined) throw httpError(409, "This offer is on bills; switch it off instead", "offer_used");
    db.prepare("DELETE FROM offers WHERE id = ?").run(id); // its item set and order types go with it
    return reply.status(204).send();
  });
}
