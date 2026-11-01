import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { uuidv7 } from "@masalapos/domain";
import { auth, createUser, freshApp, setupAdmin, wsAuth } from "./test-helpers.js";

describe("staff permissions", () => {
  let app: FastifyInstance; let token: string; let adminId: string;
  beforeEach(async () => { app = freshApp(); ({ token, user: { id: adminId } } = await setupAdmin(app)); });
  afterEach(async () => { await app.close(); app.db.close(); });

  const request = (method: "GET" | "POST" | "PATCH" | "PUT", url: string, payload?: object, as = token) =>
    app.inject({ method, url, headers: auth(as), ...(payload ? { payload } : {}) });
  const setPermissions = (userId: string, overrides: Record<string, boolean>, as = token) => request("PUT", `/api/users/${userId}/permissions`, { overrides }, as);

  it("lets an admin give one cashier menu editing, effective on the next request", async () => {
    const meena = await createUser(app, token, { name: "Meena", pin: "3333", role: "cashier" });
    const category = (await request("POST", "/api/categories", { name: "Food" })).json().category.id as string;
    const product = { name: "Thali", categoryId: category, pricePaise: 50000, gstRate: 5, kotStationId: null };
    expect((await request("POST", "/api/products", product, meena.token)).statusCode).toBe(403);
    expect((await request("GET", "/api/me", undefined, meena.token)).json().user.permissions).not.toContain("catalog.manage");

    const saved = await setPermissions(meena.id, { "catalog.manage": true });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json().permissions).toMatchObject({ role: "cashier", overrides: { "catalog.manage": true }, defaults: { "catalog.manage": false } });
    expect((await request("POST", "/api/products", product, meena.token)).statusCode).toBe(201);
    expect((await request("GET", "/api/me", undefined, meena.token)).json().user.permissions).toContain("catalog.manage");
    expect((await request("GET", "/api/users")).json().users.find((u: { id: string }) => u.id === meena.id).permissionChanges).toBe(1);
  });

  it("can take a permission away from one cashier: no voids for them", async () => {
    const meena = await createUser(app, token, { name: "Meena", pin: "3333", role: "cashier" });
    const category = (await request("POST", "/api/categories", { name: "Food" })).json().category.id as string;
    const productId = (await request("POST", "/api/products", { name: "Tea", categoryId: category, pricePaise: 2000, gstRate: 5, kotStationId: null })).json().product.id as string;
    const orderId = (await request("POST", "/api/orders", { clientRef: uuidv7(), type: "parcel" })).json().order.id as string;
    await request("POST", `/api/orders/${orderId}/items`, { items: [{ productId, qty: 1, clientRef: uuidv7() }] });
    const preview = await request("POST", `/api/orders/${orderId}/bill-preview`, {});
    const bill = (await request("POST", `/api/orders/${orderId}/bill`, { clientRef: uuidv7(), previewKey: preview.json().preview.previewKey })).json().bill;

    await setPermissions(meena.id, { "bills.refund": false });
    const refused = await request("POST", `/api/bills/${bill.id}/void`, { clientRef: uuidv7(), reason: "Wrong order", refunds: [], approverPin: "1234" }, meena.token);
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({ error: "forbidden", permission: "bills.refund" });
    // Taking payment, which the cashier role covers with the same bills.* rule, is untouched.
    expect((await request("GET", "/api/me", undefined, meena.token)).json().user.permissions).toContain("bills.settle");
  });

  it("stores only real differences, keeps changes through a role change, and resets to the role", async () => {
    const ravi = await createUser(app, token, { name: "Ravi", pin: "4444", role: "cashier" });
    const saved = await setPermissions(ravi.id, { "catalog.manage": true, "bills.settle": true });
    expect(saved.json().permissions.overrides).toEqual({ "catalog.manage": true });
    expect((await request("PATCH", `/api/users/${ravi.id}`, { role: "waiter" })).statusCode).toBe(200);
    const after = (await request("GET", `/api/users/${ravi.id}/permissions`)).json().permissions;
    expect(after).toMatchObject({ role: "waiter", overrides: { "catalog.manage": true } });
    expect(after.effective).toContain("catalog.manage");
    expect(after.effective).not.toContain("bills.settle");
    expect((await setPermissions(ravi.id, {})).json().permissions.overrides).toEqual({});
  });

  it("never restricts an admin and keeps managing staff and settings for admins", async () => {
    const meena = await createUser(app, token, { name: "Meena", pin: "3333", role: "cashier" });
    expect((await setPermissions(adminId, { "bills.refund": false })).statusCode).toBe(409);
    expect((await setPermissions(meena.id, { "users.manage": true })).statusCode).toBe(400);
    expect((await setPermissions(meena.id, { "settings.manage": true })).statusCode).toBe(400);
    expect((await setPermissions(meena.id, { "catalog.manage": true }, meena.token)).statusCode).toBe(403);
    expect((await request("GET", `/api/users/${meena.id}/permissions`, undefined, meena.token)).statusCode).toBe(403);
    expect((await request("GET", "/api/me")).json().user.permissions).toEqual(expect.arrayContaining(["users.manage", "settings.manage", "bills.refund"]));
  });

  it("tells open screens when a person's permissions change", async () => {
    const meena = await createUser(app, token, { name: "Meena", pin: "3333", role: "cashier" });
    await app.ready();
    const ws = await wsAuth(app, token);
    const messages: Array<{ event: string; data: unknown }> = [];
    ws.on("message", (data: Buffer) => messages.push(JSON.parse(data.toString())));
    try {
      await setPermissions(meena.id, { "catalog.manage": true });
      await new Promise((r) => setTimeout(r, 50));
      expect(messages).toContainEqual({ event: "user.changed", data: { userId: meena.id } });
    } finally { ws.close(); }
  });
});
