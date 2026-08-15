import { nextSequence, localDateKey, uuidv7 } from "@forkflow/domain";
import type { FastifyInstance } from "fastify";
import { httpError } from "./http-error.js";
import { loadOrderJson, kotJson, kotWithContextJson, type OrderRow, type OrderItemRow, type KotRow } from "./mappers.js";

export function registerKots(app: FastifyInstance): void {
  const create = app.requirePermission("kots.create");
  const read = app.requirePermission("kots.read");
  const update = app.requirePermission("kots.update");

  app.post("/api/orders/:id/send", { preHandler: create }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const order = app.db.prepare("SELECT * FROM orders WHERE id = ?").get(id) as OrderRow | undefined;
    if (!order) throw httpError(404, "order not found");
    if (order.status !== "open") throw httpError(409, "order is not open");

    interface PendingItem {
      id: string;
      product_id: string;
      station_id: string | null;
    }
    const pendingItems = app.db
      .prepare(
        `SELECT oi.id, oi.product_id, p.kot_station_id AS station_id
         FROM order_items oi
         JOIN products p ON p.id = oi.product_id
         WHERE oi.order_id = ? AND oi.status = 'pending'
         ORDER BY oi.id`,
      )
      .all(id) as PendingItem[];

    const byStation = new Map<string, string[]>();
    for (const item of pendingItems) {
      if (item.station_id) {
        const list = byStation.get(item.station_id) ?? [];
        list.push(item.id);
        byStation.set(item.station_id, list);
      }
    }

    if (byStation.size === 0) throw httpError(409, "nothing to send");

    const createdKots: Array<{ id: string; stationId: string }> = [];

    const write = app.db.transaction(() => {
      const now = Date.now();
      const dateKey = localDateKey(now);
      for (const [stationId, itemIds] of byStation.entries()) {
        const kotNo = nextSequence(app.db, "kot:" + dateKey);
        const kotId = uuidv7();
        app.db
          .prepare("INSERT INTO kots (id, order_id, kot_no, station_id, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?)")
          .run(kotId, id, kotNo, stationId, now, req.user.id);

        for (const itemId of itemIds) {
          app.db.prepare("UPDATE order_items SET status = 'sent', kot_id = ? WHERE id = ?").run(kotId, itemId);
        }

        createdKots.push({ id: kotId, stationId });
      }
    });
    write();

    const orderResult = app.db.prepare("SELECT * FROM orders WHERE id = ?").get(id) as OrderRow;
    const allItems = app.db
      .prepare("SELECT * FROM order_items WHERE order_id = ? ORDER BY id")
      .all(id) as OrderItemRow[];
    const allKots = app.db
      .prepare("SELECT * FROM kots WHERE order_id = ? ORDER BY created_at")
      .all(id) as KotRow[];

    const tableName = orderResult.table_id
      ? (app.db.prepare("SELECT name FROM dining_tables WHERE id = ?").get(orderResult.table_id) as { name: string } | undefined)?.name ?? null
      : null;

    const kotsWithContext = createdKots.map((ck) => {
      const kotRow = allKots.find((k) => k.id === ck.id)!;
      const kotItems = allItems.filter((i) => i.kot_id === ck.id);
      return kotWithContextJson(kotRow, orderResult, tableName, kotItems);
    });

    // Print each KOT
    for (const ck of createdKots) {
      const kotRow = allKots.find((k) => k.id === ck.id)!;
      const stationRow = app.db
        .prepare("SELECT name, printer_id FROM kot_stations WHERE id = ?")
        .get(ck.stationId) as { name: string; printer_id: string | null } | undefined;

      if (!stationRow) continue;

      const printerRow = stationRow.printer_id
        ? (app.db
            .prepare("SELECT paper_width FROM printers WHERE id = ? AND is_active = 1")
            .get(stationRow.printer_id) as { paper_width: number } | undefined)
        : undefined;

      if (!printerRow) continue;

      const kotItemsForPrint = allItems.filter((i) => i.kot_id === ck.id);

      // Build context line using kitchen-board rule
      let contextLine: string;
      if (orderResult.type === "parcel") {
        contextLine = "Parcel";
      } else if (tableName) {
        if (orderResult.split_label === null || orderResult.split_label === "A") {
          contextLine = tableName;
        } else {
          contextLine = `${tableName} / ${orderResult.split_label}`;
        }
      } else {
        contextLine = "Table";
      }

      const label = `KOT #${kotRow.kot_no} — ${contextLine}`;

      const { kotSlip } = await import("./print/templates.js");
      const bytes = kotSlip(
        {
          kotNo: kotRow.kot_no,
          stationName: stationRow.name,
          orderType: orderResult.type,
          tableName,
          splitLabel: orderResult.split_label,
          items: kotItemsForPrint.map((i) => ({
            qty: i.qty,
            name: i.name_snapshot,
            note: i.note,
            cancelled: i.status === "cancelled",
          })),
          atMs: kotRow.created_at,
        },
        printerRow.paper_width as 58 | 80,
      );

      app.enqueuePrint(ck.stationId, "kot", label, bytes);
    }

    for (const kot of kotsWithContext) {
      app.broadcast("kot.created", { kot });
    }

    const orderFull = loadOrderJson(app.db, id)!;

    app.broadcast("order.updated", { order: orderFull });
    if (orderResult.type === "dine_in") {
      app.broadcast("table.changed", { tableId: orderResult.table_id! });
    }

    return reply.status(200).send({ order: orderFull, kots: kotsWithContext });
  });

  app.get("/api/kots", { preHandler: read }, async () => {
    const kots = app.db
      .prepare("SELECT * FROM kots WHERE done_at IS NULL ORDER BY created_at")
      .all() as KotRow[];

    if (kots.length === 0) {
      return { kots: [] };
    }

    const orders = app.db
      .prepare(
        `SELECT o.*, dt.name AS table_name
         FROM orders o
         LEFT JOIN dining_tables dt ON dt.id = o.table_id
         WHERE o.id IN (${kots.map(() => "?").join(",")})`,
      )
      .all(...kots.map((k) => k.order_id)) as Array<OrderRow & { table_name: string | null }>;

    const items = app.db
      .prepare(
        `SELECT * FROM order_items WHERE kot_id IN (${kots.map(() => "?").join(",")})`,
      )
      .all(...kots.map((k) => k.id)) as OrderItemRow[];

    const ordersById = new Map<string, OrderRow & { table_name: string | null }>();
    for (const o of orders) {
      ordersById.set(o.id, o);
    }

    const itemsByKotId = new Map<string, OrderItemRow[]>();
    for (const item of items) {
      const list = itemsByKotId.get(item.kot_id!) ?? [];
      list.push(item);
      itemsByKotId.set(item.kot_id!, list);
    }

    return {
      kots: kots.map((kot) => {
        const order = ordersById.get(kot.order_id)!;
        const tableName = order.table_name ?? null;
        const kotItems = itemsByKotId.get(kot.id) ?? [];
        return kotWithContextJson(kot, order, tableName, kotItems);
      }),
    };
  });

  app.post("/api/kots/:id/done", { preHandler: update }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const kot = app.db.prepare("SELECT * FROM kots WHERE id = ?").get(id) as KotRow | undefined;
    if (!kot) throw httpError(404, "kot not found");

    if (kot.done_at) {
      return reply.status(200).send({ kot: kotJson(kot) });
    }

    const now = Date.now();
    app.db.prepare("UPDATE kots SET done_at = ? WHERE id = ?").run(now, id);

    const updated = app.db.prepare("SELECT * FROM kots WHERE id = ?").get(id) as KotRow;
    const order = app.db.prepare("SELECT * FROM orders WHERE id = ?").get(updated.order_id) as OrderRow;
    const tableName = order.table_id
      ? (app.db.prepare("SELECT name FROM dining_tables WHERE id = ?").get(order.table_id) as { name: string } | undefined)?.name ?? null
      : null;
    const items = app.db
      .prepare("SELECT * FROM order_items WHERE kot_id = ? ORDER BY id")
      .all(id) as OrderItemRow[];

    app.broadcast("kot.updated", { kot: kotWithContextJson(updated, order, tableName, items) });

    return reply.status(200).send({ kot: kotJson(updated) });
  });
}
