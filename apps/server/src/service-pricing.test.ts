import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { auth, freshAppWithFakeSink, setupAdmin } from "./test-helpers.js";
import { localMinute } from "./reservation-rules.js";

let app: FastifyInstance, headers: { authorization: string }, categoryId: string;
const api = (method: "GET" | "POST" | "PATCH" | "PUT", url: string, payload?: object) =>
  app.inject({ method, url, headers, ...(payload === undefined ? {} : { payload }) });
async function ok(method: "GET" | "POST" | "PATCH" | "PUT", url: string, payload?: object) {
  const response = await api(method, url, payload);
  expect(response.statusCode, response.body).toBeLessThan(300);
  return response.json();
}
beforeEach(async () => {
  app = freshAppWithFakeSink().app;
  headers = auth((await setupAdmin(app)).token);
  categoryId = (await ok("POST", "/api/categories", { name: "Meals" })).category.id;
});
afterEach(async () => { await app.close(); app.db.close(); });
const product = (extra = {}) => ok("POST", "/api/products", { categoryId, name: "Meal", pricePaise: 10000, acPricePaise: 12000, takeawayPricePaise: 11000, gstRate: 5, ...extra }).then(r => r.product);
async function order(tier: "ac" | "non_ac" | "takeaway") {
  const table = tier === "takeaway" ? null : (await ok("POST", "/api/tables", { name: tier, priceTier: tier })).table;
  return (await ok("POST", "/api/orders", { clientRef: randomUUID(), type: table ? "dine_in" : "parcel", tableId: table?.id ?? null })).order;
}
const add = (id: string, productId: string, variantId: string | null = null, clientRef = randomUUID()) =>
  ok("POST", `/api/orders/${id}/items`, { items: [{ productId, variantId, qty: 2, clientRef }] });

describe("service pricing", () => {
  it.each([["non_ac", 10000], ["ac", 12000], ["takeaway", 11000]] as const)("uses %s prices through billing and freezes saved lines", async (tier, expected) => {
    const p = await product(), o = await order(tier), ref = randomUUID();
    expect(o.priceTier).toBe(tier);
    const punched = (await add(o.id, p.id, null, ref)).order;
    expect(punched.items[0].pricePaise).toBe(expected);
    await ok("PATCH", `/api/products/${p.id}`, { pricePaise: 20000, acPricePaise: 24000, takeawayPricePaise: 22000 });
    expect((await add(o.id, p.id, null, ref)).order.items).toHaveLength(1);
    const preview = (await ok("POST", `/api/orders/${o.id}/bill-preview`, {})).preview;
    expect(preview.subtotalPaise).toBe(expected * 2);
    expect(preview.totalPaise).toBe(expected * 2);
    const bill = await ok("POST", `/api/orders/${o.id}/bill`, { clientRef: randomUUID(), previewKey: preview.previewKey });
    expect(bill.bill.subtotalPaise).toBe(expected * 2);
    expect((await ok("GET", `/api/orders/${o.id}`)).order.items[0].pricePaise).toBe(expected);
  });

  it("supports variant overrides, zero prices, clearing and fallback to the portion's own price", async () => {
    const p = await product({ variants: [{ name: "Half", pricePaise: 6000, acPricePaise: 7500, takeawayPricePaise: 0 }] });
    const v = p.variants[0], ac = await order("ac"), takeaway = await order("takeaway");
    expect((await add(ac.id, p.id, v.id)).order.items[0].pricePaise).toBe(7500);
    expect((await add(takeaway.id, p.id, v.id)).order.items[0].pricePaise).toBe(0);
    await ok("PATCH", `/api/variants/${v.id}`, { name: "Half meal" });
    expect((await ok("GET", "/api/products")).products[0].variants[0].acPricePaise).toBe(7500);
    await ok("PATCH", `/api/variants/${v.id}`, { acPricePaise: null, takeawayPricePaise: null });
    expect((await add(ac.id, p.id, v.id)).order.items[1].pricePaise).toBe(6000);
    expect((await add(takeaway.id, p.id, v.id)).order.items[1].pricePaise).toBe(6000);
    await ok("PATCH", `/api/products/${p.id}`, { acPricePaise: null, takeawayPricePaise: null });
    expect((await add(ac.id, p.id)).order.items[2].pricePaise).toBe(10000);
  });

  it("rejects invalid prices and protects occupied table pricing", async () => {
    const p = await product(), o = await order("ac");
    for (const value of [-1, 1.5, "120", false]) {
      expect((await api("PATCH", `/api/products/${p.id}`, { acPricePaise: value })).statusCode).toBe(400);
    }
    expect((await api("PATCH", `/api/tables/${o.tableId}`, { priceTier: "takeaway" })).statusCode).toBe(400);
    expect((await api("PATCH", `/api/tables/${o.tableId}`, { priceTier: "non_ac" })).statusCode).toBe(409);
    await ok("POST", `/api/orders/${o.id}/cancel`, {});
    await ok("PATCH", `/api/tables/${o.tableId}`, { priceTier: "non_ac" });
    expect((await ok("GET", `/api/orders/${o.id}`)).order.priceTier).toBe("ac");
  });

  it("uses AC prices for seated reservations and additional split groups", async () => {
    const p = await product();
    const table = (await ok("POST", "/api/tables", { name: "Window", priceTier: "ac" })).table;
    const booked = await ok("POST", "/api/reservations", { clientRef: randomUUID(), tableId: table.id,
      customerName: "Guest", partySize: 2, startsLocal: localMinute(Date.now()), durationMinutes: 90 });
    const seated = await ok("POST", `/api/reservations/${booked.reservation.id}/seat`, { version: booked.reservation.version });
    expect(seated.order.priceTier).toBe("ac");
    expect((await add(seated.order.id, p.id)).order.items[0].pricePaise).toBe(12000);
    const split = (await ok("POST", "/api/orders", { clientRef: randomUUID(), tableId: table.id, type: "dine_in" })).order;
    expect(split).toMatchObject({ priceTier: "ac", splitLabel: "B" });
    expect((await add(split.id, p.id)).order.items[0].pricePaise).toBe(12000);
  });

  it("round-trips service and portion prices in CSV and preserves them in old-format imports", async () => {
    const p = await product({ variants: [{ name: "Half", pricePaise: 6000, acPricePaise: 7500, takeawayPricePaise: 0 }] });
    const exported = await ok("GET", "/api/catalog/export");
    expect(exported.csv).toContain('"variant_takeaway_price"');
    const preview = await ok("POST", "/api/catalog/import/preview", { csv: exported.csv });
    await ok("POST", "/api/catalog/import", { csv: exported.csv, revision: preview.revision });
    expect((await ok("GET", "/api/products")).products[0]).toEqual(p);
    const csv = "category,name,price,gst_rate\nMeals,Meal,105,5\n";
    const legacy = await ok("POST", "/api/catalog/import/preview", { csv });
    await ok("POST", "/api/catalog/import", { csv, revision: legacy.revision });
    expect((await ok("GET", "/api/products")).products[0]).toMatchObject({ pricePaise: 10500, acPricePaise: 12000, takeawayPricePaise: 11000 });
  });

  it("shows table-specific QR prices and accepts the same rates into a new bill", async () => {
    const p = await product({ variants: [{ name: "Half", pricePaise: 6000, acPricePaise: 7500 }] });
    const table = (await ok("POST", "/api/tables", { name: "AC room", priceTier: "ac" })).table;
    const qr = await ok("PUT", `/api/qr/tables/${table.id}`, { enabled: true });
    const guestHeaders = { "x-qr-token": qr.table.path.split("#")[1] };
    const menu = (await app.inject({ url: "/api/guest/menu", headers: guestHeaders })).json();
    expect(menu.products[0].pricePaise).toBe(12000);
    expect(menu.products[0].variants[0].pricePaise).toBe(7500);
    const response = await app.inject({ method: "POST", url: "/api/guest/requests", headers: guestHeaders, payload: {
      clientRef: randomUUID(), receiptToken: "a".repeat(64), menuVersion: menu.menuVersion,
      items: [{ productId: p.id, variantId: p.variants[0].id, qty: 1, note: "" }],
    } });
    expect(response.statusCode, response.body).toBe(201);
    const accepted = await ok("POST", `/api/qr/requests/${response.json().request.id}/accept`, { orderId: null });
    expect(accepted.order.priceTier).toBe("ac");
    expect(accepted.order.items[0].pricePaise).toBe(7500);
  });
});
