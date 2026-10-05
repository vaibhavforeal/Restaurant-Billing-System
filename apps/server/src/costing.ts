import type { FastifyInstance } from "fastify";
import { UnitCostSet, stockJson, uuidv7, type StockRow } from "@forkflow/domain";
import { httpError } from "./http-error.js";
import { publishStock, versionCheck } from "./stock.js";

/** Every costing route needs the admin-only `costs.read` permission and the `recipes` plan. */
export function costGuards(app: FastifyInstance) {
  return [app.requirePermission("costs.read"), app.requireFeature("recipes")];
}

export function registerCosting(app: FastifyInstance): void {
  const db = app.db;
  const costs = costGuards(app);

  app.post("/api/stock-items/:id/unit-cost", { preHandler: costs }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = UnitCostSet.parse(req.body);
    const requestJson = JSON.stringify({ stockItemId: id, ...body });
    const created = db.transaction(() => {
      const old = db.prepare("SELECT request_json FROM stock_cost_changes WHERE client_ref = ?").get(body.clientRef) as { request_json: string } | undefined;
      if (old) {
        if (old.request_json !== requestJson) throw httpError(409, "Cost reference already used for another request");
        return false;
      }
      const row = db.prepare("SELECT * FROM stock_items WHERE id = ?").get(id) as StockRow | undefined;
      if (!row) throw httpError(404, "Stock item not found");
      versionCheck(row.version, body.expectedVersion);
      if (!row.is_active) throw httpError(409, "Reactivate this stock item before changing its cost");
      db.prepare(`INSERT INTO stock_cost_changes (id, stock_item_id, old_cost_milli_paise, new_cost_milli_paise, note, created_at, created_by, client_ref, request_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(uuidv7(), id, row.unit_cost_milli_paise, body.unitCostMilliPaise, body.note, Date.now(), req.user.id, body.clientRef, requestJson);
      db.prepare("UPDATE stock_items SET unit_cost_milli_paise = ?, version = version + 1 WHERE id = ?").run(body.unitCostMilliPaise, id);
      return true;
    })();
    if (created) publishStock(app, [id]);
    const row = db.prepare("SELECT * FROM stock_items WHERE id = ?").get(id) as StockRow;
    return reply.status(created ? 201 : 200).send({ item: stockJson(row), unitCostMilliPaise: row.unit_cost_milli_paise });
  });
}
