import { SentItemEdit, returnPartialStock, uuidv7 } from "@masalapos/domain";
import type { FastifyInstance } from "fastify";
import { priorRequest } from "./client-ref.js";
import { httpError } from "./http-error.js";
import { kotWithContextJson, loadOrderJson, type KotRow, type OrderItemRow, type OrderRow } from "./mappers.js";
import { jobContext, printStationSlip } from "./print/station-slip.js";
import { contextLine, editSlip } from "@masalapos/print";
import { publishStock } from "./stock.js";
import { orderTableLabel } from "./table-label.js";
import { userCan } from "./auth.js";

type KotEditPrint = "ask" | "always" | "never";

/**
 * Set afresh on the cancelled item that holds a quantity cut; every other column keeps the original item's value.
 * guest_request_id is cleared because a QR guest's items are matched back to their request through client_ref, which the copy cannot share.
 */
const SPLIT_OVERRIDES = new Set(["id", "qty", "status", "cancel_reason", "cancelled_by", "cancelled_at", "client_ref", "guest_request_id"]);

/**
 * Editing an item after it was sent to the kitchen (GoFrugal's "KOT edit"). A note change needs `orders.update`;
 * a quantity cut is a partial cancellation and needs `orders.cancel_sent`, like cancelling a sent item.
 */
export function registerKotEdits(app: FastifyInstance): void {
  const db = app.db;
  const kotEditPrint = () => (db.prepare("SELECT kot_edit_print AS v FROM settings WHERE id = 1").get() as { v: KotEditPrint }).v;

  /** Staff screens read the print rule so they know whether to ask before printing. */
  app.get("/api/kot-edit-settings", { preHandler: app.requirePermission("orders.update") }, async () => ({ print: kotEditPrint() }));

  app.post("/api/order-items/:id/edit-sent", { preHandler: app.requirePermission("orders.update") }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = SentItemEdit.parse(req.body);
    if (body.qty !== undefined && !userCan(req.user, "orders.cancel_sent")) {
      return reply.status(403).send({ error: "forbidden", permission: "orders.cancel_sent" });
    }
    const requestJson = JSON.stringify({ itemId: id, ...body });

    let printError: string | null = null;
    const result = db.transaction(() => {
      const replay = priorRequest<{ order_id: string }>(db, "kot_edits", body.clientRef, requestJson, "Edit reference already used for a different request", "order_id");
      if (replay) {
        return { orderId: replay.order_id, created: false, stockIds: [] as string[], kot: null };
      }
      const item = db.prepare("SELECT * FROM order_items WHERE id = ?").get(id) as OrderItemRow | undefined;
      if (!item) throw httpError(404, "item not found");
      const order = db.prepare("SELECT * FROM orders WHERE id = ?").get(item.order_id) as OrderRow;
      if (order.status !== "open") throw httpError(409, "order is not open");
      if (item.status !== "sent") throw httpError(409, item.status === "pending" ? "This item has not been sent; edit it in the cart" : "item is cancelled");
      // A combo's items sit on several tickets; changing one means cancelling the combo and adding it again.
      if (item.parent_item_id || db.prepare("SELECT 1 FROM order_items WHERE parent_item_id = ? LIMIT 1").get(item.id)) {
        throw httpError(409, "A sent combo cannot be edited. Cancel it and add it again.", "combo_item");
      }
      // A dish and its add-ons are billed together; change them by cancelling the dish and adding it again.
      if (item.addon_of_item_id || db.prepare("SELECT 1 FROM order_items WHERE addon_of_item_id = ? LIMIT 1").get(item.id)) {
        throw httpError(409, "A sent dish with add-ons cannot be edited. Cancel it and add it again.", "addon_line");
      }
      const newQty = body.qty ?? item.qty;
      const newNote = body.note === undefined ? item.note : body.note || null;
      if (newQty > item.qty) throw httpError(400, "To add more, add the dish again and send it to the kitchen");
      if (newQty === item.qty && newNote === item.note) throw httpError(400, "Nothing changed");

      const now = Date.now();
      const reason = body.reason ?? null;
      let cancelledItemId: string | null = null;
      let stockIds: string[] = [];
      if (newQty < item.qty) {
        // The removed units become their own cancelled item, so bills, cancellation reports and the kitchen see them as cancelled.
        cancelledItemId = uuidv7();
        const columns = (db.prepare("PRAGMA table_info(order_items)").all() as Array<{ name: string }>).map((c) => c.name).filter((c) => !SPLIT_OVERRIDES.has(c));
        db.prepare(`INSERT INTO order_items (id, qty, status, cancel_reason, cancelled_by, cancelled_at, client_ref, guest_request_id, ${columns.join(", ")})
          SELECT ?, ?, 'cancelled', ?, ?, ?, NULL, NULL, ${columns.join(", ")} FROM order_items WHERE id = ?`)
          .run(cancelledItemId, item.qty - newQty, reason, req.user.id, now, id);
        stockIds = returnPartialStock(db, { orderItemId: id, cancelledItemId, currentQty: item.qty, removedQty: item.qty - newQty, actorId: req.user.id, note: reason ?? "KOT edit" });
      }
      db.prepare("UPDATE order_items SET qty = ?, note = ? WHERE id = ?").run(newQty, newNote, id);

      const rule = kotEditPrint();
      const print = rule === "always" || (rule === "ask" && body.print);
      let printed = false;
      let kot = null;
      if (item.kot_id) {
        const kotRow = db.prepare("SELECT * FROM kots WHERE id = ?").get(item.kot_id) as KotRow;
        const tableName = orderTableLabel(db, order.id);
        if (print) printed = printEditSlip(kotRow, order, tableName, { name: item.name_snapshot, oldQty: item.qty, newQty, oldNote: item.note, newNote, reason, atMs: now });
        kot = kotWithContextJson(kotRow, order, tableName, db.prepare("SELECT * FROM order_items WHERE kot_id = ? ORDER BY id").all(item.kot_id) as OrderItemRow[], db);
      }
      db.prepare(`INSERT INTO kot_edits (id, order_item_id, order_id, kot_id, old_qty, new_qty, old_note, new_note, reason, cancelled_item_id,
        printed, created_at, created_by, client_ref, request_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(uuidv7(), id, order.id, item.kot_id, item.qty, newQty, item.note, newNote, reason, cancelledItemId, printed ? 1 : 0, now, req.user.id, body.clientRef, requestJson);
      return { orderId: order.id, created: true, stockIds, kot };
    })();

    /** Queues the edit slip on the ticket's station printer. Returns whether a slip was queued; a render failure is reported, not thrown. */
    function printEditSlip(kot: KotRow, order: OrderRow, tableName: string | null, change: { name: string; oldQty: number; newQty: number; oldNote: string | null; newNote: string | null; reason: string | null; atMs: number }): boolean {
      const context = contextLine(order.type, tableName, order.split_label, order.zomato_order_id ?? null, order.order_type_name ?? null);
      const slip = printStationSlip(app, kot.station_id, "edit", `Changed — KOT #${kot.kot_no} — ${jobContext(order, tableName)}`,
        (target) => editSlip({ kotNo: kot.kot_no, context, ...change }, target.paperWidth, target.profile));
      printError = slip.error;
      return slip.queued;
    }

    const order = loadOrderJson(db, result.orderId)!;
    if (result.created) {
      publishStock(app, result.stockIds);
      app.broadcast("order.updated", { order });
      if (result.kot) app.broadcast("kot.updated", { kot: result.kot });
    }
    return { order, printError };
  });
}
