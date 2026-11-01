import { OrderTypeChange, OrderTypeCreate, OrderTypeUpdate, uuidv7, type Database, type OrderTypeKind } from "@masalapos/domain";
import type { FastifyInstance } from "fastify";
import { httpError } from "./http-error.js";
import { loadOrderJson } from "./mappers.js";

interface OrderTypeRow { id: string; name: string; kind: OrderTypeKind; is_active: number; is_system: number; sort_order: number }
const toOrderType = (r: OrderTypeRow) => ({ id: r.id, name: r.name, kind: r.kind, isActive: r.is_active === 1, isSystem: r.is_system === 1, sortOrder: r.sort_order });

/**
 * An active takeaway or delivery type a parcel order can use. The built-in Takeaway ('parcel') returns null:
 * orders on it keep a NULL `order_type_id` and no name snapshot, exactly as before order types existed.
 */
export function takeawayOrderType(db: Database, id: string): { id: string; name: string } | null {
  const row = db.prepare("SELECT * FROM order_types WHERE id = ?").get(id) as OrderTypeRow | undefined;
  if (!row || row.is_active !== 1) throw httpError(400, "Choose an active order type");
  if (row.kind !== "takeaway" && row.kind !== "delivery") throw httpError(400, "Only takeaway and delivery types can be chosen for a takeaway order");
  return row.id === "parcel" ? null : { id: row.id, name: row.name };
}

export function registerOrderTypes(app: FastifyInstance): void {
  const db = app.db;
  const manage = app.requirePermission("catalog.manage");
  const get = (id: string) => db.prepare("SELECT * FROM order_types WHERE id = ?").get(id) as OrderTypeRow | undefined;
  const nameTaken = (name: string, exceptId?: string) =>
    db.prepare("SELECT 1 FROM order_types WHERE name = ? COLLATE NOCASE AND id <> ?").get(name, exceptId ?? "") !== undefined;

  app.get("/api/order-types", { preHandler: app.requirePermission("orders.read") }, async () => ({
    orderTypes: (db.prepare("SELECT * FROM order_types ORDER BY sort_order, name COLLATE NOCASE").all() as OrderTypeRow[]).map(toOrderType),
  }));

  app.post("/api/order-types", { preHandler: manage }, async (req, reply) => {
    const body = OrderTypeCreate.parse(req.body);
    if (nameTaken(body.name)) throw httpError(409, "An order type with this name already exists");
    const id = uuidv7();
    const next = (db.prepare("SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM order_types").get() as { n: number }).n;
    db.prepare("INSERT INTO order_types (id, name, kind, sort_order, created_at) VALUES (?, ?, ?, ?, ?)").run(id, body.name, body.kind, next, Date.now());
    return reply.status(201).send({ orderType: toOrderType(get(id)!) });
  });

  app.patch("/api/order-types/:id", { preHandler: manage }, async (req) => {
    const { id } = req.params as { id: string };
    const body = OrderTypeUpdate.parse(req.body);
    const row = get(id);
    if (!row) throw httpError(404, "order type not found");
    // Built-in types drive dine-in tables, Quick takeaway and the Zomato desk; they can be renamed and reordered only.
    if (row.is_system === 1 && body.isActive === false) throw httpError(409, "Built-in order types cannot be turned off");
    if (body.name !== undefined && nameTaken(body.name, id)) throw httpError(409, "An order type with this name already exists");
    db.prepare("UPDATE order_types SET name = ?, is_active = ?, sort_order = ? WHERE id = ?")
      .run(body.name ?? row.name, body.isActive === undefined ? row.is_active : body.isActive ? 1 : 0, body.sortOrder ?? row.sort_order, id);
    return { orderType: toOrderType(get(id)!) };
  });

  app.patch("/api/orders/:id/order-type", { preHandler: app.requirePermission("orders.update") }, async (req) => {
    const { id } = req.params as { id: string };
    const body = OrderTypeChange.parse(req.body);
    db.transaction(() => {
      const order = db.prepare("SELECT type, status FROM orders WHERE id = ?").get(id) as { type: string; status: string } | undefined;
      if (!order) throw httpError(404, "order not found");
      if (order.status !== "open") throw httpError(409, "order is not open");
      if (order.type !== "parcel") throw httpError(409, "Only takeaway orders can change order type");
      const chosen = takeawayOrderType(db, body.orderTypeId);
      db.prepare("UPDATE orders SET order_type_id = ?, order_type_name = ? WHERE id = ?").run(chosen?.id ?? null, chosen?.name ?? null, id);
    })();
    const order = loadOrderJson(db, id)!;
    app.broadcast("order.updated", { order });
    return { order };
  });
}
