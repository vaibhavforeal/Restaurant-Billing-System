import { OrderCreate, uuidv7 } from "@forkflow/domain";
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
}
