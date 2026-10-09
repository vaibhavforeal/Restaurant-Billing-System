import { afterEach, describe, expect, it } from "vitest";
import { uuidv7 } from "@forkflow/domain";
import { auth, createUser, enableIntegration, freshApp, setupAdmin } from "./test-helpers.js";

let app: ReturnType<typeof freshApp>;
afterEach(async () => { await app?.close(); });

async function setup(opts: { zomato?: boolean } = {}) {
  app = freshApp();
  const admin = await setupAdmin(app);
  if (opts.zomato !== false) enableIntegration(app, "zomato");
  return admin;
}
const createOrder = (token: string, zomatoOrderId: string, clientRef = uuidv7()) =>
  app.inject({ method: "POST", url: "/api/orders", headers: auth(token), payload: { clientRef, type: "zomato", zomatoOrderId } });

async function product(token: string, payload: Record<string, unknown>) {
  const category = (await app.inject({ method: "POST", url: "/api/categories", headers: auth(token), payload: { name: "Mains" } })).json().category;
  const res = await app.inject({ method: "POST", url: "/api/products", headers: auth(token), payload: { categoryId: category.id, gstRate: 5, ...payload } });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().product as { id: string; variants: Array<{ id: string; name: string }> };
}
async function addItem(token: string, orderId: string, productId: string, variantId: string | null = null) {
  const res = await app.inject({ method: "POST", url: `/api/orders/${orderId}/items`, headers: auth(token), payload: { items: [{ productId, variantId, qty: 1 }] } });
  expect(res.statusCode, res.body).toBe(200);
  return res.json().order as { items: Array<{ pricePaise: number }> };
}

describe("creating Zomato orders", () => {
  it("lets an admin create a Zomato order with the zomato price tier and no status", async () => {
    const admin = await setup();
    const res = await createOrder(admin.token, "5821");
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().order).toMatchObject({
      type: "zomato", priceTier: "zomato", zomatoOrderId: "5821", zomatoStatus: null,
      tableId: null, splitLabel: null, status: "open",
    });
  });

  it("lets a cashier create one and gives other orders null Zomato fields", async () => {
    const admin = await setup();
    const cashier = await createUser(app, admin.token, { name: "Cash", pin: "2222", role: "cashier" });
    expect((await createOrder(cashier.token, "A-1")).statusCode).toBe(201);
    const parcel = await app.inject({ method: "POST", url: "/api/orders", headers: auth(admin.token), payload: { clientRef: uuidv7(), type: "parcel" } });
    expect(parcel.json().order).toMatchObject({ type: "parcel", priceTier: "takeaway", zomatoOrderId: null, zomatoStatus: null });
  });

  it("refuses a duplicate Zomato order ID with zomato_duplicate and the existing status", async () => {
    const admin = await setup();
    expect((await createOrder(admin.token, "5821")).statusCode).toBe(201);
    const dup = await createOrder(admin.token, "5821");
    expect(dup.statusCode).toBe(409);
    expect(dup.json().code).toBe("zomato_duplicate");
    expect(dup.json().error).toContain("5821");
    expect(dup.json().error).toContain("new");
    app.db.prepare("UPDATE orders SET zomato_status = 'ready' WHERE zomato_order_id = '5821'").run();
    expect((await createOrder(admin.token, "5821")).json().error).toContain("ready");
    expect(app.db.prepare("SELECT COUNT(*) n FROM orders WHERE type = 'zomato'").get()).toEqual({ n: 1 });
  });

  it("treats a repeated clientRef as the same order", async () => {
    const admin = await setup();
    const clientRef = uuidv7();
    const first = await createOrder(admin.token, "5821", clientRef);
    const again = await createOrder(admin.token, "5821", clientRef);
    expect(again.statusCode).toBe(200);
    expect(again.json().order.id).toBe(first.json().order.id);
  });

  it("refuses new Zomato orders while the integration is off", async () => {
    const admin = await setup({ zomato: false });
    const res = await createOrder(admin.token, "5821");
    expect(res.statusCode).toBe(409);
    expect(app.db.prepare("SELECT COUNT(*) n FROM orders").get()).toEqual({ n: 0 });
  });

  it("keeps Zomato order creation away from waiters and kitchen staff", async () => {
    const admin = await setup();
    const waiter = await createUser(app, admin.token, { name: "Wai", pin: "3333", role: "waiter" });
    const kitchen = await createUser(app, admin.token, { name: "Kit", pin: "4444", role: "kitchen" });
    expect((await createOrder(waiter.token, "5821")).statusCode).toBe(403);
    expect((await createOrder(kitchen.token, "5822")).statusCode).toBe(403);
    expect(app.db.prepare("SELECT COUNT(*) n FROM orders").get()).toEqual({ n: 0 });
  });

  it("maps a unique-index violation (concurrent writer) to the same zomato_duplicate error", async () => {
    const admin = await setup();
    expect((await createOrder(admin.token, "5821")).statusCode).toBe(201);
    // Make the pre-check miss once, so only the unique index can catch the duplicate.
    const realPrepare = app.db.prepare.bind(app.db);
    let hidden = false;
    (app.db as unknown as { prepare: unknown }).prepare = (sql: string) => {
      if (!hidden && sql.includes("FROM orders WHERE zomato_order_id")) {
        hidden = true;
        return { get: () => undefined };
      }
      return realPrepare(sql);
    };
    const res = await createOrder(admin.token, "5821");
    expect(hidden).toBe(true);
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("zomato_duplicate");
  });
});

describe("Zomato prices on order items", () => {
  it("uses the Zomato price when set, even over the Takeaway price", async () => {
    const admin = await setup();
    const dal = await product(admin.token, { name: "Dal", pricePaise: 20000, takeawayPricePaise: 26000, zomatoPricePaise: 29000 });
    const order = (await createOrder(admin.token, "5821")).json().order;
    expect((await addItem(admin.token, order.id, dal.id)).items[0]!.pricePaise).toBe(29000);
  });

  it("falls back to the Takeaway price, then the base price, and honours a zero Zomato price", async () => {
    const admin = await setup();
    const a = await product(admin.token, { name: "A", pricePaise: 20000, takeawayPricePaise: 26000 });
    const b = await product(admin.token, { name: "B", pricePaise: 20000 });
    const c = await product(admin.token, { name: "C", pricePaise: 20000, takeawayPricePaise: 26000, zomatoPricePaise: 0 });
    const order = (await createOrder(admin.token, "5821")).json().order;
    await addItem(admin.token, order.id, a.id);
    await addItem(admin.token, order.id, b.id);
    const result = await addItem(admin.token, order.id, c.id);
    expect(result.items.map((i) => i.pricePaise).sort((x, y) => x - y)).toEqual([0, 20000, 26000]);
  });

  it("prices a variant by its own Zomato price, else its own Takeaway price", async () => {
    const admin = await setup();
    const p = await product(admin.token, {
      name: "Biryani", pricePaise: 20000, zomatoPricePaise: 29000,
      variants: [{ name: "Half", pricePaise: 15000, takeawayPricePaise: 17000 }, { name: "Full", pricePaise: 30000, takeawayPricePaise: 32000, zomatoPricePaise: 35000 }],
    });
    const half = p.variants.find((v) => v.name === "Half")!.id;
    const full = p.variants.find((v) => v.name === "Full")!.id;
    const order = (await createOrder(admin.token, "5821")).json().order;
    await addItem(admin.token, order.id, p.id, half);
    const result = await addItem(admin.token, order.id, p.id, full);
    expect(result.items.map((i) => i.pricePaise).sort((x, y) => x - y)).toEqual([17000, 35000]);
  });
});

describe("Zomato price on the catalog", () => {
  it("exposes zomatoPricePaise on products and variants, and PATCH null clears it", async () => {
    const admin = await setup();
    const p = await product(admin.token, { name: "Dal", pricePaise: 20000, zomatoPricePaise: 29000, variants: [{ name: "Half", pricePaise: 15000, zomatoPricePaise: 17500 }] });
    const list = (await app.inject({ method: "GET", url: "/api/products", headers: auth(admin.token) })).json().products[0];
    expect(list.zomatoPricePaise).toBe(29000);
    expect(list.variants[0].zomatoPricePaise).toBe(17500);
    const renamed = await app.inject({ method: "PATCH", url: `/api/products/${p.id}`, headers: auth(admin.token), payload: { name: "Dal Tadka" } });
    expect(renamed.json().product.zomatoPricePaise).toBe(29000);
    const cleared = await app.inject({ method: "PATCH", url: `/api/products/${p.id}`, headers: auth(admin.token), payload: { zomatoPricePaise: null } });
    expect(cleared.json().product.zomatoPricePaise).toBeNull();
    const v = await app.inject({ method: "PATCH", url: `/api/variants/${list.variants[0].id}`, headers: auth(admin.token), payload: { zomatoPricePaise: null } });
    expect(v.json().variant.zomatoPricePaise).toBeNull();
    const created = await app.inject({ method: "POST", url: `/api/products/${p.id}/variants`, headers: auth(admin.token), payload: { name: "Full", pricePaise: 30000, zomatoPricePaise: 35000 } });
    expect(created.json().variant.zomatoPricePaise).toBe(35000);
  });
});
