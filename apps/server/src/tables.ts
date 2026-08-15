import { TableCreate, TableUpdate, uuidv7 } from "@forkflow/domain";
import type { FastifyInstance } from "fastify";
import { httpError } from "./http-error.js";

interface TableRow {
  id: string;
  name: string;
  area: string | null;
  sort_order: number;
  is_active: number;
}

type OrderStatus = "open" | "billed" | "settled" | "cancelled";
type TableStatus = "free" | "occupied" | "billed";

export function registerTables(app: FastifyInstance): void {
  const read = app.requirePermission("tables.read");
  const manage = app.requirePermission("tables.manage");

  const getTable = (id: string) =>
    app.db.prepare("SELECT * FROM dining_tables WHERE id = ?").get(id) as TableRow | undefined;

  // Derive status and activeOrders from all open/billed orders (never stored)
  function deriveTableState(tableId: string): {
    status: TableStatus;
    activeOrders: Array<{ id: string; splitLabel: string | null; status: "open" | "billed" }>;
  } {
    const orders = app.db
      .prepare(
        `SELECT id, split_label, status FROM orders
         WHERE table_id = ? AND status IN ('open', 'billed')
         ORDER BY split_label`,
      )
      .all(tableId) as Array<{ id: string; split_label: string | null; status: "open" | "billed" }>;

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

  const toTable = (r: TableRow) => {
    const { status, activeOrders } = deriveTableState(r.id);
    return {
      id: r.id,
      name: r.name,
      area: r.area,
      sortOrder: r.sort_order,
      isActive: r.is_active === 1,
      status,
      activeOrders,
    };
  };

  app.get("/api/tables", { preHandler: read }, async () => {
    const rows = app.db.prepare("SELECT * FROM dining_tables ORDER BY sort_order, name").all() as TableRow[];
    return { tables: rows.map(toTable) };
  });

  app.post("/api/tables", { preHandler: manage }, async (req, reply) => {
    const body = TableCreate.parse(req.body);
    const id = uuidv7();
    app.db
      .prepare("INSERT INTO dining_tables (id, name, area, sort_order) VALUES (?, ?, ?, ?)")
      .run(id, body.name, body.area, body.sortOrder);
    return reply.status(201).send({ table: toTable(getTable(id)!) });
  });

  app.patch("/api/tables/:id", { preHandler: manage }, async (req) => {
    const { id } = req.params as { id: string };
    const body = TableUpdate.parse(req.body);
    const row = getTable(id);
    if (!row) throw httpError(404, "table not found");

    // Check if deactivating a table with an open/billed order
    if (body.isActive === false) {
      const { status } = deriveTableState(id);
      if (status === "occupied" || status === "billed") {
        throw httpError(409, "table has an open order");
      }
    }

    app.db
      .prepare("UPDATE dining_tables SET name = ?, area = ?, sort_order = ?, is_active = ? WHERE id = ?")
      .run(
        body.name ?? row.name,
        body.area === undefined ? row.area : body.area,
        body.sortOrder ?? row.sort_order,
        (body.isActive ?? row.is_active === 1) ? 1 : 0,
        id,
      );
    return { table: toTable(getTable(id)!) };
  });
}
