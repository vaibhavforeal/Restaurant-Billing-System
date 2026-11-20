import { uuidv7, type Database } from "@masalapos/domain";
import { inOfferWindow, OfferRule, type Offer } from "@masalapos/domain/offers";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { httpError } from "./http-error.js";
import { requireModule } from "./modules.js";

export function readOffers(db: Database, activeOnly = false): Offer[] {
  const filter = activeOnly ? "WHERE json_extract(rule_json, '$.state') = 'active'" : "";
  const rows = db.prepare(`SELECT id, created_at, revision, rule_json FROM offers ${filter} ORDER BY created_at, id`).all() as
    Array<{ id: string; created_at: number; revision: number; rule_json: string }>;
  return rows.map(r => ({ ...JSON.parse(r.rule_json), id: r.id, createdAt: r.created_at, revision: r.revision }));
}

function validateTargets(db: Database, rule: OfferRule) {
  if (rule.benefit.kind !== "bogo" || rule.state !== "active") return;
  const valid = db.prepare(`SELECT 1 FROM products p WHERE p.id = ? AND p.addon_only = 0
    AND (? IS NULL OR EXISTS (SELECT 1 FROM variants v WHERE v.id = ? AND v.product_id = p.id))`);
  for (const t of [...rule.benefit.qualifying, ...rule.benefit.rewards]) {
    if (!valid.get(t.productId, t.variantId, t.variantId)) throw httpError(400, "Choose a menu dish or one of its variants for each offer target");
  }
}

export function registerOffers(app: FastifyInstance) {
  const preHandler = [app.requirePermission("integrations.configure"), async (req: FastifyRequest) => {
    if (req.user.role !== "admin") throw httpError(403, "Only admins can manage offers");
  }, requireModule(app, "offers")];
  app.get("/api/offers", { preHandler }, async () => {
    const time = Date.now();
    return { offers: readOffers(app.db).map(offer => ({ ...offer, inWindow: inOfferWindow(offer, time) })) };
  });
  app.post("/api/offers", { preHandler }, async (req, reply) => {
    const rule = OfferRule.parse(req.body);
    const { clientRef } = z.object({ clientRef: z.uuid().optional() }).parse(req.body);
    const id = clientRef ?? uuidv7();
    const json = JSON.stringify(rule);
    const existing = app.db.prepare("SELECT rule_json FROM offers WHERE id = ?").get(id) as { rule_json: string } | undefined;
    if (existing) {
      if (existing.rule_json !== json) throw httpError(409, "This offer already exists. Reload the offers list.");
      return { id };
    }
    validateTargets(app.db, rule);
    app.db.prepare("INSERT INTO offers (id, created_at, revision, rule_json) VALUES (?, ?, 1, ?)").run(id, Date.now(), json);
    return reply.code(201).send({ id });
  });
  app.put<{ Params: { id: string } }>("/api/offers/:id", { preHandler }, async req => {
    const { rule, revision } = z.object({ rule: OfferRule, revision: z.number().int().positive() }).parse(req.body);
    validateTargets(app.db, rule);
    const result = app.db.prepare("UPDATE offers SET rule_json = ?, revision = revision + 1 WHERE id = ? AND revision = ?").run(JSON.stringify(rule), req.params.id, revision);
    if (!result.changes) throw httpError(409, "This offer changed. Reload the offers list.");
    return { id: req.params.id };
  });
}
