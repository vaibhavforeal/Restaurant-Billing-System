import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { MIGRATIONS, PLANS, migrate, openDb, uuidv7,
  type GuestMenu, type GuestReceipt, type GuestRequest, type GuestSubmission, type LicenseClaims, type QrTable } from "@forkflow/domain";
import { buildServer } from "./server.js";
import { makeFakeSink } from "./print/sinks.js";
import { SETUP } from "./test-helpers.js";
import { localMinute } from "./reservation-rules.js";

const keys = generateKeyPairSync("ed25519");
const publicKey = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
const apps: FastifyInstance[] = [];
type Headers = { authorization: string; "x-forkflow-device": string };
type Product = { id: string; name: string; variants: Array<{ id: string; name: string; pricePaise: number }> };
type Order = { id: string; tableId: string; splitLabel: string; status: string; items: Array<{ id: string; productId: string; variantId: string | null; qty: number; status: string; note: string | null }> };

afterEach(async () => {
  vi.restoreAllMocks();
  for (const app of apps.splice(0)) { await app.close(); app.db.close(); }
});

async function fixture() {
  let now = Date.now();
  const installationId = randomUUID();
  const db = openDb(":memory:"); migrate(db, MIGRATIONS);
  const app = buildServer({ db, sinkSend: makeFakeSink().send, licensing: { publicKey, installationId, now: () => now } });
  apps.push(app);
  const device = "a".repeat(64);
  const setup = await app.inject({ method: "POST", url: "/api/setup", payload: SETUP, headers: { "x-forkflow-device": device } });
  expect(setup.statusCode, setup.body).toBe(201);
  const headers: Headers = { authorization: `Bearer ${setup.json().token}`, "x-forkflow-device": device };
  const api = (method: "GET" | "POST" | "PUT" | "PATCH", url: string, payload?: object, as = headers) =>
    app.inject({ method, url, headers: as, ...(payload === undefined ? {} : { payload }) });
  const claims: LicenseClaims = { version: 1, installationId, licenseId: randomUUID(), organizationId: randomUUID(), outletId: randomUUID(),
    revision: 1, plan: "pro", features: PLANS.pro.features, maxDevices: PLANS.pro.maxDevices,
    issuedAt: now - 1000, expiresAt: now + 600_000, graceUntil: now + 1_200_000 };
  async function activate(plan: "basic" | "pro", revision: number, features: object = PLANS[plan].features) {
    const next = { ...claims, plan, revision, features, maxDevices: PLANS[plan].maxDevices };
    const message = `ff1.${Buffer.from(JSON.stringify(next)).toString("base64url")}`;
    const license = `${message}.${sign(null, Buffer.from(message), keys.privateKey).toString("base64url")}`;
    const response = await api("PUT", "/api/license", { license });
    expect(response.statusCode, response.body).toBe(200);
    return response.json();
  }
  await activate("pro", 1);
  const registered = await api("POST", "/api/license/devices", { name: "Main counter" });
  expect(registered.statusCode, registered.body).toBe(200);
  const categoryResponse = await api("POST", "/api/categories", { name: "Meals" });
  expect(categoryResponse.statusCode, categoryResponse.body).toBe(201);
  const category = categoryResponse.json().category as { id: string; name: string };
  const station = (db.prepare("SELECT id FROM kot_stations LIMIT 1").get() as { id: string }).id;
  async function product(name: string, withVariants = false): Promise<Product> {
    const response = await api("POST", "/api/products", { name, categoryId: category.id, pricePaise: 10000, gstRate: 5,
      kotStationId: withVariants ? station : null,
      variants: withVariants ? [{ name: "Large", pricePaise: 15000 }, { name: "Small", pricePaise: 8000 }] : [],
    });
    expect(response.statusCode, response.body).toBe(201);
    return response.json().product;
  }
  const meal = await product("Rice bowl", true);
  const water = await product("Water");
  const stockResponse = await api("POST", "/api/stock-items", { clientRef: uuidv7(), name: "Rice", unit: "kg", openingQty: 10 });
  expect(stockResponse.statusCode, stockResponse.body).toBe(201);
  const stockId = stockResponse.json().item.id as string;
  const linked = await api("PUT", `/api/products/${meal.id}/stock-links`, { expectedVersion: 0, stockItemId: stockId, qtyPerSale: 0.25 });
  expect(linked.statusCode, linked.body).toBe(200);
  async function table(name = "T1") {
    const response = await api("POST", "/api/tables", { name, area: "Patio" });
    expect(response.statusCode, response.body).toBe(201);
    return response.json().table as { id: string; name: string };
  }
  const diningTable = await table();
  const enabled = await api("PUT", `/api/qr/tables/${diningTable.id}`, { enabled: true });
  expect(enabled.statusCode, enabled.body).toBe(200);
  const qr = enabled.json().table as QrTable;
  expect(qr.path).toMatch(/^\/menu#[a-f0-9]{64}$/);
  const qrToken = qr.path!.split("#")[1]!;
  async function menu(token = qrToken): Promise<GuestMenu> {
    const response = await app.inject({ url: "/api/guest/menu", headers: { "x-qr-token": token } });
    expect(response.statusCode, response.body).toBe(200);
    return response.json();
  }
  async function submission(items?: GuestSubmission["items"]): Promise<GuestSubmission> {
    return { clientRef: randomUUID(), receiptToken: randomBytes(32).toString("hex"), menuVersion: (await menu()).menuVersion,
      items: items ?? [{ productId: meal.id, variantId: meal.variants[0]!.id, qty: 2, note: "Less spicy" }] };
  }
  const submit = (payload: object, token = qrToken) => app.inject({ method: "POST", url: "/api/guest/requests", headers: { "x-qr-token": token }, payload });
  async function request(items?: GuestSubmission["items"]) {
    const body = await submission(items);
    const response = await submit(body);
    expect(response.statusCode, response.body).toBe(201);
    return { body, request: response.json().request as GuestReceipt };
  }
  const receipt = (id: string, token: string) => app.inject({ url: `/api/guest/requests/${id}`, headers: { "x-guest-receipt": token } });
  const accept = (id: string, orderId: string | null = null, as = headers) => api("POST", `/api/qr/requests/${id}/accept`, { orderId }, as);
  async function order(tableId = diningTable.id) {
    const response = await api("POST", "/api/orders", { clientRef: randomUUID(), type: "dine_in", tableId });
    expect(response.statusCode, response.body).toBe(201);
    return response.json().order as Order;
  }
  async function staff(role: "cashier" | "waiter" | "kitchen"): Promise<Headers> {
    const pin = { cashier: "2345", waiter: "3456", kitchen: "4567" }[role];
    const created = await api("POST", "/api/users", { name: role, role, pin });
    expect(created.statusCode, created.body).toBe(201);
    const loggedIn = await api("POST", "/api/login", { pin });
    expect(loggedIn.statusCode, loggedIn.body).toBe(200);
    return { authorization: `Bearer ${loggedIn.json().token}`, "x-forkflow-device": device };
  }
  const count = (tableName: "orders" | "order_items" | "kots" | "guest_requests") =>
    (db.prepare(`SELECT COUNT(*) AS n FROM ${tableName}`).get() as { n: number }).n;
  const balance = () => (db.prepare("SELECT qty FROM stock_items WHERE id = ?").get(stockId) as { qty: number }).qty;
  return { app, api, claims, activate, headers, category, meal, water, product, stockId, balance, table, diningTable, qr, qrToken,
    menu, submission, submit, request, receipt, accept, order, staff, count, setNow: (value: number) => { now = value; } };
}

describe("guest QR ordering", () => {
  it("holds reserved tables during QR acceptance and allows additions after seating", async () => {
    const f = await fixture();
    const pending = await f.request();
    const booking = await f.api("POST", "/api/reservations", { clientRef: randomUUID(), tableId: f.diningTable.id,
      customerName: "Reserved party", partySize: 4, startsLocal: localMinute(Date.now()), durationMinutes: 90 });
    expect(booking.statusCode, booking.body).toBe(201);
    const blocked = await f.accept(pending.request.id);
    expect(blocked.statusCode).toBe(409);
    expect(f.count("orders")).toBe(0); expect(f.count("order_items")).toBe(0); expect(f.count("kots")).toBe(0);
    expect((await f.receipt(pending.request.id, pending.body.receiptToken)).json().request.status).toBe("pending");
    const seated = await f.api("POST", `/api/reservations/${booking.json().reservation.id}/seat`, { version: 1 });
    expect(seated.statusCode, seated.body).toBe(200);
    const accepted = await f.accept(pending.request.id, seated.json().order.id);
    expect(accepted.statusCode, accepted.body).toBe(200);
    expect(f.count("orders")).toBe(1); expect(f.count("order_items")).toBe(1);
  });

  it("enforces sold-out state for new additions and approvals while preserving exact retries and punched items", async () => {
    const f = await fixture();
    const pending = await f.request();
    const before = await f.menu();
    const order = await f.order();
    const staffBody = { items: [{ productId: f.meal.id, variantId: f.meal.variants[0]!.id, qty: 1, clientRef: randomUUID() }] };
    expect((await f.api("POST", `/api/orders/${order.id}/items`, staffBody)).statusCode).toBe(200);
    expect((await f.api("PATCH", `/api/products/${f.meal.id}`, { description: "Fragrant rice" })).statusCode).toBe(200);
    expect((await f.menu()).menuVersion).toBe(before.menuVersion);
    expect((await f.api("PATCH", `/api/products/${f.meal.id}`, { isSoldOut: true })).statusCode).toBe(200);
    const after = await f.menu();
    expect(after.menuVersion).not.toBe(before.menuVersion);
    expect(after.products.find(p => p.id === f.meal.id)).toMatchObject({ isSoldOut: true, description: "Fragrant rice" });
    expect((await f.submit(await f.submission())).statusCode).toBe(409);
    expect((await f.accept(pending.request.id)).statusCode).toBe(409);
    expect((await f.receipt(pending.request.id, pending.body.receiptToken)).json().request.status).toBe("pending");
    expect((await f.submit(pending.body)).statusCode).toBe(200);
    expect((await f.api("POST", `/api/orders/${order.id}/items`, staffBody)).statusCode).toBe(200);
    const freshStaff = { items: [{ ...staffBody.items[0]!, clientRef: randomUUID() }] };
    expect((await f.api("POST", `/api/orders/${order.id}/items`, freshStaff)).statusCode).toBe(409);
    expect((await f.api("POST", `/api/orders/${order.id}/send`)).statusCode).toBe(200);
    expect(f.balance()).toBe(9.75);
    expect(f.count("order_items")).toBe(1);
    expect((await f.api("PATCH", `/api/products/${f.meal.id}`, { isSoldOut: false })).statusCode).toBe(200);
    expect((await f.accept(pending.request.id, order.id)).statusCode).toBe(200);
  });

  it("tracks only this guest's items through staff approval, real KOT send and completion on a shared bill", async () => {
    const f = await fixture();
    const first = await f.request();
    expect(first.request.preparation).toBeNull();
    const accepted = await f.accept(first.request.id);
    expect(accepted.statusCode, accepted.body).toBe(200);
    const order = accepted.json().order as Order;
    const tracked = async () => (await f.receipt(first.request.id, first.body.receiptToken)).json().request as GuestReceipt;
    expect((await tracked()).preparation).toEqual({ state: "queued", hasChanges: false,
      items: [{ name: "Rice bowl (Large)", qty: 2, state: "queued" }] });
    const other = await f.request([{ productId: f.water.id, variantId: null, qty: 3, note: "Private guest note" }]);
    expect((await f.accept(other.request.id, order.id)).statusCode).toBe(200);
    const secret = await f.product("Staff-only surprise");
    expect((await f.api("POST", `/api/orders/${order.id}/items`, { items: [{ productId: secret.id, qty: 1 }] })).statusCode).toBe(200);
    const sent = await f.api("POST", `/api/orders/${order.id}/send`);
    expect(sent.statusCode, sent.body).toBe(200);
    expect((await tracked()).preparation).toMatchObject({ state: "preparing", hasChanges: false, items: [{ state: "preparing" }] });
    const kotId = sent.json().kots[0].id as string;
    expect((await f.api("POST", `/api/kots/${kotId}/done`)).statusCode).toBe(200);
    const ready = await tracked();
    expect(ready.preparation).toEqual({ state: "ready", hasChanges: false,
      items: [{ name: "Rice bowl (Large)", qty: 2, state: "ready" }] });
    expect(JSON.stringify(ready)).not.toContain("Water");
    expect(JSON.stringify(ready)).not.toContain("Private guest note");
    expect(JSON.stringify(ready)).not.toContain("Staff-only surprise");
    expect(JSON.stringify(ready)).not.toContain(order.id);
    expect(Object.keys(ready.preparation!.items[0]!).sort()).toEqual(["name", "qty", "state"]);
    expect((await f.receipt(other.request.id, other.body.receiptToken)).json().request.preparation.state).toBe("with_staff");
  });

  it("reports partial kitchen completion, edits and cancellations without claiming stationless items are ready", async () => {
    const f = await fixture();
    const bar = (await f.api("POST", "/api/kot-stations", { name: "Drinks" })).json().station as { id: string };
    expect(bar.id).toBeTruthy();
    expect((await f.api("PATCH", `/api/products/${f.water.id}`, { kotStationId: bar.id })).statusCode).toBe(200);
    const dessert = await f.product("Dessert with staff");
    const pending = await f.request([
      { productId: f.meal.id, variantId: f.meal.variants[0]!.id, qty: 2, note: "Less spicy" },
      { productId: f.water.id, variantId: null, qty: 1, note: "" },
      { productId: dessert.id, variantId: null, qty: 1, note: "" },
    ]);
    const accepted = await f.accept(pending.request.id);
    const order = accepted.json().order as Order;
    const mealItem = order.items.find(i => i.productId === f.meal.id)!;
    const dessertItem = order.items.find(i => i.productId === dessert.id)!;
    const tracked = async () => (await f.receipt(pending.request.id, pending.body.receiptToken)).json().request as GuestReceipt;
    expect((await tracked()).preparation).toMatchObject({ state: "with_staff", hasChanges: false });
    expect((await f.api("PATCH", `/api/order-items/${mealItem.id}`, { qty: 1, note: "No chilli" })).statusCode).toBe(200);
    expect((await tracked()).preparation).toMatchObject({ hasChanges: true, items: expect.arrayContaining([{ name: "Rice bowl (Large)", qty: 1, state: "queued" }]) });
    const sent = await f.api("POST", `/api/orders/${order.id}/send`);
    expect(sent.statusCode, sent.body).toBe(200);
    const kots = sent.json().kots as Array<{ id: string }>;
    expect(kots).toHaveLength(2);
    expect((await f.api("POST", `/api/kots/${kots[0]!.id}/done`)).statusCode).toBe(200);
    const partial = (await tracked()).preparation!;
    expect(partial.state).toBe("preparing");
    expect(partial.items.map(i => i.state).sort()).toEqual(["preparing", "ready", "with_staff"]);
    expect((await f.api("POST", `/api/kots/${kots[1]!.id}/done`)).statusCode).toBe(200);
    expect((await tracked()).preparation!.state).toBe("with_staff");
    expect((await f.api("POST", `/api/order-items/${dessertItem.id}/cancel`, {})).statusCode).toBe(200);
    expect((await tracked()).preparation!.state).toBe("ready");
    for (const item of order.items.filter(i => i.id !== dessertItem.id)) {
      expect((await f.api("POST", `/api/order-items/${item.id}/cancel`, { reason: "Guest cancelled" })).statusCode).toBe(200);
    }
    expect((await tracked()).preparation).toMatchObject({ state: "cancelled", hasChanges: true });
    expect(f.balance()).toBe(10);
  });

  it("keeps preparation accessible after downgrade and flags missing linked items for staff follow-up", async () => {
    const f = await fixture(); const pending = await f.request();
    const accepted = await f.accept(pending.request.id);
    expect(accepted.statusCode, accepted.body).toBe(200);
    await f.activate("basic", 2);
    const basic = await f.receipt(pending.request.id, pending.body.receiptToken);
    expect(basic.statusCode).toBe(200);
    expect(basic.json().request.preparation.state).toBe("queued");
    f.app.db.prepare("DELETE FROM order_items WHERE guest_request_id = ?").run(pending.request.id);
    expect((await f.receipt(pending.request.id, pending.body.receiptToken)).json().request.preparation)
      .toEqual({ state: "with_staff", hasChanges: true, items: [] });
  });

  it("serves only the public active menu to a QR guest without a staff session or device registration", async () => {
    const f = await fixture();
    const archived = await f.product("Archived meal");
    expect((await f.api("PATCH", `/api/products/${archived.id}`, { isActive: false })).statusCode).toBe(200);
    expect((await f.api("PATCH", `/api/variants/${f.meal.variants[1]!.id}`, { isActive: false })).statusCode).toBe(200);
    const hiddenCategory = await f.api("POST", "/api/categories", { name: "Hidden category" });
    const hiddenProduct = await f.api("POST", "/api/products", { categoryId: hiddenCategory.json().category.id, name: "Hidden category product", pricePaise: 500, gstRate: 5 });
    expect(hiddenProduct.statusCode).toBe(201);
    expect((await f.api("PATCH", `/api/categories/${hiddenCategory.json().category.id}`, { isActive: false })).statusCode).toBe(200);
    const menu = await f.menu();
    expect(Object.keys(menu).sort()).toEqual(["categories", "menuVersion", "orderingAvailable", "products", "restaurantName", "table", "taxInclusive"]);
    expect(menu).toMatchObject({ restaurantName: SETUP.restaurantName, table: { id: f.diningTable.id, name: "T1", area: "Patio" }, orderingAvailable: true, taxInclusive: false });
    expect(menu.menuVersion).toMatch(/^[a-f0-9]{64}$/);
    expect(menu.categories).toEqual([{ id: f.category.id, name: "Meals" }]);
    expect(menu.products.map((product) => product.id).sort()).toEqual([f.meal.id, f.water.id].sort());
    const meal = menu.products.find((product) => product.id === f.meal.id)!;
    expect(Object.keys(meal).sort()).toEqual(["categoryId", "description", "gstRate", "id", "isSoldOut", "isVeg", "name", "photoUrl", "pricePaise", "variants"]);
    expect(meal.variants).toEqual([{ id: f.meal.variants[0]!.id, name: f.meal.variants[0]!.name, pricePaise: f.meal.variants[0]!.pricePaise }]);
    expect(JSON.stringify(menu)).not.toContain(f.qrToken);
    expect((await f.api("GET", "/api/license/devices")).json().devices).toHaveLength(1);
  });

  it("does not let a public QR or receipt credential authorize staff APIs or read another guest receipt", async () => {
    const f = await fixture(); const first = await f.request(); const second = await f.request();
    for (const url of ["/api/orders", "/api/settings", "/api/stock-items", "/api/qr/tables", "/api/qr/requests"]) {
      const response = await f.app.inject({ url, headers: { "x-qr-token": f.qrToken, "x-guest-receipt": first.body.receiptToken } });
      expect(response.statusCode, `${url}: ${response.body}`).toBe(401);
    }
    expect((await f.app.inject({ method: "POST", url: `/api/qr/requests/${first.request.id}/accept`, headers: { "x-qr-token": f.qrToken }, payload: { orderId: null } })).statusCode).toBe(401);
    const own = await f.receipt(first.request.id, first.body.receiptToken);
    expect(own.statusCode, own.body).toBe(200);
    expect(Object.keys(own.json().request).sort()).toEqual(["createdAt", "expiresAt", "id", "items", "preparation", "reason", "status", "subtotalPaise", "tableName", "taxInclusive"]);
    expect((await f.receipt(second.request.id, first.body.receiptToken)).statusCode).toBe(404);
    expect((await f.receipt(first.request.id, f.qrToken)).statusCode).toBe(404);
    expect((await f.app.inject({ url: `/api/guest/requests/${first.request.id}`, headers: { "x-qr-token": f.qrToken } })).statusCode).toBeGreaterThanOrEqual(400);
    const row = f.app.db.prepare("SELECT receipt_hash FROM guest_requests WHERE id = ?").get(first.request.id) as { receipt_hash: string };
    expect(row.receipt_hash).toBe(createHash("sha256").update(first.body.receiptToken).digest("hex"));
    expect(JSON.stringify(own.json())).not.toContain(first.body.receiptToken);
    expect((await f.app.inject({ url: "/api/guest/menu" })).statusCode).toBeGreaterThanOrEqual(400);
    expect((await f.app.inject({ url: "/api/guest/menu", headers: { "x-qr-token": "f".repeat(64) } })).statusCode).toBeGreaterThanOrEqual(400);
  });

  it("restricts QR administration to admins and produces an image only for a listed local origin", async () => {
    const f = await fixture(); const waiter = await f.staff("waiter");
    expect((await f.api("GET", "/api/qr/tables", undefined, waiter)).statusCode).toBe(403);
    expect((await f.api("PUT", `/api/qr/tables/${f.diningTable.id}`, { enabled: false }, waiter)).statusCode).toBe(403);
    const listed = await f.api("GET", "/api/qr/tables");
    expect(listed.statusCode, listed.body).toBe(200);
    const { tables, origins } = listed.json() as { tables: QrTable[]; origins: string[] };
    expect(tables).toContainEqual(expect.objectContaining({ id: f.diningTable.id, enabled: true, path: f.qr.path }));
    expect(origins.length).toBeGreaterThan(0);
    const image = await f.api("GET", `/api/qr/tables/${f.diningTable.id}/image?origin=${encodeURIComponent(origins[0]!)}`);
    expect(image.statusCode, image.body).toBe(200);
    expect(image.json()).toMatchObject({ url: `${origins[0]}${f.qr.path}` });
    expect(image.json().qr).toMatch(/^data:image\/png;base64,/);
    expect((await f.api("GET", `/api/qr/tables/${f.diningTable.id}/image?origin=${encodeURIComponent("https://untrusted.example")}`)).statusCode).toBe(400);
    expect((await f.api("GET", `/api/qr/tables/${f.diningTable.id}/image?origin=${encodeURIComponent(origins[0]!)}`, undefined, waiter)).statusCode).toBe(403);
  });

  it("allows Basic menu browsing but denies new guest ordering, and treats older grants without qrOrdering as disabled", async () => {
    const f = await fixture(); const body = await f.submission();
    const basic = await f.activate("basic", 2);
    expect(basic.features.qrOrdering).toBe(false);
    expect((await f.menu()).orderingAvailable).toBe(false);
    expect((await f.submit(body)).statusCode).toBe(403);
    expect(f.count("guest_requests")).toBe(0);
    const legacy = await f.activate("pro", 3, { recipes: true });
    expect(legacy.features).toMatchObject({ recipes: true, qrOrdering: false });
    expect((await f.menu()).orderingAvailable).toBe(false);
    expect((await f.submit(body)).statusCode).toBe(403);
    await f.activate("pro", 4);
    expect((await f.submit(await f.submission())).statusCode).toBe(201);
  });

  it("denies menu browsing and new submissions after offline license expiry while preserving existing receipt tracking", async () => {
    const f = await fixture(); const pending = await f.request(); const fresh = await f.submission();
    f.setNow(f.claims.graceUntil);
    expect((await f.app.inject({ url: "/api/guest/menu", headers: { "x-qr-token": f.qrToken } })).statusCode).toBe(403);
    expect((await f.submit(fresh)).statusCode).toBe(403);
    const tracked = await f.receipt(pending.request.id, pending.body.receiptToken);
    expect(tracked.statusCode, tracked.body).toBe(200);
    expect(tracked.json().request.status).toBe("pending");
    expect((await f.submit(pending.body)).statusCode).toBe(200);
    expect(f.count("guest_requests")).toBe(1);
  });

  it("enforces strict submission bounds and refuses client-provided prices or table identity", async () => {
    const f = await fixture(); const body = await f.submission(); const item = body.items[0]!;
    const invalid = [
      { label: "empty basket", body: { ...body, items: [] } },
      { label: "31 lines", body: { ...body, items: Array.from({ length: 31 }, () => item) } },
      { label: "zero quantity", body: { ...body, items: [{ ...item, qty: 0 }] } },
      { label: "21 quantity", body: { ...body, items: [{ ...item, qty: 21 }] } },
      { label: "fractional quantity", body: { ...body, items: [{ ...item, qty: 1.5 }] } },
      { label: "long note", body: { ...body, items: [{ ...item, note: "x".repeat(201) }] } },
      { label: "printer commands", body: { ...body, items: [{ ...item, note: "Note \u001bd\u007f" }] } },
      { label: "invalid reference", body: { ...body, clientRef: "not-a-uuid" } },
      { label: "short receipt", body: { ...body, receiptToken: "a".repeat(63) } },
      { label: "invalid version", body: { ...body, menuVersion: "bad" } },
      { label: "injected price", body: { ...body, items: [{ ...item, pricePaise: 1 }] } },
      { label: "injected table", body: { ...body, tableId: randomUUID() } },
      { label: "missing variant field", body: { ...body, items: [{ productId: item.productId, qty: 1, note: "" }] } },
    ];
    const broadcast = vi.spyOn(f.app, "broadcast");
    for (const input of invalid) {
      const response = await f.submit(input.body);
      expect(response.statusCode, `${input.label}: ${response.body}`).toBe(400);
    }
    expect(f.count("guest_requests")).toBe(0);
    expect(f.count("orders")).toBe(0);
    expect(broadcast).not.toHaveBeenCalled();
  });

  it("refuses unknown products, another product's variant and archived products or variants", async () => {
    const f = await fixture();
    const invalidItems = [
      { productId: randomUUID(), variantId: null, qty: 1, note: "" },
      { productId: f.water.id, variantId: f.meal.variants[0]!.id, qty: 1, note: "" },
      { productId: f.meal.id, variantId: randomUUID(), qty: 1, note: "" },
    ];
    for (const item of invalidItems) {
      const response = await f.submit(await f.submission([item]));
      expect(response.statusCode, response.body).toBe(409);
      expect(response.json().code).toBe("menu_changed");
    }
    expect((await f.api("PATCH", `/api/variants/${f.meal.variants[0]!.id}`, { isActive: false })).statusCode).toBe(200);
    const archivedVariant = await f.submit(await f.submission());
    expect(archivedVariant.statusCode, archivedVariant.body).toBe(409);
    expect(archivedVariant.json().code).toBe("menu_changed");
    expect((await f.api("PATCH", `/api/products/${f.water.id}`, { isActive: false })).statusCode).toBe(200);
    const archivedProduct = await f.submit(await f.submission([{ productId: f.water.id, variantId: null, qty: 1, note: "" }]));
    expect(archivedProduct.statusCode, archivedProduct.body).toBe(409);
    expect(archivedProduct.json().code).toBe("menu_changed");
    expect(f.count("guest_requests")).toBe(0);
  });

  it("rejects a stale menu version after price or tax changes before recording a request", async () => {
    const f = await fixture(); const stalePrice = await f.submission();
    expect((await f.api("PATCH", `/api/variants/${f.meal.variants[0]!.id}`, { pricePaise: 18000 })).statusCode).toBe(200);
    const priceChanged = await f.submit(stalePrice);
    expect(priceChanged.statusCode, priceChanged.body).toBe(409);
    expect(priceChanged.json().code).toBe("menu_changed");
    const newMenu = await f.menu();
    expect(newMenu.menuVersion).not.toBe(stalePrice.menuVersion);
    const staleTax = await f.submission();
    const settings = (await f.api("GET", "/api/settings")).json().settings;
    expect((await f.api("PUT", "/api/settings", { ...settings, taxInclusive: true })).statusCode).toBe(200);
    const taxChanged = await f.submit(staleTax);
    expect(taxChanged.statusCode, taxChanged.body).toBe(409);
    expect(taxChanged.json().code).toBe("menu_changed");
    expect(f.count("guest_requests")).toBe(0);
    const fresh = await f.request();
    expect(fresh.request).toMatchObject({ taxInclusive: true, subtotalPaise: 36000 });
  });

  it("uses server price snapshots and prevents approval after their prices change", async () => {
    const f = await fixture(); const pending = await f.request();
    expect(pending.request).toMatchObject({ status: "pending", tableName: "T1", subtotalPaise: 30000,
      items: [{ productId: f.meal.id, variantId: f.meal.variants[0]!.id, qty: 2, pricePaise: 15000, gstRate: 5, note: "Less spicy" }] });
    expect(pending.request.expiresAt - pending.request.createdAt).toBe(2 * 60 * 60 * 1000);
    expect((await f.api("PATCH", `/api/variants/${f.meal.variants[0]!.id}`, { pricePaise: 16000 })).statusCode).toBe(200);
    const accepted = await f.accept(pending.request.id);
    expect(accepted.statusCode, accepted.body).toBe(409);
    expect(accepted.json().code).toBe("menu_changed");
    expect((await f.receipt(pending.request.id, pending.body.receiptToken)).json().request).toEqual(pending.request);
    expect(f.count("orders")).toBe(0);
    expect(f.count("order_items")).toBe(0);
  });

  it("replays identical submissions once but rejects changed bodies, receipt tokens or table QR credentials", async () => {
    const f = await fixture(); const pending = await f.request();
    const again = await f.submit(pending.body);
    expect(again.statusCode, again.body).toBe(200);
    expect(again.json().request).toEqual(pending.request);
    expect((await f.submit({ ...pending.body, items: [{ ...pending.body.items[0]!, qty: 3 }] })).statusCode).toBe(409);
    expect((await f.submit({ ...pending.body, receiptToken: randomBytes(32).toString("hex") })).statusCode).toBe(404);
    const otherTable = await f.table("T2");
    const otherQr = await f.api("PUT", `/api/qr/tables/${otherTable.id}`, { enabled: true });
    expect((await f.submit(pending.body, otherQr.json().table.path.split("#")[1])).statusCode).toBe(409);
    await f.activate("basic", 2);
    expect((await f.api("PUT", `/api/qr/tables/${f.diningTable.id}`, { enabled: false })).statusCode).toBe(200);
    expect((await f.submit(pending.body)).statusCode).toBe(200);
    expect(f.count("guest_requests")).toBe(1);
  });

  it("records simultaneous retries of one guest submission only once", async () => {
    const f = await fixture(); const body = await f.submission();
    const responses = await Promise.all([f.submit(body), f.submit(body)]);
    expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 201]);
    expect(responses[0]!.json().request).toEqual(responses[1]!.json().request);
    expect(f.count("guest_requests")).toBe(1);
    expect(f.count("orders")).toBe(0);
  });

  it("requires staff approval and inserts pending items without sending a KOT or consuming stock", async () => {
    const f = await fixture(); const pending = await f.request();
    expect(f.count("orders")).toBe(0);
    expect(f.count("order_items")).toBe(0);
    const listed = await f.api("GET", "/api/qr/requests");
    expect(listed.statusCode, listed.body).toBe(200);
    expect(listed.json().requests).toEqual([expect.objectContaining({ id: pending.request.id, status: "pending", tableId: f.diningTable.id })]);
    const accepted = await f.accept(pending.request.id);
    expect(accepted.statusCode, accepted.body).toBe(200);
    const { request, order } = accepted.json() as { request: GuestRequest; order: Order };
    expect(request).toMatchObject({ id: pending.request.id, status: "accepted", tableId: f.diningTable.id, orderId: order.id, reviewedByName: SETUP.adminName });
    expect(order).toMatchObject({ tableId: f.diningTable.id, splitLabel: "A", status: "open",
      items: [{ productId: f.meal.id, variantId: f.meal.variants[0]!.id, qty: 2, status: "pending", note: "Less spicy" }] });
    expect(f.count("kots")).toBe(0);
    expect(f.balance()).toBe(10);
    expect(f.app.db.prepare("SELECT COUNT(*) AS n FROM stock_moves WHERE reason = 'sale'").get()).toEqual({ n: 0 });
    expect((await f.api("GET", "/api/qr/requests")).json().requests).toEqual([]);
    const receipt = (await f.receipt(pending.request.id, pending.body.receiptToken)).json().request;
    expect(receipt.status).toBe("accepted");
    expect(receipt).not.toHaveProperty("orderId");
    expect((await f.api("POST", `/api/orders/${order.id}/send`)).statusCode).toBe(200);
    expect(f.count("kots")).toBe(1);
    expect(f.balance()).toBe(9.5);
  });

  it("attaches approval to the chosen open order at the same table and makes repeated approval idempotent", async () => {
    const f = await fixture(); const existing = await f.order(); const pending = await f.request();
    const accepted = await f.accept(pending.request.id, existing.id);
    expect(accepted.statusCode, accepted.body).toBe(200);
    expect(accepted.json().order.id).toBe(existing.id);
    const again = await f.accept(pending.request.id, existing.id);
    expect(again.statusCode, again.body).toBe(200);
    expect(again.json().request).toEqual(accepted.json().request);
    expect(again.json().order.items).toEqual(accepted.json().order.items);
    expect(f.count("orders")).toBe(1);
    expect(f.count("order_items")).toBe(1);
    expect((await f.accept(pending.request.id, null)).statusCode).toBe(409);
    const split = await f.request([{ productId: f.water.id, variantId: null, qty: 1, note: "" }]);
    const newSplit = await f.accept(split.request.id, null);
    expect(newSplit.statusCode, newSplit.body).toBe(200);
    expect(newSplit.json().order).toMatchObject({ tableId: f.diningTable.id, splitLabel: "B" });
    expect(newSplit.json().order.id).not.toBe(existing.id);
  });

  it("rejects approval into another table or a billed order without changing the pending request", async () => {
    const f = await fixture(); const pending = await f.request();
    const otherTable = await f.table("T2"); const otherOrder = await f.order(otherTable.id);
    const wrongTable = await f.accept(pending.request.id, otherOrder.id);
    expect(wrongTable.statusCode, wrongTable.body).toBe(409);
    const existing = await f.order();
    expect((await f.api("POST", `/api/orders/${existing.id}/items`, { items: [{ productId: f.water.id, qty: 1, clientRef: randomUUID() }] })).statusCode).toBe(200);
    const preview = await f.api("POST", `/api/orders/${existing.id}/bill-preview`, {});
    expect(preview.statusCode, preview.body).toBe(200);
    const billed = await f.api("POST", `/api/orders/${existing.id}/bill`, { clientRef: randomUUID(), previewKey: preview.json().preview.previewKey });
    expect(billed.statusCode, billed.body).toBe(201);
    const closedOrder = await f.accept(pending.request.id, existing.id);
    expect(closedOrder.statusCode, closedOrder.body).toBe(409);
    expect((await f.receipt(pending.request.id, pending.body.receiptToken)).json().request.status).toBe("pending");
    expect(f.count("order_items")).toBe(1);
    expect(f.count("kots")).toBe(0);
  });

  it("rolls back new orders, inserted items and the request decision when a later item insert fails", async () => {
    const f = await fixture(); const pending = await f.request([
      { productId: f.meal.id, variantId: f.meal.variants[0]!.id, qty: 1, note: "" },
      { productId: f.water.id, variantId: null, qty: 1, note: "" },
    ]);
    f.app.db.exec("CREATE TRIGGER fail_guest_item BEFORE INSERT ON order_items WHEN (SELECT name FROM products WHERE id = NEW.product_id) = 'Water' BEGIN SELECT RAISE(ABORT, 'test'); END");
    const broadcast = vi.spyOn(f.app, "broadcast");
    const failed = await f.accept(pending.request.id);
    expect(failed.statusCode, failed.body).toBe(500);
    expect(f.count("orders")).toBe(0);
    expect(f.count("order_items")).toBe(0);
    expect(f.count("kots")).toBe(0);
    expect(f.balance()).toBe(10);
    expect((await f.receipt(pending.request.id, pending.body.receiptToken)).json().request).toEqual(pending.request);
    expect(f.app.db.prepare("SELECT order_id, decision_json, reviewed_at, reviewed_by FROM guest_requests WHERE id = ?").get(pending.request.id))
      .toEqual({ order_id: null, decision_json: null, reviewed_at: null, reviewed_by: null });
    expect(broadcast).not.toHaveBeenCalled();
    f.app.db.exec("DROP TRIGGER fail_guest_item");
    expect((await f.accept(pending.request.id)).statusCode).toBe(200);
    expect(f.count("orders")).toBe(1);
    expect(f.count("order_items")).toBe(2);
  });

  it("serializes simultaneous approval retries into one order with one set of items", async () => {
    const f = await fixture(); const pending = await f.request();
    const responses = await Promise.all([f.accept(pending.request.id), f.accept(pending.request.id)]);
    expect(responses.map((response) => response.statusCode)).toEqual([200, 200]);
    expect(responses[0]!.json().request).toEqual(responses[1]!.json().request);
    expect(responses[0]!.json().order.id).toBe(responses[1]!.json().order.id);
    expect(f.count("orders")).toBe(1);
    expect(f.count("order_items")).toBe(1);
  });

  it("allows a waiter to review requests but denies kitchen users and enforces the ordering entitlement", async () => {
    const f = await fixture(); const waiter = await f.staff("waiter"); const kitchen = await f.staff("kitchen"); const pending = await f.request();
    expect((await f.api("GET", "/api/qr/requests", undefined, waiter)).statusCode).toBe(200);
    expect((await f.api("GET", "/api/qr/requests", undefined, kitchen)).statusCode).toBe(403);
    expect((await f.accept(pending.request.id, null, kitchen)).statusCode).toBe(403);
    await f.activate("basic", 2);
    expect((await f.accept(pending.request.id, null, waiter)).statusCode).toBe(403);
    expect(f.count("orders")).toBe(0);
    await f.activate("pro", 3);
    expect((await f.accept(pending.request.id, null, waiter)).statusCode).toBe(200);
  });

  it("records rejection reasons, permits exact rejection retries and never adds rejected items to orders", async () => {
    const f = await fixture(); const pending = await f.request();
    const rejected = await f.api("POST", `/api/qr/requests/${pending.request.id}/reject`, { reason: "Kitchen is out of rice" });
    expect(rejected.statusCode, rejected.body).toBe(200);
    expect(rejected.json().request).toMatchObject({ status: "rejected", reason: "Kitchen is out of rice", orderId: null });
    expect((await f.receipt(pending.request.id, pending.body.receiptToken)).json().request).toMatchObject({ status: "rejected", reason: "Kitchen is out of rice" });
    const retry = await f.api("POST", `/api/qr/requests/${pending.request.id}/reject`, { reason: "Kitchen is out of rice" });
    expect(retry.statusCode, retry.body).toBe(200);
    expect(retry.json().request).toEqual(rejected.json().request);
    expect((await f.api("POST", `/api/qr/requests/${pending.request.id}/reject`, { reason: "Different reason" })).statusCode).toBe(409);
    expect((await f.accept(pending.request.id)).statusCode).toBe(409);
    expect((await f.api("GET", "/api/qr/requests")).json().requests).toEqual([]);
    expect(f.count("orders")).toBe(0);
    expect(f.count("order_items")).toBe(0);
    expect(f.balance()).toBe(10);
  });

  it("expires unreviewed requests and makes their receipts terminal without adding order items", async () => {
    const f = await fixture(); const pending = await f.request();
    f.app.db.prepare("UPDATE guest_requests SET expires_at = ? WHERE id = ?").run(Date.now() - 1, pending.request.id);
    const expired = await f.receipt(pending.request.id, pending.body.receiptToken);
    expect(expired.statusCode, expired.body).toBe(200);
    expect(expired.json().request.status).toBe("expired");
    expect((await f.api("GET", "/api/qr/requests")).json().requests).toEqual([]);
    expect((await f.accept(pending.request.id)).statusCode).toBe(409);
    expect((await f.submit(pending.body)).json().request.status).toBe("expired");
    expect(f.count("orders")).toBe(0);
  });

  it("rotates or disables a QR for new guests while keeping earlier pending requests reviewable", async () => {
    const f = await fixture(); const pending = await f.request(); const unsent = await f.submission();
    const rotated = await f.api("PUT", `/api/qr/tables/${f.diningTable.id}`, { enabled: true, rotate: true });
    expect(rotated.statusCode, rotated.body).toBe(200);
    const nextToken = rotated.json().table.path.split("#")[1] as string;
    expect(nextToken).toMatch(/^[a-f0-9]{64}$/);
    expect(nextToken).not.toBe(f.qrToken);
    expect((await f.app.inject({ url: "/api/guest/menu", headers: { "x-qr-token": f.qrToken } })).statusCode).toBeGreaterThanOrEqual(400);
    expect((await f.submit(unsent)).statusCode).toBeGreaterThanOrEqual(400);
    expect((await f.menu(nextToken)).orderingAvailable).toBe(true);
    expect((await f.api("PUT", `/api/qr/tables/${f.diningTable.id}`, { enabled: false })).statusCode).toBe(200);
    expect((await f.app.inject({ url: "/api/guest/menu", headers: { "x-qr-token": nextToken } })).statusCode).toBeGreaterThanOrEqual(400);
    expect((await f.submit(unsent, nextToken)).statusCode).toBeGreaterThanOrEqual(400);
    expect((await f.accept(pending.request.id)).statusCode).toBe(200);
    expect(f.count("order_items")).toBe(1);
  });

  it("blocks menu access and approval for an inactive table", async () => {
    const f = await fixture(); const pending = await f.request();
    expect((await f.api("PATCH", `/api/tables/${f.diningTable.id}`, { isActive: false })).statusCode).toBe(200);
    expect((await f.app.inject({ url: "/api/guest/menu", headers: { "x-qr-token": f.qrToken } })).statusCode).toBeGreaterThanOrEqual(400);
    const response = await f.accept(pending.request.id);
    expect(response.statusCode, response.body).toBe(409);
    expect(f.count("orders")).toBe(0);
  });

  it("caps pending requests per table and frees capacity when staff reject one", async () => {
    const f = await fixture(); const requests: Awaited<ReturnType<typeof f.request>>[] = [];
    for (let index = 0; index < 10; index++) requests.push(await f.request());
    const overflow = await f.submission();
    const full = await f.submit(overflow);
    expect(full.statusCode, full.body).toBe(429);
    expect(f.count("guest_requests")).toBe(10);
    expect((await f.api("POST", `/api/qr/requests/${requests[0]!.request.id}/reject`, { reason: "Duplicate guest request" })).statusCode).toBe(200);
    expect((await f.submit(overflow)).statusCode).toBe(201);
    expect((await f.api("GET", "/api/qr/requests")).json().requests).toHaveLength(10);
  });
});
