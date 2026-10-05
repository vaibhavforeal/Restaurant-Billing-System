import { OrderMerge, OrderMove, nextSplitLabel, uuidv7 } from "@forkflow/domain";
import type { FastifyInstance } from "fastify";
import { httpError } from "./http-error.js";
import { kotWithContextJson, loadOrderJson, type KotRow, type OrderItemRow, type OrderRow } from "./mappers.js";
import { readProfile } from "./print/profile.js";
import { bestEffortPrint } from "./print/best-effort.js";
import { tableChangeSlip } from "./print/templates.js";
import { assertTableNotReserved } from "./reservation-rules.js";
import { orderTableLabel } from "./table-label.js";

/**
 * Prints a table-change slip at every station that still has an unfinished ticket on the order.
 * `text` is printed as-is, so callers pass ASCII only (e.g. "T3 -> T7"). Returns print error messages;
 * the caller's transaction owns the queue inserts.
 */
export function notifyKitchenTableChange(app: FastifyInstance, orderId: string, text: string): string[] {
  const printErrors: string[] = [];
  const stations = app.db
    .prepare(
      `SELECT DISTINCT ks.id, ks.name, ks.printer_id FROM kots k
       JOIN kot_stations ks ON ks.id = k.station_id
       WHERE k.order_id = ? AND k.done_at IS NULL
       ORDER BY ks.name, ks.id`,
    )
    .all(orderId) as Array<{ id: string; name: string; printer_id: string | null }>;
  const now = Date.now();
  for (const station of stations) {
    if (!station.printer_id) continue;
    const printer = app.db
      .prepare("SELECT paper_width, kot_profile FROM printers WHERE id = ? AND is_active = 1")
      .get(station.printer_id) as { paper_width: number; kot_profile: string } | undefined;
    if (!printer) continue;
    const rendered = bestEffortPrint(app.log, "table change slip", () =>
      tableChangeSlip({ stationName: station.name, text, atMs: now }, printer.paper_width as 58 | 80, readProfile(printer.kot_profile)),
    );
    if (rendered.error) printErrors.push(rendered.error);
    else app.enqueuePrint(station.id, "table", `Table change — ${text}`, rendered.value!);
  }
  return printErrors;
}

export function registerTableTransfer(app: FastifyInstance): void {
  const update = app.requirePermission("orders.update");

  app.post("/api/orders/:id/move", { preHandler: update }, async (req) => {
    const { id } = req.params as { id: string };
    const body = OrderMove.parse(req.body);
    const fingerprint = JSON.stringify({ kind: "move", orderId: id, tableId: body.tableId });
    const printErrors: string[] = [];
    const affectedTableIds = new Set<string>();

    const replayed = app.db.transaction((): boolean => {
      const previous = app.db.prepare("SELECT request_json FROM order_table_events WHERE client_ref = ?").get(body.clientRef) as { request_json: string } | undefined;
      if (previous) {
        if (previous.request_json !== fingerprint) throw httpError(409, "Table change reference already used for a different request");
        return true;
      }

      const order = app.db.prepare("SELECT * FROM orders WHERE id = ?").get(id) as OrderRow | undefined;
      if (!order) throw httpError(404, "order not found");
      if (order.status !== "open") throw httpError(409, "Only open orders can be moved");
      if (order.type !== "dine_in" || !order.table_id) throw httpError(409, "Only dine-in orders can be moved");

      const table = app.db.prepare("SELECT id, name, is_active, price_tier FROM dining_tables WHERE id = ?").get(body.tableId) as { id: string; name: string; is_active: number; price_tier: "non_ac" | "ac" } | undefined;
      if (!table) throw httpError(400, "unknown table");
      if (table.is_active !== 1) throw httpError(409, "Choose an active table");
      // A table linked only to this very order is where part of the party already sits, so it counts as free
      // for this order; any other open/billed order or another order's link makes it occupied.
      const occupied = app.db.prepare("SELECT 1 FROM orders WHERE table_id = ? AND status IN ('open', 'billed') LIMIT 1").get(table.id);
      const linkedElsewhere = app.db
        .prepare(`SELECT 1 FROM table_links tl JOIN orders o ON o.id = tl.order_id
          WHERE tl.table_id = ? AND tl.order_id != ? AND o.status IN ('open', 'billed') LIMIT 1`)
        .get(table.id, id);
      if (occupied || linkedElsewhere) throw httpError(409, "That table is occupied — merge instead");
      const now = Date.now();
      assertTableNotReserved(app.db, table.id, now);

      const label = nextSplitLabel(app.db, table.id);
      if (label === null) throw httpError(409, "table has too many open splits");
      const fromTable = app.db.prepare("SELECT name FROM dining_tables WHERE id = ?").get(order.table_id) as { name: string };

      // The order now sits on that table, so its link there is dropped; links to other tables stay.
      app.db.prepare("DELETE FROM table_links WHERE table_id = ? AND order_id = ?").run(table.id, id);
      app.db.prepare("UPDATE orders SET table_id = ?, split_label = ?, price_tier = ? WHERE id = ?").run(table.id, label, table.price_tier, id);
      app.db
        .prepare(
          `INSERT INTO order_table_events (id, kind, order_id, from_table_id, to_table_id, created_at, created_by, client_ref, request_json)
           VALUES (?, 'move', ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(uuidv7(), id, order.table_id, table.id, now, req.user.id, body.clientRef, fingerprint);

      affectedTableIds.add(order.table_id);
      affectedTableIds.add(table.id);
      for (const link of app.db.prepare("SELECT table_id FROM table_links WHERE order_id = ?").all(id) as Array<{ table_id: string }>) affectedTableIds.add(link.table_id);

      // The printed slip stays ASCII: the thermal encoder cannot print an arrow.
      printErrors.push(...notifyKitchenTableChange(app, id, `${fromTable.name} -> ${table.name}`));
      return false;
    })();

    const order = loadOrderJson(app.db, id)!;
    if (!replayed) {
      app.broadcast("order.updated", { order });
      for (const tableId of affectedTableIds) app.broadcast("table.changed", { tableId });
      broadcastTickets(app, id, order.tableLabel);
    }
    return { order, printErrors };
  });

  // `:id` is the order folded in (S); `targetOrderId` is the receiving order (R) that keeps the bill.
  app.post("/api/orders/:id/merge", { preHandler: update }, async (req) => {
    const { id } = req.params as { id: string };
    const body = OrderMerge.parse(req.body);
    const fingerprint = JSON.stringify({ kind: "merge", orderId: id, targetOrderId: body.targetOrderId });
    const printErrors: string[] = [];
    const affectedTableIds = new Set<string>();

    const replayed = app.db.transaction((): boolean => {
      const previous = app.db.prepare("SELECT request_json FROM order_table_events WHERE client_ref = ?").get(body.clientRef) as { request_json: string } | undefined;
      if (previous) {
        if (previous.request_json !== fingerprint) throw httpError(409, "Table change reference already used for a different request");
        return true;
      }

      const getOrder = app.db.prepare("SELECT * FROM orders WHERE id = ?");
      const folded = getOrder.get(id) as (OrderRow & { merged_into: string | null }) | undefined;
      const receiving = getOrder.get(body.targetOrderId) as (OrderRow & { merged_into: string | null }) | undefined;
      if (!folded || !receiving) throw httpError(404, "order not found");
      const mergeable = (o: typeof folded) => o.status === "open" && o.type === "dine_in" && o.table_id !== null && o.merged_into === null;
      if (folded.id === receiving.id || !mergeable(folded) || !mergeable(receiving)) throw httpError(409, "Both orders must be open to merge");
      const foldedTableId = folded.table_id!, receivingTableId = receiving.table_id!;
      const now = Date.now();

      // Spec §4 Merge, steps 1–3: items (any status) and tickets (acceptance/done unchanged) move to R; S closes.
      app.db.prepare("UPDATE order_items SET order_id = ? WHERE order_id = ?").run(receiving.id, folded.id);
      app.db.prepare("UPDATE kots SET order_id = ? WHERE order_id = ?").run(receiving.id, folded.id);
      app.db.prepare("UPDATE orders SET status = 'cancelled', closed_at = ?, merged_into = ? WHERE id = ?").run(now, receiving.id, folded.id);
      // Accepted guest requests track their items through order_id, so they follow the items.
      app.db.prepare("UPDATE guest_requests SET order_id = ? WHERE order_id = ?").run(receiving.id, folded.id);

      // Step 4: S's table, then the tables linked to S (in link order), become links to R — skipping R's own
      // table and tables already linked to R. S was open, so every link on it was active.
      const foldedLinks = (app.db.prepare("SELECT table_id FROM table_links WHERE order_id = ? ORDER BY linked_at, id").all(folded.id) as Array<{ table_id: string }>).map((l) => l.table_id);
      app.db.prepare("DELETE FROM table_links WHERE order_id = ?").run(folded.id);
      const alreadyLinked = app.db.prepare("SELECT 1 FROM table_links WHERE table_id = ? AND order_id = ?");
      const insertLink = app.db.prepare("INSERT INTO table_links (id, table_id, order_id, linked_at, linked_by) VALUES (?, ?, ?, ?, ?)");
      let linksAdded = 0;
      for (const tableId of [foldedTableId, ...foldedLinks]) {
        affectedTableIds.add(tableId);
        if (tableId === receivingTableId || alreadyLinked.get(tableId, receiving.id)) continue;
        insertLink.run(uuidv7(), tableId, receiving.id, now, req.user.id);
        linksAdded++;
      }
      affectedTableIds.add(receivingTableId);
      for (const link of app.db.prepare("SELECT table_id FROM table_links WHERE order_id = ?").all(receiving.id) as Array<{ table_id: string }>) affectedTableIds.add(link.table_id);

      // Step 5.
      app.db
        .prepare(
          `INSERT INTO order_table_events (id, kind, order_id, target_order_id, from_table_id, to_table_id, folded_captain_name, created_at, created_by, client_ref, request_json)
           VALUES (?, 'merge', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(uuidv7(), folded.id, receiving.id, foldedTableId, receivingTableId, folded.captain_name ?? null, now, req.user.id, body.clientRef, fingerprint);

      // The label is plain table names joined by ", " — already ASCII for the thermal encoder. Two groups at the
      // same table merging with no new link leave the table name unchanged, so the kitchen needs no slip.
      if (foldedTableId !== receivingTableId || linksAdded > 0) {
        printErrors.push(...notifyKitchenTableChange(app, receiving.id, orderTableLabel(app.db, receiving.id)!));
      }
      return false;
    })();

    const order = loadOrderJson(app.db, body.targetOrderId)!;
    if (!replayed) {
      app.broadcast("order.updated", { order: loadOrderJson(app.db, id)! });
      app.broadcast("order.updated", { order });
      for (const tableId of affectedTableIds) app.broadcast("table.changed", { tableId });
      broadcastTickets(app, order.id, order.tableLabel);
    }
    return { order, printErrors };
  });
}

/** Re-broadcasts every ticket on the order so kitchen screens pick up its new table label. */
function broadcastTickets(app: FastifyInstance, orderId: string, tableLabel: string | null): void {
  const row = app.db.prepare("SELECT * FROM orders WHERE id = ?").get(orderId) as OrderRow;
  const kots = app.db.prepare("SELECT * FROM kots WHERE order_id = ? ORDER BY created_at").all(orderId) as KotRow[];
  for (const kot of kots) {
    const items = app.db.prepare("SELECT * FROM order_items WHERE kot_id = ? ORDER BY id").all(kot.id) as OrderItemRow[];
    app.broadcast("kot.updated", { kot: kotWithContextJson(kot, row, tableLabel, items) });
  }
}
