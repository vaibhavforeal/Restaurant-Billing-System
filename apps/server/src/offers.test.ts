import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { uuidv7, type Bill } from "@masalapos/domain";
import type { OfferRule } from "@masalapos/domain/offers";
import { auth, createTradingUser, enableIntegration, freshApp, setupTradingAdmin } from "./test-helpers.js";
import { receiptHtml, receiptSlip } from "./print/receipt.js";

let app: ReturnType<typeof freshApp>, token: string, meal: string, soda: string;
const request = (method: "GET" | "POST" | "PUT" | "PATCH", url: string, payload?: object) =>
  app.inject({ method, url, headers: auth(token), ...(payload ? { payload } : {}) });
const rule: OfferRule = { name: "Lunch offer", state: "active", benefit: { kind: "percent", percent: 10 }, minimumPaise: 0,
  kinds: ["takeaway"], weekdays: [0,1,2,3,4,5,6], firstDate: null, lastDate: null, startTime: null, endTime: null };
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 10, 20, 12));
  app = freshApp(); ({ token } = await setupTradingAdmin(app));
  const categoryId = (await request("POST", "/api/categories", { name: "Lunch" })).json().category.id;
  const product = async (name: string, pricePaise: number, gstRate: number) => (await request("POST", "/api/products",
    { name, pricePaise, gstRate, categoryId, kotStationId: null })).json().product.id as string;
  meal = await product("Meal", 10500, 5); soda = await product("Soda", 2000, 18);
});
afterEach(async () => { vi.useRealTimers(); await app.close(); app.db.close(); });
async function basket() {
  const id = (await request("POST", "/api/orders", { clientRef: uuidv7(), type: "parcel" })).json().order.id as string;
  await request("POST", `/api/orders/${id}/items`, { items: [{ productId: meal, qty: 2 }, { productId: soda, qty: 1 }] });
  return id;
}

it("gates offer management and rejects a stale rule edit or bill preview", async () => {
  expect((await request("GET", "/api/offers")).statusCode).toBe(409);
  enableIntegration(app, "offers");
  const staff = await createTradingUser(app, token, { name:"Cara", role:"cashier", pin:"9876" });
  expect((await app.inject({ url:"/api/offers", headers:auth(staff.token) })).statusCode).toBe(403);
  const offer = (await request("POST", "/api/offers", rule)).json().id;
  const id = await basket();
  const preview = (await request("POST", `/api/orders/${id}/bill-preview`, {})).json().preview;
  expect(preview.receipt.offer.savingPaise).toBe(2300);
  const edit = { revision: 1, rule: { ...rule, state: "paused" } };
  expect((await request("PUT", "/api/offers/" + offer, edit)).statusCode).toBe(200);
  expect((await request("PUT", "/api/offers/" + offer, edit)).statusCode).toBe(409);
  expect((await request("POST", `/api/orders/${id}/bill`, { clientRef: uuidv7(), previewKey: preview.previewKey })).statusCode).toBe(409);
  expect((await request("POST", `/api/orders/${id}/bill-preview`, {})).json().preview.discountPaise).toBe(0);
});

it("checks each split independently and expires the offer between preview and issue", async () => {
  const time = new Date();
  enableIntegration(app, "offers");
  const body = { ...rule, kinds: ["dine_in"], minimumPaise: 20000, startTime: "12:00", endTime: "12:01", clientRef: uuidv7() };
  expect((await request("POST", "/api/offers", body)).statusCode).toBe(201);
  expect((await request("POST", "/api/offers", body)).statusCode).toBe(200);
  const tableId = (await request("POST", "/api/tables", { name: "T1" })).json().table.id;
  async function split(qty: number) {
    const id = (await request("POST", "/api/orders", { type: "dine_in", tableId, clientRef: uuidv7() })).json().order.id as string;
    await request("POST", `/api/orders/${id}/items`, { items: [{ productId: meal, qty }] });
    return id;
  }
  const first = await split(1), second = await split(2);
  const preview = async (id: string) => (await request("POST", `/api/orders/${id}/bill-preview`, {})).json().preview;
  expect((await preview(first)).discountPaise).toBe(0);
  const before = await preview(second);
  expect(before.discountPaise).toBe(2100);
  vi.setSystemTime(time.getTime() + 60_000);
  expect((await request("POST", `/api/orders/${second}/bill`, { previewKey:before.previewKey, clientRef:uuidv7() })).statusCode).toBe(409);
  expect((await preview(second)).discountPaise).toBe(0);
});

it("preserves the mixed-rate BOGO allocation across issuance, replay, printing and refunds", async () => {
  enableIntegration(app, "offers");
  // Three eligible units: one paid meal earns two free items (the soda and the other meal).
  const target = (productId: string) => ({ productId, variantId:null });
  await request("POST", "/api/offers", { ...rule, benefit: { kind:"bogo", buy:1, get:2, qualifying:[target(meal)], rewards:[target(meal),target(soda)] } });
  const id = await basket();
  const preview = (await request("POST", `/api/orders/${id}/bill-preview`, {})).json().preview;
  expect(preview.receipt.offer.savingPaise).toBe(12500);
  const issue = { clientRef:uuidv7(), previewKey:preview.previewKey };
  const bill = (await request("POST", `/api/orders/${id}/bill`, issue)).json().bill as Bill;
  expect(bill.totalPaise).toBe(10500);
  expect(bill.taxes.find(t => t.gstRate === 18)).toMatchObject({ taxablePaise:0, cgstPaise:0, sgstPaise:0 });
  const lines = app.db.prepare("SELECT name, order_item_id AS id, discount_paise AS saving, total_paise AS total FROM bill_report_lines WHERE bill_id=? ORDER BY name").all(bill.id) as Array<{ id:string; saving:number; total:number }>;
  expect(lines).toMatchObject([{ saving:10500, total:10500 }, { saving:2000, total:0 }]);
  await request("PATCH","/api/integrations/offers",{ enabled:false });
  const replay = (await request("POST", `/api/orders/${id}/bill`, issue)).json().bill as Bill;
  expect(replay.receipt.offer).toEqual(preview.receipt.offer);
  expect(receiptHtml(replay)).toContain("Lunch offer");
  expect(receiptSlip(replay,58).toString()).toContain("Lunch offer");
  await request("POST", `/api/bills/${bill.id}/settle`, { clientRef:uuidv7(), payments:[{ mode:"cash", amountPaise:bill.totalPaise }] });
  const selected = [{ orderItemId:lines[0]!.id, qty:1 }];
  const credit = (await request("POST", `/api/bills/${bill.id}/credit-preview`, { kind:"refund", lines:selected })).json().preview;
  const partial = credit.totals.totalPaise;
  expect(Math.abs(partial - 5250)).toBeLessThanOrEqual(2);
  expect((await request("POST", `/api/bills/${bill.id}/refund`, { clientRef:uuidv7(), reason:"Returned", lines:selected, refunds:[{ mode:"cash", amountPaise:partial }] })).statusCode).toBe(201);
  const remaining = bill.totalPaise - partial;
  const reversal = await request("POST", `/api/bills/${bill.id}/void`, { clientRef:uuidv7(), reason:"Returned remainder", refunds:[{ mode:"cash", amountPaise:remaining }] });
  expect(reversal.statusCode, reversal.body).toBe(201);
  expect(reversal.json().creditNote.totalPaise).toBe(remaining);
});

it("awards the customer slab on ties and recalculates the points cap when an offer wins", async () => {
  enableIntegration(app,"offers"); enableIntegration(app,"crm");
  await request("PUT","/api/loyalty-settings",{ enabled:true, pointsPer100:1, pointValuePaise:100, minRedeemPoints:0, maxRedeemPercent:50 });
  const type = (await request("POST","/api/customer-types",{ name:"Regular", slabs:[{ minBillPaise:0, percent:10 }] })).json().customerType.id;
  const person = (await request("POST","/api/customers",{ name:"Priya", phone:"9876543210", typeId:type })).json().customer;
  const id = await basket();
  await request("PATCH", `/api/orders/${id}/customer`, { customerId:person.id });
  await request("POST", `/api/customers/${person.id}/loyalty-adjustments`, { clientRef: uuidv7(), points: 500, note: "Welcome" });
  const offer = (await request("POST","/api/offers",rule)).json().id;
  const preview = async () => (await request("POST", `/api/orders/${id}/bill-preview`, { discountPaise:1000, discountNote:"Service" })).json().preview;
  expect((await preview()).receipt.customer.customerDiscountPaise).toBe(2300);
  await request("PUT","/api/offers/"+offer,{ revision:1, rule:{ ...rule, benefit:{ kind:"percent", percent:50 } } });
  const result = await preview();
  expect(result.maxRedeemPoints).toBe(52);
  expect(result.discountPaise).toBe(12500);
  expect(result.receipt.offer.savingPaise).toBe(11500);
  expect(result.receipt.customer.customerDiscountPaise).toBeUndefined();
});
