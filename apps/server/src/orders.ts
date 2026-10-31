import { OrderCreate, OrderItemsAdd, OrderItemUpdate, ItemCancel, uuidv7, nextSplitLabel } from "@masalapos/domain";
import { z } from "zod";
import { tablePriceTier } from "./pricing.js";
import { priceOrderItem, insertOrderItem } from "./order-items.js";
import { assertTableNotReserved } from "./reservation-rules.js";
import type { FastifyInstance } from "fastify";
import { httpError } from "./http-error.js";
import { reverseStock } from "@masalapos/domain";
import { publishStock } from "./stock.js";
import { cancelSlip } from "./print/templates.js";
import { readProfile } from "./print/profile.js";
import { bestEffortPrint } from "./print/best-effort.js";
import { loadOrderJson, kotWithContextJson, type OrderRow, type OrderItemRow, type KotRow } from "./mappers.js";
import { linkedTableIds, orderTableLabel } from "./table-label.js";
import { integrationEnabled } from "./integrations.js";
import { takeawayOrderType } from "./order-types.js";
import { assertModuleActive } from "./modules.js";
import { userCan } from "./auth.js";

export function registerOrders(app: FastifyInstance): void {
  const create = app.requirePermission("orders.create");
  const read = app.requirePermission("orders.read");
  function captainName(id: string | null | undefined) {
    if (!id) return null;
    const captain = app.db.prepare("SELECT name FROM users WHERE id = ? AND role = 'waiter' AND is_active = 1").get(id) as { name: string } | undefined;
    if (!captain) throw httpError(400, "Choose an active captain.");
    return captain.name;
  }
  app.get("/api/captains", { preHandler: read }, async () => ({
    captains: app.db.prepare("SELECT id, name FROM users WHERE role = 'waiter' AND is_active = 1 ORDER BY name, id").all(),
  }));

  const getOrder = (id: string) =>
    app.db.prepare("SELECT * FROM orders WHERE id = ?").get(id) as OrderRow | undefined;

  function orderWithDetails(id: string) {
    return loadOrderJson(app.db, id);
  }

  const ZOMATO_STATUS_LABEL = { preparing: "preparing", ready: "ready", picked_up: "picked up" } as const;
  const zomatoDuplicate = (zomatoOrderId: string) => {
    const row = app.db.prepare("SELECT status, zomato_status FROM orders WHERE zomato_order_id = ? AND type = 'zomato'").get(zomatoOrderId) as
      { status: string; zomato_status: keyof typeof ZOMATO_STATUS_LABEL | null } | undefined;
    const state = row?.status === "cancelled" ? "cancelled" : row?.zomato_status ? ZOMATO_STATUS_LABEL[row.zomato_status] : "new";
    return httpError(409, `Zomato order ${zomatoOrderId} is already on the desk (${state}).`, "zomato_duplicate");
  };

  app.post("/api/orders", { preHandler: create }, async (req, reply) => {
    const body = OrderCreate.parse(req.body);
    // Zomato orders are quick-billing work: admin and cashier only (same rule as canQuickBill in the UI).
    if (body.type === "zomato" && !userCan(req.user, "bills.settle")) throw httpError(403, "Not allowed to create Zomato orders");
    const existing = app.db.prepare("SELECT id FROM orders WHERE client_ref = ?").get(body.clientRef) as { id: string } | undefined;
    if (existing) {
      if (body.id && body.id !== existing.id) throw httpError(409, "Order reference already used for a different order");
      return reply.status(200).send({ order: orderWithDetails(existing.id) });
    }
    if (body.id && app.db.prepare("SELECT 1 FROM orders WHERE id = ?").get(body.id)) throw httpError(409, "An order with this id already exists");

    // Only starting takeaway is gated: open takeaway orders can always be finished and billed.
    if (body.type === "parcel") assertModuleActive(app.db, "takeaway");
    if (body.type === "zomato") {
      // Only creating is gated: Ready and Picked up keep working for open orders when Zomato is turned off.
      if (!integrationEnabled(app.db, "zomato")) throw httpError(409, "Zomato is turned off in the Marketplace.");
      if (app.db.prepare("SELECT id FROM orders WHERE zomato_order_id = ? AND type = 'zomato'").get(body.zomatoOrderId!)) throw zomatoDuplicate(body.zomatoOrderId!);
    }

    const customType = body.orderTypeId ? takeawayOrderType(app.db, body.orderTypeId) : null;

    if (body.type === "dine_in") {
      const table = app.db
        .prepare("SELECT id, is_active FROM dining_tables WHERE id = ?")
        .get(body.tableId!) as { id: string; is_active: number } | undefined;
      if (!table) throw httpError(400, "unknown table");
      if (table.is_active !== 1) throw httpError(409, "table is not active");

      // No longer checking for occupied — splits allowed
    }

    const id = body.id ?? uuidv7();
    const now = Date.now();
    // A captain opening a table from the Captain app serves it; counter staff choose explicitly.
    const captainId = body.captainId ?? (body.type === "dine_in" && req.user.role === "waiter" ? req.user.id : null);
    const chosenCaptainName = captainName(captainId);

    if (body.type === "dine_in") {
      const write = app.db.transaction(() => {
        assertTableNotReserved(app.db, body.tableId!, now);
        const label = nextSplitLabel(app.db, body.tableId!);
        if (label === null) throw httpError(409, "table has too many open splits");

        app.db
          .prepare("INSERT INTO orders (id, client_ref, type, table_id, split_label, opened_by, opened_at, price_tier, captain_id, captain_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
          .run(id, body.clientRef, body.type, body.tableId, label, req.user.id, now, tablePriceTier(app.db, body.tableId!), captainId, chosenCaptainName);
      });
      write();
    } else if (body.type === "zomato") {
      try {
        app.db
          .prepare("INSERT INTO orders (id, client_ref, type, table_id, split_label, opened_by, opened_at, price_tier, zomato_order_id) VALUES (?, ?, 'zomato', NULL, NULL, ?, ?, 'zomato', ?)")
          .run(id, body.clientRef, req.user.id, now, body.zomatoOrderId!);
      } catch (err) {
        // A concurrent writer won the race: the partial unique index is the source of truth.
        if (err instanceof Error && "code" in err && err.code === "SQLITE_CONSTRAINT_UNIQUE") throw zomatoDuplicate(body.zomatoOrderId!);
        throw err;
      }
    } else {
      // Parcel: split_label is NULL
      app.db
        .prepare("INSERT INTO orders (id, client_ref, type, table_id, split_label, opened_by, opened_at, price_tier, order_type_id, order_type_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(id, body.clientRef, body.type, body.tableId, null, req.user.id, now, "takeaway", customType?.id ?? null, customType?.name ?? null);
    }

    const order = orderWithDetails(id)!;
    app.broadcast("order.updated", { order });
    if (body.type === "dine_in") {
      app.broadcast("table.changed", { tableId: body.tableId! });
    }

    return reply.status(201).send({ order });
  });

  app.get("/api/orders", { preHandler: read }, async () => {
    const rows = app.db
      .prepare("SELECT * FROM orders WHERE status IN ('open', 'billed') ORDER BY opened_at")
      .all() as OrderRow[];
    const orders = rows.map((r) => orderWithDetails(r.id)!);
    return { orders };
  });

  app.get("/api/orders/:id", { preHandler: read }, async (req) => {
    const { id } = req.params as { id: string };
    const order = orderWithDetails(id);
    if (!order) throw httpError(404, "order not found");
    return { order };
  });

  const update = app.requirePermission("orders.update");
  app.patch("/api/orders/:id/captain", { preHandler: update }, async (req) => {
    const { id } = req.params as { id: string };
    const body = z.object({ captainId: z.string().min(1).nullable(), expectedCaptainId: z.string().min(1).nullable() }).strict().parse(req.body);
    const row = getOrder(id);
    if (!row) throw httpError(404, "order not found");
    if (row.type !== "dine_in" || row.status !== "open") throw httpError(409, "Choose a captain on an open dine-in order.");
    if (row.captain_id !== body.captainId) {
      if ((row.captain_id ?? null) !== body.expectedCaptainId) throw httpError(409, "Captain changed on another counter. Refresh this order before changing it.");
      const name = captainName(body.captainId);
      app.db.prepare("UPDATE orders SET captain_id = ?, captain_name = ? WHERE id = ?").run(body.captainId, name, id);
    }
    const order = orderWithDetails(id)!;
    app.broadcast("order.updated", { order });
    app.broadcast("table.changed", { tableId: row.table_id });
    return { order };
  });

  app.post("/api/orders/:id/items", { preHandler: update }, async (req) => {
    const { id } = req.params as { id: string };
    const body = OrderItemsAdd.parse(req.body);
    const order = getOrder(id);
    if (!order) throw httpError(404, "order not found");

    const incomingRefs = body.items.map((i) => i.clientRef).filter((r): r is string => !!r);
    const placeholders = incomingRefs.map(() => "?").join(",");
    const saved = incomingRefs.length
      ? app.db.prepare(`SELECT client_ref, order_id FROM order_items WHERE client_ref IN (${placeholders})`).all(...incomingRefs) as Array<{ client_ref: string; order_id: string }>
      : [];
    // A replayed reference must belong to this order; one from another order is a different request.
    if (saved.some((r) => r.order_id !== id)) throw httpError(409, "Item reference already used on another order");
    const existingRefs = new Set(saved.map((r) => r.client_ref));
    // A replay of a punch the hub already saved succeeds even after the order was billed or closed.
    if (order.status !== "open") {
      if (incomingRefs.length === body.items.length && body.items.every((i) => existingRefs.has(i.clientRef!))) return { order: orderWithDetails(id)! };
      throw httpError(409, "order is not open");
    }

    const toAdd = body.items.filter((item) => !(item.clientRef && existingRefs.has(item.clientRef)))
      .map((item) => ({ clientRef: item.clientRef ?? null, priced: priceOrderItem(app.db, order.price_tier, item) }));
    if (toAdd.length > 0) app.db.transaction(() => { for (const item of toAdd) insertOrderItem(app.db, id, item.priced, { clientRef: item.clientRef }); })();

    const result = orderWithDetails(id)!;
    app.broadcast("order.updated", { order: result });
    return { order: result };
  });

  app.patch("/api/order-items/:id", { preHandler: update }, async (req) => {
    const { id } = req.params as { id: string };
    const body = OrderItemUpdate.parse(req.body);
    const item = app.db.prepare("SELECT * FROM order_items WHERE id = ?").get(id) as OrderItemRow | undefined;
    if (!item) throw httpError(404, "item not found");
    const order = getOrder(item.order_id);
    if (!order) throw httpError(404, "order not found");
    if (order.status !== "open") throw httpError(409, "order is not open");
    if (item.parent_item_id) throw httpError(409, "Change the combo, not the items in it", "combo_item");
    if (item.status !== "pending") throw httpError(409, "item is not pending");

    const qty = body.qty ?? item.qty;
    const note = body.note === undefined ? item.note : body.note;

    app.db.transaction(() => {
      app.db.prepare("UPDATE order_items SET qty = ?, note = ? WHERE id = ?").run(qty, note, id);
      // A combo's items follow its quantity and cooking note; each holds a whole number of units per combo.
      app.db.prepare("UPDATE order_items SET qty = qty / ? * ?, note = ? WHERE parent_item_id = ? AND status != 'cancelled'").run(item.qty, qty, note, id);
    })();

    const result = orderWithDetails(item.order_id)!;
    app.broadcast("order.updated", { order: result });
    return { order: result };
  });

  app.post("/api/order-items/:id/cancel", { preHandler: update }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = ItemCancel.parse(req.body);
    const item = app.db.prepare("SELECT * FROM order_items WHERE id = ?").get(id) as OrderItemRow | undefined;
    if (!item) throw httpError(404, "item not found");
    const order = getOrder(item.order_id);
    if (!order) throw httpError(404, "order not found");
    // Repeating a cancel (for example a saved action replayed after a lost reply) changes nothing and succeeds.
    if (item.status === "cancelled") return reply.status(200).send({ order: orderWithDetails(item.order_id)!, printError: null });
    if (order.status !== "open") throw httpError(409, "order is not open");
    if (item.parent_item_id) throw httpError(409, "Cancel the whole combo, not one item in it", "combo_item");

    // A combo is cancelled with the items in it; it counts as sent once any of them reached the kitchen.
    const rows = [item, ...app.db.prepare("SELECT * FROM order_items WHERE parent_item_id = ? AND status != 'cancelled' ORDER BY id").all(id) as OrderItemRow[]];
    if (rows.some((row) => row.status === "sent")) {
      if (!userCan(req.user, "orders.cancel_sent")) {
        return reply.status(403).send({ error: "forbidden", permission: "orders.cancel_sent" });
      }
      if (!body.reason) throw httpError(400, "reason required");
    }

    let printError: string | null = null;
    const changed = app.db.transaction(() => {
      const ids: string[] = [];
      const kotIds = new Set<string>();
      const now = Date.now();
      for (const row of rows) {
        if (row.status === "sent") ids.push(...reverseStock(app.db, row.id, req.user.id, body.reason!));
        app.db.prepare("UPDATE order_items SET status = 'cancelled', cancel_reason = ?, cancelled_by = ?, cancelled_at = ? WHERE id = ?")
          .run(body.reason ?? null, req.user.id, now, row.id);
        if (row.status === "sent" && row.kot_id) {
          const error = printCancelSlip(row, body.reason ?? "No reason provided");
          if (error) printError = error;
          kotIds.add(row.kot_id);
        }
      }
      const kots = [...kotIds].map((kotId) => {
        const kot = app.db.prepare("SELECT * FROM kots WHERE id = ?").get(kotId) as KotRow;
        const kotItems = app.db.prepare("SELECT * FROM order_items WHERE kot_id = ? ORDER BY id").all(kotId) as OrderItemRow[];
        const kotOrder = app.db.prepare("SELECT * FROM orders WHERE id = ?").get(kot.order_id) as OrderRow;
        return kotWithContextJson(kot, kotOrder, orderTableLabel(app.db, kotOrder.id), kotItems);
      });
      return { ids, kots };
    })();
    publishStock(app, changed.ids);
    const result = orderWithDetails(item.order_id)!;
    app.broadcast("order.updated", { order: result });
    for (const kot of changed.kots) app.broadcast("kot.updated", { kot });
    return { order: result, printError };
  });

  /** Prints a cancel slip for a sent item at its KOT's station. Returns the print error, if any. */
  function printCancelSlip(item: OrderItemRow, reason: string): string | null {
    const kot = app.db.prepare("SELECT * FROM kots WHERE id = ?").get(item.kot_id) as KotRow;
    const order = app.db.prepare("SELECT * FROM orders WHERE id = ?").get(kot.order_id) as OrderRow;
    // The combined label (e.g. "T3, T4") so the kitchen matches the slip to the tickets on screen.
    const tableName = orderTableLabel(app.db, order.id);
    const stationRow = app.db
      .prepare("SELECT name, printer_id FROM kot_stations WHERE id = ?")
      .get(kot.station_id) as { name: string; printer_id: string | null } | undefined;
    if (!stationRow) return null;
    const printerRow = stationRow.printer_id
      ? (app.db
          .prepare("SELECT paper_width, kot_profile FROM printers WHERE id = ? AND is_active = 1")
          .get(stationRow.printer_id) as { paper_width: number; kot_profile: string } | undefined)
      : undefined;
    if (!printerRow) return null;

    // Build context line using kitchen-board rule
    let contextLine: string;
    if (order.type === "parcel") {
      contextLine = order.order_type_name ?? "Parcel";
    } else if (order.type === "zomato") {
      contextLine = `Zomato #${order.zomato_order_id}`;
    } else if (tableName) {
      if (order.split_label === null || order.split_label === "A") {
        contextLine = tableName;
      } else {
        contextLine = `${tableName} / ${order.split_label}`;
      }
    } else {
      contextLine = "Table";
    }

    const label = `Cancel — KOT #${kot.kot_no} — ${contextLine}`;

    const rendered = bestEffortPrint(app.log, `Cancel slip for KOT #${kot.kot_no}`, () => cancelSlip(
      {
        kotNo: kot.kot_no,
        stationName: stationRow.name,
        orderType: order.type,
        orderTypeName: order.order_type_name ?? null,
        zomatoOrderId: order.zomato_order_id ?? null,
        tableName,
        splitLabel: order.split_label,
        item: { qty: item.qty, name: item.name_snapshot },
        reason,
        atMs: Date.now(),
      },
      printerRow.paper_width as 58 | 80,
      readProfile(printerRow.kot_profile),
    ));
    if (rendered.error) return rendered.error;
    app.enqueuePrint(kot.station_id, "cancel", label, rendered.value!);
    return null;
  }

  app.post("/api/orders/:id/cancel", { preHandler: update }, async (req) => {
    const { id } = req.params as { id: string };
    const body = ItemCancel.parse(req.body ?? {});
    const order = getOrder(id);
    if (!order) throw httpError(404, "order not found");
    // Repeating a cancel changes nothing and succeeds.
    if (order.status === "cancelled") return { order: orderWithDetails(id)! };
    if (order.status !== "open") throw httpError(409, "order is not open");

    const sentItem = app.db
      .prepare("SELECT id FROM order_items WHERE order_id = ? AND status = 'sent' LIMIT 1")
      .get(id) as { id: string } | undefined;
    if (sentItem) throw httpError(409, "cancel sent items first");

    app.db.transaction(() => {
      const now = Date.now();
      app.db.prepare("UPDATE orders SET status = 'cancelled', closed_at = ?, cancelled_by = ?, cancel_reason = ? WHERE id = ?")
        .run(now, req.user.id, body.reason ?? null, id);
      app.db.prepare("UPDATE order_items SET status = 'cancelled', cancelled_at = ?, cancelled_by = ?, cancel_reason = ? WHERE order_id = ? AND status = 'pending'")
        .run(now, req.user.id, body.reason ?? "Order cancelled", id);
    })();

    const result = orderWithDetails(id)!;
    app.broadcast("order.updated", { order: result });
    if (order.table_id) {
      app.broadcast("table.changed", { tableId: order.table_id });
    }
    // Cancelling a combined order frees its linked tables as well.
    for (const tableId of linkedTableIds(app.db, id)) app.broadcast("table.changed", { tableId });
    return { order: result };
  });
}
