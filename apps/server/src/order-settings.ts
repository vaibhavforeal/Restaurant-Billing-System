import type { Database } from "@masalapos/domain";
import type { FastifyInstance } from "fastify";

/** Whether the restaurant has Hold orders on (Settings → Restaurant profile). */
export function holdOrdersEnabled(db: Database): boolean {
  return (db.prepare("SELECT hold_orders_enabled AS v FROM settings WHERE id = 1").get() as { v: number }).v === 1;
}

/** Order screens and captain tablets read the ordering options here; `/api/settings` needs `settings.manage`. */
export function registerOrderSettings(app: FastifyInstance): void {
  app.get("/api/order-settings", { preHandler: app.requirePermission("orders.read") }, async (_req, reply) => {
    reply.header("Cache-Control", "no-store");
    return { holdOrders: holdOrdersEnabled(app.db) };
  });
}
