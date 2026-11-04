import { orderedTogether, popularProductIds, type Database, type PairedDish } from "@masalapos/domain";
import type { FastifyInstance } from "fastify";

/** Whether the restaurant shows popular items on its menus (Settings → Restaurant profile). */
export function popularItemsEnabled(db: Database): boolean {
  return (db.prepare("SELECT popular_items_enabled AS v FROM settings WHERE id = 1").get() as { v: number }).v === 1;
}

/** Whether the carts suggest dishes ordered together (Settings → Restaurant profile). */
export function orderedTogetherEnabled(db: Database): boolean {
  return (db.prepare("SELECT ordered_together_enabled AS v FROM settings WHERE id = 1").get() as { v: number }).v === 1;
}

/** Dishes often on the same bill as each dish, for the carts' "Goes well with" row; none while the setting is off. */
export function menuPairs(db: Database, now = Date.now()): Record<string, PairedDish[]> {
  return orderedTogetherEnabled(db) ? orderedTogether(db, now) : {};
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
    const now = Date.now();
    return { popularProductIds: menuPopularIds(app.db, now), pairs: menuPairs(app.db, now) };
  });
}
