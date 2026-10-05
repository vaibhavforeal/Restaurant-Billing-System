import { OrderCreate, OrderItemsAdd, OrderItemUpdate, ItemCancel, uuidv7, roleFor, nextSplitLabel } from "@forkflow/domain";
import { z } from "zod";
import { rowPrice, tablePriceTier, type PriceRow } from "./pricing.js";
import { can } from "@forkflow/core";
import { assertTableNotReserved } from "./reservation-rules.js";
import type { FastifyInstance } from "fastify";
import { httpError } from "./http-error.js";
import { reverseStock } from "@forkflow/domain";
import { publishStock } from "./stock.js";
import { cancelSlip } from "./print/templates.js";
import { readProfile } from "./print/profile.js";
import { bestEffortPrint } from "./print/best-effort.js";
import { loadOrderJson, kotWithContextJson, type OrderRow, type OrderItemRow, type KotRow } from "./mappers.js";
import { linkedTableIds, orderTableLabel } from "./table-label.js";

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

  app.post("/api/orders", { preHandler: create }, async (req, reply) => {
    const body = OrderCreate.parse(req.body);
    const existing = app.db.prepare("SELECT id FROM orders WHERE client_ref = ?").get(body.clientRef) as { id: string } | undefined;
    if (existing) {
      return reply.status(200).send({ order: orderWithDetails(existing.id) });
    }

    if (body.type === "dine_in") {
      const table = app.db
        .prepare("SELECT id, is_active FROM dining_tables WHERE id = ?")
        .get(body.tableId!) as { id: string; is_active: number } | undefined;
      if (!table) throw httpError(400, "unknown table");
      if (table.is_active !== 1) throw httpError(409, "table is not active");

      // No longer checking for occupied — splits allowed
    }

    const id = uuidv7();
    const now = Date.now();
    const chosenCaptainName = captainName(body.captainId);

    if (body.type === "dine_in") {
      const write = app.db.transaction(() => {
        assertTableNotReserved(app.db, body.tableId!, now);
        const label = nextSplitLabel(app.db, body.tableId!);
        if (label === null) throw httpError(409, "table has too many open splits");

        app.db
          .prepare("INSERT INTO orders (id, client_ref, type, table_id, split_label, opened_by, opened_at, price_tier, captain_id, captain_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
          .run(id, body.clientRef, body.type, body.tableId, label, req.user.id, now, tablePriceTier(app.db, body.tableId!), body.captainId ?? null, chosenCaptainName);
      });
      write();
    } else {
      // Parcel: split_label is NULL
      app.db
        .prepare("INSERT INTO orders (id, client_ref, type, table_id, split_label, opened_by, opened_at, price_tier) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .run(id, body.clientRef, body.type, body.tableId, null, req.user.id, now, "takeaway");
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
    if (order.status !== "open") throw httpError(409, "order is not open");

    const incomingRefs = body.items.map((i) => i.clientRef).filter((r): r is string => !!r);
    const placeholders = incomingRefs.map(() => "?").join(",");
    const existingRefs = new Set(
      incomingRefs.length
        ? (app.db.prepare(`SELECT client_ref FROM order_items WHERE client_ref IN (${placeholders})`).all(...incomingRefs) as Array<{ client_ref: string }>).map((r) => r.client_ref)
        : [],
    );

    interface ProductRow extends PriceRow {
      id: string;
      name: string;
      price_paise: number;
      gst_rate: number;
      is_active: number;
      is_sold_out: number;
    }
    interface VariantRow extends PriceRow {
      id: string;
      product_id: string;
      name: string;
      price_paise: number;
      is_active: number;
    }

    const itemsToInsert: Array<{
      clientRef: string | null;
      productId: string;
      variantId: string | null;
      name: string;
      pricePaise: number;
      gstRate: number;
      qty: number;
      note: string | undefined;
    }> = [];

    for (const item of body.items) {
      if (item.clientRef && existingRefs.has(item.clientRef)) continue;

      const product = app.db.prepare("SELECT * FROM products WHERE id = ?").get(item.productId) as ProductRow | undefined;
      if (!product) throw httpError(400, "unknown product");

      let variant: VariantRow | undefined;
      if (item.variantId) {
        variant = app.db.prepare("SELECT * FROM variants WHERE id = ?").get(item.variantId) as VariantRow | undefined;
        if (!variant) throw httpError(400, "unknown variant");
        if (variant.is_active !== 1) throw httpError(400, "variant is not active");
        if (variant.product_id !== item.productId) throw httpError(400, "variant does not belong to product");
      }

      if (product.is_active !== 1) throw httpError(400, "product is not active");
      if (product.is_sold_out === 1) throw httpError(409, `${product.name} is sold out. Review the order before adding it.`);

      const name = variant ? `${product.name} (${variant.name})` : product.name;
      const pricePaise = rowPrice(variant ?? product, order.price_tier);

      itemsToInsert.push({
        clientRef: item.clientRef ?? null,
        productId: item.productId,
        variantId: item.variantId,
        name,
        pricePaise,
        gstRate: product.gst_rate,
        qty: item.qty,
        note: item.note,
      });
    }

    if (itemsToInsert.length > 0) {
      const write = app.db.transaction(() => {
        for (const item of itemsToInsert) {
          app.db
            .prepare(
              "INSERT INTO order_items (id, order_id, client_ref, product_id, variant_id, name_snapshot, price_paise_snapshot, gst_rate_snapshot, qty, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            )
            .run(
              uuidv7(),
              id,
              item.clientRef,
              item.productId,
              item.variantId,
              item.name,
              item.pricePaise,
              item.gstRate,
              item.qty,
              item.note ?? null,
            );
        }
      });
      write();
    }

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
    if (item.status !== "pending") throw httpError(409, "item is not pending");

    const qty = body.qty ?? item.qty;
    const note = body.note === undefined ? item.note : body.note;

    app.db.prepare("UPDATE order_items SET qty = ?, note = ? WHERE id = ?").run(qty, note, id);

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
    if (order.status !== "open") throw httpError(409, "order is not open");
    if (item.status === "cancelled") throw httpError(409, "item already cancelled");

    if (item.status === "sent") {
      if (!can(roleFor(req.user.role), "orders.cancel_sent")) {
        return reply.status(403).send({ error: "forbidden", permission: "orders.cancel_sent" });
      }
      if (!body.reason) throw httpError(400, "reason required");
    }

    let printError: string | null = null;
    const changedStockIds = app.db.transaction(() => {
      const ids = item.status === "sent" ? reverseStock(app.db, id, req.user.id, body.reason!) : [];
      app.db.prepare("UPDATE order_items SET status = 'cancelled', cancel_reason = ?, cancelled_by = ?, cancelled_at = ? WHERE id = ?")
        .run(body.reason ?? null, req.user.id, Date.now(), id);
      if (item.status === "sent" && item.kot_id) {
        const kot = app.db.prepare("SELECT * FROM kots WHERE id = ?").get(item.kot_id) as KotRow;
        const kotItems = app.db
          .prepare("SELECT * FROM order_items WHERE kot_id = ? ORDER BY id")
          .all(item.kot_id) as OrderItemRow[];
        const order = app.db.prepare("SELECT * FROM orders WHERE id = ?").get(kot.order_id) as OrderRow;
        // The combined label (e.g. "T3, T4") so the kitchen matches the slip to the tickets on screen.
        const tableName = orderTableLabel(app.db, order.id);

        // Print cancel slip
        const stationRow = app.db
          .prepare("SELECT name, printer_id FROM kot_stations WHERE id = ?")
          .get(kot.station_id) as { name: string; printer_id: string | null } | undefined;

        if (stationRow) {
          const printerRow = stationRow.printer_id
            ? (app.db
                .prepare("SELECT paper_width, kot_profile FROM printers WHERE id = ? AND is_active = 1")
                .get(stationRow.printer_id) as { paper_width: number; kot_profile: string } | undefined)
            : undefined;

          if (printerRow) {
            // Build context line using kitchen-board rule
            let contextLine: string;
            if (order.type === "parcel") {
              contextLine = "Parcel";
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
                tableName,
                splitLabel: order.split_label,
                item: { qty: item.qty, name: item.name_snapshot },
                reason: body.reason ?? "No reason provided",
                atMs: Date.now(),
              },
              printerRow.paper_width as 58 | 80,
              readProfile(printerRow.kot_profile),
            ));
            if (rendered.error) printError = rendered.error;
            else app.enqueuePrint(kot.station_id, "cancel", label, rendered.value!);
          }
        }

        return { ids, kot: kotWithContextJson(kot, order, tableName, kotItems) };
      }
      return { ids, kot: null };
    })();
    publishStock(app, changedStockIds.ids);
    const result = orderWithDetails(item.order_id)!;
    app.broadcast("order.updated", { order: result });
    if (changedStockIds.kot) app.broadcast("kot.updated", { kot: changedStockIds.kot });
    return { order: result, printError };
  });

  app.post("/api/orders/:id/cancel", { preHandler: update }, async (req) => {
    const { id } = req.params as { id: string };
    const body = ItemCancel.parse(req.body ?? {});
    const order = getOrder(id);
    if (!order) throw httpError(404, "order not found");
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
