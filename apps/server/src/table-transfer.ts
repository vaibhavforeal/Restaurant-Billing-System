import { OrderMove, nextSplitLabel, uuidv7 } from "@forkflow/domain";
import type { FastifyInstance } from "fastify";
import { httpError } from "./http-error.js";
import { kotWithContextJson, loadOrderJson, type KotRow, type OrderItemRow, type OrderRow } from "./mappers.js";
import { readProfile } from "./print/profile.js";
import { bestEffortPrint } from "./print/best-effort.js";
import { tableChangeSlip } from "./print/templates.js";
import { assertTableNotReserved } from "./reservation-rules.js";
import { activeLinkForTable } from "./table-label.js";

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
      const occupied = app.db.prepare("SELECT 1 FROM orders WHERE table_id = ? AND status IN ('open', 'billed') LIMIT 1").get(table.id);
      if (occupied || activeLinkForTable(app.db, table.id)) throw httpError(409, "That table is occupied — merge instead");
      const now = Date.now();
      assertTableNotReserved(app.db, table.id, now);

      const label = nextSplitLabel(app.db, table.id);
      if (label === null) throw httpError(409, "table has too many open splits");
      const fromTable = app.db.prepare("SELECT name FROM dining_tables WHERE id = ?").get(order.table_id) as { name: string };

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
      const row = app.db.prepare("SELECT * FROM orders WHERE id = ?").get(id) as OrderRow;
      const kots = app.db.prepare("SELECT * FROM kots WHERE order_id = ? ORDER BY created_at").all(id) as KotRow[];
      for (const kot of kots) {
        const items = app.db.prepare("SELECT * FROM order_items WHERE kot_id = ? ORDER BY id").all(kot.id) as OrderItemRow[];
        app.broadcast("kot.updated", { kot: kotWithContextJson(kot, row, order.tableLabel, items) });
      }
    }
    return { order, printErrors };
  });
}
