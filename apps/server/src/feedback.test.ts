import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { uuidv7, type Bill } from "@forkflow/domain";
import { auth, createUser, enableIntegration, freshApp, setupAdmin } from "./test-helpers.js";
import { receiptHtml } from "./print/receipt.js";

describe("bill feedback", () => {
  let app: FastifyInstance; let token: string; let productId: string;
  beforeEach(async () => {
    app = freshApp(); ({ token } = await setupAdmin(app)); enableIntegration(app, "crm");
    const c = await app.inject({ method: "POST", url: "/api/categories", headers: auth(token), payload: { name: "Food" } });
    const p = await app.inject({ method: "POST", url: "/api/products", headers: auth(token), payload: { name: "Thali", categoryId: c.json().category.id, pricePaise: 50000, gstRate: 5, kotStationId: null } });
    productId = p.json().product.id;
  });
  afterEach(async () => { vi.useRealTimers(); await app.close(); app.db.close(); });

  const request = (method: "GET" | "POST" | "PUT", url: string, payload?: object, as = token) => app.inject({ method, url, headers: auth(as), ...(payload ? { payload } : {}) });
  const guest = (method: "GET" | "POST", url: string, payload?: object) => app.inject({ method, url, ...(payload ? { payload } : {}) });
  const feedbackOn = (on = true) => request("PUT", "/api/loyalty-settings", { enabled: false, pointsPer100: 1, pointValuePaise: 100, minRedeemPoints: 0, feedbackEnabled: on });
  async function bill(customerId?: string) {
    const id = (await request("POST", "/api/orders", { clientRef: uuidv7(), type: "parcel" })).json().order.id as string;
    await request("POST", `/api/orders/${id}/items`, { items: [{ productId, qty: 1, clientRef: uuidv7() }] });
    if (customerId) await app.inject({ method: "PATCH", url: `/api/orders/${id}/customer`, headers: auth(token), payload: { customerId } });
    const preview = await request("POST", `/api/orders/${id}/bill-preview`, {});
    const res = await request("POST", `/api/orders/${id}/bill`, { clientRef: uuidv7(), previewKey: preview.json().preview.previewKey });
    expect(res.statusCode).toBe(201); return res.json().bill as Bill;
  }
  const tokenOf = (b: Bill) => b.feedbackUrl!.split("/feedback/")[1]!;

  it("puts a feedback QR on receipts only while feedback is on", async () => {
    expect((await bill()).feedbackUrl).toBeUndefined();
    await feedbackOn();
    const b = await bill();
    expect(b.feedbackUrl).toMatch(/^http:\/\/[^/]+\/feedback\/[A-Za-z0-9_-]{32}$/);
    expect(receiptHtml(b)).toContain("Rate your visit");
    await feedbackOn(false);
    expect((await request("GET", `/api/orders/${b.orderId}/bill`)).json().bill.feedbackUrl).toBeUndefined();
    expect((await guest("GET", `/api/guest/feedback/${tokenOf(b)}`)).statusCode).toBe(404);
  });

  it("takes one rating per bill from the QR link, linked to the bill's customer", async () => {
    await feedbackOn();
    const priya = (await request("POST", "/api/customers", { name: "Priya", phone: "9876543210" })).json().customer;
    const b = await bill(priya.id);
    const link = `/api/guest/feedback/${tokenOf(b)}`;
    expect((await guest("GET", link)).json()).toMatchObject({ restaurantName: "Cafe Test", billNo: b.billNo, submitted: false, open: true });
    expect((await guest("POST", link, { overall: 6 })).statusCode).toBe(400);
    expect((await guest("POST", link, { overall: 4, food: 5, comment: "  Lovely thali " })).statusCode).toBe(201);
    expect((await guest("POST", link, { overall: 1 })).statusCode).toBe(409);
    expect((await guest("GET", link)).json().submitted).toBe(true);
    expect((await guest("GET", "/api/guest/feedback/not-a-real-token-at-all-0000000")).statusCode).toBe(404);

    const list = (await request("GET", "/api/feedback")).json();
    expect(list.feedback).toEqual([expect.objectContaining({ overall: 4, food: 5, comment: "Lovely thali", source: "qr", customerName: "Priya", billNo: b.billNo })]);
    expect(list.summary).toMatchObject({ count: 1, average: 4 });
    expect((await request("GET", `/api/customers/${priya.id}`)).json().feedback).toHaveLength(1);
  });

  it("closes the link after seven days and refuses void bills", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 3, 1, 12));
    await feedbackOn();
    const b = await bill();
    vi.setSystemTime(new Date(2026, 3, 9, 12));
    app.db.prepare("UPDATE sessions SET expires_at = ?").run(Date.now() + 86_400_000);
    const link = `/api/guest/feedback/${tokenOf(b)}`;
    expect((await guest("GET", link)).json().open).toBe(false);
    expect((await guest("POST", link, { overall: 5 })).statusCode).toBe(410);
    const fresh = await bill();
    expect((await request("POST", `/api/bills/${fresh.id}/void`, { clientRef: uuidv7(), reason: "Wrong order", refunds: [] })).statusCode).toBe(201);
    expect((await guest("GET", `/api/guest/feedback/${tokenOf(fresh)}`)).statusCode).toBe(404);
  });

  it("lets cashiers record feedback by hand, but not waiters", async () => {
    const b = await bill();
    const cashier = await createUser(app, token, { name: "Meena", pin: "3333", role: "cashier" });
    const waiter = await createUser(app, token, { name: "Arun", pin: "5555", role: "waiter" });
    expect((await request("POST", `/api/bills/${b.id}/feedback`, { overall: 3 }, waiter.token)).statusCode).toBe(403);
    expect((await request("POST", `/api/bills/${b.id}/feedback`, { overall: 3, service: 2 }, cashier.token)).statusCode).toBe(201);
    expect((await request("POST", `/api/bills/${b.id}/feedback`, { overall: 5 }, cashier.token)).statusCode).toBe(409);
    expect((await request("GET", "/api/feedback?maxRating=3")).json().feedback).toEqual([expect.objectContaining({ source: "staff", recordedBy: "Meena" })]);
  });
});
