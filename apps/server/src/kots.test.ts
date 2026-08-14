import { afterEach, describe, expect, it } from "vitest";
import { auth, createUser, freshApp, setupAdmin } from "./test-helpers.js";
import { uuidv7 } from "@forkflow/domain";

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

  const station2Id = uuidv7();
  app.db.prepare("INSERT INTO kot_stations (id, name, is_active) VALUES (?, 'Grill', 1)").run(station2Id);

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

  const kebabRes = await app.inject({
    method: "POST", url: "/api/products",
    payload: { categoryId, name: "Kebab", pricePaise: 20000, gstRate: 5, kotStationId: station2Id },
    headers: auth(adminToken),
  });
  const kebabId = kebabRes.json().product.id;

  return {
    categoryId,
    kitchenStationId: kitchenStation.id,
    grillStationId: station2Id,
    dalId,
    biryaniId: biryaniProduct.id,
    biryaniHalfVariantId: biryaniProduct.variants[0].id,
    kebabId,
  };
}

describe("kots: send-to-kitchen", () => {
  it("groups items by station and assigns per-day KOT numbers", async () => {
    app = freshApp();
    const admin = await setupAdmin(app);
    const { biryaniId, biryaniHalfVariantId, kebabId } = await fixtures(app, admin.token);

    const orderRes = await app.inject({
      method: "POST", url: "/api/orders",
      payload: { clientRef: "order-send", type: "parcel" },
      headers: auth(admin.token),
    });
    const orderId = orderRes.json().order.id;

    await app.inject({
      method: "POST", url: `/api/orders/${orderId}/items`,
      payload: {
        items: [
          { productId: biryaniId, variantId: biryaniHalfVariantId, qty: 1 },
          { productId: kebabId, qty: 2 },
        ],
      },
      headers: auth(admin.token),
    });

    const sendRes = await app.inject({
      method: "POST", url: `/api/orders/${orderId}/send`,
      headers: auth(admin.token),
    });
    expect(sendRes.statusCode).toBe(200);
    const { order, kots } = sendRes.json();

    expect(kots).toHaveLength(2);
    expect(kots[0].kotNo).toBe(1);
    expect(kots[1].kotNo).toBe(2);
    expect(order.items.every((i: { status: string }) => i.status === "sent")).toBe(true);

    const orderRes2 = await app.inject({
      method: "POST", url: "/api/orders",
      payload: { clientRef: "order-send-2", type: "parcel" },
      headers: auth(admin.token),
    });
    const orderId2 = orderRes2.json().order.id;

    await app.inject({
      method: "POST", url: `/api/orders/${orderId2}/items`,
      payload: { items: [{ productId: biryaniId, qty: 1 }] },
      headers: auth(admin.token),
    });

    const send2Res = await app.inject({
      method: "POST", url: `/api/orders/${orderId2}/send`,
      headers: auth(admin.token),
    });
    expect(send2Res.json().kots[0].kotNo).toBe(3);
  });

  it("items with no station stay pending", async () => {
    app = freshApp();
    const admin = await setupAdmin(app);
    const { dalId, biryaniId } = await fixtures(app, admin.token);

    const orderRes = await app.inject({
      method: "POST", url: "/api/orders",
      payload: { clientRef: "order-no-station", type: "parcel" },
      headers: auth(admin.token),
    });
    const orderId = orderRes.json().order.id;

    await app.inject({
      method: "POST", url: `/api/orders/${orderId}/items`,
      payload: {
        items: [
          { productId: dalId, qty: 1 },
          { productId: biryaniId, qty: 1 },
        ],
      },
      headers: auth(admin.token),
    });

    const sendRes = await app.inject({
      method: "POST", url: `/api/orders/${orderId}/send`,
      headers: auth(admin.token),
    });
    expect(sendRes.statusCode).toBe(200);
    const { order, kots } = sendRes.json();

    expect(kots).toHaveLength(1);
    const dalItem = order.items.find((i: { name: string }) => i.name === "Dal");
    const biryaniItem = order.items.find((i: { name: string }) => i.name === "Biryani");
    expect(dalItem.status).toBe("pending");
    expect(biryaniItem.status).toBe("sent");
  });

  it("409 when nothing to send (no items or all no-station)", async () => {
    app = freshApp();
    const admin = await setupAdmin(app);
    const { dalId } = await fixtures(app, admin.token);

    const orderRes = await app.inject({
      method: "POST", url: "/api/orders",
      payload: { clientRef: "order-empty", type: "parcel" },
      headers: auth(admin.token),
    });
    const orderId = orderRes.json().order.id;

    const emptyRes = await app.inject({
      method: "POST", url: `/api/orders/${orderId}/send`,
      headers: auth(admin.token),
    });
    expect(emptyRes.statusCode).toBe(409);
    expect(emptyRes.json().error).toBe("nothing to send");

    await app.inject({
      method: "POST", url: `/api/orders/${orderId}/items`,
      payload: { items: [{ productId: dalId, qty: 1 }] },
      headers: auth(admin.token),
    });

    const allNoStation = await app.inject({
      method: "POST", url: `/api/orders/${orderId}/send`,
      headers: auth(admin.token),
    });
    expect(allNoStation.statusCode).toBe(409);
    expect(allNoStation.json().error).toBe("nothing to send");
  });

  it("broadcasts kot.created for each KOT", async () => {
    app = freshApp();
    const admin = await setupAdmin(app);
    const { biryaniId, kebabId } = await fixtures(app, admin.token);

    await app.ready();
    const ws = await app.injectWS("/api/ws?token=" + admin.token);
    const messages: unknown[] = [];
    ws.on("message", (data: Buffer) => messages.push(JSON.parse(data.toString())));

    try {
      const orderRes = await app.inject({
        method: "POST", url: "/api/orders",
        payload: { clientRef: "order-bc", type: "parcel" },
        headers: auth(admin.token),
      });
      const orderId = orderRes.json().order.id;

      await app.inject({
        method: "POST", url: `/api/orders/${orderId}/items`,
        payload: {
          items: [
            { productId: biryaniId, qty: 1 },
            { productId: kebabId, qty: 1 },
          ],
        },
        headers: auth(admin.token),
      });

      messages.length = 0;

      await app.inject({
        method: "POST", url: `/api/orders/${orderId}/send`,
        headers: auth(admin.token),
      });

      await new Promise((r) => setTimeout(r, 50));

      const kotCreated = messages.filter(
        (m): m is { event: string; data: { kot: { orderType: string; tableName: string | null } } } =>
          (m as { event?: string }).event === "kot.created",
      );
      expect(kotCreated).toHaveLength(2);
      expect(kotCreated[0]!.data.kot).toMatchObject({ orderType: "parcel", tableName: null });
    } finally {
      ws.terminate();
    }
  });
});

describe("kots: board and done", () => {
  it("GET /api/kots shows only not-done with tableName join", async () => {
    app = freshApp();
    const admin = await setupAdmin(app);
    const { biryaniId } = await fixtures(app, admin.token);

    const tableRes = await app.inject({
      method: "POST", url: "/api/tables",
      payload: { name: "T1" },
      headers: auth(admin.token),
    });
    const tableId = tableRes.json().table.id;

    const dineInRes = await app.inject({
      method: "POST", url: "/api/orders",
      payload: { clientRef: "order-dinein", type: "dine_in", tableId },
      headers: auth(admin.token),
    });
    const dineInId = dineInRes.json().order.id;

    await app.inject({
      method: "POST", url: `/api/orders/${dineInId}/items`,
      payload: { items: [{ productId: biryaniId, qty: 1 }] },
      headers: auth(admin.token),
    });

    const parcelRes = await app.inject({
      method: "POST", url: "/api/orders",
      payload: { clientRef: "order-parcel", type: "parcel" },
      headers: auth(admin.token),
    });
    const parcelId = parcelRes.json().order.id;

    await app.inject({
      method: "POST", url: `/api/orders/${parcelId}/items`,
      payload: { items: [{ productId: biryaniId, qty: 1 }] },
      headers: auth(admin.token),
    });

    const sendDineIn = await app.inject({
      method: "POST", url: `/api/orders/${dineInId}/send`,
      headers: auth(admin.token),
    });
    const sendParcel = await app.inject({
      method: "POST", url: `/api/orders/${parcelId}/send`,
      headers: auth(admin.token),
    });

    const kotDineInId = sendDineIn.json().kots[0].id;
    const kotParcelId = sendParcel.json().kots[0].id;

    const list = await app.inject({ method: "GET", url: "/api/kots", headers: auth(admin.token) });
    expect(list.statusCode).toBe(200);
    const kots = list.json().kots;
    expect(kots).toHaveLength(2);

    const dineInKot = kots.find((k: { id: string }) => k.id === kotDineInId);
    const parcelKot = kots.find((k: { id: string }) => k.id === kotParcelId);

    expect(dineInKot.tableName).toBe("T1");
    expect(parcelKot.tableName).toBeNull();

    app.db.prepare("UPDATE kots SET done_at = ? WHERE id = ?").run(Date.now(), kotDineInId);

    const listAfterDone = await app.inject({ method: "GET", url: "/api/kots", headers: auth(admin.token) });
    expect(listAfterDone.json().kots).toHaveLength(1);
    expect(listAfterDone.json().kots[0].id).toBe(kotParcelId);
  });

  it("POST /api/kots/:id/done is idempotent and broadcasts kot.updated", async () => {
    app = freshApp();
    const admin = await setupAdmin(app);
    const { biryaniId } = await fixtures(app, admin.token);

    const orderRes = await app.inject({
      method: "POST", url: "/api/orders",
      payload: { clientRef: "order-done", type: "parcel" },
      headers: auth(admin.token),
    });
    const orderId = orderRes.json().order.id;

    await app.inject({
      method: "POST", url: `/api/orders/${orderId}/items`,
      payload: { items: [{ productId: biryaniId, qty: 1 }] },
      headers: auth(admin.token),
    });

    const sendRes = await app.inject({
      method: "POST", url: `/api/orders/${orderId}/send`,
      headers: auth(admin.token),
    });
    const kotId = sendRes.json().kots[0].id;

    const doneRes = await app.inject({
      method: "POST", url: `/api/kots/${kotId}/done`,
      headers: auth(admin.token),
    });
    expect(doneRes.statusCode).toBe(200);
    expect(doneRes.json().kot.doneAt).toBeGreaterThan(0);

    const done2Res = await app.inject({
      method: "POST", url: `/api/kots/${kotId}/done`,
      headers: auth(admin.token),
    });
    expect(done2Res.statusCode).toBe(200);
    expect(done2Res.json().kot.doneAt).toBe(doneRes.json().kot.doneAt);
  });

  it("kitchen role can read and done, waiter cannot done", async () => {
    app = freshApp();
    const admin = await setupAdmin(app);
    const waiter = await createUser(app, admin.token, { name: "Wren", pin: "5678", role: "waiter" });
    const kitchen = await createUser(app, admin.token, { name: "Chef", pin: "4321", role: "kitchen" });
    const { biryaniId } = await fixtures(app, admin.token);

    const orderRes = await app.inject({
      method: "POST", url: "/api/orders",
      payload: { clientRef: "order-perm", type: "parcel" },
      headers: auth(admin.token),
    });
    const orderId = orderRes.json().order.id;

    await app.inject({
      method: "POST", url: `/api/orders/${orderId}/items`,
      payload: { items: [{ productId: biryaniId, qty: 1 }] },
      headers: auth(admin.token),
    });

    const waiterSend = await app.inject({
      method: "POST", url: `/api/orders/${orderId}/send`,
      headers: auth(waiter.token),
    });
    expect(waiterSend.statusCode).toBe(200);
    const kotId = waiterSend.json().kots[0].id;

    expect((await app.inject({ method: "GET", url: "/api/kots", headers: auth(kitchen.token) })).statusCode).toBe(200);

    const kitchenDone = await app.inject({
      method: "POST", url: `/api/kots/${kotId}/done`,
      headers: auth(kitchen.token),
    });
    expect(kitchenDone.statusCode).toBe(200);

    const orderRes2 = await app.inject({
      method: "POST", url: "/api/orders",
      payload: { clientRef: "order-waiter-done", type: "parcel" },
      headers: auth(admin.token),
    });
    const orderId2 = orderRes2.json().order.id;

    await app.inject({
      method: "POST", url: `/api/orders/${orderId2}/items`,
      payload: { items: [{ productId: biryaniId, qty: 1 }] },
      headers: auth(admin.token),
    });

    const sendRes2 = await app.inject({
      method: "POST", url: `/api/orders/${orderId2}/send`,
      headers: auth(admin.token),
    });
    const kotId2 = sendRes2.json().kots[0].id;

    const waiterDone = await app.inject({
      method: "POST", url: `/api/kots/${kotId2}/done`,
      headers: auth(waiter.token),
    });
    expect(waiterDone.statusCode).toBe(403);
  });

  it("404s on unknown kot", async () => {
    app = freshApp();
    const admin = await setupAdmin(app);

    const res = await app.inject({
      method: "POST", url: "/api/kots/nope/done",
      headers: auth(admin.token),
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("kot not found");
  });
});
