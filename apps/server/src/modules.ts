import {
  MODULE_IDS, ModuleToggle, isModuleId, moduleDef, resolveModuleStates,
  type Database, type ModuleId, type ModuleInfo, type ModuleMap,
} from "@forkflow/domain";
import type { FastifyInstance, preHandlerHookHandler } from "fastify";
import { httpError } from "./http-error.js";

/**
 * Module controls on the counter. The ForkFlow owner's allowances come from the signed licence (every module in development
 * builds); the restaurant's own on/off switches live in `integration_state`, keyed by module id. Without a switch row a
 * service or back-office module is on as soon as it is allowed, while an add-on (Zomato, Kitchen Display, CRM & Loyalty)
 * waits until the restaurant switches it on, since each needs setting up first.
 */
const allowances = new WeakMap<Database, () => ModuleMap>();

/** Registered by buildServer: the licence's module map, read whenever a module's state is needed. */
export function provideModuleAllowances(db: Database, lookup: () => ModuleMap): void {
  allowances.set(db, lookup);
}

const noneAllowed = (): ModuleMap => Object.fromEntries(MODULE_IDS.map((id) => [id, false])) as ModuleMap;
const onByDefault = (id: ModuleId) => moduleDef(id).group !== "addon";

interface SwitchRow { id: string; enabled: number; updated_at: number }

export function moduleStates(db: Database): ModuleInfo[] {
  // Fails closed when nothing has registered the licence lookup.
  const allowed = allowances.get(db)?.() ?? noneAllowed();
  const rows = new Map((db.prepare("SELECT id, enabled, updated_at FROM integration_state").all() as SwitchRow[]).map((r) => [r.id, r]));
  return resolveModuleStates(allowed, (id) => {
    const row = rows.get(id);
    return row ? row.enabled === 1 : onByDefault(id);
  }, (id) => rows.get(id)?.updated_at ?? null);
}

export const moduleState = (db: Database, id: ModuleId): ModuleInfo => moduleStates(db).find((m) => m.id === id)!;
export const moduleActive = (db: Database, id: ModuleId): boolean => moduleState(db, id).active;

export function assertModuleActive(db: Database, id: ModuleId): void {
  const state = moduleState(db, id);
  // Not included by the owner is a licence matter (403); switched off by the restaurant is the restaurant's choice (409).
  if (!state.active) throw httpError(state.allowed ? 409 : 403, `${state.name} is not available: ${state.reason}.`, "module_off");
}

/** A route pre-handler that refuses requests while a module is not available. Put it after the permission check. */
export function requireModule(app: FastifyInstance, id: ModuleId): preHandlerHookHandler {
  return async () => assertModuleActive(app.db, id);
}

/**
 * The restaurant switches a module on or off. Switching off is always allowed (the owner may have withdrawn it since);
 * switching on needs the owner's allowance. Returns whether anything changed.
 */
export function setModuleEnabled(app: FastifyInstance, id: ModuleId, enabled: boolean, actorId: string): boolean {
  const state = moduleState(app.db, id);
  if (enabled && !state.allowed) throw httpError(403, `${state.name} is not included for this restaurant. Contact ForkFlow to add it.`);
  const changed = app.db.transaction(() => {
    // A repeat of the current value writes nothing, so updated_at/updated_by keep recording the last real change.
    if (moduleState(app.db, id).enabled === enabled) return false;
    app.db.prepare(`INSERT INTO integration_state (id, enabled, updated_at, updated_by) VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at, updated_by = excluded.updated_by`)
      .run(id, enabled ? 1 : 0, Date.now(), actorId);
    return true;
  })();
  if (changed) { app.broadcast("modules.changed", {}); app.broadcast("integrations.changed", {}); }
  return changed;
}

export function registerModules(app: FastifyInstance): void {
  // Every signed-in role reads module states: the screens use them to hide what is not available.
  app.get("/api/modules", { preHandler: app.requireAuth }, async (_req, reply) => {
    reply.header("Cache-Control", "no-store");
    return { modules: moduleStates(app.db) };
  });
  app.patch<{ Params: { id: string } }>("/api/modules/:id", { preHandler: app.requirePermission("integrations.configure") }, async (req, reply) => {
    const { id } = req.params;
    if (!isModuleId(id)) throw httpError(404, "Unknown module");
    const body = ModuleToggle.parse(req.body);
    setModuleEnabled(app, id, body.enabled, req.user.id);
    reply.header("Cache-Control", "no-store");
    return { modules: moduleStates(app.db) };
  });
}
