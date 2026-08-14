import { CategoryCreate, CategoryUpdate, uuidv7 } from "@forkflow/domain";
import type { FastifyInstance } from "fastify";
import { httpError } from "./http-error.js";

interface CategoryRow {
  id: string;
  name: string;
  sort_order: number;
  is_active: number;
}

const toCategory = (r: CategoryRow) => ({
  id: r.id,
  name: r.name,
  sortOrder: r.sort_order,
  isActive: r.is_active === 1,
});

export function registerCatalog(app: FastifyInstance): void {
  const read = app.requirePermission("catalog.read");
  const manage = app.requirePermission("catalog.manage");

  const getCategory = (id: string) =>
    app.db.prepare("SELECT * FROM categories WHERE id = ?").get(id) as CategoryRow | undefined;

  app.get("/api/categories", { preHandler: read }, async () => {
    const rows = app.db.prepare("SELECT * FROM categories ORDER BY sort_order, name").all() as CategoryRow[];
    return { categories: rows.map(toCategory) };
  });

  app.post("/api/categories", { preHandler: manage }, async (req, reply) => {
    const body = CategoryCreate.parse(req.body);
    const id = uuidv7();
    app.db.prepare("INSERT INTO categories (id, name, sort_order) VALUES (?, ?, ?)").run(id, body.name, body.sortOrder);
    return reply.status(201).send({ category: toCategory(getCategory(id)!) });
  });

  app.patch("/api/categories/:id", { preHandler: manage }, async (req) => {
    const { id } = req.params as { id: string };
    const body = CategoryUpdate.parse(req.body);
    const row = getCategory(id);
    if (!row) throw httpError(404, "category not found");
    app.db
      .prepare("UPDATE categories SET name = ?, sort_order = ?, is_active = ? WHERE id = ?")
      .run(body.name ?? row.name, body.sortOrder ?? row.sort_order, (body.isActive ?? row.is_active === 1) ? 1 : 0, id);
    return { category: toCategory(getCategory(id)!) };
  });
}
