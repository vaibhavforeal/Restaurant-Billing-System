import { OrderCreate, OrderItemsAdd, OrderItemUpdate, ItemCancel, uuidv7, roleFor } from "@forkflow/domain";
import { can } from "@forkflow/core";
import type { FastifyInstance } from "fastify";
import { httpError } from "./http-error.js";

interface OrderRow {
  id: string;
  client_ref: string;
  type: "dine_in" | "parcel";
  table_id: string | null;
  status: "open" | "billed" | "settled" | "cancelled";
  opened_by: string;
  opened_at: number;
  closed_at: number | null;
}

interface OrderItemRow {
  id: string;
  order_id: string;
  client_ref: string | null;
  product_id: string;
  variant_id: string | null;
  name_snapshot: string;
  price_paise_snapshot: number;
  gst_rate_snapshot: number;
  qty: number;
  status: "pending" | "sent" | "cancelled";
  note: string | null;
  cancel_reason: string | null;
  kot_id: string | null;
  cancelled_by: string | null;
}

interface KotRow {
  id: string;
  kot_no: number;
  station_id: string;
  order_id: string;
  created_at: number;
  done_at: number | null;
}

const toOrderItem = (r: OrderItemRow) => ({
  id: r.id,
  clientRef: r.client_ref,
  productId: r.product_id,
  variantId: r.variant_id,
  name: r.name_snapshot,
  pricePaise: r.price_paise_snapshot,
  gstRate: r.gst_rate_snapshot,
  qty: r.qty,
  status: r.status,
  note: r.note,
  cancelReason: r.cancel_reason,
  kotId: r.kot_id,
});

const toKot = (r: KotRow) => ({
  id: r.id,
  kotNo: r.kot_no,
  stationId: r.station_id,
  orderId: r.order_id,
  createdAt: r.created_at,
  doneAt: r.done_at,
});

const toOrder = (r: OrderRow, items: OrderItemRow[], kots: KotRow[]) => ({
  id: r.id,
  clientRef: r.client_ref,
  type: r.type,
  tableId: r.table_id,
  status: r.status,
  openedBy: r.opened_by,
  openedAt: r.opened_at,
  closedAt: r.closed_at,
  items: items.map(toOrderItem),
  kots: kots.map(toKot),
});

export function registerOrders(app: FastifyInstance): void {
  const create = app.requirePermission("orders.create");
  const read = app.requirePermission("orders.read");

  const getOrder = (id: string) =>
    app.db.prepare("SELECT * FROM orders WHERE id = ?").get(id) as OrderRow | undefined;

  function orderWithDetails(id: string) {
    const order = getOrder(id);
    if (!order) return null;
    const items = app.db
      .prepare("SELECT * FROM order_items WHERE order_id = ? ORDER BY id")
      .all(id) as OrderItemRow[];
    const kots = app.db
      .prepare("SELECT * FROM kots WHERE order_id = ? ORDER BY created_at")
      .all(id) as KotRow[];
    return toOrder(order, items, kots);
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

      const openOrder = app.db
        .prepare("SELECT id FROM orders WHERE table_id = ? AND status IN ('open', 'billed')")
        .get(body.tableId!) as { id: string } | undefined;
      if (openOrder) throw httpError(409, "table occupied");
    }

    const id = uuidv7();
    app.db
      .prepare("INSERT INTO orders (id, client_ref, type, table_id, opened_by, opened_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(id, body.clientRef, body.type, body.tableId, req.user.id, Date.now());

    const order = orderWithDetails(id)!;
    app.broadcast("order.updated", { order });
    if (body.type === "dine_in") {
      app.broadcast("table.changed", { tableId: body.tableId! });
    }

    return reply.status(201).send({ order });
  });

  app.get("/api/orders", { preHandler: read }, async () => {
    const rows = app.db
      .prepare("SELECT * FROM orders WHERE status = 'open' ORDER BY opened_at")
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

  app.post("/api/orders/:id/items", { preHandler: update }, async (req) => {
    const { id } = req.params as { id: string };
    const body = OrderItemsAdd.parse(req.body);
    const order = getOrder(id);
    if (!order) throw httpError(404, "order not found");
    if (order.status !== "open") throw httpError(409, "order is not open");

    const existingRefs = new Set(
      (app.db.prepare("SELECT client_ref FROM order_items WHERE client_ref IS NOT NULL").all() as Array<{ client_ref: string }>).map((r) => r.client_ref),
    );

    interface ProductRow {
      id: string;
      name: string;
      price_paise: number;
      gst_rate: number;
      is_active: number;
    }
    interface VariantRow {
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

      const name = variant ? `${product.name} (${variant.name})` : product.name;
      const pricePaise = variant ? variant.price_paise : product.price_paise;

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
    if (item.status === "cancelled") throw httpError(409, "item already cancelled");

    if (item.status === "sent") {
      if (!can(roleFor(req.user.role), "orders.cancel_sent")) {
        return reply.status(403).send({ error: "forbidden", permission: "orders.cancel_sent" });
      }
      if (!body.reason) throw httpError(400, "reason required");
    }

    app.db
      .prepare("UPDATE order_items SET status = 'cancelled', cancel_reason = ?, cancelled_by = ? WHERE id = ?")
      .run(body.reason ?? null, req.user.id, id);

    const result = orderWithDetails(item.order_id)!;
    app.broadcast("order.updated", { order: result });
    if (item.status === "sent" && item.kot_id) {
      const kot = app.db.prepare("SELECT * FROM kots WHERE id = ?").get(item.kot_id) as KotRow;
      const kotItems = app.db
        .prepare("SELECT * FROM order_items WHERE kot_id = ? ORDER BY id")
        .all(item.kot_id) as OrderItemRow[];
      const order = getOrder(kot.order_id)!;
      const tableName = order.table_id
        ? (app.db.prepare("SELECT name FROM dining_tables WHERE id = ?").get(order.table_id) as { name: string } | undefined)?.name ?? null
        : null;
      app.broadcast("kot.updated", {
        kot: {
          ...toKot(kot),
          orderType: order.type,
          tableName,
          items: kotItems.map((i) => ({ id: i.id, name: i.name_snapshot, qty: i.qty, note: i.note, status: i.status })),
        },
      });
    }
    return { order: result };
  });

  app.post("/api/orders/:id/cancel", { preHandler: update }, async (req) => {
    const { id } = req.params as { id: string };
    const order = getOrder(id);
    if (!order) throw httpError(404, "order not found");
    if (order.status !== "open") throw httpError(409, "order is not open");

    const sentItem = app.db
      .prepare("SELECT id FROM order_items WHERE order_id = ? AND status = 'sent' LIMIT 1")
      .get(id) as { id: string } | undefined;
    if (sentItem) throw httpError(409, "cancel sent items first");

    app.db.prepare("UPDATE orders SET status = 'cancelled', closed_at = ? WHERE id = ?").run(Date.now(), id);

    const result = orderWithDetails(id)!;
    app.broadcast("order.updated", { order: result });
    if (order.table_id) {
      app.broadcast("table.changed", { tableId: order.table_id });
    }
    return { order: result };
  });
}
