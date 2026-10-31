import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../env.js";
import { keyPair, ORIGIN, send, testEnv } from "../testing/harness.js";
import { as, client, PASSWORD, seedStaff, signIn } from "../testing/portal.js";
import { IDLE_MS, LOCK_MS, SESSION_MS } from "./auth.js";
import { hashPassword, PBKDF2_ITERATIONS, verifyPassword } from "./passwords.js";

const T0 = Date.UTC(2026, 9, 10, 10, 0, 0);
const keys = keyPair();
let env: Env;
beforeAll(() => { vi.useFakeTimers({ toFake: ["Date"] }); });
beforeEach(() => { vi.setSystemTime(T0); env = testEnv(keys.privatePem); });
afterEach(() => { vi.restoreAllMocks(); });

const login = (email: string, password: string, headers: Record<string, string> = {}) =>
  send(env, "POST", "/portal/api/login", { email, password }, { origin: ORIGIN, ...headers });

describe("staff passwords", () => {
  it("stay within the iteration count Cloudflare Workers allow, and verify only the right password", async () => {
    expect(PBKDF2_ITERATIONS).toBeLessThanOrEqual(100_000);
    const hash = await hashPassword("a long enough secret");
    expect(hash).toMatch(/^pbkdf2-sha256\$100000\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$/);
    expect(await verifyPassword("a long enough secret", hash)).toBe(true);
    expect(await verifyPassword("a long enough secreT", hash)).toBe(false);
    for (const bad of ["", "pbkdf2-sha256$x$y$z", "md5$1$a$b", hash.replace("100000", "200000")]) expect(await verifyPassword("a long enough secret", bad)).toBe(false);
  });
});

describe("portal sign-in", () => {
  it("signs in with a session cookie that only the portal path sees, and signs out", async () => {
    const admin = await seedStaff(env, "admin", { email: "asha@masalapos.test", name: "Asha" });
    const res = await login("ASHA@masalapos.test", PASSWORD);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ user: { id: admin.id, email: "asha@masalapos.test", name: "Asha", role: "admin", mustChangePassword: false } });
    const cookie = res.headers.get("set-cookie")!;
    expect(cookie).toMatch(/^ff_portal=[A-Za-z0-9_-]{43}; Path=\/portal; HttpOnly; Secure; SameSite=Strict; Max-Age=43200$/);
    expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    const me = client(env, cookie.split(";")[0]!);
    expect((await me.ok<{ user: { name: string } }>("GET", "/me")).user.name).toBe("Asha");
    const out = await me.call("POST", "/logout");
    expect(out.headers.get("set-cookie")).toContain("Max-Age=0");
    expect((await me.call("GET", "/me")).status).toBe(401);
  });

  it("gives one answer for an unknown email, a wrong password and a deactivated account", async () => {
    const staff = await seedStaff(env, "sales");
    await env.DB.prepare(`UPDATE staff_users SET active = 0 WHERE id = ?`).bind(staff.id).run();
    const bodies = new Set<string>();
    for (const [email, password] of [["nobody@masalapos.test", PASSWORD], [staff.email, "wrong password"], [staff.email, PASSWORD]] as const) {
      const res = await login(email, password);
      expect(res.status).toBe(401);
      bodies.add(await res.text());
    }
    expect(bodies.size).toBe(1);
  });

  it("locks an account for 15 minutes after five wrong passwords, even with the right one", async () => {
    const staff = await seedStaff(env, "accounts");
    for (let i = 0; i < 5; i++) expect((await login(staff.email, `wrong ${i}`)).status).toBe(401);
    const locked = await login(staff.email, PASSWORD);
    // Answered exactly like a wrong password or an unknown address, so the lock does not reveal which staff addresses exist.
    expect(locked.status).toBe(401);
    expect(await locked.text()).toBe(await (await login("nobody@masalapos.test", PASSWORD)).text());
    vi.setSystemTime(T0 + LOCK_MS + 1);
    expect((await login(staff.email, PASSWORD)).status).toBe(200);
  });

  it("is rate limited per address, by the sign-in limiter when there is one", async () => {
    const keys: string[] = [];
    env.LOGIN_LIMITER = { limit: async ({ key }) => { keys.push(key); return { success: false } } };
    const res = await login("a@masalapos.test", PASSWORD, { "cf-connecting-ip": "203.0.113.4" });
    expect(res.status).toBe(429);
    expect(keys).toEqual(["portal:203.0.113.4"]);
  });

  it("ends a session 12 hours after sign-in, or after 2 idle hours", async () => {
    const admin = await as(env, "admin");
    vi.setSystemTime(T0 + IDLE_MS - 60_000);
    expect((await admin.call("GET", "/me")).status).toBe(200);
    vi.setSystemTime(T0 + 2 * IDLE_MS - 120_000);
    expect((await admin.call("GET", "/me")).status).toBe(200);
    vi.setSystemTime(T0 + 2 * IDLE_MS - 120_000 + IDLE_MS + 1);
    expect((await admin.call("GET", "/me")).status).toBe(401);
    vi.setSystemTime(T0);
    const other = await as(env, "admin");
    for (let t = T0; t < T0 + SESSION_MS; t += IDLE_MS / 2) { vi.setSystemTime(t); expect((await other.call("GET", "/me")).status).toBe(200); }
    vi.setSystemTime(T0 + SESSION_MS);
    expect((await other.call("GET", "/me")).status).toBe(401);
  });

  it("refuses changes that do not come from the portal's own pages", async () => {
    const admin = await as(env, "admin");
    expect((await admin.call("POST", "/logout", undefined, { origin: "https://evil.example" })).status).toBe(403);
    const noOrigin = await send(env, "POST", "/portal/api/logout", undefined, { cookie: admin.cookie });
    expect(noOrigin.status).toBe(403);
    expect((await admin.call("GET", "/me")).status).toBe(200);
  });

  it("a temporary password must be changed before anything else, and changing it ends the other sessions", async () => {
    const staff = await seedStaff(env, "sales", { mustChange: true });
    const first = await signIn(env, staff), second = await signIn(env, staff);
    const blocked = await first.call("GET", "/settings");
    expect(blocked.status).toBe(403);
    expect(await blocked.json()).toMatchObject({ code: "password_change_required" });
    expect((await first.call("POST", "/password", { current: "wrong", next: "a brand new password" })).status).toBe(400);
    expect((await first.call("POST", "/password", { current: PASSWORD, next: "short" })).status).toBe(400);
    expect((await first.ok<{ user: { mustChangePassword: boolean } }>("POST", "/password", { current: PASSWORD, next: "a brand new password" })).user.mustChangePassword).toBe(false);
    expect((await first.call("GET", "/settings")).status).toBe(200);
    expect((await second.call("GET", "/me")).status).toBe(401);
    expect((await login(staff.email, "a brand new password")).status).toBe(200);
  });
});

describe("staff accounts", () => {
  it("an admin adds staff with a temporary password; emails are unique; other roles cannot", async () => {
    const admin = await as(env, "admin");
    const created = await admin.call("POST", "/users", { email: " Ravi@MasalaPOS.test ", name: "Ravi", role: "sales", password: "temporary password" });
    expect(created.status).toBe(201);
    expect((await created.json() as { user: unknown }).user).toMatchObject({ email: "ravi@masalapos.test", role: "sales", active: true, mustChangePassword: true });
    expect((await admin.call("POST", "/users", { email: "ravi@masalapos.test", name: "Ravi 2", role: "sales", password: "temporary password" })).status).toBe(409);
    const ravi = await signIn(env, { email: "ravi@masalapos.test" }, "temporary password");
    expect((await ravi.call("GET", "/settings")).status).toBe(403);
    for (const role of ["sales", "accounts", "support"] as const) {
      const other = await as(env, role);
      expect((await other.call("GET", "/users")).status).toBe(403);
      expect((await other.call("POST", "/users", { email: "x@masalapos.test", name: "X", role: "admin", password: "temporary password" })).status).toBe(403);
    }
  });

  it("a new role or deactivation takes effect at once, and the last admin cannot be removed", async () => {
    const admin = await as(env, "admin");
    const sales = await as(env, "sales");
    await admin.ok("PATCH", `/users/${sales.staff.id}`, { role: "support" });
    expect((await sales.call("GET", "/me")).status).toBe(401);
    const support = await signIn(env, sales.staff);
    expect((await support.ok<{ user: { role: string } }>("GET", "/me")).user.role).toBe("support");
    await admin.ok("PATCH", `/users/${sales.staff.id}`, { active: false });
    expect((await support.call("GET", "/me")).status).toBe(401);
    const last = await admin.call("PATCH", `/users/${admin.staff.id}`, { role: "sales" });
    expect(last.status).toBe(409);
    expect(await last.json()).toMatchObject({ code: "last_admin" });
    expect((await admin.call("PATCH", `/users/${admin.staff.id}`, { active: false })).status).toBe(409);
  });

  it("an admin resets a password: the old one stops working, sessions end, and the account unlocks", async () => {
    const admin = await as(env, "admin");
    const staff = await as(env, "accounts");
    for (let i = 0; i < 5; i++) await login(staff.staff.email, "wrong");
    const reset = await admin.ok<{ user: { mustChangePassword: boolean; locked: boolean } }>("POST", `/users/${staff.staff.id}/password`, { password: "a temporary one" });
    expect(reset.user).toMatchObject({ mustChangePassword: true, locked: false });
    expect((await staff.call("GET", "/me")).status).toBe(401);
    expect((await login(staff.staff.email, PASSWORD)).status).toBe(401);
    expect((await login(staff.staff.email, "a temporary one")).status).toBe(200);
    expect((await admin.call("POST", `/users/${admin.staff.id}/password`, { password: "a temporary one" })).status).toBe(400);
  });

  it("everyone can list active colleagues to assign work", async () => {
    const admin = await as(env, "admin", { name: "Asha" });
    const support = await as(env, "support", { name: "Bina" });
    const gone = await seedStaff(env, "sales", { name: "Chetan" });
    await env.DB.prepare(`UPDATE staff_users SET active = 0 WHERE id = ?`).bind(gone.id).run();
    expect((await support.ok<{ staff: Array<{ name: string }> }>("GET", "/staff")).staff.map((s) => s.name)).toEqual(["Asha", "Bina"]);
    expect(admin.staff.name).toBe("Asha");
  });
});

describe("portal settings and activity", () => {
  it("everyone reads the settings with their defaults; only admins change them, and bad details are refused", async () => {
    const admin = await as(env, "admin"), sales = await as(env, "sales");
    const { settings } = await sales.ok<{ settings: { invoice: { prefix: string; sac: string; gstRateBp: number }; trialDays: number } }>("GET", "/settings");
    expect(settings).toMatchObject({ invoice: { prefix: "FF", sac: "997331", gstRateBp: 1800 }, trialDays: 7 });
    const next = { ...settings, seller: { legalName: "MasalaPOS Technologies", gstin: "27aapfu0939f1zv", address: "Baner", city: "Pune", stateCode: "27", pincode: "411045", email: "", phone: "" },
      prices: [{ plan: "pro", termMonths: 12, pricePaise: 1_499_900 }] };
    expect((await sales.call("PUT", "/settings", next)).status).toBe(403);
    const saved = await admin.ok<{ settings: { seller: { gstin: string } } }>("PUT", "/settings", next);
    expect(saved.settings.seller.gstin).toBe("27AAPFU0939F1ZV");
    expect((await sales.ok<{ settings: { prices: unknown[] } }>("GET", "/settings")).settings.prices).toHaveLength(1);
    const bad = await admin.call("PUT", "/settings", { ...next, seller: { ...next.seller, gstin: "12345" } });
    expect(bad.status).toBe(400);
    expect((await bad.json() as { error: string }).error).toContain("seller.gstin");
  });

  it("admins see who changed what, newest first, a page at a time; other roles cannot", async () => {
    const admin = await as(env, "admin", { name: "Asha" });
    for (let i = 0; i < 52; i++) await admin.ok("POST", "/users", { email: `s${i}@masalapos.test`, name: `Staff ${i}`, role: "support", password: "temporary password" });
    const first = await admin.ok<{ entries: Array<{ summary: string; actor: { name: string } }>; nextBefore: number }>("GET", "/activity");
    expect(first.entries).toHaveLength(50);
    expect(first.entries[0]).toMatchObject({ summary: "Added Staff 51 (Support)", actor: { name: "Asha" } });
    const second = await admin.ok<{ entries: unknown[]; nextBefore: number | null }>("GET", `/activity?before=${first.nextBefore}`);
    expect(second).toMatchObject({ nextBefore: null });
    expect(second.entries).toHaveLength(2);
    expect((await admin.ok<{ entries: unknown[] }>("GET", `/activity?actorId=${admin.staff.id}&entityType=settings`)).entries).toEqual([]);
    expect((await (await as(env, "accounts")).call("GET", "/activity")).status).toBe(403);
  });
});

describe("portal web app", () => {
  const assets = (calls: string[]) => ({ fetch: async (request: Request) => {
    calls.push(new URL(request.url).pathname);
    return new Response("<!doctype html>", { headers: { "content-type": "text/html", "cache-control": "public, max-age=0" } });
  } });

  it("serves pages from the app's index and files as they are, with security headers; licensing routes are unaffected", async () => {
    const calls: string[] = [];
    env.ASSETS = assets(calls);
    const page = await send(env, "GET", "/portal/customers/0b6c3d4e-1111-4111-8111-111111111111");
    expect(page.status).toBe(200);
    expect(page.headers.get("content-security-policy")).toContain("script-src 'self'");
    expect(page.headers.get("cache-control")).toBe("no-cache");
    await send(env, "GET", "/portal/assets/index-abc123.js");
    expect(calls).toEqual(["/portal/", "/portal/assets/index-abc123.js"]);
    const bare = await send(env, "GET", "/portal");
    expect([bare.status, bare.headers.get("location")]).toEqual([308, `${ORIGIN}/portal/`]);
    expect((await send(env, "POST", "/v1/activate", "{}")).status).toBe(400);
    expect((await send(env, "GET", "/subscribe")).status).toBe(404);
    expect(calls).toHaveLength(2);
  });

  it("says the app is not built when there are no assets, and unknown API paths are JSON 404s", async () => {
    expect((await send(env, "GET", "/portal/")).status).toBe(503);
    const admin = await as(env, "admin");
    const res = await admin.call("GET", "/nothing-here");
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect((await send(env, "GET", "/portal/api/me")).status).toBe(401);
  });
});
