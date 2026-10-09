import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { httpError } from "./http-error.js";
import { issueBill, loadBill, settleBill } from "./billing.js";
import { loadOrderJson, type OrderRow } from "./mappers.js";
import { publishStock } from "./stock.js";

type ZomatoStatus = NonNullable<OrderRow["zomato_status"]>;
type Target = "ready" | "picked_up";

const ZomatoStatusUpdate = z.object({
  status: z.enum(["ready", "picked_up"]),
  clientRef: z.string().min(8).max(64),
});

const STATUS_LABEL: Record<ZomatoStatus | "new", string> = { new: "new", preparing: "preparing", ready: "ready", picked_up: "picked up" };

/**
 * Whether this endpoint may move a Zomato order from `current` to `target`. Ready comes from Preparing, or straight from
 * new when no KOT will ever be sent (only stationless items, e.g. cold drinks); Picked up comes from Ready. Both need live
 * items and no unsent station item. NULL -> Preparing and Ready -> Preparing belong to the KOT send route.
 */
export function nextZomatoStatus(current: ZomatoStatus | null, target: Target, hasPendingStationItems: boolean, hasItems: boolean): boolean {
  if (!hasItems || hasPendingStationItems) return false;
  return target === "ready" ? current === null || current === "preparing" : current === "ready";
}

function refusal(zomatoOrderId: string, current: ZomatoStatus | null, target: Target, hasPendingStationItems: boolean, hasItems: boolean): string {
  if (!hasItems) return `Zomato #${zomatoOrderId} has no items.`;
  if (hasPendingStationItems) return `Send the kitchen items of Zomato #${zomatoOrderId} first.`;
  const state = STATUS_LABEL[current ?? "new"];
  return target === "ready" ? `Zomato #${zomatoOrderId} is ${state}; it cannot be marked Ready.` : `Zomato #${zomatoOrderId} is ${state}; mark it Ready before Picked up.`;
}

/** `POST /api/orders/:id/zomato-status`: Ready, and Picked up (bills, settles as a Zomato receivable, closes; never prints). */
export function registerZomatoDesk(app: FastifyInstance): void {
  const db = app.db;
  // Not gated on the Marketplace switch: orders already on the desk must still close after Zomato is turned off.
  app.post("/api/orders/:id/zomato-status", { preHandler: app.requirePermission("bills.settle") }, async (req) => {
    if (req.user.role !== "admin" && req.user.role !== "cashier") throw httpError(403, "Not allowed to update Zomato orders");
    const { id } = req.params as { id: string };
    const body = ZomatoStatusUpdate.parse(req.body);
    const requestJson = JSON.stringify({ orderId: id, ...body });
    const changedStockIds: string[] = [];
    const result = db.transaction((): { billId: string | null; changed: boolean } => {
      if (body.status === "picked_up") {
        // Picked up is keyed on the bill's client_ref: the same reference replays the bill it created.
        const replay = db.prepare("SELECT id, order_id, request_json FROM bills WHERE client_ref = ?").get(body.clientRef) as
          { id: string; order_id: string; request_json: string | null } | undefined;
        if (replay) {
          if (replay.order_id !== id || replay.request_json !== requestJson) throw httpError(409, "Picked up reference already used for a different request");
          return { billId: replay.id, changed: false };
        }
        if (db.prepare("SELECT 1 FROM bill_settlements WHERE client_ref = ?").get(body.clientRef)) throw httpError(409, "Picked up reference already used for a different request");
      }
      const order = db.prepare("SELECT type, status, zomato_order_id, zomato_status FROM orders WHERE id = ?").get(id) as
        Pick<OrderRow, "type" | "status" | "zomato_order_id" | "zomato_status"> | undefined;
      if (!order) throw httpError(404, "order not found");
      if (order.type !== "zomato") throw httpError(409, "This is not a Zomato order");
      const zomatoOrderId = order.zomato_order_id!;
      const current = order.zomato_status ?? null;
      // One bill per order: a second Picked up (another counter, another reference) finds the order closed.
      if (order.status !== "open" || db.prepare("SELECT 1 FROM bills WHERE order_id = ?").get(id)) {
        const state = order.status === "cancelled" ? "cancelled" : STATUS_LABEL[current ?? "new"];
        throw httpError(409, `Zomato #${zomatoOrderId} is already ${state}.`, "zomato_status");
      }
      // Ready has no stored reference: a repeat (lost response, double-tap, second counter) gets the current order unchanged.
      if (body.status === "ready" && current === "ready") return { billId: null, changed: false };
      const hasItems = db.prepare("SELECT 1 FROM order_items WHERE order_id = ? AND status != 'cancelled' LIMIT 1").get(id) !== undefined;
      const hasPendingStationItems = db.prepare(`SELECT 1 FROM order_items oi JOIN products p ON p.id = oi.product_id
        WHERE oi.order_id = ? AND oi.status = 'pending' AND p.kot_station_id IS NOT NULL LIMIT 1`).get(id) !== undefined;
      if (!nextZomatoStatus(current, body.status, hasPendingStationItems, hasItems)) {
        throw httpError(409, refusal(zomatoOrderId, current, body.status, hasPendingStationItems, hasItems), "zomato_status");
      }
      if (body.status === "ready") {
        db.prepare("UPDATE orders SET zomato_status = 'ready' WHERE id = ?").run(id);
        return { billId: null, changed: true };
      }
      // Zomato collects and pays the GST (section 9(5)): operator tax mode, no discount, whatever tax_inclusive says.
      // The snapshot says so too (taxInclusive false), so no screen or receipt reads the bill as GST-inclusive.
      const issued = issueBill(db, id, {
        discountPaise: 0, discountNote: null, clientRef: body.clientRef, requestJson, actorId: req.user.id, role: req.user.role,
        taxMode: "operator", receiptExtra: { orderType: "zomato", zomatoOrderId, gstPaidBy: "zomato", taxInclusive: false },
      });
      changedStockIds.push(...issued.changedStockIds);
      const { total_paise: total } = db.prepare("SELECT total_paise FROM bills WHERE id = ?").get(issued.billId) as { total_paise: number };
      // The whole bill is a Zomato receivable; a ₹0 bill (all items at a Zomato price of 0) settles with no payment row.
      settleBill(db, issued.billId, {
        payments: total > 0 ? [{ mode: "zomato", amountPaise: total }] : [], clientRef: body.clientRef, requestJson, actorId: req.user.id,
      });
      db.prepare("UPDATE orders SET zomato_status = 'picked_up' WHERE id = ?").run(id);
      return { billId: issued.billId, changed: true };
    })();
    if (result.changed) publishStock(app, changedStockIds);
    const order = loadOrderJson(db, id)!;
    if (result.changed) app.broadcast("order.updated", { order });
    return { order, ...(result.billId ? { bill: loadBill(db, result.billId) } : {}) };
  });
}
