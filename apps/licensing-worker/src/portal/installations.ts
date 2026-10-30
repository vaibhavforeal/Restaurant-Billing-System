import { MODULES, isModuleId, resolveModules, MODULE_IDS, type ModuleId, type ModuleOverrides } from "@forkflow/domain/modules";
import { PLANS } from "@forkflow/domain/licensing";
import { parseActivationRequest, readClaims } from "@forkflow/license-issuer";
import { z } from "zod";
import { GRACE_MS } from "../dates.js";
import { assignSeat, orderFull } from "../enroll.js";
import { reissueLicense } from "../issue.js";
import { activationBlocker, orderById } from "../orders.js";
import {
  createInstallation, getInstallation, getOwnerSettings, insertOwnerEventStatement, latestLicense, ownerEvents, setOverridesStatement, type InstallationRow,
} from "../store.js";
import type { InstallationDetail, InstallationSummary } from "./api-types.js";
import { logBy, path, type Ctx, type Route } from "./context.js";
import { conflict, HttpError, json, notFound, readBody } from "./http.js";
import { ownedBy } from "./scope.js";
import { PLAN_NAMES, seesOnlyOwn } from "./shared.js";

interface Row {
  id: string; outletName: string | null; customerId: string | null; customerName: string | null; orderId: string | null; orderCode: string | null;
  activatedAt: number | null; lastSeenAt: number | null; appVersion: string | null; createdAt: number; revisionFloor: number; paired: number;
  plan: "basic" | "pro" | null; revision: number | null; expiresAt: number | null; graceUntil: number | null; envelope: string | null; licenceOrderCode: string | null;
}

/** Counters matching `where` (columns of `i`, the installation), with each one's newest licence. The caller has checked scope. */
export async function installationsWhere(ctx: Ctx, where: string, binds: unknown[]): Promise<InstallationSummary[]> {
  const { results } = await ctx.deps.db.prepare(`SELECT i.installation_id AS id, i.outlet_name AS outletName, i.customer_id AS customerId, c.business_name AS customerName,
      i.order_id AS orderId, o.code AS orderCode, i.activated_at AS activatedAt, i.last_seen_at AS lastSeenAt, i.app_version AS appVersion, i.created_at AS createdAt,
      i.revision_floor AS revisionFloor, i.secret_hash IS NOT NULL AS paired,
      l.plan, l.revision, l.expires_at AS expiresAt, l.grace_until AS graceUntil, l.envelope, lo.code AS licenceOrderCode
    FROM installations i LEFT JOIN customers c ON c.id = i.customer_id LEFT JOIN orders o ON o.id = i.order_id
      LEFT JOIN licenses l ON l.installation_id = i.installation_id AND l.revision = (SELECT MAX(revision) FROM licenses WHERE installation_id = i.installation_id)
      LEFT JOIN orders lo ON lo.id = l.order_id
    WHERE ${where} ORDER BY i.order_id IS NULL, COALESCE(i.activated_at, i.created_at) DESC`).bind(...binds).all<Row>();
  const now = ctx.deps.now();
  return results.map((r) => {
    const claims = r.envelope ? readClaims(r.envelope) : null;
    return {
      id: r.id, outletName: r.outletName, customer: r.customerId ? { id: r.customerId, name: r.customerName ?? "" } : null,
      order: r.orderId ? { id: r.orderId, code: r.orderCode ?? "" } : null, activatedAt: r.activatedAt, lastSeenAt: r.lastSeenAt, appVersion: r.appVersion,
      createdAt: r.createdAt, enrolled: r.orderId !== null, paired: r.paired === 1,
      licence: claims && r.revision !== null ? {
        plan: claims.plan, revision: r.revision, expiresAt: r.expiresAt!, graceUntil: r.graceUntil!, trial: claims.trial === true, maxDevices: claims.maxDevices,
        state: now >= r.graceUntil! ? "expired" : now >= r.expiresAt! ? "grace" : "active", delivered: r.revisionFloor >= r.revision, orderCode: r.licenceOrderCode,
      } : null,
    };
  });
}

/** The counter when the staff member may see it (through its customer); otherwise a 404. Counters with no customer are not for sales. */
export async function visibleInstallation(ctx: Ctx, id: string): Promise<InstallationRow> {
  const installation = await getInstallation(ctx.deps.db, id);
  if (!installation) throw notFound("That counter");
  if (installation.customerId === null) { if (seesOnlyOwn(ctx.user.role)) throw notFound("That counter"); return installation; }
  const scope = ownedBy(ctx.user, "owner_id");
  if (!(await ctx.deps.db.prepare(`SELECT 1 AS hit FROM customers WHERE id = ? AND ${scope.sql}`).bind(installation.customerId, ...scope.binds).first())) throw notFound("That counter");
  return installation;
}

async function detail(ctx: Ctx, installation: InstallationRow): Promise<InstallationDetail> {
  const [summary] = await installationsWhere(ctx, "i.installation_id = ?", [installation.installationId]);
  const settings = await getOwnerSettings(ctx.deps.db, installation.installationId);
  const plan = summary!.licence?.plan ?? "pro";
  const allowed = resolveModules(plan, settings.overrides);
  return {
    ...summary!, modulesUpdatedAt: settings.updatedAt,
    modules: MODULES.map((m) => ({ id: m.id, name: m.name, group: m.group, description: m.description, inPlan: m.plans[plan], override: settings.overrides[m.id] ?? null, allowed: allowed[m.id] })),
    moduleEvents: await ownerEvents(ctx.deps.db, installation.installationId, 50),
  };
}

const label = (i: InstallationRow) => i.outletName ?? `Counter ${i.installationId.slice(0, 8)}`;
/** Catalogue order, so the stored JSON is stable. */
const sortOverrides = (overrides: ModuleOverrides): ModuleOverrides =>
  Object.fromEntries(MODULE_IDS.filter((id) => overrides[id] !== undefined).map((id) => [id, overrides[id]])) as ModuleOverrides;

const ModuleChange = z.object({
  /** true allows, false blocks, null goes back to the plan's default. */
  modules: z.record(z.string(), z.boolean().nullable()),
  /** The `modulesUpdatedAt` the page last saw, so two people editing at once do not silently overwrite each other. */
  expectedUpdatedAt: z.number().int().nullable(),
}).strict();
const LicenceChange = z.object({
  plan: z.enum(["basic", "pro"]).optional(),
  expiresAt: z.number().int().positive().optional(),
  maxDevices: z.number().int().min(1).max(100).optional(),
  note: z.string().trim().min(3, "Say why, for the activity log").max(300),
}).strict();

export const installationsRoutes: Route[] = [
  { method: "GET", path: path("/installations/:id"), permission: "customers.read", handler: async (ctx) =>
    json({ installation: await detail(ctx, await visibleInstallation(ctx, ctx.params[0]!)) }) },

  // The owner panel's module switches: a change is signed into the counter's next licence revision.
  { method: "PATCH", path: path("/installations/:id/modules"), permission: "licences.manage", handler: async (ctx) => {
    const installation = await visibleInstallation(ctx, ctx.params[0]!);
    const change = await readBody(ctx.request, ModuleChange);
    const current = await getOwnerSettings(ctx.deps.db, installation.installationId);
    if (change.expectedUpdatedAt !== current.updatedAt) throw conflict("Someone else changed this counter's modules. Reload and try again.", "stale");
    const overrides: ModuleOverrides = { ...current.overrides };
    const changed: Array<{ id: ModuleId; allowed: boolean | null }> = [];
    for (const [id, value] of Object.entries(change.modules)) {
      if (!isModuleId(id)) throw new HttpError(400, `Unknown module "${id}"`);
      if ((current.overrides[id] ?? null) === value) continue;
      if (value === null) delete overrides[id]; else overrides[id] = value;
      changed.push({ id, allowed: value });
    }
    if (!changed.length) return json({ installation: await detail(ctx, installation), issuedRevision: null });
    const sorted = sortOverrides(overrides), now = ctx.deps.now(), { db } = ctx.deps;
    // Nothing to sign while the counter has no current licence; its next licence carries the choice.
    const issued = await reissueLicense(ctx.deps, installation, "owner", { modules: sorted });
    await db.batch([
      setOverridesStatement(db, installation.installationId, sorted, now),
      ...(issued ? [issued.statement] : []),
      ...changed.map((c) => insertOwnerEventStatement(db, installation.installationId, c.id, c.allowed, issued?.row.revision ?? null, now, ctx.user.id)),
      logBy(ctx, { action: "installation.modules", entityType: "installation", entityId: installation.installationId, customerId: installation.customerId,
        summary: `${label(installation)}: ${changed.map((c) => `${MODULES.find((m) => m.id === c.id)!.name} ${c.allowed === null ? "follows the plan" : c.allowed ? "allowed" : "blocked"}`).join(", ")}` }),
    ]);
    return json({ installation: await detail(ctx, installation), issuedRevision: issued?.row.revision ?? null });
  } },

  // A staff adjustment: another plan, end date or device count, signed as the next revision with the reason in the log.
  { method: "POST", path: path("/installations/:id/licence"), permission: "licences.manage", handler: async (ctx) => {
    const installation = await visibleInstallation(ctx, ctx.params[0]!);
    const change = await readBody(ctx.request, LicenceChange);
    const latest = await latestLicense(ctx.deps.db, installation.installationId);
    if (!latest) throw conflict("This counter has no licence yet. It gets one when it activates with an order.", "no_licence");
    const now = ctx.deps.now();
    if (change.expiresAt !== undefined && change.expiresAt <= now) throw new HttpError(400, "Choose an end date after today");
    const trial = readClaims(latest.envelope).trial === true;
    const next = change.maxDevices !== undefined ? { ...installation, maxDevices: change.maxDevices } : installation;
    const issued = await reissueLicense(ctx.deps, next, "manual", {
      ...(change.plan ? { plan: change.plan } : {}),
      ...(change.expiresAt !== undefined ? { expiresAt: change.expiresAt, graceUntil: trial ? change.expiresAt : change.expiresAt + GRACE_MS } : {}),
    });
    if (!issued) throw conflict("This counter's licence has ended. Give it a new end date to sign one.", "expired");
    const what = [change.plan && `plan ${PLAN_NAMES[change.plan]}`, change.expiresAt !== undefined && "new end date", change.maxDevices !== undefined && `${change.maxDevices} devices`].filter(Boolean).join(", ");
    const { db } = ctx.deps;
    await db.batch([
      ...(change.maxDevices !== undefined ? [db.prepare(`UPDATE installations SET max_devices = ? WHERE installation_id = ?`).bind(change.maxDevices, installation.installationId)] : []),
      issued.statement,
      logBy(ctx, { action: "installation.licence", entityType: "installation", entityId: installation.installationId, customerId: installation.customerId,
        summary: `${label(installation)}: ${what || "licence re-signed"} (${change.note})`, data: { revision: issued.row.revision } }),
    ]);
    return json({ installation: await detail(ctx, installation), issuedRevision: issued.row.revision });
  } },

  // For a counter that died or was reinstalled: its seat goes back to the order, so the new computer can activate. The old computer's
  // licence is signed and offline, so it keeps working until it ends; the log says so.
  { method: "POST", path: path("/installations/:id/release"), permission: "installations.support", handler: async (ctx) => {
    const installation = await visibleInstallation(ctx, ctx.params[0]!);
    if (!installation.orderId) throw conflict("This counter doesn't hold a seat.", "not_enrolled");
    const latest = await latestLicense(ctx.deps.db, installation.installationId);
    const { db } = ctx.deps, now = ctx.deps.now();
    const order = await orderById(db, installation.orderId);
    await db.batch([
      db.prepare(`UPDATE orders SET seats_used = seats_used - 1, updated_at = ? WHERE id = ?`).bind(now, installation.orderId),
      db.prepare(`UPDATE installations SET order_id = NULL WHERE installation_id = ?`).bind(installation.installationId),
      logBy(ctx, { action: "installation.released", entityType: "installation", entityId: installation.installationId, customerId: installation.customerId,
        summary: `Released ${label(installation)}'s seat on order ${order?.code ?? ""}${latest ? `; its current licence still works offline until ${new Date(latest.graceUntil).toISOString().slice(0, 10)}` : ""}` }),
    ]);
    return json({ installation: await detail(ctx, (await getInstallation(db, installation.installationId))!) });
  } },

  // After the restaurant restored or reinstalled the counter with a new installation secret: the next check-in claims the counter again.
  { method: "POST", path: path("/installations/:id/reset-pairing"), permission: "installations.support", handler: async (ctx) => {
    const installation = await visibleInstallation(ctx, ctx.params[0]!);
    const { db } = ctx.deps;
    await db.batch([
      db.prepare(`UPDATE installations SET secret_hash = NULL WHERE installation_id = ?`).bind(installation.installationId),
      logBy(ctx, { action: "installation.pairing_reset", entityType: "installation", entityId: installation.installationId, customerId: installation.customerId,
        summary: `Reset the pairing of ${label(installation)}; the next computer to check in with its ID claims it` }),
    ]);
    return json({ installation: await detail(ctx, (await getInstallation(db, installation.installationId))!) });
  } },

  // Moves a counter onto another new or trial order of the same customer, e.g. when the trial converts and the restaurant doesn't re-enter IDs.
  { method: "POST", path: path("/installations/:id/move"), permission: "licences.manage", handler: async (ctx) => {
    const installation = await visibleInstallation(ctx, ctx.params[0]!);
    const { orderId } = await readBody(ctx.request, z.object({ orderId: z.string().uuid() }).strict());
    const order = await orderById(ctx.deps.db, orderId);
    if (!order || order.customerId !== installation.customerId) throw notFound("That order");
    if (order.id === installation.orderId) throw conflict("The counter is already on that order.");
    const blocker = activationBlocker(order, ctx.deps.now());
    if (blocker) throw conflict(blocker === "not_paid" ? "That order isn't paid or approved on credit yet." : "That order can't take counters.", blocker);
    if (order.seatsUsed >= order.outlets) throw conflict("Every outlet on that order is taken. Release one first.", "seats_full");
    try { await assignSeat(ctx.deps, installation, order, { actorId: ctx.user.id, outletName: null, appVersion: null, handedOut: false }); }
    catch (error) { if (await orderFull(ctx.deps, order.id)) throw conflict("Every outlet on that order is taken. Release one first.", "seats_full"); throw error; }
    return json({ installation: await detail(ctx, (await getInstallation(ctx.deps.db, installation.installationId))!) });
  } },

  // The current licence as a file, for a counter that cannot reach the licensing service.
  { method: "GET", path: path("/installations/:id/licence"), permission: "installations.support", handler: async (ctx) => {
    const installation = await visibleInstallation(ctx, ctx.params[0]!);
    const latest = await latestLicense(ctx.deps.db, installation.installationId);
    if (!latest) throw notFound("A licence for this counter");
    return json({ license: latest.envelope, fileName: `forkflow-licence-${installation.installationId.slice(0, 8)}-r${latest.revision}.txt` });
  } },

  // Activates a counter that has no internet: its activation request file comes in, and its licence goes out as a file. It takes a seat.
  { method: "POST", path: path("/orders/:id/offline-licence"), permission: "licences.manage", handler: async (ctx) => {
    const { activationRequest } = await readBody(ctx.request, z.object({ activationRequest: z.string().max(4000) }).strict());
    let request;
    try { request = parseActivationRequest(activationRequest); } catch (error) { throw new HttpError(400, (error as Error).message); }
    if (request.verificationKeyFingerprint !== ctx.deps.signer.fingerprint) throw new HttpError(400, "This activation request is from a ForkFlow build that trusts a different signing key.");
    const order = await orderById(ctx.deps.db, ctx.params[0]!);
    const scope = ownedBy(ctx.user, "owner_id");
    if (!order || !(await ctx.deps.db.prepare(`SELECT 1 AS hit FROM customers WHERE id = ? AND ${scope.sql}`).bind(order.customerId, ...scope.binds).first())) throw notFound("That order");
    const blocker = activationBlocker(order, ctx.deps.now());
    if (blocker) throw conflict("This order can't activate counters yet: it must be paid, approved on credit, or a trial.", blocker);
    const { db } = ctx.deps;
    const held = request.licenseId !== null && request.organizationId !== null && request.outletId !== null;
    let installation = await getInstallation(db, request.installationId);
    if (!installation) {
      // No secret: the counter has never talked to the service. It claims the row on its first check-in, as after a reset.
      await createInstallation(db, {
        installationId: request.installationId, licenseId: held ? request.licenseId! : ctx.deps.uuid(), organizationId: held ? request.organizationId! : ctx.deps.uuid(),
        outletId: held ? request.outletId! : ctx.deps.uuid(), revisionFloor: held ? request.currentRevision : 0, createdAt: ctx.deps.now(), secretHash: null,
      });
      installation = (await getInstallation(db, request.installationId))!;
    }
    if (installation.customerId !== null && installation.customerId !== order.customerId) throw conflict("That counter belongs to another customer.", "other_customer");
    let envelope: string, revision: number;
    if (installation.orderId === order.id) {
      const latest = (await latestLicense(db, installation.installationId))!;
      envelope = latest.envelope; revision = latest.revision;
    } else {
      if (order.seatsUsed >= order.outlets) throw conflict("Every outlet on this order is taken. Release one first.", "seats_full");
      const row = await assignSeat(ctx.deps, installation, order, { actorId: ctx.user.id, outletName: request.outletName ?? null, appVersion: request.appVersion ?? null, handedOut: true });
      envelope = row.envelope; revision = row.revision;
    }
    return json({ license: envelope, fileName: `forkflow-licence-${request.installationId.slice(0, 8)}-r${revision}.txt`, installationId: request.installationId });
  } },
];

export const planDevices = (plan: "basic" | "pro") => PLANS[plan].maxDevices;
