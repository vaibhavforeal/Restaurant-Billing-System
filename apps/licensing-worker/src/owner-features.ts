import { FEATURES, RestaurantFeaturePolicy } from "@forkflow/domain/features";
import { z } from "zod";
import type { D1Like, Env } from "./env.js";
import { getInstallation } from "./store.js";
import { sha256Hex } from "./secret.js";
import { ownerPage, ownerScript, ownerStyle } from "./owner-page.js";
import { staffPolicy, ownerStaffRoute } from "./staff-permissions.js";
import { staffScript, staffStyle } from "./staff-page.js";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
interface PolicyRow { organizationId: string; outletId: string; name: string; revision: number; settings: string; updatedAt: number | null }
const columns = "organization_id AS organizationId, outlet_id AS outletId, name, revision, settings, updated_at AS updatedAt";
async function ensurePolicy(db: D1Like, organizationId: string, outletId: string): Promise<PolicyRow> {
  await db.prepare("INSERT OR IGNORE INTO restaurant_feature_policies (organization_id,outlet_id) VALUES (?,?)").bind(organizationId, outletId).run();
  return (await db.prepare(`SELECT ${columns} FROM restaurant_feature_policies WHERE organization_id=? AND outlet_id=?`).bind(organizationId, outletId).first<PolicyRow>())!;
}
export async function installationPolicy(db: D1Like, installationId: string, secret: string | null): Promise<RestaurantFeaturePolicy | null> {
  if (!/^[a-f0-9]{64}$/.test(secret ?? "")) return null;
  const installation = await getInstallation(db, installationId);
  // Policy fetch never claims/reset secrets: activation must establish the installation first.
  if (!installation?.secretHash || await sha256Hex(secret!) !== installation.secretHash) return null;
  const row = await ensurePolicy(db, installation.organizationId, installation.outletId);
  return RestaurantFeaturePolicy.parse({ kind: "restaurant-features", version: 1, installationId, organizationId: row.organizationId, outletId: row.outletId, revision: row.revision, enabled: JSON.parse(row.settings), staffPermissions: await staffPolicy(db, installationId) });
}
async function ownerAuthenticated(request: Request, db: D1Like) {
  const token = request.headers.get("cookie")?.match(/(?:^|;\s*)ff_owner=([A-Za-z0-9_-]{43})(?:;|$)/)?.[1];
  return token && await db.prepare("SELECT 1 AS hit FROM owner_sessions WHERE token_hash=? AND expires_at>?").bind(await sha256Hex(token), Date.now()).first();
}
export async function ownerRoute(request: Request, env: Pick<Env, "DB" | "OWNER_PASSWORD" | "LIMITER">): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/owner")) return null;
  if (request.method === "GET" && (url.pathname === "/owner/panel.js" || url.pathname === "/owner/style.css")) return new Response(url.pathname.endsWith(".js") ? staffScript + ownerScript : ownerStyle + staffStyle, { headers: { "content-type": url.pathname.endsWith(".js") ? "text/javascript" : "text/css", "cache-control": "no-store", "x-content-type-options": "nosniff" } });
  if (request.method === "GET" && url.pathname === "/owner") return new Response(ownerPage, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-security-policy": "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'", "x-content-type-options": "nosniff" } });
  if (request.method !== "GET" && request.headers.get("origin") !== url.origin) return json({ error: "Cross-origin changes are not allowed" }, 403);
  if (request.method === "POST" && url.pathname === "/owner/api/login") {
    if (!env.OWNER_PASSWORD || env.OWNER_PASSWORD.length < 16) return json({ error: "Owner login is not configured" }, 503);
    if (!(await env.LIMITER.limit({ key: `owner:${request.headers.get("cf-connecting-ip") ?? "unknown"}` })).success) return json({ error: "Try again later" }, 429);
    let body: unknown; try { body = await request.json(); } catch { return json({ error: "Invalid request" }, 400); }
    const parsed = z.object({ password: z.string().max(512) }).strict().safeParse(body);
    if (!parsed.success || await sha256Hex(parsed.data.password) !== await sha256Hex(env.OWNER_PASSWORD)) return json({ error: "Invalid owner password" }, 401);
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    const token = btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    await env.DB.batch([env.DB.prepare("DELETE FROM owner_sessions WHERE expires_at<=?").bind(Date.now()), env.DB.prepare("INSERT INTO owner_sessions VALUES (?,?)").bind(await sha256Hex(token), Date.now() + 8 * 3600_000)]);
    const response = json({ ok: true }); response.headers.set("set-cookie", `ff_owner=${token}; Path=/owner; HttpOnly; Secure; SameSite=Strict; Max-Age=28800`); return response;
  }
  if (!await ownerAuthenticated(request, env.DB)) return json({ error: "Owner login required" }, 401);
  const staff = await ownerStaffRoute(request, env.DB);
  if (staff) return staff;
  if (request.method === "POST" && url.pathname === "/owner/api/logout") {
    const token = request.headers.get("cookie")?.match(/ff_owner=([A-Za-z0-9_-]{43})/)?.[1];
    if (token) await env.DB.prepare("DELETE FROM owner_sessions WHERE token_hash=?").bind(await sha256Hex(token)).run();
    const response = json({ ok: true }); response.headers.set("set-cookie", "ff_owner=; Path=/owner; HttpOnly; Secure; SameSite=Strict; Max-Age=0"); return response;
  }
  if (request.method === "GET" && url.pathname === "/owner/api/restaurants") {
    const identities = (await env.DB.prepare("SELECT DISTINCT organization_id AS organizationId,outlet_id AS outletId FROM installations ORDER BY created_at DESC").all<{ organizationId: string; outletId: string }>()).results;
    const restaurants = [];
    for (const identity of identities) {
      const row = await ensurePolicy(env.DB, identity.organizationId, identity.outletId);
      const settings = JSON.parse(row.settings) as Record<string, boolean>;
      const installations = (await env.DB.prepare("SELECT installation_id AS id,contact_email AS email FROM installations WHERE organization_id=? AND outlet_id=?").bind(row.organizationId, row.outletId).all()).results;
      restaurants.push({ ...identity, name: row.name, revision: row.revision, updatedAt: row.updatedAt, installations, features: FEATURES.map(def => ({ ...def, enabled: settings[def.id] ?? def.defaultEnabled })) });
    }
    return json({ restaurants });
  }
  const match = url.pathname.match(/^\/owner\/api\/restaurants\/([^/]+)\/([^/]+)(?:\/features\/([^/]+))?$/);
  if (!match || !z.string().uuid().safeParse(match[1]).success || !z.string().uuid().safeParse(match[2]).success) return json({ error: "Not found" }, 404);
  const [, organizationId, outletId, featureId] = match;
  if (!await env.DB.prepare("SELECT 1 FROM installations WHERE organization_id=? AND outlet_id=?").bind(organizationId, outletId).first()) return json({ error: "Restaurant not found" }, 404);
  if (request.method === "GET" && !featureId) return json({ events: (await env.DB.prepare("SELECT feature_id AS featureId,enabled,revision,occurred_at AS occurredAt FROM restaurant_feature_events WHERE organization_id=? AND outlet_id=? ORDER BY id DESC LIMIT 100").bind(organizationId, outletId).all()).results });
  if (request.method !== "PATCH") return json({ error: "Not found" }, 404);
  let body: unknown; try { body = await request.json(); } catch { return json({ error: "Invalid request" }, 400); }
  if (!featureId) {
    const parsed = z.object({ name: z.string().trim().min(1).max(120) }).strict().safeParse(body);
    if (!parsed.success) return json({ error: "Invalid restaurant name" }, 400);
    await ensurePolicy(env.DB, organizationId!, outletId!);
    await env.DB.prepare("UPDATE restaurant_feature_policies SET name=? WHERE organization_id=? AND outlet_id=?").bind(parsed.data.name, organizationId, outletId).run();
    return json({ ok: true });
  }
  const def = FEATURES.find(f => f.id === featureId);
  if (!def) return json({ error: "Unknown feature" }, 404);
  if (!def.configurable || featureId === "swiggy") return json({ error: "This feature cannot be changed" }, 409);
  const parsed = z.object({ enabled: z.boolean(), revision: z.number().int().nonnegative().safe() }).strict().safeParse(body);
  if (!parsed.success) return json({ error: "Invalid feature update" }, 400);
  const row = await ensurePolicy(env.DB, organizationId!, outletId!);
  if (row.revision !== parsed.data.revision) return json({ error: "Settings changed. Refresh before saving." }, 409);
  const settings = JSON.parse(row.settings) as Record<string, boolean>;
  if ((settings[featureId] ?? def.defaultEnabled) === parsed.data.enabled) return json({ revision: row.revision });
  settings[featureId] = parsed.data.enabled;
  const now = Date.now();
  // Audit only the writer which won the compare-and-set, within the same D1 transaction.
  const result = await env.DB.batch([
    env.DB.prepare("UPDATE restaurant_feature_policies SET settings=?,revision=revision+1,updated_at=? WHERE organization_id=? AND outlet_id=? AND revision=?").bind(JSON.stringify(settings), now, organizationId, outletId, row.revision),
    env.DB.prepare("INSERT INTO restaurant_feature_events (organization_id,outlet_id,feature_id,enabled,revision,occurred_at) SELECT ?,?,?,?,?,? WHERE changes()=1").bind(organizationId, outletId, featureId, Number(parsed.data.enabled), row.revision + 1, now),
  ]) as Array<{ meta: { changes: number } }>;
  return result[0]!.meta.changes === 1 ? json({ revision: row.revision + 1 }) : json({ error: "Settings changed. Refresh before saving." }, 409);
}
