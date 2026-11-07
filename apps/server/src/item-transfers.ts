import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { priorRequest } from "./client-ref.js";
import { httpError } from "./http-error.js";
import { loadOrderJson, type OrderItemRow, type OrderRow } from "./mappers.js";

export function registerItemTransfers(app: FastifyInstance) {
  app.post("/api/orders/:id/transfer-items", { preHandler: app.requirePermission("orders.update") }, async (req) => {
    const { id } = req.params as { id: string };
    const body = z.object({ clientRef: z.uuid(), targetOrderId: z.uuid(), items: z.array(z.object({ id: z.uuid(), qty: z.number().int().positive() }).strict()).min(1).max(500) }).strict().parse(req.body);
    const fingerprint = JSON.stringify({ orderId: id, targetOrderId: body.targetOrderId, actor: req.user.id, items: [...body.items].sort((a, b) => a.id.localeCompare(b.id)) });
    app.db.transaction(() => {
      if (priorRequest(app.db, "order_item_transfers", body.clientRef, fingerprint, "This transfer reference belongs to a different request.")) return;
      const getOrder = (orderId: string) => app.db.prepare("SELECT * FROM orders WHERE id = ?").get(orderId) as OrderRow | undefined;
      const source = getOrder(id), target = getOrder(body.targetOrderId);
      if (!source || !target) throw httpError(404, "Order not found.");
      if (id === body.targetOrderId || [source, target].some((o) => o.status !== "open" || o.type !== "dine_in" || o.merged_into)) throw httpError(409, "Choose two different open dine-in orders.");
      if (app.db.prepare("SELECT 1 FROM bills WHERE order_id IN (?, ?)").get(id, target.id)) throw httpError(409, "Orders with a bill cannot transfer items.");
      if (new Set(body.items.map((i) => i.id)).size !== body.items.length) throw httpError(400, "Choose each item once.");
      const moveIds: string[] = [];
      for (const chosen of body.items) {
        const row = app.db.prepare("SELECT * FROM order_items WHERE id = ? AND order_id = ?").get(chosen.id, id) as OrderItemRow | undefined;
        if (row?.addon_of_item_id) throw httpError(409, "Move the dish, and its add-ons go with it.", "addon_line");
        if (!row || row.parent_item_id || row.qty !== chosen.qty) throw httpError(409, "Items changed. Reopen Transfer items and choose again.");
        // Combo items and add-ons move with their dish; a cancelled add-on goes too, so the dish's history stays together.
        const family = [row, ...app.db.prepare("SELECT * FROM order_items WHERE parent_item_id = ? OR addon_of_item_id = ?").all(row.id, row.id) as OrderItemRow[]];
        // Only an add-on cancelled before it reached the kitchen may ride along; the dish itself must still be unsent.
        const cancelledUnsentAddon = (i: OrderItemRow) => i !== row && i.addon_of_item_id !== null && i.status === "cancelled" && !i.kot_id;
        if (family.some((i) => !cancelledUnsentAddon(i) && (i.status !== "pending" || i.kot_id))) throw httpError(409, "Only unsent items can transfer. Use Move table or Merge for kitchen orders.");
        if (family.some((i) => i.client_ref?.startsWith("guest:"))) throw httpError(409, "Guest QR items must stay with their guest request. Move or merge the table instead.");
        moveIds.push(...family.map((i) => i.id));
      }
      // Keep item ids, quantities, notes, holds and price snapshots together; combo children follow their parent.
      for (const itemId of moveIds) app.db.prepare("UPDATE order_items SET order_id = ? WHERE id = ?").run(target.id, itemId);
      app.db.prepare("INSERT INTO order_item_transfers (client_ref, request_json, order_id, target_order_id, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(body.clientRef, fingerprint, id, target.id, req.user.id, Date.now());
    })();
    const order = loadOrderJson(app.db, id)!, targetOrder = loadOrderJson(app.db, body.targetOrderId)!;
    for (const current of [order, targetOrder]) {
      app.broadcast("order.updated", { order: current });
      if (current.tableId) app.broadcast("table.changed", { tableId: current.tableId });
    }
    return { order, targetOrder };
  });
}
