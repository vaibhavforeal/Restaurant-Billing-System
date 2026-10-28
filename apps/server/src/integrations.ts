import { INTEGRATIONS, IntegrationToggle, isIntegrationId, isModuleId, type Database, type IntegrationId, type IntegrationInfo } from "@forkflow/domain";
import type { FastifyInstance } from "fastify";
import { httpError } from "./http-error.js";
import { moduleActive, moduleStates, requireModule, setModuleEnabled } from "./modules.js";

/**
 * The Marketplace add-on cards: a view over the module controls (see modules.ts). An add-on works when the ForkFlow owner
 * allows it and the restaurant has switched it on. Swiggy is listed but not yet a module, so it is never on.
 */
export function integrationEnabled(db: Database, id: IntegrationId): boolean {
  return isModuleId(id) && moduleActive(db, id);
}

/** A route pre-handler that refuses requests while an add-on is not available. Put it after the permission check. */
export function requireIntegration(app: FastifyInstance, id: IntegrationId & Parameters<typeof requireModule>[1]) {
  return requireModule(app, id);
}

/** CRM & Loyalty: customers, discount slabs, points, tiers, feedback and segments. */
export const crmEnabled = (db: Database) => integrationEnabled(db, "crm");

function listIntegrations(db: Database): IntegrationInfo[] {
  const states = new Map(moduleStates(db).map((m) => [m.id as string, m]));
  return INTEGRATIONS.map((def) => {
    const state = states.get(def.id);
    // `licensed` now means "the owner allows it": the plan's defaults with the owner's choices, from the licence.
    return { ...def, enabled: state?.enabled ?? false, licensed: state?.allowed ?? false, updatedAt: state?.updatedAt ?? null };
  });
}

export function registerIntegrations(app: FastifyInstance): void {
  const read = app.requirePermission("integrations.read");
  const configure = app.requirePermission("integrations.configure");

  app.get("/api/integrations", { preHandler: read }, async (_req, reply) => {
    reply.header("Cache-Control", "no-store");
    return { integrations: listIntegrations(app.db) };
  });

  app.patch<{ Params: { id: string } }>("/api/integrations/:id", { preHandler: configure }, async (req, reply) => {
    const { id } = req.params;
    if (!isIntegrationId(id)) throw httpError(404, "Unknown integration");
    const body = IntegrationToggle.parse(req.body);
    const def = INTEGRATIONS.find((integration) => integration.id === id)!;
    if ((def.status === "coming_soon" || !isModuleId(id)) && body.enabled) throw httpError(409, `${def.name} is coming soon and cannot be turned on yet`);
    if (isModuleId(id)) setModuleEnabled(app, id, body.enabled, req.user.id);
    reply.header("Cache-Control", "no-store");
    return { integration: listIntegrations(app.db).find((integration) => integration.id === id)! };
  });
}
