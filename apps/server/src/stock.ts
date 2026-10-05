import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { can } from "@forkflow/core";
import { StockCreate, StockUpdate, StockAdjust, StockLinkUpdate, stockMilli, stockJson, appendStockMove, uuidv7, roleFor,
  type StockRow, type StockLink, type StockMove, type StockCostChange } from "@forkflow/domain";
import { httpError } from "./http-error.js";

/** Publish only after the caller has committed the transaction. */
export function publishStock(app: FastifyInstance, ids: string[]) {
  const items = [...new Set(ids)].map((id) => app.db.prepare("SELECT * FROM stock_items WHERE id = ?").get(id) as StockRow | undefined)
    .filter((r): r is StockRow => r !== undefined).map(stockJson);
  if (!items.length) return;
  // Full balances remain behind stock.read; order clients refetch their own warnings.
  app.broadcast("stock.changed", { stockItemIds: items.map((item) => item.id) });
  const low = items.filter((item) => item.isActive && item.isLow);
  if (low.length) app.broadcast("stock.low", { stockItemIds: low.map((item) => item.id) });
}

export const versionCheck = (actual: number, expected: number) => {
  if (actual !== expected) throw httpError(409, "Stock changed on another counter. Refresh and review before saving.");
};

export function registerStock(app: FastifyInstance) {
  const db = app.db;
  const read = app.requirePermission("stock.read");
  const manage = app.requirePermission("stock.manage");
  function item(id: string): StockRow {
    const row = db.prepare("SELECT * FROM stock_items WHERE id = ?").get(id) as StockRow | undefined;
    if (!row) throw httpError(404, "Stock item not found");
    return row;
  }
  const links = (productId: string) => db.prepare(`SELECT l.id, l.stock_item_id AS stockItemId, l.qty_per_sale AS qtyPerSale,
    s.name AS stockName, s.unit FROM product_stock_links l JOIN stock_items s ON s.id = l.stock_item_id WHERE l.product_id = ? ORDER BY l.id`).all(productId) as StockLink[];

  app.get("/api/stock-items", { preHandler: read }, async () => ({
    items: (db.prepare("SELECT * FROM stock_items ORDER BY name COLLATE NOCASE, id").all() as StockRow[]).map(stockJson),
  }));
  app.post("/api/stock-items", { preHandler: manage }, async (req, reply) => {
    const body = StockCreate.parse(req.body);
    const requestJson = JSON.stringify(body);
    const result = db.transaction(() => {
      const old = db.prepare("SELECT * FROM stock_items WHERE client_ref = ?").get(body.clientRef) as StockRow | undefined;
      if (old) {
        if (old.request_json !== requestJson) throw httpError(409, "Stock reference already used for another request");
        return { id: old.id, created: false };
      }
      const id = uuidv7();
      db.prepare("INSERT INTO stock_items (id, name, unit, low_stock_threshold, client_ref, request_json) VALUES (?, ?, ?, ?, ?, ?)")
        .run(id, body.name, body.unit, body.lowStockThreshold, body.clientRef, requestJson);
      if (body.openingQty) appendStockMove(db, { stockItemId: id, delta: body.openingQty, reason: "adjustment", actorId: req.user.id, note: "Opening balance" });
      return { id, created: true };
    })();
    if (result.created) publishStock(app, [result.id]);
    return reply.status(result.created ? 201 : 200).send({ item: stockJson(item(result.id)) });
  });
  app.patch("/api/stock-items/:id", { preHandler: manage }, async (req) => {
    const { id } = req.params as { id: string };
    const body = StockUpdate.parse(req.body);
    db.transaction(() => {
      const row = item(id); versionCheck(row.version, body.expectedVersion);
      if (body.isActive === false && db.prepare("SELECT id FROM product_stock_links WHERE stock_item_id = ? LIMIT 1").get(id)) throw httpError(409, "Remove product links before archiving this stock item");
      db.prepare("UPDATE stock_items SET name = ?, low_stock_threshold = ?, is_active = ?, version = version + 1 WHERE id = ?")
        .run(body.name ?? row.name, body.lowStockThreshold === undefined ? row.low_stock_threshold : body.lowStockThreshold,
          body.isActive === undefined ? row.is_active : Number(body.isActive), id);
    })();
    publishStock(app, [id]); return { item: stockJson(item(id)) };
  });
  app.post("/api/stock-items/:id/movements", { preHandler: manage }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = StockAdjust.parse(req.body);
    const requestJson = JSON.stringify({ stockItemId: id, ...body });
    // Priced receiving needs the cost permission and the recipes plan; refuse before anything is written.
    if (body.costPaise !== undefined) {
      if (!can(roleFor(req.user.role), "costs.read")) throw httpError(403, "Not allowed to record cost");
      app.licensing.assertFeature("recipes", req.headers["x-forkflow-device"]);
    }
    const result = db.transaction(() => {
      const old = db.prepare("SELECT id, request_json FROM stock_moves WHERE client_ref = ?").get(body.clientRef) as { id: string; request_json: string } | undefined;
      if (old) {
        if (old.request_json !== requestJson) throw httpError(409, "Stock movement reference already used for another request");
        return { moveId: old.id, created: false };
      }
      const row = item(id); versionCheck(row.version, body.expectedVersion);
      if (!row.is_active) throw httpError(409, "Reactivate this stock item before adjusting it");
      const amount = stockMilli(body.quantity);
      const deltaMilli = body.reason === "purchase" ? amount : body.reason === "wastage" ? -amount : amount - stockMilli(row.qty);
      if (!deltaMilli) throw httpError(400, "Count already matches the stock balance");
      try { stockMilli(deltaMilli / 1000); stockMilli((stockMilli(row.qty) + deltaMilli) / 1000); }
      catch { throw httpError(400, "Resulting stock balance exceeds the supported range"); }
      const moveId = appendStockMove(db, { stockItemId: id, delta: deltaMilli / 1000, reason: body.reason, actorId: req.user.id, note: body.note, clientRef: body.clientRef, requestJson,
        ...(body.costPaise === undefined ? {} : { costPaise: body.costPaise }) });
      return { moveId, created: true };
    })();
    if (result.created) publishStock(app, [id]);
    return reply.status(result.created ? 201 : 200).send({ item: stockJson(item(id)), movementId: result.moveId });
  });
  app.get("/api/stock-items/:id/movements", { preHandler: read }, async (req) => {
    const { id } = req.params as { id: string }; item(id);
    const { before } = z.object({ before: z.string().min(1).max(64).optional() }).parse(req.query);
    // Cost is admin-only and part of the recipes plan; everyone else gets no cost keys at all.
    const showCost = can(roleFor(req.user.role), "costs.read") && app.licensing.status(req.headers["x-forkflow-device"]).features.recipes;
    const moves = db.prepare(`SELECT m.id, m.stock_item_id AS stockItemId, m.delta, m.reason, m.note,
      m.order_item_id AS orderItemId, oi.order_id AS orderId, m.reversal_of AS reversalOf,
      m.created_at AS createdAt, u.name AS createdByName, m.balance_after AS balanceAfter${showCost ? ", m.cost_paise AS costPaise" : ""}
      FROM stock_moves m LEFT JOIN users u ON u.id = m.created_by LEFT JOIN order_items oi ON oi.id = m.order_item_id
      WHERE m.stock_item_id = ? AND (? IS NULL OR m.id < ?) ORDER BY m.id DESC LIMIT 100`).all(id, before ?? null, before ?? null) as StockMove[];
    if (!showCost) return { movements: moves };
    // Cost changes follow the same time window as the page: up to the cursor movement, down to the oldest
    // movement shown (no lower bound on the last page, so the earliest changes always appear).
    const cursor = before ? db.prepare("SELECT created_at FROM stock_moves WHERE id = ?").get(before) as { created_at: number } | undefined : undefined;
    const upper = cursor?.created_at ?? null;
    const lower = moves.length >= 100 ? moves[moves.length - 1]!.createdAt : null;
    const costChanges = db.prepare(`SELECT c.id, c.stock_item_id AS stockItemId, c.old_cost_milli_paise AS oldCostMilliPaise,
      c.new_cost_milli_paise AS newCostMilliPaise, c.note, c.created_at AS createdAt, u.name AS createdByName
      FROM stock_cost_changes c LEFT JOIN users u ON u.id = c.created_by
      WHERE c.stock_item_id = ? AND (? IS NULL OR c.created_at <= ?) AND (? IS NULL OR c.created_at >= ?)
      ORDER BY c.created_at DESC, c.id DESC`).all(id, upper, upper, lower, lower) as StockCostChange[];
    return { movements: moves, costChanges };
  });
  app.get("/api/products/:id/stock-links", { preHandler: read }, async (req) => {
    const { id } = req.params as { id: string };
    const product = db.prepare("SELECT stock_version FROM products WHERE id = ?").get(id) as { stock_version: number } | undefined;
    if (!product) throw httpError(404, "Product not found");
    return { links: links(id), version: product.stock_version };
  });
  app.put("/api/products/:id/stock-links", { preHandler: manage }, async (req) => {
    const { id } = req.params as { id: string };
    const body = StockLinkUpdate.parse(req.body);
    const changedIds = db.transaction(() => {
      const product = db.prepare("SELECT stock_version FROM products WHERE id = ?").get(id) as { stock_version: number } | undefined;
      if (!product) throw httpError(404, "Product not found");
      const previous = links(id);
      if (previous.length > 1) throw httpError(409, "This product has multiple stock links. Use the recipe editor when available.");
      const unchanged = body.stockItemId === null ? previous.length === 0 : previous[0]?.stockItemId === body.stockItemId && previous[0].qtyPerSale === body.qtyPerSale;
      if (unchanged) return [];
      versionCheck(product.stock_version, body.expectedVersion);
      if (body.stockItemId && !item(body.stockItemId).is_active) throw httpError(400, "Choose an active stock item");
      db.prepare("DELETE FROM product_stock_links WHERE product_id = ?").run(id);
      if (body.stockItemId) db.prepare("INSERT INTO product_stock_links (id, product_id, stock_item_id, qty_per_sale) VALUES (?, ?, ?, ?)").run(uuidv7(), id, body.stockItemId, body.qtyPerSale);
      db.prepare("UPDATE products SET stock_version = stock_version + 1 WHERE id = ?").run(id);
      return [...previous.map((l) => l.stockItemId), ...(body.stockItemId ? [body.stockItemId] : [])];
    })();
    publishStock(app, changedIds);
    return { links: links(id), version: (db.prepare("SELECT stock_version FROM products WHERE id = ?").get(id) as { stock_version: number }).stock_version };
  });
}
