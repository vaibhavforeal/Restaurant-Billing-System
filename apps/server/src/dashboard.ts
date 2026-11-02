import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  DashboardItem, DashboardLayout, DASHBOARD_LIMITS, clampItem, compact, defaultLayout, widgetDef, widgetVisible,
  type DashboardItemValue, type DashboardLayoutValue, type WidgetDef,
} from "@masalapos/domain/dashboard";
import { userCan } from "./auth.js";
import { httpError } from "./http-error.js";
import { moduleActive, requireModule } from "./modules.js";

/** Whether this person may see a widget right now: they hold its permissions and its modules are on. */
export function visibleTo(app: FastifyInstance, req: FastifyRequest): (def: WidgetDef) => boolean {
  return (def) => widgetVisible(def, (slug) => userCan(req.user, slug), (id) => moduleActive(app.db, id));
}

/**
 * Turn whatever is stored into a list the grid accepts: unreadable or unknown items and repeated keys are dropped,
 * sizes are pulled into their limits and gaps are closed. Returns null when the stored text is not a layout at all.
 */
function repair(json: string): DashboardItemValue[] | null {
  let stored: unknown;
  try { stored = JSON.parse(json); } catch { return null; }
  const list = (stored as { items?: unknown } | null)?.items;
  if (typeof stored !== "object" || stored === null || !Array.isArray(list)) return null;
  const keys = new Set<string>();
  const items: DashboardItemValue[] = [];
  for (const raw of list) {
    const parsed = DashboardItem.safeParse(raw);
    if (!parsed.success || keys.has(parsed.data.key)) continue;
    keys.add(parsed.data.key);
    items.push(clampItem(parsed.data, widgetDef(parsed.data.widget).limits));
  }
  return compact(items);
}

export function registerDashboard(app: FastifyInstance): void {
  const preHandler = [app.requirePermission("reports.read"), app.requirePermission("reports.dashboard"), requireModule(app, "dynamicReports")];
  /** The person's saved items, or null when they have no row or the row holds no layout at all. */
  const storedItems = (userId: string): DashboardItemValue[] | null => {
    const json = app.db.prepare("SELECT layout_json FROM dashboard_layouts WHERE user_id = ?").pluck().get(userId) as string | undefined;
    return json === undefined ? null : repair(json);
  };
  const respond = (req: FastifyRequest, items: DashboardItemValue[], isDefault: boolean) => {
    const visible = visibleTo(app, req);
    const layout: DashboardLayoutValue = { version: 1, items: items.filter((item) => visible(widgetDef(item.widget))) };
    return { layout, isDefault };
  };

  app.get("/api/dashboard/layout", { preHandler }, async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    const stored = storedItems(req.user.id);
    return stored ? respond(req, stored, false) : respond(req, defaultLayout().items, true);
  });

  app.put("/api/dashboard/layout", { preHandler }, async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    const { layout } = (req.body ?? {}) as { layout?: unknown };
    const submitted = DashboardLayout.parse(layout);
    const visible = visibleTo(app, req);
    if (submitted.items.some((item) => !visible(widgetDef(item.widget)))) throw httpError(403, "That widget is not available to you.");
    // Widgets hidden from this person right now stay stored, so they come back when the module or permission does.
    const hidden = (storedItems(req.user.id) ?? []).filter((item) => !visible(widgetDef(item.widget)));
    const used = new Set(submitted.items.map((item) => item.key));
    const kept = hidden.filter((item) => !used.has(item.key));
    if (submitted.items.length + kept.length > DASHBOARD_LIMITS.items) throw httpError(400, "Your dashboard is full. Remove a widget before adding more.");
    const bottom = Math.max(0, ...submitted.items.map((item) => item.y + item.h));
    const top = Math.min(...kept.map((item) => item.y));
    const merged = compact([...submitted.items, ...kept.map((item) => ({ ...item, y: item.y - top + bottom }))]);
    app.db.prepare(`INSERT INTO dashboard_layouts (user_id, layout_json, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET layout_json = excluded.layout_json, updated_at = excluded.updated_at`)
      .run(req.user.id, JSON.stringify({ version: 1, items: merged }), Date.now());
    return respond(req, merged, false);
  });

  app.delete("/api/dashboard/layout", { preHandler }, async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    app.db.prepare("DELETE FROM dashboard_layouts WHERE user_id = ?").run(req.user.id);
    return respond(req, defaultLayout().items, true);
  });
}
