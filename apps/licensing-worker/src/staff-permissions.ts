import { StaffRoster, StaffOverrides, STAFF_RESOURCES, STAFF_ACTIONS, effectiveStaffPermissions, type StaffMember } from "@forkflow/domain/staff-permissions";
import { z } from "zod";
import type { D1Like } from "./env.js";
import { getInstallation } from "./store.js";
import { sha256Hex } from "./secret.js";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
export async function syncStaffRoster(db: D1Like, installationId: string, secret: string | null, roster: unknown): Promise<boolean> {
  const parsed = StaffRoster.safeParse(roster);
  if (!parsed.success || !/^[a-f0-9]{64}$/.test(secret ?? "")) return false;
  const installation = await getInstallation(db, installationId);
  if (!installation?.secretHash || installation.secretHash !== await sha256Hex(secret!)) return false;
  const now = Date.now();
  // Replace reported identities atomically, retaining owner overrides for temporarily absent staff.
  await db.batch([db.prepare("DELETE FROM restaurant_staff WHERE installation_id=?").bind(installationId), ...parsed.data.map(user => db.prepare("INSERT INTO restaurant_staff (installation_id,user_id,name,role,is_active,synced_at) VALUES (?,?,?,?,?,?)").bind(installationId, user.id, user.name, user.role, Number(user.isActive), now))]);
  return true;
}
export async function staffPolicy(db: D1Like, installationId: string): Promise<Record<string, StaffOverrides>> {
  const rows = (await db.prepare("SELECT user_id AS userId,overrides FROM restaurant_staff_permissions WHERE installation_id=?").bind(installationId).all<{ userId: string; overrides: string }>()).results;
  return Object.fromEntries(rows.map(row => [row.userId, StaffOverrides.parse(JSON.parse(row.overrides))]));
}
/** Invoked only after the owner router has verified login and mutation origin. */
export async function ownerStaffRoute(request: Request, db: D1Like): Promise<Response | null> {
  const match = new URL(request.url).pathname.match(/^\/owner\/api\/restaurants\/([^/]+)\/([^/]+)\/staff(?:\/([^/]+)\/([^/]+))?$/);
  if (!match) return null;
  const [, organizationId, outletId, installationId, userId] = match;
  if (![organizationId, outletId, ...(installationId ? [installationId, userId] : [])].every(id => z.string().uuid().safeParse(id).success)) return json({ error: "Invalid staff identity" }, 400);
  if (!await db.prepare("SELECT 1 FROM installations WHERE organization_id=? AND outlet_id=?").bind(organizationId, outletId).first()) return json({ error: "Restaurant not found" }, 404);
  await db.prepare("INSERT OR IGNORE INTO restaurant_feature_policies (organization_id,outlet_id) VALUES (?,?)").bind(organizationId, outletId).run();
  const revision = (await db.prepare("SELECT revision FROM restaurant_feature_policies WHERE organization_id=? AND outlet_id=?").bind(organizationId, outletId).first<{ revision: number }>())!.revision;
  if (request.method === "GET" && !installationId) {
    const rows = (await db.prepare(`SELECT s.installation_id AS installationId,s.user_id AS id,s.name,s.role,s.is_active AS isActive,s.synced_at AS syncedAt,p.overrides
      FROM restaurant_staff s JOIN installations i ON i.installation_id=s.installation_id
      LEFT JOIN restaurant_staff_permissions p ON p.installation_id=s.installation_id AND p.user_id=s.user_id
      WHERE i.organization_id=? AND i.outlet_id=? ORDER BY s.name,s.user_id`).bind(organizationId, outletId).all<StaffMember & { installationId: string; overrides: string | null; syncedAt: number }>()).results;
    return json({ revision, resources: STAFF_RESOURCES, actions: STAFF_ACTIONS, staff: rows.map(row => { const overrides = StaffOverrides.parse(JSON.parse(row.overrides ?? "{}")); return { ...row, isActive: Boolean(row.isActive), overrides, permissions: effectiveStaffPermissions(row.role, overrides) }; }) });
  }
  if (request.method !== "PATCH" || !installationId) return json({ error: "Not found" }, 404);
  if (!await db.prepare("SELECT 1 FROM restaurant_staff s JOIN installations i ON i.installation_id=s.installation_id WHERE s.installation_id=? AND s.user_id=? AND i.organization_id=? AND i.outlet_id=?").bind(installationId, userId, organizationId, outletId).first()) return json({ error: "Staff member not found in this restaurant" }, 404);
  let body: unknown; try { body = await request.json(); } catch { return json({ error: "Invalid request" }, 400); }
  const parsed = z.object({ revision: z.number().int().nonnegative().safe(), overrides: StaffOverrides }).strict().safeParse(body);
  if (!parsed.success) return json({ error: "Invalid permissions" }, 400);
  if (parsed.data.revision !== revision) return json({ error: "Settings changed. Refresh before saving." }, 409);
  const old = await db.prepare("SELECT overrides FROM restaurant_staff_permissions WHERE installation_id=? AND user_id=?").bind(installationId, userId).first<{ overrides: string }>();
  const overrides = Object.fromEntries(Object.entries(parsed.data.overrides).sort(([a], [b]) => a.localeCompare(b)));
  if (JSON.stringify(overrides) === (old?.overrides ?? "{}")) return json({ revision });
  const now = Date.now(), encoded = JSON.stringify(overrides);
  // Write permissions first with a revision predicate; the following UPDATE uses changes()
  // from that write. Losing concurrent callers cannot overwrite the policy or audit it.
  const result = await db.batch([
    db.prepare(`INSERT INTO restaurant_staff_permissions (installation_id,user_id,overrides,updated_at)
      SELECT ?,?,?,? WHERE (SELECT revision FROM restaurant_feature_policies WHERE organization_id=? AND outlet_id=?)=?
      ON CONFLICT(installation_id,user_id) DO UPDATE SET overrides=excluded.overrides,updated_at=excluded.updated_at`).bind(installationId, userId, encoded, now, organizationId, outletId, revision),
    db.prepare("UPDATE restaurant_feature_policies SET revision=revision+1,updated_at=? WHERE organization_id=? AND outlet_id=? AND changes()=1").bind(now, organizationId, outletId),
    db.prepare("INSERT INTO restaurant_staff_permission_events (installation_id,user_id,overrides,revision,occurred_at) SELECT ?,?,?,?,? WHERE changes()=1").bind(installationId, userId, encoded, revision + 1, now),
  ]) as Array<{ meta: { changes: number } }>;
  return result[0]!.meta.changes === 1 ? json({ revision: revision + 1, permissions: overrides }) : json({ error: "Settings changed. Refresh before saving." }, 409);
}
