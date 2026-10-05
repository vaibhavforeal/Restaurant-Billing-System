import { afterEach, describe, expect, it, vi } from "vitest";
import { auth, createUser, freshApp, setupAdmin, wsAuth } from "./test-helpers.js";
import { uuidv7 } from "@forkflow/domain";

let app: ReturnType<typeof freshApp>;
afterEach(async () => {
  vi.restoreAllMocks();
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

async function sentTableKot(app: ReturnType<typeof freshApp>, adminToken: string) {
  const { biryaniId } = await fixtures(app, adminToken);
  const tableRes = await app.inject({
    method: "POST", url: "/api/tables", headers: auth(adminToken), payload: { name: "T-Accept" },
  });
  const orderRes = await app.inject({
    method: "POST", url: "/api/orders", headers: auth(adminToken),
    payload: { clientRef: uuidv7(), type: "dine_in", tableId: tableRes.json().table.id },
  });
  const orderId = orderRes.json().order.id;
  await app.inject({
    method: "POST", url: `/api/orders/${orderId}/items`, headers: auth(adminToken),
    payload: { items: [{ productId: biryaniId, qty: 2, note: "Mild" }] },
  });
  const sendRes = await app.inject({ method: "POST", url: `/api/orders/${orderId}/send`, headers: auth(adminToken) });
  expect(sendRes.statusCode).toBe(200);
  expect(sendRes.json().kots[0]).toMatchObject({ acceptedAt: null, doneAt: null });
  return { orderId, kotId: sendRes.json().kots[0].id as string };
}

describe("kots: print faults", () => {
  it("sends the ticket and reports the problem when its KOT slip cannot be queued", async () => {
    app = freshApp();
    const { token } = await setupAdmin(app);
    const { biryaniId, kitchenStationId } = await fixtures(app, token);
    const printer = await app.inject({ method: "POST", url: "/api/printers", headers: auth(token), payload: { name: "Kitchen", kind: "network", connection: "127.0.0.1:9100", paperWidth: 58 } });
    const printerId = printer.json().printer.id as string;
    await app.inject({ method: "PATCH", url: `/api/kot-stations/${kitchenStationId}`, headers: auth(token), payload: { printerId } });
    app.db.prepare("UPDATE printers SET kot_profile = 'not json' WHERE id = ?").run(printerId);
    const order = await app.inject({ method: "POST", url: "/api/orders", headers: auth(token), payload: { clientRef: uuidv7(), type: "parcel", tableId: null } });
    const orderId = order.json().order.id;
    await app.inject({ method: "POST", url: `/api/orders/${orderId}/items`, headers: auth(token), payload: { items: [{ productId: biryaniId, qty: 1 }] } });
    const sent = await app.inject({ method: "POST", url: `/api/orders/${orderId}/send`, headers: auth(token) });
    expect(sent.statusCode).toBe(200);
    expect(sent.json().kots).toHaveLength(1);
    expect(sent.json().printErrors).toHaveLength(1);
    expect(app.db.prepare("SELECT COUNT(*) AS n FROM kots").get()).toEqual({ n: 1 });
    expect(app.db.prepare("SELECT COUNT(*) AS n FROM print_jobs").get()).toEqual({ n: 0 });
  });
});

describe("kots: kitchen acceptance", () => {
  it("persists acceptance, exposes it on the board and order, and preserves it through replay and done", async () => {
    app = freshApp();
    const admin = await setupAdmin(app);
    const { orderId, kotId } = await sentTableKot(app, admin.token);
    const acceptedAt = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(acceptedAt);
    const accept = () => app.inject({ method: "POST", url: `/api/kots/${kotId}/accept`, headers: auth(admin.token) });

    const first = await accept();
    expect(first.statusCode).toBe(200);
    expect(first.json().kot).toMatchObject({ id: kotId, acceptedAt, doneAt: null });
    expect(app.db.prepare("SELECT accepted_at, done_at FROM kots WHERE id = ?").get(kotId)).toEqual({ accepted_at: acceptedAt, done_at: null });
    const board = await app.inject({ method: "GET", url: "/api/kots", headers: auth(admin.token) });
    expect(board.json().kots[0]).toMatchObject({ acceptedAt, doneAt: null });
    const order = await app.inject({ method: "GET", url: `/api/orders/${orderId}`, headers: auth(admin.token) });
    expect(order.json().order.kots[0]).toMatchObject({ acceptedAt, doneAt: null });

    clock.mockReturnValue(acceptedAt + 100);
    expect((await accept()).json().kot.acceptedAt).toBe(acceptedAt);
    const done = await app.inject({ method: "POST", url: `/api/kots/${kotId}/done`, headers: auth(admin.token) });
    expect(done.json().kot).toMatchObject({ acceptedAt, doneAt: acceptedAt + 100 });
    expect((await accept()).json().kot).toMatchObject({ acceptedAt, doneAt: acceptedAt + 100 });
  });

  it("broadcasts one contextual kot.updated when a ticket is accepted", async () => {
    app = freshApp();
    const admin = await setupAdmin(app);
    const { orderId, kotId } = await sentTableKot(app, admin.token);
    const broadcast = vi.spyOn(app, "broadcast");
    const accept = () => app.inject({ method: "POST", url: `/api/kots/${kotId}/accept`, headers: auth(admin.token) });
    const result = await accept();
    expect(result.statusCode).toBe(200);
    expect(broadcast).toHaveBeenCalledExactlyOnceWith("kot.updated", {
      kot: expect.objectContaining({
        id: kotId, orderId, acceptedAt: result.json().kot.acceptedAt, doneAt: null,
        orderType: "dine_in", tableName: "T-Accept", splitLabel: "A",
        items: [expect.objectContaining({ name: "Biryani", qty: 2, note: "Mild", status: "sent" })],
      }),
    });
    await accept();
    expect(broadcast).toHaveBeenCalledTimes(1);
  });

  it("requires kots.update for acceptance, permits kitchen and cashier, and rejects unknown tickets", async () => {
    app = freshApp();
    const admin = await setupAdmin(app);
    const waiter = await createUser(app, admin.token, { name: "Wren", pin: "5678", role: "waiter" });
    const kitchen = await createUser(app, admin.token, { name: "Chef", pin: "4321", role: "kitchen" });
    const cashier = await createUser(app, admin.token, { name: "Cashier", pin: "9876", role: "cashier" });
    const { kotId } = await sentTableKot(app, admin.token);
    const accept = (token?: string) => app.inject({ method: "POST", url: `/api/kots/${kotId}/accept`, headers: token ? auth(token) : {} });
    expect((await accept()).statusCode).toBe(401);
    expect((await accept(waiter.token)).statusCode).toBe(403);
    expect(app.db.prepare("SELECT accepted_at FROM kots WHERE id = ?").get(kotId)).toEqual({ accepted_at: null });
    expect((await accept(kitchen.token)).statusCode).toBe(200);
    app.db.prepare("UPDATE kots SET accepted_at = NULL WHERE id = ?").run(kotId);
    expect((await accept(cashier.token)).statusCode).toBe(200);
    const missing = await app.inject({ method: "POST", url: "/api/kots/nope/accept", headers: auth(admin.token) });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error).toBe("kot not found");
  });
});

describe("kots: send-to-kitchen", () => {
  it("replays the same request after later punches without sending the later round", async () => {
    app = freshApp(); const admin = await setupAdmin(app);
    const { biryaniId } = await fixtures(app, admin.token);
    const created = await app.inject({ method: "POST", url: "/api/orders", headers: auth(admin.token), payload: { clientRef: uuidv7(), type: "parcel" } });
    const orderId = created.json().order.id;
    const punch = () => app.inject({ method: "POST", url: `/api/orders/${orderId}/items`, headers: auth(admin.token), payload: { items: [{ clientRef: uuidv7(), productId: biryaniId, qty: 1 }] } });
    await punch();
    const item = (app.db.prepare("SELECT id FROM order_items WHERE order_id = ?").get(orderId) as { id: string }).id;
    const payload = { clientRef: uuidv7(), itemIds: [item] };
    const send = (body = payload) => app.inject({ method: "POST", url: `/api/orders/${orderId}/send`, headers: auth(admin.token), payload: body });
    const first = await send(); expect(first.statusCode).toBe(200);
    await punch(); const replay = await send(); expect(replay.statusCode).toBe(200);
    expect(replay.json().kots.map((k: { id: string }) => k.id)).toEqual(first.json().kots.map((k: { id: string }) => k.id));
    expect(app.db.prepare("SELECT COUNT(*) AS n FROM kots").get()).toEqual({ n: 1 });
    expect(app.db.prepare("SELECT COUNT(*) AS n FROM order_items WHERE status = 'pending'").get()).toEqual({ n: 1 });
    expect((await send({ ...payload, itemIds: [uuidv7()] })).statusCode).toBe(409);
    expect((await send({ clientRef: uuidv7(), itemIds: [item] })).statusCode).toBe(409);
  });
  it("groups items by station and assigns per-day KOT numbers", async () => {
    app = freshApp();
    const admin = await setupAdmin(app);
    const { biryaniId, biryaniHalfVariantId, kebabId, kitchenStationId, grillStationId } = await fixtures(app, admin.token);

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
    // Verify station assignments (order-independent)
    const stationIds = new Set(kots.map((k: { stationId: string }) => k.stationId));
    expect(stationIds).toContain(kitchenStationId);
    expect(stationIds).toContain(grillStationId);

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
    const ws = await wsAuth(app, admin.token);
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

    await app.ready();
    const ws = await wsAuth(app, admin.token);
    const messages: unknown[] = [];
    ws.on("message", (data: Buffer) => messages.push(JSON.parse(data.toString())));

    try {
      messages.length = 0;

      const doneRes = await app.inject({
        method: "POST", url: `/api/kots/${kotId}/done`,
        headers: auth(admin.token),
      });
      expect(doneRes.statusCode).toBe(200);
      expect(doneRes.json().kot.doneAt).toBeGreaterThan(0);
      expect(doneRes.json().kot.acceptedAt).toBe(doneRes.json().kot.doneAt);

      await new Promise((r) => setTimeout(r, 50));

      const kotUpdated = messages.filter(
        (m): m is { event: string; data: { kot: { id: string; doneAt: number } } } =>
          (m as { event?: string }).event === "kot.updated",
      );
      expect(kotUpdated).toHaveLength(1);
      expect(kotUpdated[0]!.data.kot.id).toBe(kotId);
      expect(kotUpdated[0]!.data.kot.doneAt).toBeGreaterThan(0);

      const done2Res = await app.inject({
        method: "POST", url: `/api/kots/${kotId}/done`,
        headers: auth(admin.token),
      });
      expect(done2Res.statusCode).toBe(200);
      expect(done2Res.json().kot.doneAt).toBe(doneRes.json().kot.doneAt);
      expect(done2Res.json().kot.acceptedAt).toBe(doneRes.json().kot.acceptedAt);
      await new Promise((r) => setTimeout(r, 50));
      expect(messages.filter((m) => (m as { event?: string }).event === "kot.updated")).toHaveLength(1);
    } finally {
      ws.terminate();
    }
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

    const kitchenSendAttempt = await app.inject({
      method: "POST", url: `/api/orders/${orderId}/send`,
      headers: auth(kitchen.token),
    });
    expect(kitchenSendAttempt.statusCode).toBe(403);

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

  it("KOT board payload includes splitLabel from order", async () => {
    app = freshApp();
    const admin = await setupAdmin(app);
    const { biryaniId } = await fixtures(app, admin.token);

    const tableRes = await app.inject({
      method: "POST", url: "/api/tables",
      payload: { name: "T1" },
      headers: auth(admin.token),
    });
    const tableId = tableRes.json().table.id;

    const orderRes = await app.inject({
      method: "POST", url: "/api/orders",
      payload: { clientRef: "order-for-kot", type: "dine_in", tableId },
      headers: auth(admin.token),
    });
    const orderId = orderRes.json().order.id;

    await app.inject({
      method: "POST", url: `/api/orders/${orderId}/items`,
      payload: { items: [{ productId: biryaniId, qty: 1 }] },
      headers: auth(admin.token),
    });

    await app.inject({
      method: "POST", url: `/api/orders/${orderId}/send`,
      headers: auth(admin.token),
    });

    const boardRes = await app.inject({
      method: "GET", url: "/api/kots",
      headers: auth(admin.token),
    });
    expect(boardRes.statusCode).toBe(200);
    const kots = boardRes.json().kots;
    expect(kots[0]!.splitLabel).toBe("A");
  });

  it("send response KOT context includes splitLabel", async () => {
    app = freshApp();
    const admin = await setupAdmin(app);
    const { biryaniId } = await fixtures(app, admin.token);

    const tableRes = await app.inject({
      method: "POST", url: "/api/tables",
      payload: { name: "T2" },
      headers: auth(admin.token),
    });
    const tableId = tableRes.json().table.id;

    const orderRes = await app.inject({
      method: "POST", url: "/api/orders",
      payload: { clientRef: "order-send-split", type: "dine_in", tableId },
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
    expect(sendRes.statusCode).toBe(200);
    const { kots } = sendRes.json();
    expect(kots[0]!.splitLabel).toBe("A");
  });
});
