import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { localDateKey, uuidv7, type Bill } from "@masalapos/domain";
import { auth, createUser, freshAppWithFakeSink, setupAdmin } from "./test-helpers.js";
import { receiptHtml, receiptSlip } from "./print/receipt.js";

describe("order types", () => {
  let app: FastifyInstance; let token: string; let productId: string;
  beforeEach(async () => {
    ({ app } = freshAppWithFakeSink()); ({ token } = await setupAdmin(app));
    const c = await app.inject({ method: "POST", url: "/api/categories", headers: auth(token), payload: { name: "Food" } });
    const station = app.db.prepare("SELECT id FROM kot_stations LIMIT 1").get() as { id: string };
    const p = await app.inject({ method: "POST", url: "/api/products", headers: auth(token), payload: { name: "Biryani", categoryId: c.json().category.id, pricePaise: 20000, gstRate: 5, kotStationId: station.id } });
    productId = p.json().product.id;
    const printer = await app.inject({ method: "POST", url: "/api/printers", headers: auth(token), payload: { name: "Kitchen", kind: "network", connection: "127.0.0.1:9100", paperWidth: 80 } });
    await app.inject({ method: "PATCH", url: `/api/kot-stations/${station.id}`, headers: auth(token), payload: { printerId: printer.json().printer.id } });
  });
  afterEach(async () => { await app.close(); app.db.close(); });

  const request = (method: "GET" | "POST" | "PATCH", url: string, payload?: object, as = token) => app.inject({ method, url, headers: auth(as), ...(payload ? { payload } : {}) });
  async function addType(name: string, kind: "takeaway" | "delivery" = "delivery") {
    const res = await request("POST", "/api/order-types", { name, kind });
    expect(res.statusCode).toBe(201); return res.json().orderType as { id: string; name: string };
  }
  async function parcel(orderTypeId?: string) {
    const res = await request("POST", "/api/orders", { clientRef: uuidv7(), type: "parcel", ...(orderTypeId ? { orderTypeId } : {}) });
    expect(res.statusCode).toBe(201);
    const id = res.json().order.id as string;
    await request("POST", `/api/orders/${id}/items`, { items: [{ productId, qty: 1, clientRef: uuidv7() }] });
    return res.json().order as { id: string; orderTypeId: string; orderTypeName: string | null };
  }
  async function bill(orderId: string) {
    await request("POST", `/api/orders/${orderId}/send`);
    const preview = await request("POST", `/api/orders/${orderId}/bill-preview`, {});
    const res = await request("POST", `/api/orders/${orderId}/bill`, { clientRef: uuidv7(), previewKey: preview.json().preview.previewKey });
    expect(res.statusCode).toBe(201); return res.json().bill as Bill;
  }

  it("lists the built-in types and manages the restaurant's own", async () => {
    expect((await request("GET", "/api/order-types")).json().orderTypes.map((t: { id: string; name: string }) => t.name)).toEqual(["Dine-in", "Takeaway", "Zomato"]);
    const delivery = await addType("Home delivery");
    expect((await request("POST", "/api/order-types", { name: "home DELIVERY", kind: "delivery" })).statusCode).toBe(409);
    expect((await request("POST", "/api/order-types", { name: "Table service", kind: "dine_in" })).statusCode).toBe(400);
    expect((await request("PATCH", "/api/order-types/parcel", { isActive: false })).statusCode).toBe(409);
    expect((await request("PATCH", "/api/order-types/parcel", { name: "Parcel" })).json().orderType.name).toBe("Parcel");
    expect((await request("PATCH", `/api/order-types/${delivery.id}`, { isActive: false })).json().orderType.isActive).toBe(false);
    const cashier = await createUser(app, token, { name: "Meena", pin: "3333", role: "cashier" });
    expect((await request("POST", "/api/order-types", { name: "Pickup", kind: "takeaway" }, cashier.token)).statusCode).toBe(403);
    expect((await request("GET", "/api/order-types", undefined, cashier.token)).statusCode).toBe(200);
  });

  it("puts the type name on the order, kitchen slip and bill; built-in takeaway is unchanged", async () => {
    const delivery = await addType("Home delivery");
    const order = await parcel(delivery.id);
    expect(order).toMatchObject({ orderTypeId: delivery.id, orderTypeName: "Home delivery" });
    const kots = (await request("POST", `/api/orders/${order.id}/send`)).json().kots;
    expect(kots[0].orderTypeName).toBe("Home delivery");
    const job = JSON.parse((app.db.prepare("SELECT job_json FROM print_jobs").get() as { job_json: string }).job_json);
    expect(job.label).toContain("Home delivery");
    const issued = await bill(order.id);
    expect(issued.receipt.orderTypeName).toBe("Home delivery");
    expect(receiptSlip(issued, 80).toString("latin1")).toContain("HOME DELIVERY");
    expect(receiptHtml(issued)).toContain("Home delivery");

    const plain = await parcel();
    expect(plain).toMatchObject({ orderTypeId: "parcel", orderTypeName: null });
    expect("orderTypeName" in (await bill(plain.id)).receipt).toBe(false);
  });

  it("switches an open takeaway between types and refuses other orders and inactive types", async () => {
    const pickup = await addType("Counter pickup", "takeaway");
    const order = await parcel();
    const switched = await request("PATCH", `/api/orders/${order.id}/order-type`, { orderTypeId: pickup.id });
    expect(switched.json().order).toMatchObject({ orderTypeId: pickup.id, orderTypeName: "Counter pickup" });
    expect((await request("PATCH", `/api/orders/${order.id}/order-type`, { orderTypeId: "parcel" })).json().order).toMatchObject({ orderTypeId: "parcel", orderTypeName: null });
    expect((await request("PATCH", `/api/orders/${order.id}/order-type`, { orderTypeId: "zomato" })).statusCode).toBe(400);
    await request("PATCH", `/api/order-types/${pickup.id}`, { isActive: false });
    expect((await request("PATCH", `/api/orders/${order.id}/order-type`, { orderTypeId: pickup.id })).statusCode).toBe(400);
    expect((await request("POST", "/api/orders", { clientRef: uuidv7(), type: "parcel", orderTypeId: pickup.id })).statusCode).toBe(400);
    const table = (await request("POST", "/api/tables", { name: "T1", area: "Main" })).json().table;
    expect((await request("POST", "/api/orders", { clientRef: uuidv7(), type: "dine_in", tableId: table.id, orderTypeId: "parcel" })).statusCode).toBe(400);
    await bill(order.id);
    expect((await request("PATCH", `/api/orders/${order.id}/order-type`, { orderTypeId: "parcel" })).statusCode).toBe(409);
  });

  it("reports sales by order type, with credit notes on the type of the bill they credit", async () => {
    const delivery = await addType("Home delivery");
    await bill((await parcel(delivery.id)).id);
    const second = await bill((await parcel(delivery.id)).id);
    await bill((await parcel()).id);
    const voided = await request("POST", `/api/bills/${second.id}/void`, { clientRef: uuidv7(), reason: "Wrong address" });
    expect(voided.statusCode).toBe(201);
    const day = localDateKey(Date.now());
    const report = (await request("GET", `/api/reports/operations/order-types?from=${day}&to=${day}`)).json().report;
    const rows = report.tables[0].rows as Array<{ orderType: string; kind: string; bills: number; total: number; credit: number }>;
    expect(rows.find((r) => r.orderType === "Home delivery")).toMatchObject({ kind: "Delivery", bills: 2, total: 20000, credit: 20000 });
    expect(rows.find((r) => r.orderType === "Takeaway")).toMatchObject({ kind: "Takeaway", bills: 1, total: 20000 });
    expect(report.tables[0].totals).toMatchObject({ bills: 3, total: 40000 });
  });
});
