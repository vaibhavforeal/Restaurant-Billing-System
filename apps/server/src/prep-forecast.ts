import { localDateKey, prepForecast } from "@masalapos/domain";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { httpError } from "./http-error.js";
import { requireModule } from "./modules.js";

/** How far ahead the prep forecast can look. */
export const PREP_MAX_DAYS_AHEAD = 7;

/** Inventory → Prep forecast: expected plates for a day (tomorrow by default) and the ingredients they need. */
export function registerPrepForecast(app: FastifyInstance): void {
  app.get("/api/prep-forecast", { preHandler: [app.requirePermission("stock.read"), requireModule(app, "inventory")] }, async (req, reply) => {
    const now = Date.now();
    const today = localDateKey(now);
    const { date } = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Choose a date").optional() }).parse(req.query);
    const day = date ?? localDateKey(now + 24 * 60 * 60 * 1000);
    const latest = new Date(Date.parse(`${today}T00:00:00Z`) + PREP_MAX_DAYS_AHEAD * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    if (day < today || day > latest) throw httpError(400, `Choose a day from today to ${PREP_MAX_DAYS_AHEAD} days ahead`);
    reply.header("Cache-Control", "no-store");
    return { forecast: prepForecast(app.db, day, today) };
  });
}
