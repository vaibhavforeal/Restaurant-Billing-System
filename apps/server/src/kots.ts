import { nextSequence, businessDateKey, uuidv7, consumeStock } from "@masalapos/domain";
import { publishStock } from "./stock.js";
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { httpError } from "./http-error.js";
import { assertKdsActive } from "./kds.js";
import { loadOrderJson, kotJson, kotWithContextJson, type OrderRow, type OrderItemRow, type KotRow } from "./mappers.js";
import { kotSlip } from "@masalapos/print";
import { jobContext, printStationSlip } from "./print/station-slip.js";
import { orderTableLabel } from "./table-label.js";
import { dayStartHour } from "./business-day.js";

export function registerKots(app: FastifyInstance): void {
  const create = app.requirePermission("kots.create");
  const read = app.requirePermission("kots.read");
  const update = app.requirePermission("kots.update");

  app.post("/api/orders/:id/send", { preHandler: create }, async (req, reply) => {
    const { id } = req.params as { id: string };
    return reply.status(200).send(sendKitchenTickets(app, id, req.body, req.user.id));
  });

  app.get("/api/kots", { preHandler: read }, async () => {
    assertKdsActive(app.db);
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
        const tableName = orderTableLabel(app.db, order.id);
        const kotItems = itemsByKotId.get(kot.id) ?? [];
        return kotWithContextJson(kot, order, tableName, kotItems, app.db);
      }),
    };
  });

  function broadcastKotUpdated(updated: KotRow): void {
    const order = app.db.prepare("SELECT * FROM orders WHERE id = ?").get(updated.order_id) as OrderRow;
    const tableName = orderTableLabel(app.db, order.id);
    const items = app.db
      .prepare("SELECT * FROM order_items WHERE kot_id = ? ORDER BY id")
      .all(updated.id) as OrderItemRow[];

    app.broadcast("kot.updated", { kot: kotWithContextJson(updated, order, tableName, items, app.db) });
  }

  app.post("/api/kots/:id/done", { preHandler: update }, async (req, reply) => {
    assertKdsActive(app.db);
    const { id } = req.params as { id: string };
    const kot = app.db.prepare("SELECT * FROM kots WHERE id = ?").get(id) as KotRow | undefined;
    if (!kot) throw httpError(404, "kot not found");

    if (kot.done_at !== null && kot.accepted_at !== null) {
      return reply.status(200).send({ kot: kotJson(kot) });
    }

    const now = Date.now();
    // The kitchen finishing the last KOT of a Preparing Zomato order makes it Ready, in the same transaction as Done.
    const becameReady = app.db.transaction(() => {
      app.db.prepare("UPDATE kots SET accepted_at = COALESCE(accepted_at, done_at, ?), done_at = COALESCE(done_at, ?) WHERE id = ?").run(now, now, id);
      const order = app.db.prepare("SELECT type, status, zomato_status FROM orders WHERE id = ?").get(kot.order_id) as Pick<OrderRow, "type" | "status" | "zomato_status">;
      if (order.type !== "zomato" || order.status !== "open" || order.zomato_status !== "preparing") return false;
      const waiting = app.db.prepare(`SELECT 1 FROM kots WHERE order_id = ? AND done_at IS NULL
        UNION ALL SELECT 1 FROM order_items oi JOIN products p ON p.id = oi.product_id
          WHERE oi.order_id = ? AND oi.status = 'pending' AND p.kot_station_id IS NOT NULL LIMIT 1`).get(kot.order_id, kot.order_id);
      if (waiting) return false;
      app.db.prepare("UPDATE orders SET zomato_status = 'ready' WHERE id = ?").run(kot.order_id);
      return true;
    })();

    const updated = app.db.prepare("SELECT * FROM kots WHERE id = ?").get(id) as KotRow;
    broadcastKotUpdated(updated);
    if (becameReady) app.broadcast("order.updated", { order: loadOrderJson(app.db, kot.order_id)! });

    return reply.status(200).send({ kot: kotJson(updated) });
  });
}

/**
 * Sends an order's pending items to the kitchen: one KOT per station, printed at the station unless Settings says the
 * Kitchen Display is enough. `rawBody` is the send request (or undefined for every pending item); `userId` is who sent it.
 * The counter's Send button and auto-accepted QR orders both come here.
 */
export function sendKitchenTickets(app: FastifyInstance, id: string, rawBody: unknown, userId: string) {
  // Items are named by id, or by the references the counter gave them, so a counter that punched them while offline
  // (and so never learned their ids) can send them in the same saved action.
  const parsed = z.object({
    clientRef: z.uuid(),
    itemIds: z.array(z.uuid()).min(1).max(500).optional(),
    itemRefs: z.array(z.string().min(8).max(64)).min(1).max(500).optional(),
    /** Fire: send the named held items (and only held ones), clearing their hold. */
    fire: z.literal(true).optional(),
  }).refine((b) => !!b.itemIds !== !!b.itemRefs, "Name the items by id or by reference").optional().parse(rawBody);
  const fire = parsed?.fire === true;
  const named = !parsed ? "" : parsed.itemIds ? JSON.stringify([...new Set(parsed.itemIds)].sort()) : `refs:${JSON.stringify([...new Set(parsed.itemRefs)].sort())}`;
  const fingerprint = fire ? `fire:${named}` : named;
  let body: { clientRef: string; itemIds: string[] } | undefined;
  if (parsed?.itemIds) body = { clientRef: parsed.clientRef, itemIds: parsed.itemIds };
  if (parsed) {
    const previous = app.db.prepare("SELECT * FROM kot_requests WHERE client_ref = ?").get(parsed.clientRef) as { order_id: string; user_id: string; fingerprint: string; kot_ids: string } | undefined;
    if (previous) {
      if (previous.order_id !== id || previous.user_id !== userId || previous.fingerprint !== fingerprint) throw httpError(409, "Kitchen request reference was already used for different items");
      const saved = JSON.parse(previous.kot_ids) as string[];
      return { order: loadOrderJson(app.db, id), kots: saved.map((kotId) => kotJson(app.db.prepare("SELECT * FROM kots WHERE id = ?").get(kotId) as KotRow)) };
    }
  }
  const order = app.db.prepare("SELECT * FROM orders WHERE id = ?").get(id) as OrderRow | undefined;
  if (!order) throw httpError(404, "order not found");
  if (order.status !== "open") throw httpError(409, "order is not open");
  if (parsed?.itemRefs) {
    const refs = [...new Set(parsed.itemRefs)];
    const found = app.db.prepare(`SELECT id FROM order_items WHERE order_id = ? AND client_ref IN (${refs.map(() => "?").join(",")})`).all(id, ...refs) as Array<{ id: string }>;
    if (found.length !== refs.length) throw httpError(409, "Kitchen items changed; review the order before sending again");
    body = { clientRef: parsed.clientRef, itemIds: found.map((r) => r.id) };
  }

  interface PendingItem {
    id: string;
    product_id: string;
    station_id: string | null;
    parent_item_id: string | null;
    addon_of_item_id: string | null;
    /** 1 when the item, the combo it is in, or the dish it was picked under is held back from the kitchen. */
    held: number;
  }
  const allPending = app.db
    .prepare(
      // An add-on without a station of its own goes to its dish's station, on the dish's ticket.
      `SELECT oi.id, oi.product_id, COALESCE(p.kot_station_id, dp.kot_station_id) AS station_id, oi.parent_item_id, oi.addon_of_item_id,
         MAX(oi.held, COALESCE(parent.held, 0), COALESCE(dish.held, 0)) AS held
       FROM order_items oi
       JOIN products p ON p.id = oi.product_id
       LEFT JOIN order_items parent ON parent.id = oi.parent_item_id
       LEFT JOIN order_items dish ON dish.id = oi.addon_of_item_id
       LEFT JOIN products dp ON dp.id = dish.product_id
       WHERE oi.order_id = ? AND oi.status = 'pending'
       ORDER BY oi.id`,
    )
    .all(id) as PendingItem[];
  // Naming a combo sends the items in it; naming a dish or one of its add-ons sends the dish with all its add-ons.
  const namedIds = new Set(body?.itemIds ?? []);
  for (const item of allPending) if (item.addon_of_item_id && namedIds.has(item.id)) namedIds.add(item.addon_of_item_id);
  const namedItems = allPending.filter((item) => !body || namedIds.has(item.id) || (item.parent_item_id !== null && namedIds.has(item.parent_item_id))
    || (item.addon_of_item_id !== null && namedIds.has(item.addon_of_item_id)));
  if (body && new Set(body.itemIds).size !== allPending.filter((item) => body.itemIds.includes(item.id)).length) throw httpError(409, "Kitchen items changed; review the order before sending again");
  if (fire && allPending.some((item) => body!.itemIds.includes(item.id) && !item.held)) throw httpError(409, "Only held items can be fired");
  // A KOT leaves held dishes for later, even when a screen that has not seen the hold names them; Fire sends them.
  const pendingItems = fire ? namedItems : namedItems.filter((item) => !item.held);

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
  const changedStockIds: string[] = [];
  const printErrors: string[] = [];

  const kotsWithContext = app.db.transaction(() => {
    const now = Date.now();
    // KOT numbers restart each business day, so a night past midnight keeps counting up.
    const dateKey = businessDateKey(now, dayStartHour(app.db));
    for (const [stationId, itemIds] of byStation.entries()) {
      changedStockIds.push(...consumeStock(app.db, itemIds, userId));
      const kotNo = nextSequence(app.db, "kot:" + dateKey);
      const kotId = uuidv7();
      app.db
        .prepare("INSERT INTO kots (id, order_id, kot_no, station_id, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?)")
        .run(kotId, id, kotNo, stationId, now, userId);

      for (const itemId of itemIds) {
        app.db.prepare("UPDATE order_items SET status = 'sent', kot_id = ? WHERE id = ?").run(kotId, itemId);
      }

      createdKots.push({ id: kotId, stationId });
    }
    // A combo is sent once any of its items is: it takes its own stock (packaging, say) and can no longer be edited.
    const combos = [...new Set(pendingItems.filter((item) => item.station_id && item.parent_item_id).map((item) => item.parent_item_id!))];
    changedStockIds.push(...consumeStock(app.db, combos, userId));
    for (const comboId of combos) app.db.prepare("UPDATE order_items SET status = 'sent' WHERE id = ? AND status = 'pending'").run(comboId);
    if (fire) for (const itemId of namedIds) app.db.prepare("UPDATE order_items SET held = 0 WHERE id = ?").run(itemId);
    // A new Zomato order enters the kitchen; a Ready one goes back (new items to cook). Only when a KOT was created.
    if (createdKots.length > 0) {
      app.db.prepare("UPDATE orders SET zomato_status = 'preparing' WHERE id = ? AND type = 'zomato' AND (zomato_status IS NULL OR zomato_status = 'ready')").run(id);
    }
    if (body) app.db.prepare("INSERT INTO kot_requests (client_ref, order_id, user_id, fingerprint, kot_ids) VALUES (?, ?, ?, ?, ?)")
      .run(body.clientRef, id, userId, fingerprint, JSON.stringify(createdKots.map((k) => k.id)));
    const orderResult = app.db.prepare("SELECT * FROM orders WHERE id = ?").get(id) as OrderRow;
    const allItems = app.db
      .prepare("SELECT * FROM order_items WHERE order_id = ? ORDER BY id")
      .all(id) as OrderItemRow[];
    const allKots = app.db
      .prepare("SELECT * FROM kots WHERE order_id = ? ORDER BY created_at")
      .all(id) as KotRow[];

    const tableName = orderTableLabel(app.db, id);

    const kotsWithContext = createdKots.map((ck) => {
      const kotRow = allKots.find((k) => k.id === ck.id)!;
      const kotItems = allItems.filter((i) => i.kot_id === ck.id);
      return kotWithContextJson(kotRow, orderResult, tableName, kotItems, app.db);
    });

    // Print each KOT
    const context = jobContext(orderResult, tableName);
    for (const ck of createdKots) {
      const kotRow = allKots.find((k) => k.id === ck.id)!;
      const kotItemsForPrint = allItems.filter((i) => i.kot_id === ck.id);
      const { error: printError } = printStationSlip(app, ck.stationId, "kot", `KOT #${kotRow.kot_no} — ${context}`, (target) => kotSlip(
        {
          kotNo: kotRow.kot_no,
          stationName: target.stationName,
          orderType: orderResult.type,
          orderTypeName: orderResult.order_type_name ?? null,
          zomatoOrderId: orderResult.zomato_order_id ?? null,
          tableName,
          splitLabel: orderResult.split_label,
          items: kotItemsForPrint.map((i) => {
            // An add-on prints under its dish; on another station's ticket it names the dish it is for.
            const dish = i.addon_of_item_id ? allItems.find((d) => d.id === i.addon_of_item_id) : undefined;
            return {
              qty: i.qty,
              name: i.name_snapshot,
              note: i.note,
              cancelled: i.status === "cancelled",
              ...(dish ? { addon: true, ...(dish.kot_id !== ck.id ? { forItem: dish.name_snapshot } : {}) } : {}),
            };
          }),
          atMs: kotRow.created_at,
        },
        target.paperWidth,
        target.profile,
      ));
      if (printError) printErrors.push(printError);
    }
    return kotsWithContext;
  })();
  publishStock(app, changedStockIds);
  const orderResult = app.db.prepare("SELECT * FROM orders WHERE id = ?").get(id) as OrderRow;

  for (const kot of kotsWithContext) {
    app.broadcast("kot.created", { kot });
  }

  const orderFull = loadOrderJson(app.db, id)!;

  app.broadcast("order.updated", { order: orderFull });
  if (orderResult.type === "dine_in") {
    app.broadcast("table.changed", { tableId: orderResult.table_id! });
  }

  return { order: orderFull, kots: kotsWithContext, printErrors };
}
