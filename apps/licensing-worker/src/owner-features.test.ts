import { describe, expect, it } from "vitest";
import { randomUUID, generateKeyPairSync } from "node:crypto";
import { verifyLicenseSignature } from "@forkflow/core";
import worker from "./index.js";
import { memoryD1 } from "./testing/d1.js";
import { createInstallation } from "./store.js";
import { sha256Hex } from "./secret.js";
import { ownerRoute, installationPolicy } from "./owner-features.js";

const secret = "a".repeat(64);
async function fixture() {
  const db = memoryD1();
  const organizationId = randomUUID(), outletId = randomUUID(), installationId = randomUUID();
  for (const [id, outlet] of [[installationId, outletId], [randomUUID(), randomUUID()]]) {
    await createInstallation(db, { installationId: id!, outletId: outlet!, organizationId, licenseId: randomUUID(), trialStartedAt: null, revisionFloor: 0, createdAt: 100, secretHash: await sha256Hex(secret) });
  }
  const env = { DB: db, OWNER_PASSWORD: "test-only-owner-password", LIMITER: { limit: async () => ({ success: true }) } };
  const send = (method: string, path: string, body?: unknown, cookie = "", origin = "https://owner.test") => ownerRoute(new Request(`https://owner.test${path}`, { method, headers: { origin, cookie, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) }), env);
  const login = await send("POST", "/owner/api/login", { password: env.OWNER_PASSWORD });
  const cookie = login!.headers.get("set-cookie")!.split(";")[0]!;
  return { db, send, cookie, organizationId, outletId, installationId };
}
describe("private restaurant feature controls", () => {
  it("requires owner login, rejects installation credentials and cross-origin writes", async () => {
    const f = await fixture();
    expect((await f.send("GET", "/owner/api/restaurants"))!.status).toBe(401);
    expect((await f.send("POST", "/owner/api/login", { password: secret }))!.status).toBe(401);
    expect((await f.send("PATCH", `/owner/api/restaurants/${f.organizationId}/${f.outletId}/features/inventory`, { enabled: false, revision: 0 }, f.cookie, "https://other.test"))!.status).toBe(403);
    expect((await f.send("GET", "/owner/api/restaurants", undefined, f.cookie))!.status).toBe(200);
  });
  it("isolates restaurants, records changes and rejects stale/core updates", async () => {
    const f = await fixture();
    const path = `/owner/api/restaurants/${f.organizationId}/${f.outletId}/features/inventory`;
    expect((await f.send("PATCH", path, { enabled: false, revision: 0 }, f.cookie))!.status).toBe(200);
    expect((await f.send("PATCH", path, { enabled: true, revision: 0 }, f.cookie))!.status).toBe(409);
    expect((await f.send("PATCH", path.replace("inventory", "billing"), { enabled: false, revision: 1 }, f.cookie))!.status).toBe(409);
    const restaurants = await (await f.send("GET", "/owner/api/restaurants", undefined, f.cookie))!.json() as { restaurants: Array<{ outletId: string; revision: number; features: Array<{ id: string; enabled: boolean }> }> };
    expect(restaurants.restaurants.find(r => r.outletId === f.outletId)!.features.find(r => r.id === "inventory")!.enabled).toBe(false);
    expect(restaurants.restaurants.find(r => r.outletId !== f.outletId)!.revision).toBe(0);
    expect((await f.db.prepare("SELECT COUNT(*) AS n FROM restaurant_feature_events").first<{ n: number }>())!.n).toBe(1);
  });
  it("only returns the caller's policy with the installation secret", async () => {
    const f = await fixture();
    expect(await installationPolicy(f.db, f.installationId, "b".repeat(64))).toBeNull();
    const policy = await installationPolicy(f.db, f.installationId, secret);
    expect(policy).toMatchObject({ organizationId: f.organizationId, outletId: f.outletId, installationId: f.installationId, revision: 0 });
  });
  it("serves a cryptographically signed policy and revokes signed-out owner sessions", async () => {
    const f = await fixture(); const keys = generateKeyPairSync("ed25519");
    const request = new Request("https://owner.test/v1/features", { method: "POST", headers: { "content-type": "application/json", "X-ForkFlow-Installation-Secret": secret }, body: JSON.stringify({ installationId: f.installationId }) });
    const response = await worker.fetch(request, { DB: f.db, LIMITER: { limit: async () => ({ success: true }) }, LICENSE_SIGNING_KEY: keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString() } as never);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const { policy } = await response.json() as { policy: string };
    expect(verifyLicenseSignature(policy, keys.publicKey.export({ type: "spki", format: "pem" }).toString())).toMatchObject({ organizationId: f.organizationId, outletId: f.outletId, installationId: f.installationId });
    expect((await f.send("POST", "/owner/api/logout", {}, f.cookie))!.status).toBe(200);
    expect((await f.send("GET", "/owner/api/restaurants", undefined, f.cookie))!.status).toBe(401);
  });
});
