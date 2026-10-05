import { TableCreate, TableUpdate, uuidv7 } from "@forkflow/domain";
import type { FastifyInstance } from "fastify";
import { httpError } from "./http-error.js";
import { localMinute } from "./reservation-rules.js";

interface TableRow {
  id: string;
  name: string;
  area: string | null;
  price_tier: "non_ac" | "ac";
  sort_order: number;
  is_active: number;
}

type TableStatus = "free" | "occupied" | "billed";

export function registerTables(app: FastifyInstance): void {
  const read = app.requirePermission("tables.read");
  const manage = app.requirePermission("tables.manage");

  const getTable = (id: string) =>
    app.db.prepare("SELECT * FROM dining_tables WHERE id = ?").get(id) as TableRow | undefined;

  interface ActiveOrderRow { id: string; table_id: string; split_label: string | null; status: "open" | "billed" }
  interface ReservationRow { id: string; table_id: string; customer_name: string; party_size: number; starts_at: number; ends_at: number }

  // Derive status and activeOrders from a table's open/billed orders (never stored)
  function stateFromOrders(orders: ActiveOrderRow[]): {
    status: TableStatus;
    activeOrders: Array<{ id: string; splitLabel: string | null; status: "open" | "billed" }>;
  } {
    if (orders.length === 0) {
      return { status: "free", activeOrders: [] };
    }

    const hasOpen = orders.some((o) => o.status === "open");
    const status = hasOpen ? "occupied" : "billed";

    return {
      status,
      activeOrders: orders.map((o) => ({ id: o.id, splitLabel: o.split_label, status: o.status })),
    };
  }

  const deriveTableState = (tableId: string) => stateFromOrders(app.db
    .prepare(`SELECT id, table_id, split_label, status FROM orders WHERE table_id = ? AND status IN ('open', 'billed') ORDER BY split_label`)
    .all(tableId) as ActiveOrderRow[]);

  // Two grouped queries cover every table, instead of two per table on each refresh.
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
    return rows.map((r) => buildTable(r, stateFromOrders(ordersByTable.get(r.id) ?? []), nextReservation.get(r.id), now));
  }
  const toTable = (r: TableRow) => toTables([r])[0]!;

  const buildTable = (r: TableRow, { status, activeOrders }: ReturnType<typeof stateFromOrders>, reservation: ReservationRow | undefined, now: number) => {
    return {
      id: r.id,
      name: r.name,
      area: r.area,
      priceTier: r.price_tier,
      sortOrder: r.sort_order,
      isActive: r.is_active === 1,
      status: status === "free" && reservation && reservation.starts_at <= now ? "reserved" : status,
      activeOrders,
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
