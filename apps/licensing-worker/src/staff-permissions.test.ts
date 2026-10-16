import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { memoryD1 } from "./testing/d1.js";
import { createInstallation } from "./store.js";
import { sha256Hex } from "./secret.js";
import { installationPolicy, ownerRoute } from "./owner-features.js";
import { syncStaffRoster, ownerStaffRoute } from "./staff-permissions.js";
const secret = "a".repeat(64);
async function fixture() {
  const db = memoryD1(), organizationId = randomUUID(), outletId = randomUUID(), installationId = randomUUID(), userId = randomUUID();
  await createInstallation(db, { installationId, organizationId, outletId, licenseId: randomUUID(), trialStartedAt: null, revisionFloor: 0, createdAt: 0, secretHash: await sha256Hex(secret) });
  const env = { DB: db, OWNER_PASSWORD: "local-owner-password", LIMITER: { limit: async () => ({ success: true }) } };
  const login = await ownerRoute(new Request("https://owner.test/owner/api/login", { method: "POST", headers: { origin: "https://owner.test" }, body: JSON.stringify({ password: env.OWNER_PASSWORD }) }), env);
  const cookie = login!.headers.get("set-cookie")!.split(";")[0]!;
  const request = (method: string, path: string, body?: unknown) => new Request(`https://owner.test${path}`, { method, headers: { origin: "https://owner.test", cookie }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { db, env, request, organizationId, outletId, installationId, userId };
}
describe("owner-managed staff permissions", () => {
  it("syncs staff safely and provides a checkbox matrix with role defaults", async () => {
    const f = await fixture();
    expect(await syncStaffRoster(f.db, f.installationId, "b".repeat(64), [{ id: f.userId, name: "Cashier", role: "cashier", isActive: true }])).toBe(false);
    expect(await syncStaffRoster(f.db, f.installationId, secret, [{ id: f.userId, name: "Cashier", role: "cashier", isActive: true }])).toBe(true);
    const result = await ownerStaffRoute(f.request("GET", `/owner/api/restaurants/${f.organizationId}/${f.outletId}/staff`), f.db);
    const body = await result!.json() as { staff: Array<{ permissions: Record<string, boolean> }> };
    expect(body.staff[0]!.permissions["orders.create"]).toBe(true);
    expect(body.staff[0]!.permissions["products.create"]).toBe(false);
  });
  it("isolates staff, rejects stale/unsupported updates and signs selected overrides", async () => {
    const f = await fixture(); await syncStaffRoster(f.db, f.installationId, secret, [{ id: f.userId, name: "Cashier", role: "cashier", isActive: true }]);
    const path = `/owner/api/restaurants/${f.organizationId}/${f.outletId}/staff/${f.installationId}/${f.userId}`;
    expect((await ownerStaffRoute(f.request("PATCH", path, { revision: 0, overrides: { "products.create": true, "orders.delete": false } }), f.db))!.status).toBe(200);
    expect((await ownerStaffRoute(f.request("PATCH", path, { revision: 0, overrides: {} }), f.db))!.status).toBe(409);
    expect((await ownerStaffRoute(f.request("PATCH", path.replace(f.outletId, randomUUID()), { revision: 1, overrides: {} }), f.db))!.status).toBe(404);
    expect((await ownerStaffRoute(f.request("PATCH", path, { revision: 1, overrides: { "reports.delete": true } }), f.db))!.status).toBe(400);
    expect((await installationPolicy(f.db, f.installationId, secret))!.staffPermissions?.[f.userId]).toEqual({ "products.create": true, "orders.delete": false });
  });
});
