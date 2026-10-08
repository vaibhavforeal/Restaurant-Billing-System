import { INTEGRATIONS, IntegrationToggle, isIntegrationId, type Database, type IntegrationId, type IntegrationInfo } from "@forkflow/domain";
import type { FastifyInstance } from "fastify";
import { httpError } from "./http-error.js";
import { integrationLicensed } from "./kds.js";

interface StateRow { id: string; enabled: number; updated_at: number }

/** True only when the Marketplace has an `enabled = 1` row for this integration (no row means off). */
export function integrationEnabled(db: Database, id: IntegrationId): boolean {
  const row = db.prepare("SELECT enabled FROM integration_state WHERE id=?").get(id) as { enabled: number } | undefined;
  return row?.enabled === 1;
}

function listIntegrations(db: Database): IntegrationInfo[] {
  const rows = new Map((db.prepare("SELECT id, enabled, updated_at FROM integration_state").all() as StateRow[]).map((r) => [r.id, r]));
  return INTEGRATIONS.map((def) => {
    const row = rows.get(def.id);
    return { ...def, enabled: row?.enabled === 1, licensed: integrationLicensed(db, def), updatedAt: row?.updated_at ?? null };
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
    if (def.status === "coming_soon" && body.enabled) throw httpError(409, `${def.name} is coming soon and cannot be turned on yet`);
    // Turning off stays allowed so an admin can clear a switch left on by a plan downgrade.
    if (body.enabled && !integrationLicensed(app.db, def)) throw httpError(403, "Kitchen Display requires the Pro plan");
    const changed = app.db.transaction(() => {
      // A repeat of the current value writes nothing, so updated_at/updated_by keep recording the last real change.
      if (integrationEnabled(app.db, id) === body.enabled) return false;
      app.db.prepare(`INSERT INTO integration_state (id, enabled, updated_at, updated_by) VALUES (?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET enabled=excluded.enabled, updated_at=excluded.updated_at, updated_by=excluded.updated_by`)
        .run(id, body.enabled ? 1 : 0, Date.now(), req.user.id);
      return true;
    })();
    if (changed) app.broadcast("integrations.changed", {});
    reply.header("Cache-Control", "no-store");
    return { integration: listIntegrations(app.db).find((integration) => integration.id === id)! };
  });
}
