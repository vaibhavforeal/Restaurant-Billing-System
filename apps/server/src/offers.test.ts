import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { uuidv7, type Offer, type OfferInputValue } from "@masalapos/domain";
import { auth, commercialApp, createUser, enableIntegration, freshAppWithFakeSink, setupAdmin } from "./test-helpers.js";
import { setModuleEnabled } from "./modules.js";
import { loadOffers } from "./offers.js";

type Listed = Offer & { bills30d: number; used: boolean };

const DAY_MS = 24 * 60 * 60 * 1000;
/** Every field an offer has, at its default; each kind below overrides what it uses. */
const base = {
  active: true, buyQty: null, getQty: null, sameItemOnly: false, percentBp: null, amountPaise: null, minBillPaise: 0, maxDiscountPaise: null,
  categoryIds: [], productIds: [], validFrom: null, validUntil: null, days: [0, 1, 2, 3, 4, 5, 6], timeFrom: null, timeUntil: null, orderTypeIds: [],
} satisfies Omit<OfferInputValue, "name" | "kind">;

describe("offers API", () => {
  let app: FastifyInstance; let token: string; let adminId: string;
  let pizzas: string; let margherita: string; let cola: string;

  beforeEach(async () => {
    ({ app } = freshAppWithFakeSink());
    const admin = await setupAdmin(app); token = admin.token; adminId = admin.user.id;
    enableIntegration(app, "offers");
    pizzas = (await post("/api/categories", { name: "Pizzas" })).json().category.id;
    margherita = await product("Margherita", 25000);
    cola = await product("Cola", 5000);
  });
  afterEach(async () => { await app.close(); app.db.close(); });

  const send = (method: "POST" | "PUT" | "PATCH" | "DELETE", url: string, payload?: object, as = token) =>
    app.inject({ method, url, headers: auth(as), ...(payload ? { payload } : {}) });
  const post = (url: string, payload: object) => send("POST", url, payload);
  const list = async (as = token) => (await app.inject({ url: "/api/offers", headers: auth(as) })).json().offers as Listed[];
  async function product(name: string, pricePaise: number) {
    const res = await post("/api/products", { name, categoryId: pizzas, pricePaise, gstRate: 5, kotStationId: null });
    expect(res.statusCode, res.body).toBe(201);
    return res.json().product.id as string;
  }
  const bogo = (): OfferInputValue => ({
    ...base, name: "BOGO Pizza", kind: "buy_get", buyQty: 1, getQty: 1, percentBp: 10000, sameItemOnly: true,
    categoryIds: [pizzas], productIds: [cola], validFrom: "2026-11-01", validUntil: "2026-11-30", days: [0, 1, 2, 3], timeFrom: 900, timeUntil: 1080, orderTypeIds: ["dine_in"],
  });
  const colaOff = (): OfferInputValue => ({ ...base, name: "Cola 5 off", kind: "item_off", amountPaise: 500, productIds: [cola] });
  const bigBill = (): OfferInputValue => ({
    ...base, name: "Big Bill", kind: "bill_off", percentBp: 1000, minBillPaise: 50000, maxDiscountPaise: 20000, days: [4, 5, 6], timeFrom: 1320, timeUntil: 120,
  });
  async function create(offer: OfferInputValue) {
    const res = await post("/api/offers", offer);
    expect(res.statusCode, res.body).toBe(201);
    return res.json().offer as Offer;
  }
  /** A bill for one Margherita, with the offer recorded on it. */
  async function billWith(offerId: string, adjust: { daysAgo?: number; status?: string } = {}) {
    const order = (await post("/api/orders", { clientRef: uuidv7(), type: "parcel", tableId: null })).json().order.id as string;
    expect((await post(`/api/orders/${order}/items`, { items: [{ productId: margherita, qty: 1, clientRef: uuidv7() }] })).statusCode).toBe(200);
    const preview = await post(`/api/orders/${order}/bill-preview`, { discountPaise: 0 });
    const issued = await post(`/api/orders/${order}/bill`, { clientRef: uuidv7(), previewKey: preview.json().preview.previewKey, discountPaise: 0 });
    expect(issued.statusCode, issued.body).toBe(201);
    const billId = issued.json().bill.id as string;
    if (adjust.daysAgo) app.db.prepare("UPDATE bills SET created_at = ? WHERE id = ?").run(Date.now() - adjust.daysAgo * DAY_MS, billId);
    if (adjust.status) app.db.prepare("UPDATE bills SET status = ? WHERE id = ?").run(adjust.status, billId);
    app.db.prepare("INSERT INTO bill_offers (bill_id, offer_id, name, discount_paise) VALUES (?, ?, 'Offer', 100)").run(billId, offerId);
    return billId;
  }
  const rows = (table: "offer_targets" | "offer_order_types", offerId: string) =>
    (app.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE offer_id = ?`).get(offerId) as { n: number }).n;

  it("creates each kind and reads it back field for field", async () => {
    const inputs = [bogo(), colaOff(), bigBill()];
    for (const input of inputs) {
      expect(await create(input)).toEqual({ ...input, id: expect.any(String), createdAt: expect.any(Number) });
    }
    const listed = await list();
    expect(listed).toHaveLength(3);
    inputs.forEach((input, i) => expect(listed[i]).toEqual({ ...input, id: expect.any(String), createdAt: expect.any(Number), bills30d: 0, used: false }));
  });

  it("fills in the defaults for a short body", async () => {
    const res = await post("/api/offers", { name: "Cola 10% off", kind: "item_off", percentBp: 1000, productIds: [cola] });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().offer).toMatchObject({ active: true, sameItemOnly: false, minBillPaise: 0, days: [0, 1, 2, 3, 4, 5, 6], orderTypeIds: [], categoryIds: [] });
  });

  it("loadOffers returns every offer, switched off ones too, with targets and order types", async () => {
    const first = await create(bogo());
    const second = await create({ ...colaOff(), active: false, orderTypeIds: ["parcel", "dine_in"] });
    expect(loadOffers(app.db)).toEqual([first, { ...second, active: false }]);
    expect(loadOffers(app.db)[1]!.orderTypeIds).toEqual(["parcel", "dine_in"]);
  });

  it("replaces an offer's fields, targets and order types on PUT", async () => {
    const created = await create(bogo());
    app.db.prepare("UPDATE offers SET updated_at = 0 WHERE id = ?").run(created.id);
    const changed: OfferInputValue = { ...colaOff(), name: "Changed", orderTypeIds: ["parcel"], days: [5, 6], timeFrom: 60, timeUntil: 120 };
    const res = await send("PUT", `/api/offers/${created.id}`, changed);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().offer).toEqual({ ...changed, id: created.id, createdAt: created.createdAt });
    expect(await list()).toEqual([{ ...changed, id: created.id, createdAt: created.createdAt, bills30d: 0, used: false }]);
    expect(rows("offer_targets", created.id)).toBe(1);
    expect(rows("offer_order_types", created.id)).toBe(1);
    expect((app.db.prepare("SELECT updated_at FROM offers WHERE id = ?").get(created.id) as { updated_at: number }).updated_at).toBeGreaterThan(0);
    expect((await send("PUT", "/api/offers/missing", changed)).statusCode).toBe(404);
  });

  it("switches an offer on and off", async () => {
    const created = await create(colaOff());
    app.db.prepare("UPDATE offers SET updated_at = 0 WHERE id = ?").run(created.id);
    const off = await send("PATCH", `/api/offers/${created.id}/active`, { active: false });
    expect(off.statusCode, off.body).toBe(200);
    expect(off.json().offer).toEqual({ ...colaOff(), active: false, id: created.id, createdAt: created.createdAt });
    expect((await list())[0]!.active).toBe(false);
    expect((app.db.prepare("SELECT updated_at FROM offers WHERE id = ?").get(created.id) as { updated_at: number }).updated_at).toBeGreaterThan(0);
    expect((await send("PATCH", `/api/offers/${created.id}/active`, { active: true })).json().offer.active).toBe(true);
    expect((await send("PATCH", `/api/offers/${created.id}/active`, { active: "yes" })).statusCode).toBe(400);
    expect((await send("PATCH", "/api/offers/missing/active", { active: false })).statusCode).toBe(404);
  });

  it("rejects what the menu cannot back", async () => {
    const created = await create(colaOff());
    const rejected = async (offer: Partial<OfferInputValue>, message: string) => {
      for (const res of [await post("/api/offers", { ...bogo(), ...offer }), await send("PUT", `/api/offers/${created.id}`, { ...bogo(), ...offer })]) {
        expect(res.statusCode, res.body).toBe(400);
        expect(res.json().error).toBe(message);
      }
    };
    await rejected({ categoryIds: ["missing"] }, "Pick categories and items from the menu");
    await rejected({ productIds: ["missing"] }, "Pick categories and items from the menu");
    await rejected({ orderTypeIds: ["zomato"] }, "Zomato orders can't have offers");
    await rejected({ orderTypeIds: ["dine_in", "zomato"] }, "Zomato orders can't have offers");
    await rejected({ orderTypeIds: ["missing"] }, "Pick order types from the list");
    expect(await list()).toHaveLength(1);
    expect((await list())[0]).toMatchObject({ name: "Cola 5 off" });
  });

  it("rejects an offer that breaks the offer rules", async () => {
    for (const bad of [{ ...bogo(), categoryIds: [], productIds: [] }, { ...bigBill(), productIds: [cola] }, { ...colaOff(), percentBp: 1000 }, { ...bogo(), name: " " }]) {
      const res = await post("/api/offers", bad);
      expect(res.statusCode, res.body).toBe(400);
      expect(res.json().error).toBe("validation");
    }
    expect(await list()).toEqual([]);
  });

  it("lets a cashier read offers but not change them", async () => {
    const cashier = await createUser(app, token, { name: "Cashier", pin: "3333", role: "cashier" });
    const kitchen = await createUser(app, token, { name: "Kitchen", pin: "4444", role: "kitchen" });
    const created = await create(colaOff());
    expect(await list(cashier.token)).toHaveLength(1);
    expect((await send("POST", "/api/offers", colaOff(), cashier.token)).statusCode).toBe(403);
    expect((await send("PUT", `/api/offers/${created.id}`, colaOff(), cashier.token)).statusCode).toBe(403);
    expect((await send("PATCH", `/api/offers/${created.id}/active`, { active: false }, cashier.token)).statusCode).toBe(403);
    expect((await send("DELETE", `/api/offers/${created.id}`, undefined, cashier.token)).statusCode).toBe(403);
    expect((await app.inject({ url: "/api/offers", headers: auth(kitchen.token) })).statusCode).toBe(403);
    expect((await app.inject({ url: "/api/offers" })).statusCode).toBe(401);
    expect(await list()).toHaveLength(1);
  });

  it("refuses every route while the Offers module is switched off", async () => {
    const created = await create(colaOff());
    setModuleEnabled(app, "offers", false, adminId);
    const responses = [
      await app.inject({ url: "/api/offers", headers: auth(token) }),
      await send("POST", "/api/offers", colaOff()),
      await send("PUT", `/api/offers/${created.id}`, colaOff()),
      await send("PATCH", `/api/offers/${created.id}/active`, { active: false }),
      await send("DELETE", `/api/offers/${created.id}`),
    ];
    for (const res of responses) {
      expect(res.statusCode, res.body).toBe(409);
      expect(res.json().code).toBe("module_off");
    }
  });

  it("refuses the routes when the licence leaves Offers out", async () => {
    const f = await commercialApp("basic", { offers: false });
    try {
      const res = await f.app.inject({ url: "/api/offers", headers: f.headers });
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe("module_off");
    } finally { await f.app.close(); f.app.db.close(); }
  });

  it("deletes an offer nothing has used, with its targets and order types", async () => {
    const created = await create(bogo());
    expect((await send("DELETE", "/api/offers/missing")).statusCode).toBe(404);
    const res = await send("DELETE", `/api/offers/${created.id}`);
    expect(res.statusCode, res.body).toBe(204);
    expect(await list()).toEqual([]);
    expect(rows("offer_targets", created.id)).toBe(0);
    expect(rows("offer_order_types", created.id)).toBe(0);
  });

  it("refuses to delete an offer that is on a bill, which can be switched off instead", async () => {
    const created = await create(bogo());
    await billWith(created.id);
    const res = await send("DELETE", `/api/offers/${created.id}`);
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json()).toEqual({ error: "This offer is on bills; switch it off instead", code: "offer_used" });
    expect((await list())[0]).toMatchObject({ id: created.id, used: true });
    expect(rows("offer_targets", created.id)).toBe(2);
    expect((await send("PATCH", `/api/offers/${created.id}/active`, { active: false })).statusCode).toBe(200);
  });

  it("counts an offer's bills of the last 30 days, leaving out void bills", async () => {
    const busy = await create(bogo()); const quiet = await create(colaOff()); const old = await create(bigBill());
    await billWith(busy.id); await billWith(busy.id, { daysAgo: 29 });
    await billWith(busy.id, { daysAgo: 31 }); await billWith(busy.id, { status: "void" });
    await billWith(old.id, { daysAgo: 45 });
    const listed = new Map((await list()).map((o) => [o.id, o]));
    expect(listed.get(busy.id)).toMatchObject({ bills30d: 2, used: true });
    expect(listed.get(quiet.id)).toMatchObject({ bills30d: 0, used: false });
    expect(listed.get(old.id)).toMatchObject({ bills30d: 0, used: true });
  });
});
