import { SentItemEdit, returnPartialStock, uuidv7 } from "@masalapos/domain";
import type { FastifyInstance } from "fastify";
import { httpError } from "./http-error.js";
import { kotWithContextJson, loadOrderJson, type KotRow, type OrderItemRow, type OrderRow } from "./mappers.js";
import { bestEffortPrint } from "./print/best-effort.js";
import { readProfile } from "./print/profile.js";
import { contextLine, editSlip } from "./print/templates.js";
import { publishStock } from "./stock.js";
import { orderTableLabel } from "./table-label.js";
import { userCan } from "./auth.js";

type KotEditPrint = "ask" | "always" | "never";

/** Copied onto the cancelled item that holds a quantity cut; every other column keeps the original item's value. */
const SPLIT_OVERRIDES = new Set(["id", "qty", "status", "cancel_reason", "cancelled_by", "cancelled_at", "client_ref"]);

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
      const replay = db.prepare("SELECT order_id, request_json FROM kot_edits WHERE client_ref = ?").get(body.clientRef) as { order_id: string; request_json: string } | undefined;
      if (replay) {
        if (replay.request_json !== requestJson) throw httpError(409, "Edit reference already used for a different request");
        return { orderId: replay.order_id, created: false, stockIds: [] as string[], kot: null };
      }
      const item = db.prepare("SELECT * FROM order_items WHERE id = ?").get(id) as OrderItemRow | undefined;
      if (!item) throw httpError(404, "item not found");
      const order = db.prepare("SELECT * FROM orders WHERE id = ?").get(item.order_id) as OrderRow;
      if (order.status !== "open") throw httpError(409, "order is not open");
      if (item.status !== "sent") throw httpError(409, item.status === "pending" ? "This item has not been sent; edit it in the cart" : "item is cancelled");
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
        db.prepare(`INSERT INTO order_items (id, qty, status, cancel_reason, cancelled_by, cancelled_at, client_ref, ${columns.join(", ")})
          SELECT ?, ?, 'cancelled', ?, ?, ?, NULL, ${columns.join(", ")} FROM order_items WHERE id = ?`)
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
        kot = kotWithContextJson(kotRow, order, tableName, db.prepare("SELECT * FROM order_items WHERE kot_id = ? ORDER BY id").all(item.kot_id) as OrderItemRow[]);
      }
      db.prepare(`INSERT INTO kot_edits (id, order_item_id, order_id, kot_id, old_qty, new_qty, old_note, new_note, reason, cancelled_item_id,
        printed, created_at, created_by, client_ref, request_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(uuidv7(), id, order.id, item.kot_id, item.qty, newQty, item.note, newNote, reason, cancelledItemId, printed ? 1 : 0, now, req.user.id, body.clientRef, requestJson);
      return { orderId: order.id, created: true, stockIds, kot };
    })();

    /** Queues the edit slip on the ticket's station printer. Returns whether a slip was queued; a render failure is reported, not thrown. */
    function printEditSlip(kot: KotRow, order: OrderRow, tableName: string | null, change: { name: string; oldQty: number; newQty: number; oldNote: string | null; newNote: string | null; reason: string | null; atMs: number }): boolean {
      const station = db.prepare("SELECT name, printer_id FROM kot_stations WHERE id = ?").get(kot.station_id) as { name: string; printer_id: string | null } | undefined;
      const printer = station?.printer_id
        ? db.prepare("SELECT paper_width, kot_profile FROM printers WHERE id = ? AND is_active = 1").get(station.printer_id) as { paper_width: 58 | 80; kot_profile: string } | undefined
        : undefined;
      if (!printer) return false;
      const context = contextLine(order.type, tableName, order.split_label, order.zomato_order_id ?? null, order.order_type_name ?? null);
      const rendered = bestEffortPrint(app.log, `Edit slip for KOT #${kot.kot_no}`, () => editSlip({ kotNo: kot.kot_no, context, ...change }, printer.paper_width, readProfile(printer.kot_profile)));
      if (rendered.error) { printError = rendered.error; return false; }
      app.enqueuePrint(kot.station_id, "edit", `Changed — KOT #${kot.kot_no} — ${context}`, rendered.value!);
      return true;
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
