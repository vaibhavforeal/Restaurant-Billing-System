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

describe("orders: items punch/update/cancel", () => {
  it("punches items with snapshots and variant name composition", async () => {
    app = freshApp();
    const admin = await setupAdmin(app);
    const { dalId, biryaniId, biryaniHalfVariantId } = await fixtures(app, admin.token);

    const orderRes = await app.inject({
      method: "POST", url: "/api/orders",
      payload: { clientRef: "order-punch", type: "parcel" },
      headers: auth(admin.token),
    });
    const orderId = orderRes.json().order.id;

    const punchRes = await app.inject({
      method: "POST", url: `/api/orders/${orderId}/items`,
      payload: {
        items: [
          { productId: dalId, variantId: null, qty: 2 },
          { productId: biryaniId, variantId: biryaniHalfVariantId, qty: 1, note: "Extra spicy" },
        ],
      },
      headers: auth(admin.token),
    });
    expect(punchRes.statusCode).toBe(200);
    const items = punchRes.json().order.items;
    expect(items).toHaveLength(2);

    expect(items[0]).toMatchObject({
      name: "Dal",
      pricePaise: 12000,
      gstRate: 5,
      qty: 2,
      status: "pending",
      note: null,
    });

    expect(items[1]).toMatchObject({
      name: "Biryani (Half)",
      pricePaise: 18000,
      gstRate: 5,
      qty: 1,
      note: "Extra spicy",
      status: "pending",
    });
  });

  it("skips items with duplicate clientRef on retry", async () => {
    app = freshApp();
    const admin = await setupAdmin(app);
    const { dalId } = await fixtures(app, admin.token);

    const orderRes = await app.inject({
      method: "POST", url: "/api/orders",
      payload: { clientRef: "order-retry", type: "parcel" },
      headers: auth(admin.token),
    });
    const orderId = orderRes.json().order.id;

    const itemClientRef = "item-abc";
    const punch1 = await app.inject({
      method: "POST", url: `/api/orders/${orderId}/items`,
      payload: { items: [{ clientRef: itemClientRef, productId: dalId, qty: 1 }] },
      headers: auth(admin.token),
    });
    expect(punch1.json().order.items).toHaveLength(1);

    const punch2 = await app.inject({
      method: "POST", url: `/api/orders/${orderId}/items`,
      payload: { items: [{ clientRef: itemClientRef, productId: dalId, qty: 5 }] },
      headers: auth(admin.token),
    });
    expect(punch2.json().order.items).toHaveLength(1);
    expect(punch2.json().order.items[0].qty).toBe(1);
  });

  it("reference checks: unknown/inactive product, unknown/inactive/wrong variant", async () => {
    app = freshApp();
    const admin = await setupAdmin(app);
    const { dalId, biryaniId, biryaniHalfVariantId } = await fixtures(app, admin.token);

    const orderRes = await app.inject({
      method: "POST", url: "/api/orders",
      payload: { clientRef: "order-refs", type: "parcel" },
      headers: auth(admin.token),
    });
    const orderId = orderRes.json().order.id;

    const unknownProduct = await app.inject({
      method: "POST", url: `/api/orders/${orderId}/items`,
      payload: { items: [{ productId: "nope", qty: 1 }] },
      headers: auth(admin.token),
    });
    expect(unknownProduct.statusCode).toBe(400);
    expect(unknownProduct.json().error).toBe("unknown product");

    await app.inject({
      method: "PATCH", url: `/api/products/${dalId}`,
      payload: { isActive: false },
      headers: auth(admin.token),
    });

    const inactiveProduct = await app.inject({
      method: "POST", url: `/api/orders/${orderId}/items`,
      payload: { items: [{ productId: dalId, qty: 1 }] },
      headers: auth(admin.token),
    });
    expect(inactiveProduct.statusCode).toBe(400);
    expect(inactiveProduct.json().error).toBe("product is not active");

    const unknownVariant = await app.inject({
      method: "POST", url: `/api/orders/${orderId}/items`,
      payload: { items: [{ productId: biryaniId, variantId: "nope", qty: 1 }] },
      headers: auth(admin.token),
    });
    expect(unknownVariant.statusCode).toBe(400);
    expect(unknownVariant.json().error).toBe("unknown variant");

    await app.inject({
      method: "PATCH", url: `/api/variants/${biryaniHalfVariantId}`,
      payload: { isActive: false },
      headers: auth(admin.token),
    });

    const inactiveVariant = await app.inject({
      method: "POST", url: `/api/orders/${orderId}/items`,
      payload: { items: [{ productId: biryaniId, variantId: biryaniHalfVariantId, qty: 1 }] },
      headers: auth(admin.token),
    });
    expect(inactiveVariant.statusCode).toBe(400);
    expect(inactiveVariant.json().error).toBe("variant is not active");

    await app.inject({
      method: "PATCH", url: `/api/variants/${biryaniHalfVariantId}`,
      payload: { isActive: true },
      headers: auth(admin.token),
    });

    const wrongVariant = await app.inject({
      method: "POST", url: `/api/orders/${orderId}/items`,
      payload: { items: [{ productId: dalId, variantId: biryaniHalfVariantId, qty: 1 }] },
      headers: auth(admin.token),
    });
    expect(wrongVariant.statusCode).toBe(400);
    expect(wrongVariant.json().error).toBe("variant does not belong to product");
  });

  it("updates qty and note for pending items, 409 for sent items", async () => {
    app = freshApp();
    const admin = await setupAdmin(app);
    const { dalId } = await fixtures(app, admin.token);

    const orderRes = await app.inject({
      method: "POST", url: "/api/orders",
      payload: { clientRef: "order-update", type: "parcel" },
      headers: auth(admin.token),
    });
    const orderId = orderRes.json().order.id;

    const punchRes = await app.inject({
      method: "POST", url: `/api/orders/${orderId}/items`,
      payload: { items: [{ productId: dalId, qty: 1 }] },
      headers: auth(admin.token),
    });
    const itemId = punchRes.json().order.items[0].id;

    const updateRes = await app.inject({
      method: "PATCH", url: `/api/order-items/${itemId}`,
      payload: { qty: 3, note: "Less salt" },
      headers: auth(admin.token),
    });
    expect(updateRes.statusCode).toBe(200);
    const updated = updateRes.json().order.items.find((i: { id: string }) => i.id === itemId);
    expect(updated).toMatchObject({ qty: 3, note: "Less salt" });

    app.db.prepare("UPDATE order_items SET status = 'sent' WHERE id = ?").run(itemId);

    const sentUpdate = await app.inject({
      method: "PATCH", url: `/api/order-items/${itemId}`,
      payload: { qty: 5 },
      headers: auth(admin.token),
    });
    expect(sentUpdate.statusCode).toBe(409);
    expect(sentUpdate.json().error).toBe("item is not pending");
  });

  it("cancels pending items freely, sent items with permission and reason", async () => {
    app = freshApp();
    const admin = await setupAdmin(app);
    const waiter = await createUser(app, admin.token, { name: "Wren", pin: "5678", role: "waiter" });
    const cashier = await createUser(app, admin.token, { name: "Ravi", pin: "4321", role: "cashier" });
    const { dalId, biryaniId } = await fixtures(app, admin.token);

    const orderRes = await app.inject({
      method: "POST", url: "/api/orders",
      payload: { clientRef: "order-cancel", type: "parcel" },
      headers: auth(admin.token),
    });
    const orderId = orderRes.json().order.id;

    const punchRes = await app.inject({
      method: "POST", url: `/api/orders/${orderId}/items`,
      payload: {
        items: [
          { productId: dalId, qty: 1 },
          { productId: biryaniId, qty: 1 },
        ],
      },
      headers: auth(admin.token),
    });
    const items = punchRes.json().order.items;
    const pendingItemId = items[0].id;
    const sentItemId = items[1].id;

    const pendingCancel = await app.inject({
      method: "POST", url: `/api/order-items/${pendingItemId}/cancel`,
      payload: {},
      headers: auth(admin.token),
    });
    expect(pendingCancel.statusCode).toBe(200);
    expect(pendingCancel.json().order.items.find((i: { id: string }) => i.id === pendingItemId).status).toBe("cancelled");

    app.db.prepare("UPDATE order_items SET status = 'sent' WHERE id = ?").run(sentItemId);

    const waiterSentCancel = await app.inject({
      method: "POST", url: `/api/order-items/${sentItemId}/cancel`,
      payload: { reason: "Customer changed mind" },
      headers: auth(waiter.token),
    });
    expect(waiterSentCancel.statusCode).toBe(403);
    expect(waiterSentCancel.json()).toMatchObject({ error: "forbidden", permission: "orders.cancel_sent" });

    const cashierNoReason = await app.inject({
      method: "POST", url: `/api/order-items/${sentItemId}/cancel`,
      payload: {},
      headers: auth(cashier.token),
    });
    expect(cashierNoReason.statusCode).toBe(400);
    expect(cashierNoReason.json().error).toBe("reason required");

    const cashierWithReason = await app.inject({
      method: "POST", url: `/api/order-items/${sentItemId}/cancel`,
      payload: { reason: "Customer changed mind" },
      headers: auth(cashier.token),
    });
    expect(cashierWithReason.statusCode).toBe(200);
    const cancelled = cashierWithReason.json().order.items.find((i: { id: string }) => i.id === sentItemId);
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.cancelReason).toBe("Customer changed mind");
    const row = app.db.prepare("SELECT cancelled_by FROM order_items WHERE id = ?").get(sentItemId) as { cancelled_by: string };
    expect(row.cancelled_by).toBe(cashier.id);
  });

  it("404s on unknown item", async () => {
    app = freshApp();
    const admin = await setupAdmin(app);

    expect((await app.inject({
      method: "PATCH", url: "/api/order-items/nope",
      payload: { qty: 1 },
      headers: auth(admin.token),
    })).statusCode).toBe(404);

    expect((await app.inject({
      method: "POST", url: "/api/order-items/nope/cancel",
      payload: {},
      headers: auth(admin.token),
    })).statusCode).toBe(404);
  });

  it("rejects PATCH on item when parent order is not open", async () => {
    app = freshApp();
    const admin = await setupAdmin(app);
    const { dalId } = await fixtures(app, admin.token);

    const orderRes = await app.inject({
      method: "POST", url: "/api/orders",
      payload: { clientRef: "order-closed", type: "parcel" },
      headers: auth(admin.token),
    });
    const orderId = orderRes.json().order.id;

    const punchRes = await app.inject({
      method: "POST", url: `/api/orders/${orderId}/items`,
      payload: { items: [{ productId: dalId, qty: 1 }] },
      headers: auth(admin.token),
    });
    const itemId = punchRes.json().order.items[0].id;

    // Backdoor: close the order via SQL (like auth.test.ts)
    app.db.prepare("UPDATE orders SET status = 'cancelled' WHERE id = ?").run(orderId);

    const patchRes = await app.inject({
      method: "PATCH", url: `/api/order-items/${itemId}`,
      payload: { qty: 2 },
      headers: auth(admin.token),
    });
    expect(patchRes.statusCode).toBe(409);
    expect(patchRes.json().error).toBe("order is not open");
  });

  it("rejects cancel on item when parent order is not open", async () => {
    app = freshApp();
    const admin = await setupAdmin(app);
    const { dalId } = await fixtures(app, admin.token);

    const orderRes = await app.inject({
      method: "POST", url: "/api/orders",
      payload: { clientRef: "order-closed-2", type: "parcel" },
      headers: auth(admin.token),
    });
    const orderId = orderRes.json().order.id;

    const punchRes = await app.inject({
      method: "POST", url: `/api/orders/${orderId}/items`,
      payload: { items: [{ productId: dalId, qty: 1 }] },
      headers: auth(admin.token),
    });
    const itemId = punchRes.json().order.items[0].id;

    // Backdoor: close the order via SQL
    app.db.prepare("UPDATE orders SET status = 'cancelled' WHERE id = ?").run(orderId);

    const cancelRes = await app.inject({
      method: "POST", url: `/api/order-items/${itemId}/cancel`,
      payload: {},
      headers: auth(admin.token),
    });
    expect(cancelRes.statusCode).toBe(409);
    expect(cancelRes.json().error).toBe("order is not open");
  });

  it("broadcasts order.updated via WS on item mutations", async () => {
    app = freshApp();
    const admin = await setupAdmin(app);
    const { dalId } = await fixtures(app, admin.token);

    await app.ready();
    const ws = await app.injectWS("/api/ws?token=" + admin.token);
    const messages: unknown[] = [];
    ws.on("message", (data: Buffer) => messages.push(JSON.parse(data.toString())));

    try {
      const orderRes = await app.inject({
        method: "POST", url: "/api/orders",
        payload: { clientRef: "order-ws", type: "parcel" },
        headers: auth(admin.token),
      });
      const orderId = orderRes.json().order.id;

      messages.length = 0;

      await app.inject({
        method: "POST", url: `/api/orders/${orderId}/items`,
        payload: { items: [{ productId: dalId, qty: 1 }] },
        headers: auth(admin.token),
      });

      await new Promise((r) => setTimeout(r, 50));
      expect(messages).toEqual([{ event: "order.updated", data: { order: expect.objectContaining({ id: orderId }) } }]);
    } finally {
      ws.terminate();
    }
  });
});

describe("orders: order cancel", () => {
  it("blocks cancel if sent items exist, allows after cancelling them", async () => {
    app = freshApp();
    const admin = await setupAdmin(app);
    const { dalId } = await fixtures(app, admin.token);

    const orderRes = await app.inject({
      method: "POST", url: "/api/orders",
      payload: { clientRef: "order-cancel-2", type: "parcel" },
      headers: auth(admin.token),
    });
    const orderId = orderRes.json().order.id;

    const punchRes = await app.inject({
      method: "POST", url: `/api/orders/${orderId}/items`,
      payload: { items: [{ productId: dalId, qty: 1 }] },
      headers: auth(admin.token),
    });
    const itemId = punchRes.json().order.items[0].id;

    app.db.prepare("UPDATE order_items SET status = 'sent' WHERE id = ?").run(itemId);

    const blockedCancel = await app.inject({
      method: "POST", url: `/api/orders/${orderId}/cancel`,
      headers: auth(admin.token),
    });
    expect(blockedCancel.statusCode).toBe(409);
    expect(blockedCancel.json().error).toBe("cancel sent items first");

    await app.inject({
      method: "POST", url: `/api/order-items/${itemId}/cancel`,
      payload: { reason: "Mistake" },
      headers: auth(admin.token),
    });

    const allowedCancel = await app.inject({
      method: "POST", url: `/api/orders/${orderId}/cancel`,
      headers: auth(admin.token),
    });
    expect(allowedCancel.statusCode).toBe(200);
    expect(allowedCancel.json().order.status).toBe("cancelled");
    expect(allowedCancel.json().order.closedAt).toBeGreaterThan(0);
  });

  it("409s if order is not open", async () => {
    app = freshApp();
    const admin = await setupAdmin(app);

    const orderRes = await app.inject({
      method: "POST", url: "/api/orders",
      payload: { clientRef: "order-not-open", type: "parcel" },
      headers: auth(admin.token),
    });
    const orderId = orderRes.json().order.id;

    app.db.prepare("UPDATE orders SET status = 'billed' WHERE id = ?").run(orderId);

    const res = await app.inject({
      method: "POST", url: `/api/orders/${orderId}/cancel`,
      headers: auth(admin.token),
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("order is not open");
  });
});
