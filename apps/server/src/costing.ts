import type { FastifyInstance } from "fastify";
import { UnitCostSet, dishCost, moveCostPaise, preGstPaise, priceForTier, stockJson, stockMilli, uuidv7, type DishCost, type DishPrice, type PriceTier, type StockCost, type StockRow } from "@forkflow/domain";
import { httpError } from "./http-error.js";
import { publishStock, versionCheck } from "./stock.js";

const PRICE_TIERS: PriceTier[] = ["non_ac", "ac", "takeaway"];

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

  app.get("/api/costing/stock", { preHandler: costs }, async () => {
    const rows = db.prepare("SELECT * FROM stock_items ORDER BY name COLLATE NOCASE, id").all() as StockRow[];
    const items: StockCost[] = rows.map((row) => ({
      stockItemId: row.id, name: row.name, unit: row.unit, qty: row.qty, isActive: row.is_active === 1,
      unitCostMilliPaise: row.unit_cost_milli_paise,
      valuePaise: moveCostPaise(stockMilli(row.qty), row.unit_cost_milli_paise),
    }));
    const totalValuePaise = items.reduce((sum, item) => sum + (item.isActive ? item.valuePaise ?? 0 : 0), 0);
    return { items, totalValuePaise };
  });

  app.get("/api/costing/dishes", { preHandler: costs }, async () => {
    const taxInclusive = (db.prepare("SELECT tax_inclusive FROM settings WHERE id = 1").get() as { tax_inclusive: number }).tax_inclusive === 1;
    const products = db.prepare(`SELECT p.id, p.name, p.price_paise, p.gst_rate, p.ac_price_paise, p.takeaway_price_paise, c.name AS category_name
      FROM products p JOIN categories c ON c.id = p.category_id WHERE p.is_active = 1
      ORDER BY c.sort_order, c.name COLLATE NOCASE, p.name COLLATE NOCASE, p.id`).all() as Array<{
      id: string; name: string; price_paise: number; gst_rate: number; ac_price_paise: number | null; takeaway_price_paise: number | null; category_name: string;
    }>;
    const variantRows = db.prepare("SELECT id, product_id, name, price_paise, ac_price_paise, takeaway_price_paise, is_active FROM variants ORDER BY name COLLATE NOCASE, id").all() as Array<{
      id: string; product_id: string; name: string; price_paise: number; ac_price_paise: number | null; takeaway_price_paise: number | null; is_active: number;
    }>;
    const variantsByProduct = new Map<string, typeof variantRows>();
    for (const v of variantRows) variantsByProduct.set(v.product_id, [...(variantsByProduct.get(v.product_id) ?? []), v]);
    const linkRows = db.prepare(`SELECT l.product_id, l.qty_per_sale, s.name, s.unit_cost_milli_paise
      FROM product_stock_links l JOIN stock_items s ON s.id = l.stock_item_id ORDER BY l.id`).all() as Array<{
      product_id: string; qty_per_sale: number; name: string; unit_cost_milli_paise: number | null;
    }>;
    const linksByProduct = new Map<string, Array<{ stockName: string; qtyPerSale: number; unitCostMilliPaise: number | null }>>();
    for (const l of linkRows) {
      const list = linksByProduct.get(l.product_id) ?? [];
      list.push({ stockName: l.name, qtyPerSale: l.qty_per_sale, unitCostMilliPaise: l.unit_cost_milli_paise });
      linksByProduct.set(l.product_id, list);
    }

    const dishes: DishCost[] = [];
    for (const p of products) {
      const cost = dishCost(linksByProduct.get(p.id) ?? []);
      const row = (variantId: string | null, name: string, prices: { price_paise: number; ac_price_paise: number | null; takeaway_price_paise: number | null }) => {
        const item = { pricePaise: prices.price_paise, acPricePaise: prices.ac_price_paise, takeawayPricePaise: prices.takeaway_price_paise };
        dishes.push({
          productId: p.id, variantId, name, categoryName: p.category_name, ...cost,
          prices: PRICE_TIERS.map((tier): DishPrice => {
            const pricePaise = priceForTier(item, tier);
            const preGst = preGstPaise(pricePaise, p.gst_rate, taxInclusive);
            const known = cost.costPaise !== null && preGst !== 0;
            return {
              tier, pricePaise, preGstPaise: preGst,
              costPercent: known ? Math.round(cost.costPaise! * 1000 / preGst) / 10 : null,
              marginPaise: known ? preGst - cost.costPaise! : null,
            };
          }),
        });
      };
      const variants = variantsByProduct.get(p.id);
      if (!variants) row(null, p.name, p);
      else for (const v of variants) if (v.is_active === 1) row(v.id, `${p.name} · ${v.name}`, v);
    }
    return { dishes, taxInclusive };
  });
}
