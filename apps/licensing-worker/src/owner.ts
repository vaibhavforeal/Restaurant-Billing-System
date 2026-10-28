import { MODULES, MODULE_IDS, isModuleId, resolveModules, type ModuleId, type ModuleOverrides } from "@forkflow/domain/modules";
import { readClaims } from "@forkflow/license-issuer";
import { z } from "zod";
import type { Env } from "./env.js";
import { issueOwnerRevision, type Deps } from "./issue.js";
import { ownerPage, OWNER_SCRIPT, OWNER_STYLE } from "./owner-page.js";
import { constantTimeEqual, sha256Hex } from "./secret.js";
import {
  deleteExpiredOwnerSessionsStatement, deleteOwnerSessionStatement, getInstallation, getOwnerSettings, insertOwnerEventStatement,
  insertOwnerSessionStatement, latestLicense, listInstallations, ownerEvents, ownerSessionValid, upsertOwnerSettingsStatement,
  type InstallationRow,
} from "./store.js";

/**
 * The ForkFlow owner control panel: one owner password (the OWNER_PASSWORD secret) opens an 8-hour session. The owner sees every
 * restaurant and decides which modules each may use; a change is signed into the restaurant's next licence revision, which the
 * counter picks up on its next check.
 */
const SESSION_MS = 8 * 60 * 60 * 1000;
const COOKIE = "ff_owner";
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...headers } });
const SECURITY_HEADERS = {
  "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer",
  "content-security-policy": "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};

const Login = z.object({ password: z.string().min(1).max(512) }).strict();
const Change = z.object({
  displayName: z.string().trim().max(120).nullable().optional(),
  /** true allows, false blocks, null goes back to the plan's default. */
  modules: z.record(z.string(), z.boolean().nullable()).optional(),
  /** The `updatedAt` the panel last saw, so two owners editing at once do not silently overwrite each other. */
  expectedUpdatedAt: z.number().int().nullable(),
}).strict();

export type OwnerDeps = Deps & { env: Pick<Env, "OWNER_PASSWORD" | "LIMITER"> };

function sessionToken(request: Request): string | null {
  return request.headers.get("cookie")?.match(new RegExp(`(?:^|;\\s*)${COOKIE}=([A-Za-z0-9_-]{43})(?:;|$)`))?.[1] ?? null;
}
const cookie = (value: string, maxAge: number) => `${COOKIE}=${value}; Path=/owner; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;
function newToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function restaurantJson(deps: Deps, installation: InstallationRow) {
  const [latest, settings] = await Promise.all([latestLicense(deps.db, installation.installationId), getOwnerSettings(deps.db, installation.installationId)]);
  const plan = latest?.plan ?? "pro";
  const now = deps.now();
  return {
    installationId: installation.installationId,
    displayName: settings.displayName,
    contactEmail: installation.contactEmail,
    createdAt: installation.createdAt,
    licence: latest && {
      plan: latest.plan, revision: latest.revision, reason: latest.reason, trial: readClaims(latest.envelope).trial === true,
      expiresAt: latest.expiresAt, graceUntil: latest.graceUntil,
      state: now >= latest.graceUntil ? "expired" : now >= latest.expiresAt ? "grace" : "active",
      /** The counter has picked this revision up (it reported or was handed it). */
      delivered: installation.revisionFloor >= latest.revision,
    },
    overrides: settings.overrides,
    allowed: resolveModules(plan, settings.overrides),
    updatedAt: settings.updatedAt,
  };
}

export async function ownerRoute(request: Request, deps: OwnerDeps): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname;
  if (path !== "/owner" && !path.startsWith("/owner/")) return null;
  const { method } = request;
  const { db } = deps;

  if (method === "GET" && (path === "/owner" || path === "/owner/")) return new Response(ownerPage(), { headers: { "content-type": "text/html; charset=utf-8", ...SECURITY_HEADERS } });
  if (method === "GET" && path === "/owner/app.js") return new Response(OWNER_SCRIPT, { headers: { "content-type": "text/javascript; charset=utf-8", ...SECURITY_HEADERS } });
  if (method === "GET" && path === "/owner/app.css") return new Response(OWNER_STYLE, { headers: { "content-type": "text/css; charset=utf-8", ...SECURITY_HEADERS } });
  if (!path.startsWith("/owner/api/")) return json({ error: "not_found" }, 404);
  // Every change must come from the panel itself: a page on another site cannot drive it with the owner's cookie.
  if (method !== "GET" && request.headers.get("origin") !== url.origin) return json({ error: "Changes must come from the owner panel" }, 403);

  if (method === "POST" && path === "/owner/api/login") {
    const password = deps.env.OWNER_PASSWORD;
    if (!password || password.length < 16) return json({ error: "Owner login is not set up on this service" }, 503);
    let limited = false;
    try { limited = !(await deps.env.LIMITER.limit({ key: `owner:${request.headers.get("cf-connecting-ip") ?? "unknown"}` })).success; }
    catch { /* an unavailable limiter fails open, as for licensing */ }
    if (limited) return json({ error: "Too many attempts. Try again in a minute." }, 429);
    let body: unknown; try { body = await request.json(); } catch { return json({ error: "Invalid request" }, 400); }
    const parsed = Login.safeParse(body);
    if (!parsed.success || !constantTimeEqual(await sha256Hex(parsed.data.password), await sha256Hex(password))) return json({ error: "Wrong password" }, 401);
    const token = newToken(), now = deps.now();
    await db.batch([deleteExpiredOwnerSessionsStatement(db, now), insertOwnerSessionStatement(db, await sha256Hex(token), now + SESSION_MS)]);
    return json({ ok: true }, 200, { "set-cookie": cookie(token, SESSION_MS / 1000) });
  }

  const token = sessionToken(request);
  if (!token || !(await ownerSessionValid(db, await sha256Hex(token), deps.now()))) return json({ error: "Sign in again" }, 401);

  if (method === "POST" && path === "/owner/api/logout") {
    await deleteOwnerSessionStatement(db, await sha256Hex(token)).run();
    return json({ ok: true }, 200, { "set-cookie": cookie("", 0) });
  }
  if (method === "GET" && path === "/owner/api/restaurants") {
    const installations = await listInstallations(db);
    return json({
      modules: MODULES.map(({ id, name, group, description, dependsOn, plans }) => ({ id, name, group, description, dependsOn, plans })),
      restaurants: await Promise.all(installations.map((i) => restaurantJson(deps, i))),
    });
  }

  const match = path.match(/^\/owner\/api\/restaurants\/([0-9a-f-]{36})(\/events)?$/);
  if (!match) return json({ error: "not_found" }, 404);
  const installation = await getInstallation(db, match[1]!);
  if (!installation) return json({ error: "Restaurant not found" }, 404);
  if (method === "GET" && match[2]) return json({ events: await ownerEvents(db, installation.installationId) });
  if (method !== "PATCH" || match[2]) return json({ error: "not_found" }, 404);

  let body: unknown; try { body = await request.json(); } catch { return json({ error: "Invalid request" }, 400); }
  const parsed = Change.safeParse(body);
  if (!parsed.success) return json({ error: "Invalid change" }, 400);
  const change = parsed.data;
  const current = await getOwnerSettings(db, installation.installationId);
  if (change.expectedUpdatedAt !== current.updatedAt) return json({ error: "Someone else changed this restaurant. Reload and try again." }, 409);
  const overrides: ModuleOverrides = { ...current.overrides };
  const changed: Array<{ id: ModuleId; allowed: boolean | null }> = [];
  for (const [id, value] of Object.entries(change.modules ?? {})) {
    if (!isModuleId(id)) return json({ error: `Unknown module "${id}"` }, 400);
    const before = current.overrides[id] ?? null;
    if (before === value) continue;
    if (value === null) delete overrides[id]; else overrides[id] = value;
    changed.push({ id, allowed: value });
  }
  const displayName = change.displayName === undefined ? current.displayName : change.displayName || null;
  const now = deps.now();
  await upsertOwnerSettingsStatement(db, installation.installationId, displayName, sortOverrides(overrides), now).run();
  // A new licence only when the allowances changed; renaming a restaurant does not need one.
  const issued = changed.length ? await issueOwnerRevision(deps, installation) : null;
  if (changed.length) await db.batch(changed.map((c) => insertOwnerEventStatement(db, installation.installationId, c.id, c.allowed, issued?.revision ?? null, now)));
  const fresh = (await getInstallation(db, installation.installationId))!;
  return json({ restaurant: await restaurantJson(deps, fresh), issuedRevision: issued?.revision ?? null });
}

/** Catalogue order, so the stored JSON is stable. */
const sortOverrides = (overrides: ModuleOverrides): ModuleOverrides =>
  Object.fromEntries(MODULE_IDS.filter((id) => overrides[id] !== undefined).map((id) => [id, overrides[id]])) as ModuleOverrides;
