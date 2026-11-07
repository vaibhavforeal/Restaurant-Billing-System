import type { FastifyInstance } from "fastify";
import { nextSplitLabel } from "@masalapos/domain";
import { z } from "zod";
import { httpError } from "./http-error.js";
import { loadOrderJson, type OrderRow } from "./mappers.js";
import { takeawayOrderType } from "./order-types.js";
import { assertModuleActive } from "./modules.js";
import { assertTableNotReserved } from "./reservation-rules.js";
import { linkedTableIds } from "./table-label.js";
import { tablePriceTier } from "./pricing.js";

const Details = z.object({
  expectedRevision: z.number().int().nonnegative(),
  notes: z.string().trim().max(1000).optional(),
  guestCount: z.number().int().min(1).max(999).nullable().optional(),
  soldById: z.string().min(1).optional(),
}).strict().refine((v) => v.notes !== undefined || v.guestCount !== undefined || v.soldById !== undefined, "Choose details to update");

export function registerOrderSummary(app: FastifyInstance) {
  const db = app.db;
  const update = app.requirePermission("orders.update");
  const getOpen = (id: string) => {
    const row = db.prepare("SELECT * FROM orders WHERE id = ?").get(id) as OrderRow | undefined;
    if (!row) throw httpError(404, "Order not found");
    if (row.status !== "open" || row.type === "zomato") throw httpError(409, "These details can only change on an open dine-in or takeaway order.");
    return row;
  };
  const publish = (id: string) => {
    const order = loadOrderJson(db, id)!;
    app.broadcast("order.updated", { order });
    if (order.tableId) app.broadcast("table.changed", { tableId: order.tableId });
    return { order };
  };

  app.get("/api/order-staff", { preHandler: app.requirePermission("orders.read") }, async () => ({
    staff: db.prepare("SELECT id, name FROM users WHERE is_active = 1 AND role IN ('admin', 'cashier', 'waiter') ORDER BY name, id").all(),
  }));

  app.patch("/api/orders/:id/summary", { preHandler: update }, async (req) => {
    const { id } = req.params as { id: string };
    const body = Details.parse(req.body);
    db.transaction(() => {
      const row = getOpen(id);
      if (row.summary_revision !== body.expectedRevision) throw httpError(409, "Order details changed on another counter. Reopen these details and try again.");
      if (body.guestCount !== undefined && row.type !== "dine_in") throw httpError(409, "Guest count is only available for dine-in orders.");
      let soldById = row.sold_by_id, soldByName = row.sold_by_name;
      if (body.soldById !== undefined) {
        const staff = db.prepare("SELECT id, name FROM users WHERE id = ? AND is_active = 1 AND role IN ('admin', 'cashier', 'waiter')").get(body.soldById) as { id: string; name: string } | undefined;
        if (!staff) throw httpError(400, "Choose an active member of the sales staff.");
        soldById = staff.id; soldByName = staff.name;
      }
      db.prepare("UPDATE orders SET order_notes = ?, guest_count = ?, sold_by_id = ?, sold_by_name = ?, summary_revision = summary_revision + 1 WHERE id = ?")
        .run(body.notes ?? row.order_notes, body.guestCount === undefined ? row.guest_count : body.guestCount, soldById ?? null, soldByName ?? null, id);
    })();
    return publish(id);
  });

  app.patch("/api/orders/:id/service-type", { preHandler: update }, async (req) => {
    const { id } = req.params as { id: string };
    const body = z.object({ orderTypeId: z.string().min(1), tableId: z.string().min(1).optional(), expectedRevision: z.number().int().nonnegative() }).strict().parse(req.body);
    let oldTable: string | null = null;
    db.transaction(() => {
      const row = getOpen(id);
      if (row.summary_revision !== body.expectedRevision) throw httpError(409, "Order details changed on another counter. Reopen these details and try again.");
      const dineIn = body.orderTypeId === "dine_in";
      const chosen = dineIn ? null : takeawayOrderType(db, body.orderTypeId);
      if (!dineIn) assertModuleActive(db, "takeaway");
      if (row.type === "dine_in" && dineIn) throw httpError(409, "Use Move table to change this order's table.");
      if (db.prepare("SELECT 1 FROM kots WHERE order_id = ?").get(id)) throw httpError(409, "Order type cannot change after a KOT. Finish this order with its current type.");
      if (linkedTableIds(db, id).length || db.prepare("SELECT 1 FROM orders WHERE merged_into = ?").get(id)) throw httpError(409, "A merged order must keep its current type.");
      if (db.prepare("SELECT 1 FROM bills WHERE order_id = ?").get(id)) throw httpError(409, "An order with a bill must keep its current type.");
      let tableId: string | null = null, split: string | null = null;
      if (dineIn) {
        if (!body.tableId) throw httpError(400, "Choose a table for dine-in.");
        const table = db.prepare("SELECT id FROM dining_tables WHERE id = ? AND is_active = 1").get(body.tableId);
        if (!table) throw httpError(400, "Choose an active table.");
        assertTableNotReserved(db, body.tableId, Date.now());
        split = nextSplitLabel(db, body.tableId);
        if (split === null) throw httpError(409, "Table has too many open splits.");
        tableId = body.tableId;
      }
      oldTable = row.table_id;
      db.prepare(`UPDATE orders SET type = ?, order_type_id = ?, order_type_name = ?, table_id = ?, split_label = ?,
        price_tier = ?, captain_id = NULL, captain_name = NULL, guest_count = NULL, summary_revision = summary_revision + 1 WHERE id = ?`)
        .run(dineIn ? "dine_in" : "parcel", chosen?.id ?? null, chosen?.name ?? null, tableId, split, tableId ? tablePriceTier(db, tableId) : "takeaway", id);
    })();
    if (oldTable) app.broadcast("table.changed", { tableId: oldTable });
    return publish(id);
  });
}
