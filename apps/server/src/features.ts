import { FEATURES, type FeatureCatalog, type FeatureInfo } from "@forkflow/domain";
import type { FastifyInstance, preHandlerHookHandler } from "fastify";
import { httpError } from "./http-error.js";

export function featureCatalog(app: FastifyInstance): FeatureCatalog {
  const preferences = new Map((app.db.prepare("SELECT id, enabled, updated_at FROM feature_state").all() as Array<{ id: string; enabled: number; updated_at: number }>).map(row => [row.id, row]));
  const integrations = new Map((app.db.prepare("SELECT id, enabled, updated_at FROM integration_state").all() as Array<{ id: string; enabled: number; updated_at: number }>).map(row => [row.id, row]));
  const licence = app.licensing.status().features;
  const policy = app.licensing.featurePolicy();
  const resolved = new Map<string, FeatureInfo>();
  function resolve(id: string): FeatureInfo {
    const cached = resolved.get(id);
    if (cached) return cached;
    const def = FEATURES.find(feature => feature.id === id)!;
    const row = def.integration ? integrations.get(id) : preferences.get(id);
    const enabled = !def.configurable || (app.licensing.enabled || app.licensing.cloudManaged ? policy?.enabled[id] ?? def.defaultEnabled : row ? row.enabled === 1 : def.defaultEnabled);
    const licensed = !def.entitlement || licence[def.entitlement] === true;
    const available = id !== "swiggy";
    const dependency = def.dependencies.map(resolve).find(feature => !feature.active);
    const reason = !available ? "Coming soon" : !licensed ? "Requires the Pro plan" : !enabled ? "Turned off" : dependency ? `Requires ${dependency.name} to be enabled` : null;
    const info = { ...def, enabled, active: reason === null, licensed, available, reason, updatedAt: row?.updated_at ?? null };
    resolved.set(id, info);
    return info;
  }
  return { revision: (app.db.prepare("SELECT revision FROM feature_revision WHERE id=1").get() as { revision: number }).revision, features: FEATURES.map(def => resolve(def.id)) };
}

export class FeatureDisabledError extends Error {
  readonly statusCode = 403;
  readonly code = "feature_disabled";
  constructor(readonly feature: string, name: string, reason: string | null) { super(`${name} is unavailable: ${reason ?? "turned off"}. Open Marketplace to manage features.`); }
}
export function assertFeatureActive(app: FastifyInstance, id: string): void {
  const info = featureCatalog(app).features.find(feature => feature.id === id);
  if (!info?.active) throw new FeatureDisabledError(id, info?.name ?? id, info?.reason ?? null);
}

/** Append guards after existing authentication/permission checks. Recovery endpoints deliberately remain accessible. */
export function registerFeatureGuards(app: FastifyInstance): void {
  app.addHook("onRoute", route => {
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    const url = route.url;
    let feature: string | undefined;
    if (url.startsWith("/api/reports/") && url !== "/api/reports/profit") feature = "reports";
    if (url.startsWith("/api/costing/") || url === "/api/reports/profit" || url.endsWith("/unit-cost")) feature = "costing";
    if (url.startsWith("/api/stock-items") && methods.some(method => method !== "GET" && method !== "HEAD") && !url.endsWith("/unit-cost")) feature = "inventory";
    if (url === "/api/reservations" && methods.includes("POST") || url === "/api/reservations/:id" && methods.includes("PATCH")) feature = "reservations";
    if (!feature) return;
    const id = feature;
    const guard: preHandlerHookHandler = async req => {
      // Only existing idempotency references bypass creation gates. The route still verifies its full fingerprint.
      const body = req.body as { clientRef?: unknown } | undefined;
      const reference = typeof body?.clientRef === "string" ? body.clientRef : null;
      const recoveryTable = methods.includes("POST") ? url === "/api/stock-items" ? "stock_items"
        : url.endsWith("/movements") ? "stock_moves"
        : url.endsWith("/unit-cost") ? "stock_cost_changes"
        : url === "/api/reservations" ? "reservations" : null : null;
      if (reference && recoveryTable && app.db.prepare(`SELECT 1 FROM ${recoveryTable} WHERE client_ref=?`).get(reference)) return;
      assertFeatureActive(app, id);
      if (url === "/api/reports/profit") assertFeatureActive(app, "reports");
      if (url.endsWith("/movements") && req.body && typeof req.body === "object" && "costPaise" in req.body) assertFeatureActive(app, "costing");
    };
    route.preHandler = [...(Array.isArray(route.preHandler) ? route.preHandler : route.preHandler ? [route.preHandler] : []), guard];
  });
}

export function registerFeatures(app: FastifyInstance): void {
  app.get("/api/features", { preHandler: app.requireAuth }, async (_req, reply) => {
    reply.header("Cache-Control", "no-store");
    return featureCatalog(app);
  });
  app.patch<{ Params: { id: string } }>("/api/features/:id", { preHandler: app.requirePermission("integrations.configure") }, async (req, reply) => {
    throw httpError(403, "Features are controlled by the ForkFlow owner. Restaurant staff cannot change them.");
  });
}

