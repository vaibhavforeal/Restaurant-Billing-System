import { afterEach, describe, expect, it } from "vitest";
import { MIGRATIONS, migrate, openDb } from "@forkflow/domain";
import type { FastifyInstance } from "fastify";
import { buildServer } from "./server.js";
import { auth, commercialApp, createUser, enableIntegration, freshApp, setupAdmin, wsAuth } from "./test-helpers.js";
import { kdsActive } from "./kds.js";
import type { ZomatoProvider } from "./zomato.js";

let app: FastifyInstance;
afterEach(async () => { if (app) { await app.close(); app.db.close(); } });

async function roles() {
  app = freshApp();
  const admin = await setupAdmin(app);
  const cashier = await createUser(app, admin.token, { name: "Cy", pin: "2222", role: "cashier" });
  const waiter = await createUser(app, admin.token, { name: "Wes", pin: "3333", role: "waiter" });
  const kitchen = await createUser(app, admin.token, { name: "Kim", pin: "4444", role: "kitchen" });
  return { admin, cashier, waiter, kitchen };
}
const get = (token?: string) => app.inject({ method: "GET", url: "/api/integrations", ...(token ? { headers: auth(token) } : {}) });
const patch = (id: string, token: string, payload: unknown) => app.inject({ method: "PATCH", url: `/api/integrations/${id}`, headers: auth(token), payload: payload as object });

describe("GET /api/integrations", () => {
  it("lists the registry, all disabled, uncached, for admin and cashier only", async () => {
    const { admin, cashier, waiter, kitchen } = await roles();
    const res = await get(admin.token);
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    const list = res.json().integrations as { id: string; enabled: boolean; licensed: boolean; updatedAt: number | null }[];
    expect(list.map((i) => i.id)).toEqual(["zomato", "swiggy", "kds"]);
    expect(list.every((i) => i.enabled === false && i.updatedAt === null && i.licensed === true)).toBe(true);
    expect((await get()).statusCode).toBe(401);
    expect((await get(waiter.token)).statusCode).toBe(403);
    expect((await get(kitchen.token)).statusCode).toBe(403);
    expect((await get(cashier.token)).statusCode).toBe(200);
  });
});

describe("kds licensing", () => {
  const kdsOf = (res: { json(): { integrations: { id: string; licensed: boolean; enabled: boolean }[] } }) => res.json().integrations.find((i) => i.id === "kds")!;

  it("reports kds as unlicensed on Basic", async () => {
    const c = await commercialApp("basic"); app = c.app;
    const res = await app.inject({ method: "GET", url: "/api/integrations", headers: c.headers });
    expect(res.statusCode, res.body).toBe(200);
    expect(kdsOf(res).licensed).toBe(false);
    expect(res.json().integrations.find((i: { id: string }) => i.id === "zomato").licensed).toBe(true);
  });

  it("allows turning kds off but not on while unlicensed", async () => {
    const c = await commercialApp("basic"); app = c.app;
    const on = await app.inject({ method: "PATCH", url: "/api/integrations/kds", headers: c.headers, payload: { enabled: true } });
    expect(on.statusCode).toBe(403);
    expect(on.json().error).toBe("Kitchen Display requires the Pro plan");
    enableIntegration(app, "kds"); // a plan downgrade can leave the stored switch on
    const off = await app.inject({ method: "PATCH", url: "/api/integrations/kds", headers: c.headers, payload: { enabled: false } });
    expect(off.statusCode, off.body).toBe(200);
    expect(off.json().integration).toMatchObject({ id: "kds", enabled: false, licensed: false });
  });

  it("lets a Pro admin turn kds on", async () => {
    const c = await commercialApp("pro"); app = c.app;
    const on = await app.inject({ method: "PATCH", url: "/api/integrations/kds", headers: c.headers, payload: { enabled: true } });
    expect(on.statusCode, on.body).toBe(200);
    expect(on.json().integration).toMatchObject({ id: "kds", enabled: true, licensed: true });
  });
});

describe("kdsActive", () => {
  it("needs the switch on in a development build", async () => {
    app = freshApp(); await setupAdmin(app);
    expect(kdsActive(app.db)).toBe(false);
    enableIntegration(app, "kds");
    expect(kdsActive(app.db)).toBe(true);
  });

  it("stays inactive on Basic even with the switch on", async () => {
    const c = await commercialApp("basic"); app = c.app;
    enableIntegration(app, "kds");
    expect(kdsActive(app.db)).toBe(false);
  });
});

describe("PATCH /api/integrations/:id", () => {
  it("enables for admin, persists, and enforces role, id, status and body rules", async () => {
    const { admin, cashier } = await roles();
    const res = await patch("zomato", admin.token, { enabled: true });
    expect(res.statusCode).toBe(200);
    expect(res.json().integration).toMatchObject({ id: "zomato", enabled: true });
    expect(res.json().integration.updatedAt).toBeTypeOf("number");
    const list = (await get(admin.token)).json().integrations as { id: string; enabled: boolean }[];
    expect(list.find((i) => i.id === "zomato")?.enabled).toBe(true);
    expect((await patch("zomato", cashier.token, { enabled: false })).statusCode).toBe(403);
    expect((await patch("dineout", admin.token, { enabled: true })).statusCode).toBe(404);
    expect((await patch("swiggy", admin.token, { enabled: true })).statusCode).toBe(409);
    for (const body of [{}, { enabled: "yes" }, { enabled: true, x: 1 }]) {
      expect((await patch("zomato", admin.token, body)).statusCode).toBe(400);
    }
  });

  it("broadcasts integrations.changed only when the stored value changes", async () => {
    const { admin } = await roles();
    await app.ready();
    const ws = await wsAuth(app, admin.token);
    const messages: unknown[] = [];
    ws.on("message", (data: Buffer) => messages.push(JSON.parse(data.toString())));
    try {
      expect((await patch("zomato", admin.token, { enabled: true })).statusCode).toBe(200);
      await new Promise((r) => setTimeout(r, 50));
      expect(messages).toEqual([{ event: "integrations.changed", data: {} }]);
      messages.length = 0;
      expect((await patch("zomato", admin.token, { enabled: true })).statusCode).toBe(200);
      await new Promise((r) => setTimeout(r, 50));
      expect(messages).toEqual([]);
    } finally {
      ws.terminate();
    }
  });

  it("leaves the stored row untouched when the value does not change", async () => {
    app = freshApp();
    const admin = await setupAdmin(app);
    const other = await createUser(app, admin.token, { name: "Ada", pin: "5555", role: "admin" });
    expect((await patch("zomato", other.token, { enabled: true })).statusCode).toBe(200);
    app.db.prepare("UPDATE integration_state SET updated_at=1 WHERE id='zomato'").run();
    const again = await patch("zomato", admin.token, { enabled: true });
    expect(again.json().integration).toMatchObject({ enabled: true, updatedAt: 1 });
    expect(app.db.prepare("SELECT updated_by FROM integration_state WHERE id='zomato'").get()).not.toEqual({ updated_by: admin.user.id });
    // Turning off something that was never on writes nothing either.
    expect((await patch("swiggy", admin.token, { enabled: false })).json().integration.updatedAt).toBeNull();
  });

  it("keeps Zomato data when the integration is turned off", async () => {
    const { admin } = await roles();
    app.db.prepare("INSERT INTO zomato_orders (restaurant_id,order_id,placed_at,status,total_paise,payment_mode,items_json,source,status_at,updated_at) VALUES ('R1','Z1',1,'received',100,'prepaid','[]','import',0,1)").run();
    await patch("zomato", admin.token, { enabled: true });
    await patch("zomato", admin.token, { enabled: false });
    expect(app.db.prepare("SELECT COUNT(*) AS n FROM zomato_orders").get()).toEqual({ n: 1 });
    expect(((await get(admin.token)).json().integrations as { id: string; enabled: boolean }[]).find((i) => i.id === "zomato")?.enabled).toBe(false);
  });
});

describe("Zomato webhook Marketplace gate", () => {
  const provider: ZomatoProvider = { async verifyAndDecode() { throw new Error("reached provider"); } };
  it("returns 503 while off and reaches the provider once on", async () => {
    const db = openDb(":memory:"); migrate(db, MIGRATIONS);
    app = buildServer({ db, zomatoProvider: provider });
    await setupAdmin(app);
    db.prepare("UPDATE zomato_settings SET enabled=1 WHERE id=1").run();
    const push = () => app.inject({ method: "POST", url: "/api/integrations/zomato/webhook", headers: { "content-type": "application/json" }, payload: "[]" });
    const off = await push();
    expect(off.statusCode).toBe(503);
    expect(off.json().error).toMatch(/Marketplace/);
    enableIntegration(app, "zomato");
    expect((await push()).statusCode).toBe(401); // provider rejected, so the gate let it through
  });
});
