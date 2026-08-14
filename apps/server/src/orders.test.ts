import { afterEach, describe, expect, it } from "vitest";
import { auth, createUser, freshApp, setupAdmin } from "./test-helpers.js";

let app: ReturnType<typeof freshApp>;
afterEach(async () => {
  await app?.close();
});

async function fixtures(app: ReturnType<typeof freshApp>, adminToken: string) {
  const catRes = await app.inject({
    method: "POST", url: "/api/categories",
    payload: { name: "Mains" }, headers: auth(adminToken),
  });
  const categoryId = catRes.json().category.id;

  const stationsRes = await app.inject({ method: "GET", url: "/api/kot-stations", headers: auth(adminToken) });
  const kitchenStation = stationsRes.json().stations[0];

  const dalRes = await app.inject({
    method: "POST", url: "/api/products",
    payload: { categoryId, name: "Dal", pricePaise: 12000, gstRate: 5 },
    headers: auth(adminToken),
  });
  const dalId = dalRes.json().product.id;

  const biryaniRes = await app.inject({
    method: "POST", url: "/api/products",
    payload: {
      categoryId, name: "Biryani", pricePaise: 30000, gstRate: 5,
      kotStationId: kitchenStation.id, variants: [{ name: "Half", pricePaise: 18000 }],
    },
    headers: auth(adminToken),
  });
  const biryaniProduct = biryaniRes.json().product;

  return {
    categoryId,
    kitchenStationId: kitchenStation.id,
    dalId,
    biryaniId: biryaniProduct.id,
    biryaniHalfVariantId: biryaniProduct.variants[0].id,
  };
}

describe("orders: create/get/list", () => {
  it("creates a parcel order idempotently by clientRef", async () => {
    app = freshApp();
    const admin = await setupAdmin(app);

    const clientRef = "order-c1";
    const res1 = await app.inject({
      method: "POST", url: "/api/orders",
      payload: { clientRef, type: "parcel", tableId: null },
      headers: auth(admin.token),
    });
    expect(res1.statusCode).toBe(201);
    const order1 = res1.json().order;
    expect(order1).toMatchObject({ clientRef, type: "parcel", tableId: null, status: "open", openedBy: admin.user.id });
    expect(order1.items).toEqual([]);
    expect(order1.kots).toEqual([]);

    const res2 = await app.inject({
      method: "POST", url: "/api/orders",
      payload: { clientRef, type: "dine_in", tableId: "different" },
      headers: auth(admin.token),
    });
    expect(res2.statusCode).toBe(200);
    expect(res2.json().order.id).toBe(order1.id);
    expect(res2.json().order.type).toBe("parcel");
  });

  it("creates a dine_in order after table checks", async () => {
    app = freshApp();
    const admin = await setupAdmin(app);

    const unknownTable = await app.inject({
      method: "POST", url: "/api/orders",
      payload: { clientRef: "order-c2", type: "dine_in", tableId: "nope" },
      headers: auth(admin.token),
    });
    expect(unknownTable.statusCode).toBe(400);
    expect(unknownTable.json().error).toBe("unknown table");

    const tableRes = await app.inject({
      method: "POST", url: "/api/tables",
      payload: { name: "T1", area: "Main" },
      headers: auth(admin.token),
    });
    const tableId = tableRes.json().table.id;

    const inactiveTable = await app.inject({
      method: "PATCH", url: `/api/tables/${tableId}`,
      payload: { isActive: false },
      headers: auth(admin.token),
    });
    expect(inactiveTable.statusCode).toBe(200);

    const inactive = await app.inject({
      method: "POST", url: "/api/orders",
      payload: { clientRef: "order-c3", type: "dine_in", tableId },
      headers: auth(admin.token),
    });
    expect(inactive.statusCode).toBe(409);
    expect(inactive.json().error).toBe("table is not active");

    await app.inject({
      method: "PATCH", url: `/api/tables/${tableId}`,
      payload: { isActive: true },
      headers: auth(admin.token),
    });

    const order1 = await app.inject({
      method: "POST", url: "/api/orders",
      payload: { clientRef: "order-c4", type: "dine_in", tableId },
      headers: auth(admin.token),
    });
    expect(order1.statusCode).toBe(201);
    expect(order1.json().order.tableId).toBe(tableId);

    const occupied = await app.inject({
      method: "POST", url: "/api/orders",
      payload: { clientRef: "order-c5", type: "dine_in", tableId },
      headers: auth(admin.token),
    });
    expect(occupied.statusCode).toBe(409);
    expect(occupied.json().error).toBe("table occupied");
  });

  it("GET /api/orders lists only open orders", async () => {
    app = freshApp();
    const admin = await setupAdmin(app);

    await app.inject({
      method: "POST", url: "/api/orders",
      payload: { clientRef: "order-c6", type: "parcel" },
      headers: auth(admin.token),
    });

    const list = await app.inject({ method: "GET", url: "/api/orders", headers: auth(admin.token) });
    expect(list.statusCode).toBe(200);
    expect(list.json().orders).toHaveLength(1);

    app.db.prepare("UPDATE orders SET status = 'cancelled' WHERE client_ref = 'order-c6'").run();

    const listAfter = await app.inject({ method: "GET", url: "/api/orders", headers: auth(admin.token) });
    expect(listAfter.json().orders).toHaveLength(0);
  });

  it("GET /api/orders/:id returns 404 for unknown id", async () => {
    app = freshApp();
    const admin = await setupAdmin(app);

    const res = await app.inject({ method: "GET", url: "/api/orders/nope", headers: auth(admin.token) });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("order not found");
  });

  it("kitchen role cannot create orders", async () => {
    app = freshApp();
    const admin = await setupAdmin(app);
    const kitchen = await createUser(app, admin.token, { name: "Chef", pin: "5678", role: "kitchen" });

    const res = await app.inject({
      method: "POST", url: "/api/orders",
      payload: { clientRef: "order-c7", type: "parcel" },
      headers: auth(kitchen.token),
    });
    expect(res.statusCode).toBe(403);
  });

  it("anonymous requests are 401", async () => {
    app = freshApp();
    await setupAdmin(app);

    expect((await app.inject({ method: "POST", url: "/api/orders", payload: { clientRef: "x", type: "parcel" } })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/api/orders" })).statusCode).toBe(401);
  });
});
