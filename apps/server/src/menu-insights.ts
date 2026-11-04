import { popularProductIds, type Database } from "@masalapos/domain";
import type { FastifyInstance } from "fastify";

/** Whether the restaurant shows popular items on its menus (Settings → Restaurant profile). */
export function popularItemsEnabled(db: Database): boolean {
  return (db.prepare("SELECT popular_items_enabled AS v FROM settings WHERE id = 1").get() as { v: number }).v === 1;
}

/** Each category's best-seller to badge on the staff and guest menus; none while the setting is off. */
export function menuPopularIds(db: Database, now = Date.now()): string[] {
  return popularItemsEnabled(db) ? popularProductIds(db, now) : [];
}

/**
 * Hints worked out from the restaurant's own sales, for the order screen's menu. One object so later hints
 * (dishes ordered together, time-of-day favourites) can be added as fields.
 */
export function registerMenuInsights(app: FastifyInstance): void {
  app.get("/api/menu/insights", { preHandler: app.requirePermission("orders.read") }, async (_req, reply) => {
    reply.header("Cache-Control", "no-store");
    return { popularProductIds: menuPopularIds(app.db) };
  });
}
