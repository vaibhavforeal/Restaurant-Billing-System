import { afterEach, describe, expect, it, vi } from "vitest";
import { uuidv7 } from "@forkflow/domain";
import { auth, createUser, enableIntegration, freshApp, setupAdmin } from "./test-helpers.js";
import { nextZomatoStatus } from "./zomato-desk.js";

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

describe("nextZomatoStatus", () => {
  it("allows Ready from Preparing, or from new when nothing station-bound is pending", () => {
    expect(nextZomatoStatus("preparing", "ready", false, true)).toBe(true);
    expect(nextZomatoStatus(null, "ready", false, true)).toBe(true);
    expect(nextZomatoStatus("preparing", "ready", true, true)).toBe(false);
    expect(nextZomatoStatus(null, "ready", true, true)).toBe(false);
    expect(nextZomatoStatus(null, "ready", false, false)).toBe(false);
    expect(nextZomatoStatus("ready", "ready", false, true)).toBe(false);
    expect(nextZomatoStatus("picked_up", "ready", false, true)).toBe(false);
  });

  it("allows Picked up only from Ready with nothing station-bound pending", () => {
    expect(nextZomatoStatus("ready", "picked_up", false, true)).toBe(true);
    expect(nextZomatoStatus("ready", "picked_up", true, true)).toBe(false);
    expect(nextZomatoStatus("preparing", "picked_up", false, true)).toBe(false);
    expect(nextZomatoStatus(null, "picked_up", false, true)).toBe(false);
    expect(nextZomatoStatus("picked_up", "picked_up", false, true)).toBe(false);
  });
});

describe("Zomato status and Picked up", () => {
  async function kitchenStationId(token: string): Promise<string> {
    return (await app.inject({ method: "GET", url: "/api/kot-stations", headers: auth(token) })).json().stations[0].id;
  }
  /** A Zomato order with one item; `station` puts the item on the seeded Kitchen station (left pending). */
  async function zomatoOrder(token: string, opts: { station?: boolean; zomatoPricePaise?: number } = {}) {
    const kotStationId = opts.station ? await kitchenStationId(token) : null;
    const p = await product(token, { name: `Item ${uuidv7()}`, pricePaise: 20000, zomatoPricePaise: opts.zomatoPricePaise ?? 25000, kotStationId });
    const order = (await createOrder(token, `Z-${Math.floor(Math.random() * 1e9)}`)).json().order as { id: string; zomatoOrderId: string };
    await addItem(token, order.id, p.id);
    return order;
  }
  const setStatus = (token: string, orderId: string, status: string, clientRef = uuidv7()) =>
    app.inject({ method: "POST", url: `/api/orders/${orderId}/zomato-status`, headers: auth(token), payload: { status, clientRef } });
  const setDbStatus = (orderId: string, status: string | null) =>
    app.db.prepare("UPDATE orders SET zomato_status = ? WHERE id = ?").run(status, orderId);
  const count = (sql: string, ...args: unknown[]) => (app.db.prepare(sql).get(...args) as { n: number }).n;
  const markSent = (orderId: string) => app.db.prepare("UPDATE order_items SET status = 'sent' WHERE order_id = ?").run(orderId);

  it("moves Preparing to Ready when nothing is pending", async () => {
    const admin = await setup();
    const order = await zomatoOrder(admin.token, { station: true });
    markSent(order.id);
    setDbStatus(order.id, "preparing");
    const res = await setStatus(admin.token, order.id, "ready");
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().order).toMatchObject({ id: order.id, zomatoStatus: "ready", status: "open" });
    expect(res.json().bill).toBeUndefined();
  });

  it("answers a repeated Ready with the current order, unchanged and without a broadcast", async () => {
    const admin = await setup();
    const order = await zomatoOrder(admin.token, { station: true });
    markSent(order.id);
    setDbStatus(order.id, "preparing");
    const broadcast = vi.spyOn(app, "broadcast");
    const clientRef = uuidv7();
    const first = await setStatus(admin.token, order.id, "ready", clientRef);
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json().order.zomatoStatus).toBe("ready");
    expect(broadcast.mock.calls.filter(([event]) => event === "order.updated")).toHaveLength(1);
    for (const ref of [clientRef, uuidv7()]) {
      const again = await setStatus(admin.token, order.id, "ready", ref);
      expect(again.statusCode, again.body).toBe(200);
      expect(again.json().order).toEqual(first.json().order);
      expect(again.json().bill).toBeUndefined();
    }
    expect(broadcast.mock.calls.filter(([event]) => event === "order.updated")).toHaveLength(1);
    // A closed order is not "already ready": Ready after Picked up stays refused.
    expect((await setStatus(admin.token, order.id, "picked_up")).statusCode).toBe(200);
    const late = await setStatus(admin.token, order.id, "ready", clientRef);
    expect(late.statusCode).toBe(409);
    expect(late.json().code).toBe("zomato_status");
  });

  it("refuses Ready while a station item is still pending", async () => {
    const admin = await setup();
    const order = await zomatoOrder(admin.token, { station: true });
    setDbStatus(order.id, "preparing");
    const res = await setStatus(admin.token, order.id, "ready");
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("zomato_status");
    const fresh = await zomatoOrder(admin.token, { station: true });
    const fromNew = await setStatus(admin.token, fresh.id, "ready");
    expect(fromNew.statusCode).toBe(409);
    expect(fromNew.json().code).toBe("zomato_status");
  });

  it("moves a new order with only stationless items straight to Ready", async () => {
    const admin = await setup();
    const order = await zomatoOrder(admin.token);
    const res = await setStatus(admin.token, order.id, "ready");
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().order.zomatoStatus).toBe("ready");
  });

  it("refuses Ready on a new order with no items", async () => {
    const admin = await setup();
    const order = (await createOrder(admin.token, "5821")).json().order;
    const res = await setStatus(admin.token, order.id, "ready");
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("zomato_status");
  });

  it("refuses Picked up before Ready", async () => {
    const admin = await setup();
    const order = await zomatoOrder(admin.token);
    expect((await setStatus(admin.token, order.id, "picked_up")).json().code).toBe("zomato_status");
    setDbStatus(order.id, "preparing");
    const res = await setStatus(admin.token, order.id, "picked_up");
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("zomato_status");
    expect(count("SELECT COUNT(*) n FROM bills")).toBe(0);
  });

  for (const taxInclusive of [0, 1]) {
    it(`Picked up issues and settles one GST-free bill at the item value (tax_inclusive = ${taxInclusive})`, async () => {
      const admin = await setup();
      app.db.prepare("UPDATE settings SET tax_inclusive = ? WHERE id = 1").run(taxInclusive);
      const order = await zomatoOrder(admin.token, { station: true });
      markSent(order.id);
      setDbStatus(order.id, "ready");
      const res = await setStatus(admin.token, order.id, "picked_up");
      expect(res.statusCode, res.body).toBe(200);
      const { bill, order: closed } = res.json();
      expect(bill).toMatchObject({ orderId: order.id, status: "paid", subtotalPaise: 25000, discountPaise: 0, cgstPaise: 0, sgstPaise: 0, roundingPaise: 0, totalPaise: 25000 });
      expect(bill.taxes.every((t: { cgstPaise: number; sgstPaise: number }) => t.cgstPaise === 0 && t.sgstPaise === 0)).toBe(true);
      expect(bill.receipt).toMatchObject({ orderType: "zomato", zomatoOrderId: order.zomatoOrderId, gstPaidBy: "zomato" });
      expect(bill.payments).toEqual([expect.objectContaining({ mode: "zomato", amountPaise: 25000 })]);
      expect(closed).toMatchObject({ status: "settled", zomatoStatus: "picked_up" });
      expect(count("SELECT COUNT(*) n FROM bills")).toBe(1);
      expect(count("SELECT COUNT(*) n FROM payments")).toBe(1);
      expect(count("SELECT COUNT(*) n FROM print_jobs")).toBe(0);
      expect(count("SELECT COUNT(*) n FROM bill_report_lines WHERE cgst_paise != 0 OR sgst_paise != 0")).toBe(0);
    });
  }

  it("Picked up bills stationless items still pending and settles a zero-value order without a payment row", async () => {
    const admin = await setup();
    const order = await zomatoOrder(admin.token, { zomatoPricePaise: 0 });
    expect((await setStatus(admin.token, order.id, "ready")).statusCode).toBe(200);
    const res = await setStatus(admin.token, order.id, "picked_up");
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().bill).toMatchObject({ totalPaise: 0, status: "paid", payments: [] });
    expect(res.json().order).toMatchObject({ status: "settled", zomatoStatus: "picked_up" });
    expect(count("SELECT COUNT(*) n FROM order_items WHERE order_id = ? AND status = 'pending'", order.id)).toBe(0);
  });

  it("replays the same clientRef and refuses a second Picked up, leaving one bill and one payment", async () => {
    const admin = await setup();
    const cashier = await createUser(app, admin.token, { name: "Cash", pin: "2222", role: "cashier" });
    const order = await zomatoOrder(admin.token);
    setDbStatus(order.id, "ready");
    const clientRef = uuidv7();
    const first = await setStatus(cashier.token, order.id, "picked_up", clientRef);
    expect(first.statusCode, first.body).toBe(200);
    const again = await setStatus(cashier.token, order.id, "picked_up", clientRef);
    expect(again.statusCode, again.body).toBe(200);
    expect(again.json().bill.id).toBe(first.json().bill.id);
    const other = await setStatus(admin.token, order.id, "picked_up");
    expect(other.statusCode).toBe(409);
    expect(other.json().code).toBe("zomato_status");
    expect(count("SELECT COUNT(*) n FROM bills")).toBe(1);
    expect(count("SELECT COUNT(*) n FROM payments")).toBe(1);
    // A reference reused for another order is refused, not replayed.
    const second = await zomatoOrder(admin.token);
    setDbStatus(second.id, "ready");
    expect((await setStatus(admin.token, second.id, "picked_up", clientRef)).statusCode).toBe(409);
    expect(count("SELECT COUNT(*) n FROM bills")).toBe(1);
  });

  it("keeps Ready and Picked up working after Zomato is turned off in the Marketplace", async () => {
    const admin = await setup();
    const order = await zomatoOrder(admin.token);
    app.db.prepare("UPDATE integration_state SET enabled = 0 WHERE id = 'zomato'").run();
    expect((await setStatus(admin.token, order.id, "ready")).statusCode).toBe(200);
    const res = await setStatus(admin.token, order.id, "picked_up");
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().order).toMatchObject({ status: "settled", zomatoStatus: "picked_up" });
  });

  it("keeps the status route away from waiters and kitchen staff", async () => {
    const admin = await setup();
    const waiter = await createUser(app, admin.token, { name: "Wai", pin: "3333", role: "waiter" });
    const kitchen = await createUser(app, admin.token, { name: "Kit", pin: "4444", role: "kitchen" });
    const order = await zomatoOrder(admin.token);
    expect((await setStatus(waiter.token, order.id, "ready")).statusCode).toBe(403);
    expect((await setStatus(kitchen.token, order.id, "ready")).statusCode).toBe(403);
    setDbStatus(order.id, "ready");
    expect((await setStatus(waiter.token, order.id, "picked_up")).statusCode).toBe(403);
    expect(count("SELECT COUNT(*) n FROM bills")).toBe(0);
  });

  it("refuses the status route on a non-Zomato or unknown order", async () => {
    const admin = await setup();
    const parcel = (await app.inject({ method: "POST", url: "/api/orders", headers: auth(admin.token), payload: { clientRef: uuidv7(), type: "parcel" } })).json().order;
    expect((await setStatus(admin.token, parcel.id, "ready")).statusCode).toBe(409);
    expect((await setStatus(admin.token, uuidv7(), "ready")).statusCode).toBe(404);
  });
});

describe("billing guards on Zomato orders", () => {
  async function colaOrder(token: string) {
    const p = await product(token, { name: `Cola ${uuidv7()}`, pricePaise: 5000 });
    const order = (await createOrder(token, `Z-${Math.floor(Math.random() * 1e9)}`)).json().order as { id: string };
    await addItem(token, order.id, p.id);
    return order;
  }

  it("refuses bill preview and bill on a Zomato order with zomato_order", async () => {
    const admin = await setup();
    const order = await colaOrder(admin.token);
    const preview = await app.inject({ method: "POST", url: `/api/orders/${order.id}/bill-preview`, headers: auth(admin.token), payload: {} });
    expect(preview.statusCode).toBe(409);
    expect(preview.json().code).toBe("zomato_order");
    const bill = await app.inject({ method: "POST", url: `/api/orders/${order.id}/bill`, headers: auth(admin.token), payload: { clientRef: uuidv7(), previewKey: "x".repeat(64) } });
    expect(bill.statusCode).toBe(409);
    expect(bill.json().code).toBe("zomato_order");
    expect(app.db.prepare("SELECT COUNT(*) n FROM bills").get()).toEqual({ n: 0 });
  });

  it("refuses settle, print and credit notes on a Zomato bill", async () => {
    const admin = await setup();
    const order = await colaOrder(admin.token);
    expect((await app.inject({ method: "POST", url: `/api/orders/${order.id}/zomato-status`, headers: auth(admin.token), payload: { status: "ready", clientRef: uuidv7() } })).statusCode).toBe(200);
    const closed = await app.inject({ method: "POST", url: `/api/orders/${order.id}/zomato-status`, headers: auth(admin.token), payload: { status: "picked_up", clientRef: uuidv7() } });
    expect(closed.statusCode, closed.body).toBe(200);
    const bill = closed.json().bill as { id: string; totalPaise: number };

    const settle = await app.inject({ method: "POST", url: `/api/bills/${bill.id}/settle`, headers: auth(admin.token), payload: { clientRef: uuidv7(), payments: [{ mode: "cash", amountPaise: bill.totalPaise }] } });
    expect(settle.statusCode).toBe(409);
    expect(settle.json().code).toBe("zomato_order");

    const printer = (await app.inject({ method: "POST", url: "/api/printers", headers: auth(admin.token), payload: { name: "Receipt", kind: "network", connection: "127.0.0.1:9100", paperWidth: 58 } })).json().printer;
    const print = await app.inject({ method: "POST", url: `/api/bills/${bill.id}/print`, headers: auth(admin.token), payload: { printerId: printer.id } });
    expect(print.statusCode).toBe(409);
    expect(print.json().code).toBe("zomato_order");
    expect(app.db.prepare("SELECT COUNT(*) n FROM print_jobs").get()).toEqual({ n: 0 });

    const itemId = (app.db.prepare("SELECT id FROM order_items WHERE order_id = ?").get(order.id) as { id: string }).id;
    const attempts = [
      { url: `/api/bills/${bill.id}/credit-preview`, payload: { kind: "void" } },
      { url: `/api/bills/${bill.id}/void`, payload: { clientRef: uuidv7(), reason: "Wrong", refunds: [{ mode: "cash", amountPaise: bill.totalPaise }] } },
      { url: `/api/bills/${bill.id}/refund`, payload: { clientRef: uuidv7(), reason: "Cold", lines: [{ orderItemId: itemId, qty: 1 }], refunds: [{ mode: "cash", amountPaise: bill.totalPaise }] } },
    ];
    for (const attempt of attempts) {
      const res = await app.inject({ method: "POST", headers: auth(admin.token), ...attempt });
      expect(res.statusCode, res.body).toBe(409);
      expect(res.json().error).toBe("Zomato handles refunds for Zomato orders");
    }
    // A cashier is told before being asked for an admin PIN.
    const cashier = await createUser(app, admin.token, { name: "Cash", pin: "2222", role: "cashier" });
    const cashierVoid = await app.inject({ method: "POST", url: `/api/bills/${bill.id}/void`, headers: auth(cashier.token), payload: { clientRef: uuidv7(), reason: "Wrong" } });
    expect(cashierVoid.statusCode).toBe(409);
    expect(cashierVoid.json()).toMatchObject({ error: "Zomato handles refunds for Zomato orders", code: "zomato_order" });
    expect(app.db.prepare("SELECT COUNT(*) n FROM credit_notes").get()).toEqual({ n: 0 });
    expect(app.db.prepare("SELECT status FROM bills WHERE id = ?").get(bill.id)).toEqual({ status: "paid" });
  });
});

describe("Zomato KOTs and the Kitchen Display", () => {
  /** Zomato order with one pending item routed to the seeded Kitchen station (optionally with a printer on it). */
  async function stationOrder(token: string, zomatoId = "5821", printer = false) {
    const stationId = (await app.inject({ method: "GET", url: "/api/kot-stations", headers: auth(token) })).json().stations[0].id as string;
    if (printer) {
      const p = (await app.inject({ method: "POST", url: "/api/printers", headers: auth(token), payload: { name: "Kitchen", kind: "network", connection: "127.0.0.1:9100", paperWidth: 58 } })).json().printer;
      await app.inject({ method: "PATCH", url: `/api/kot-stations/${stationId}`, headers: auth(token), payload: { printerId: p.id } });
    }
    const p = await product(token, { name: `Dal ${uuidv7()}`, pricePaise: 20000, kotStationId: stationId });
    const order = (await createOrder(token, zomatoId)).json().order as { id: string };
    await addItem(token, order.id, p.id);
    return { order, productId: p.id, stationId };
  }
  const send = (token: string, orderId: string) => app.inject({ method: "POST", url: `/api/orders/${orderId}/send`, headers: auth(token) });
  const done = (token: string, kotId: string) => app.inject({ method: "POST", url: `/api/kots/${kotId}/done`, headers: auth(token) });
  const statusOf = (orderId: string) => (app.db.prepare("SELECT zomato_status s FROM orders WHERE id = ?").get(orderId) as { s: string | null }).s;
  const setReady = (orderId: string) => app.db.prepare("UPDATE orders SET zomato_status = 'ready' WHERE id = ?").run(orderId);

  it("moves a new order to Preparing on send, labels the print job and slip with the Zomato ID", async () => {
    const admin = await setup();
    const { order } = await stationOrder(admin.token, "5821", true);
    expect(statusOf(order.id)).toBeNull();
    const res = await send(admin.token, order.id);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().order.zomatoStatus).toBe("preparing");
    expect(statusOf(order.id)).toBe("preparing");
    const jobs = app.db.prepare("SELECT job_json, payload FROM print_jobs").all() as Array<{ job_json: string; payload: Buffer }>;
    expect(jobs).toHaveLength(1);
    expect(JSON.parse(jobs[0]!.job_json)).toMatchObject({ kind: "kot", label: "KOT #1 — Zomato #5821" });
    expect(Buffer.from(jobs[0]!.payload).toString("latin1")).toContain("ZOMATO #5821");
  });

  it("moves a Ready order back to Preparing when new items are sent", async () => {
    const admin = await setup();
    const { order, productId } = await stationOrder(admin.token);
    expect((await send(admin.token, order.id)).statusCode).toBe(200);
    setReady(order.id);
    await addItem(admin.token, order.id, productId);
    const res = await send(admin.token, order.id);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().order.zomatoStatus).toBe("preparing");
  });

  it("leaves a new order with only stationless items alone", async () => {
    const admin = await setup();
    const p = await product(admin.token, { name: "Cola", pricePaise: 5000 });
    const order = (await createOrder(admin.token, "5822")).json().order as { id: string };
    await addItem(admin.token, order.id, p.id);
    expect((await send(admin.token, order.id)).statusCode).toBe(409);
    expect(statusOf(order.id)).toBeNull();
  });

  it("does not touch the status on a replayed send", async () => {
    const admin = await setup();
    const { order } = await stationOrder(admin.token);
    const itemIds = (app.db.prepare("SELECT id FROM order_items WHERE order_id = ?").all(order.id) as Array<{ id: string }>).map((i) => i.id);
    const payload = { clientRef: uuidv7(), itemIds };
    const first = await app.inject({ method: "POST", url: `/api/orders/${order.id}/send`, headers: auth(admin.token), payload });
    expect(first.statusCode, first.body).toBe(200);
    setReady(order.id);
    const again = await app.inject({ method: "POST", url: `/api/orders/${order.id}/send`, headers: auth(admin.token), payload });
    expect(again.statusCode).toBe(200);
    expect(statusOf(order.id)).toBe("ready");
  });

  it("labels the cancel slip of a sent Zomato item with the Zomato ID", async () => {
    const admin = await setup();
    const { order } = await stationOrder(admin.token, "5821", true);
    await send(admin.token, order.id);
    const itemId = (app.db.prepare("SELECT id FROM order_items WHERE order_id = ?").get(order.id) as { id: string }).id;
    const res = await app.inject({ method: "POST", url: `/api/order-items/${itemId}/cancel`, headers: auth(admin.token), payload: { reason: "Out of stock" } });
    expect(res.statusCode, res.body).toBe(200);
    const jobs = (app.db.prepare("SELECT job_json, payload FROM print_jobs ORDER BY sequence").all() as Array<{ job_json: string; payload: Buffer }>);
    expect(JSON.parse(jobs[1]!.job_json)).toMatchObject({ kind: "cancel", label: "Cancel — KOT #1 — Zomato #5821" });
    expect(Buffer.from(jobs[1]!.payload).toString("latin1")).toContain("ZOMATO #5821");
  });

  it("makes the order Ready when the kitchen marks its only KOT Done, and broadcasts the order", async () => {
    const admin = await setup();
    enableIntegration(app, "kds");
    const { order } = await stationOrder(admin.token);
    const kotId = (await send(admin.token, order.id)).json().kots[0].id as string;
    const broadcast = vi.spyOn(app, "broadcast");
    expect((await done(admin.token, kotId)).statusCode).toBe(200);
    expect(statusOf(order.id)).toBe("ready");
    const updates = broadcast.mock.calls.filter(([event]) => event === "order.updated");
    expect(updates).toHaveLength(1);
    expect(updates[0]![1]).toMatchObject({ order: { id: order.id, zomatoStatus: "ready" } });
    // Repeating Done changes nothing and does not re-broadcast the order.
    expect((await done(admin.token, kotId)).statusCode).toBe(200);
    expect(broadcast.mock.calls.filter(([event]) => event === "order.updated")).toHaveLength(1);
  });

  it("keeps the order Preparing until every KOT is Done", async () => {
    const admin = await setup();
    enableIntegration(app, "kds");
    const { order, productId } = await stationOrder(admin.token);
    const first = (await send(admin.token, order.id)).json().kots[0].id as string;
    await addItem(admin.token, order.id, productId);
    const second = (await send(admin.token, order.id)).json().kots[0].id as string;
    expect((await done(admin.token, first)).statusCode).toBe(200);
    expect(statusOf(order.id)).toBe("preparing");
    expect((await done(admin.token, second)).statusCode).toBe(200);
    expect(statusOf(order.id)).toBe("ready");
  });

  it("keeps the order Preparing while station items are still unsent", async () => {
    const admin = await setup();
    enableIntegration(app, "kds");
    const { order, productId } = await stationOrder(admin.token);
    const kotId = (await send(admin.token, order.id)).json().kots[0].id as string;
    await addItem(admin.token, order.id, productId);
    expect((await done(admin.token, kotId)).statusCode).toBe(200);
    expect(statusOf(order.id)).toBe("preparing");
  });

  it("does not change a dine-in order when its KOT is Done", async () => {
    const admin = await setup();
    enableIntegration(app, "kds");
    const stationId = (await app.inject({ method: "GET", url: "/api/kot-stations", headers: auth(admin.token) })).json().stations[0].id as string;
    const p = await product(admin.token, { name: "Biryani", pricePaise: 30000, kotStationId: stationId });
    const table = (await app.inject({ method: "POST", url: "/api/tables", headers: auth(admin.token), payload: { name: "T1" } })).json().table;
    const order = (await app.inject({ method: "POST", url: "/api/orders", headers: auth(admin.token), payload: { clientRef: uuidv7(), type: "dine_in", tableId: table.id } })).json().order;
    await addItem(admin.token, order.id, p.id);
    const kotId = (await send(admin.token, order.id)).json().kots[0].id as string;
    expect((await done(admin.token, kotId)).statusCode).toBe(200);
    expect(statusOf(order.id)).toBeNull();
  });

  it("shows the Zomato order ID on the Kitchen Display and on KOT events", async () => {
    const admin = await setup();
    enableIntegration(app, "kds");
    const { order, stationId } = await stationOrder(admin.token, "5821");
    const broadcast = vi.spyOn(app, "broadcast");
    const sent = await send(admin.token, order.id);
    expect(sent.json().kots[0]).toMatchObject({ orderType: "zomato", zomatoOrderId: "5821", tableName: null });
    expect(broadcast.mock.calls.find(([event]) => event === "kot.created")![1]).toMatchObject({ kot: { zomatoOrderId: "5821" } });
    const board = await app.inject({ method: "GET", url: "/api/kots", headers: auth(admin.token) });
    expect(board.json().kots[0]).toMatchObject({ orderType: "zomato", zomatoOrderId: "5821" });
    const parcel = (await app.inject({ method: "POST", url: "/api/orders", headers: auth(admin.token), payload: { clientRef: uuidv7(), type: "parcel" } })).json().order;
    const roll = await product(admin.token, { name: "Roll", pricePaise: 9000, kotStationId: stationId });
    await addItem(admin.token, parcel.id, roll.id);
    expect((await send(admin.token, parcel.id)).json().kots[0].zomatoOrderId).toBeNull();
  });
});
