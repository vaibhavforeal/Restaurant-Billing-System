import { TableCreate, TableUpdate, uuidv7 } from "@forkflow/domain";
import type { FastifyInstance } from "fastify";
import { httpError } from "./http-error.js";
import { localMinute } from "./reservation-rules.js";
import { activeLinkForTable } from "./table-label.js";

interface TableRow {
  id: string;
  name: string;
  area: string | null;
  price_tier: "non_ac" | "ac";
  sort_order: number;
  is_active: number;
}

type TableStatus = "free" | "occupied" | "billed";

interface TableLink { orderId: string; status: "open" | "billed"; label: string; tableName: string }

export function registerTables(app: FastifyInstance): void {
  const read = app.requirePermission("tables.read");
  const manage = app.requirePermission("tables.manage");

  const getTable = (id: string) =>
    app.db.prepare("SELECT * FROM dining_tables WHERE id = ?").get(id) as TableRow | undefined;

  interface ActiveOrderRow { id: string; table_id: string; split_label: string | null; status: "open" | "billed" }
  interface ReservationRow { id: string; table_id: string; customer_name: string; party_size: number; starts_at: number; ends_at: number }

  // Derive status, activeOrders and link from a table's open/billed orders and its active link (never stored)
  function stateFromOrders(orders: ActiveOrderRow[], link: TableLink | null): {
    status: TableStatus;
    activeOrders: Array<{ id: string; splitLabel: string | null; status: "open" | "billed" }>;
    link: TableLink | null;
  } {
    const activeOrders = orders.map((o) => ({ id: o.id, splitLabel: o.split_label, status: o.status }));
    if (orders.length === 0 && !link) {
      return { status: "free", activeOrders, link };
    }

    const hasOpen = orders.some((o) => o.status === "open") || link?.status === "open";
    return { status: hasOpen ? "occupied" : "billed", activeOrders, link };
  }

  const deriveTableState = (tableId: string) => stateFromOrders(app.db
    .prepare(`SELECT id, table_id, split_label, status FROM orders WHERE table_id = ? AND status IN ('open', 'billed') ORDER BY split_label`)
    .all(tableId) as ActiveOrderRow[], activeLinkForTableJson(tableId));

  function activeLinkForTableJson(tableId: string): TableLink | null {
    const link = activeLinkForTable(app.db, tableId);
    if (!link) return null;
    const own = app.db.prepare("SELECT dt.name FROM orders o JOIN dining_tables dt ON dt.id = o.table_id WHERE o.id = ?").get(link.orderId) as { name: string };
    return { ...link, tableName: own.name };
  }

  // Three grouped queries cover every table, instead of several per table on each refresh.
  function toTables(rows: TableRow[], now = Date.now()) {
    const ordersByTable = new Map<string, ActiveOrderRow[]>();
    for (const order of app.db.prepare(`SELECT id, table_id, split_label, status FROM orders WHERE table_id IS NOT NULL AND status IN ('open', 'billed') ORDER BY split_label`).all() as ActiveOrderRow[]) {
      const list = ordersByTable.get(order.table_id);
      if (list) list.push(order); else ordersByTable.set(order.table_id, [order]);
    }
    const nextReservation = new Map<string, ReservationRow>();
    for (const booking of app.db.prepare(`SELECT id, table_id, customer_name, party_size, starts_at, ends_at FROM reservations
      WHERE status = 'booked' AND ends_at > ? ORDER BY starts_at`).all(now) as ReservationRow[]) {
      if (!nextReservation.has(booking.table_id)) nextReservation.set(booking.table_id, booking);
    }
    // Active links in link order. Each combined order's label is its own table plus every linked table, so
    // one query yields both the links per table and the label of each order they point to.
    const links = app.db.prepare(`SELECT tl.table_id AS tableId, tl.order_id AS orderId, o.status, own.name AS ownName, linked.name AS linkedName
      FROM table_links tl
      JOIN orders o ON o.id = tl.order_id
      JOIN dining_tables own ON own.id = o.table_id
      JOIN dining_tables linked ON linked.id = tl.table_id
      WHERE o.status IN ('open', 'billed') ORDER BY tl.linked_at, tl.id`).all() as Array<{ tableId: string; orderId: string; status: "open" | "billed"; ownName: string; linkedName: string }>;
    const labelByOrder = new Map<string, string>();
    for (const l of links) labelByOrder.set(l.orderId, labelByOrder.has(l.orderId) ? `${labelByOrder.get(l.orderId)}, ${l.linkedName}` : `${l.ownName}, ${l.linkedName}`);
    const linkByTable = new Map<string, TableLink>();
    for (const l of links) {
      const current = linkByTable.get(l.tableId);
      // Same preference as activeLinkForTable: an open combined order outranks a billed one.
      if (current && (current.status === "open" || l.status !== "open")) continue;
      linkByTable.set(l.tableId, { orderId: l.orderId, status: l.status, label: labelByOrder.get(l.orderId)!, tableName: l.ownName });
    }
    return rows.map((r) => buildTable(r, stateFromOrders(ordersByTable.get(r.id) ?? [], linkByTable.get(r.id) ?? null), nextReservation.get(r.id), now));
  }
  const toTable = (r: TableRow) => toTables([r])[0]!;

  const buildTable = (r: TableRow, { status, activeOrders, link }: ReturnType<typeof stateFromOrders>, reservation: ReservationRow | undefined, now: number) => {
    return {
      id: r.id,
      name: r.name,
      area: r.area,
      priceTier: r.price_tier,
      sortOrder: r.sort_order,
      isActive: r.is_active === 1,
      status: status === "free" && reservation && reservation.starts_at <= now ? "reserved" : status,
      activeOrders,
      link,
      reservation: reservation ? { id: reservation.id, customerName: reservation.customer_name, partySize: reservation.party_size,
        startsAt: reservation.starts_at, endsAt: reservation.ends_at, startsLocal: localMinute(reservation.starts_at) } : null,
    };
  };

  app.get("/api/tables", { preHandler: read }, async () => {
    const rows = app.db.prepare("SELECT * FROM dining_tables ORDER BY sort_order, name").all() as TableRow[];
    return { tables: toTables(rows) };
  });

  app.post("/api/tables", { preHandler: manage }, async (req, reply) => {
    const body = TableCreate.parse(req.body);
    const id = uuidv7();
    app.db
      .prepare("INSERT INTO dining_tables (id, name, area, sort_order, price_tier) VALUES (?, ?, ?, ?, ?)")
      .run(id, body.name, body.area, body.sortOrder, body.priceTier);
    app.broadcast("table.changed", { tableId: id });
    return reply.status(201).send({ table: toTable(getTable(id)!) });
  });

  app.patch("/api/tables/:id", { preHandler: manage }, async (req) => {
    const { id } = req.params as { id: string };
    const body = TableUpdate.parse(req.body);
    const row = getTable(id);
    if (!row) throw httpError(404, "table not found");

    if (body.priceTier !== undefined && body.priceTier !== row.price_tier && deriveTableState(id).activeOrders.length) {
      throw httpError(409, "Close all orders at this table before changing its pricing.");
    }

    // Check if deactivating a table with an open/billed order
    if (body.isActive === false) {
      const { status } = deriveTableState(id);
      if (status === "occupied" || status === "billed") {
        throw httpError(409, "table has an open order");
      }
      if (app.db.prepare("SELECT id FROM reservations WHERE table_id = ? AND status='booked' AND ends_at > ? LIMIT 1").get(id, Date.now())) {
        throw httpError(409, "This table has upcoming reservations. Move or cancel them before deactivating it.");
      }
    }

    app.db
      .prepare("UPDATE dining_tables SET name = ?, area = ?, sort_order = ?, is_active = ?, price_tier = ? WHERE id = ?")
      .run(
        body.name ?? row.name,
        body.area === undefined ? row.area : body.area,
        body.sortOrder ?? row.sort_order,
        (body.isActive ?? row.is_active === 1) ? 1 : 0,
        body.priceTier ?? row.price_tier,
        id,
      );
    app.broadcast("table.changed", { tableId: id });
    return { table: toTable(getTable(id)!) };
  });
}
