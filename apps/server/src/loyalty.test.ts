import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { uuidv7, type Bill } from "@forkflow/domain";
import { auth, createUser, freshApp, setupAdmin } from "./test-helpers.js";
import { sweepAllExpiry } from "./loyalty.js";

describe("CRM profiles, tiers and points expiry", () => {
  let app: FastifyInstance; let token: string; let productId: string;
  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 0, 15, 12));
    app = freshApp(); ({ token } = await setupAdmin(app));
    const c = await app.inject({ method: "POST", url: "/api/categories", headers: auth(token), payload: { name: "Food" } });
    const p = await app.inject({ method: "POST", url: "/api/products", headers: auth(token), payload: { name: "Thali", categoryId: c.json().category.id, pricePaise: 50000, gstRate: 5, kotStationId: null } });
    productId = p.json().product.id;
  });
  afterEach(async () => { vi.useRealTimers(); await app.close(); app.db.close(); });

  const request = (method: "GET" | "POST" | "PATCH" | "PUT", url: string, payload?: object, as = token) => app.inject({ method, url, headers: auth(as), ...(payload ? { payload } : {}) });
  async function customer(body: object = {}) {
    const res = await request("POST", "/api/customers", { name: "Priya", phone: "9876543210", ...body });
    expect(res.statusCode).toBe(201); return res.json().customer as { id: string; pointsBalance: number; tags: string[]; tier: { name: string } | null };
  }
  async function order(customerId: string | null, qty = 1) {
    const id = (await request("POST", "/api/orders", { clientRef: uuidv7(), type: "parcel" })).json().order.id as string;
    await request("POST", `/api/orders/${id}/items`, { items: [{ productId, qty, clientRef: uuidv7() }] });
    if (customerId) expect((await request("PATCH", `/api/orders/${id}/customer`, { customerId })).statusCode).toBe(200);
    return id;
  }
  async function previewOf(orderId: string, extra: Record<string, unknown> = {}) {
    return request("POST", `/api/orders/${orderId}/bill-preview`, extra);
  }
  async function bill(orderId: string, extra: Record<string, unknown> = {}) {
    const preview = await previewOf(orderId, extra);
    expect(preview.statusCode).toBe(200);
    const res = await request("POST", `/api/orders/${orderId}/bill`, { clientRef: uuidv7(), previewKey: preview.json().preview.previewKey, ...extra });
    expect(res.statusCode).toBe(201); return res.json().bill as Bill;
  }
  const loyalty = (body: object) => request("PUT", "/api/loyalty-settings", { enabled: true, pointsPer100: 1, pointValuePaise: 100, minRedeemPoints: 0, ...body });
  const profile = async (id: string) => (await request("GET", `/api/customers/${id}`)).json();
  /** Moves the clock and keeps the signed-in session alive across the jump. */
  const travel = (to: Date) => { vi.setSystemTime(to); app.db.prepare("UPDATE sessions SET expires_at = ?").run(to.getTime() + 86_400_000); };

  it("keeps profile fields and tags, hides inactive customers from search and from new orders", async () => {
    const priya = await customer({ email: "Priya@Example.com", birthDate: "--03-14", tags: ["Vegan", "VIP"], marketingOptIn: true });
    expect(priya).toMatchObject({ tags: ["Vegan", "VIP"] });
    const updated = (await request("PATCH", `/api/customers/${priya.id}`, { tags: ["Jain"], anniversaryDate: "2019-11-02" })).json().customer;
    expect(updated).toMatchObject({ email: "priya@example.com", birthDate: "--03-14", anniversaryDate: "2019-11-02", tags: ["Jain"], marketingOptIn: true, isActive: true });
    expect((await request("GET", "/api/customers?tag=jain")).json().customers).toHaveLength(1);
    expect((await request("GET", "/api/customer-tags")).json().tags).toEqual([{ tag: "Jain", count: 1 }]);

    await request("PATCH", `/api/customers/${priya.id}`, { isActive: false });
    expect((await request("GET", "/api/customers?q=priya")).json().customers).toHaveLength(0);
    expect((await request("GET", "/api/customers?q=priya&inactive=1")).json().customers).toHaveLength(1);
    const id = await order(null);
    expect((await request("PATCH", `/api/orders/${id}/customer`, { customerId: priya.id })).statusCode).toBe(409);
  });

  it("shows visits, spend net of refunds, favourite items and paged bills on the profile", async () => {
    const priya = await customer();
    await bill(await order(priya.id, 2));
    await bill(await order(priya.id, 1));
    const body = await profile(priya.id);
    expect(body.stats).toMatchObject({ visits: 2, spendPaise: 150000, averageBillPaise: 75000, favourites: [{ name: "Thali", qty: 3 }] });
    expect(body.bills).toHaveLength(2);
    expect(body.moreBills).toBe(false);
    const older = (await request("GET", `/api/customers/${priya.id}?billsBefore=${body.bills[0].createdAt}`)).json();
    expect(older.bills.length).toBeLessThan(2);
  });

  it("works out the tier from spend in the window and multiplies the points it earns", async () => {
    await loyalty({ tiersEnabled: true, tierWindowMonths: 12 });
    expect((await request("POST", "/api/loyalty-tiers", { name: "Silver", minSpendPaise: 0 })).statusCode).toBe(201);
    expect((await request("POST", "/api/loyalty-tiers", { name: "Gold", minSpendPaise: 100000, earnMultiplier: 2 })).statusCode).toBe(201);
    expect((await request("POST", "/api/loyalty-tiers", { name: "gold", minSpendPaise: 1 })).statusCode).toBe(409);
    const cashier = await createUser(app, token, { name: "Meena", pin: "3333", role: "cashier" });
    expect((await request("POST", "/api/loyalty-tiers", { name: "Bronze", minSpendPaise: 0 }, cashier.token)).statusCode).toBe(403);

    const priya = await customer();
    expect(priya.tier?.name).toBe("Silver");
    const first = await bill(await order(priya.id, 2)); // ₹1,000 (GST included): 10 points at 1×
    expect(first.receipt.customer).toMatchObject({ tierName: "Silver", pointsEarned: 10 });
    const second = await bill(await order(priya.id, 2)); // now Gold: 10 × 2
    expect(second.receipt.customer).toMatchObject({ tierName: "Gold", pointsEarned: 20 });
    expect((await profile(priya.id)).tier).toMatchObject({ name: "Gold", next: null });

    // Spend older than the window no longer counts.
    travel(new Date(2027, 1, 1, 12));
    expect((await profile(priya.id)).customer.tier.name).toBe("Silver");
    // With tiers off, nobody has a tier and points earn at 1×.
    await loyalty({ tiersEnabled: false });
    expect((await profile(priya.id)).customer.tier).toBeNull();
  });

  it("expires points N months after earning, oldest first, and never lets expired points be redeemed", async () => {
    await loyalty({ expiryMonths: 1 });
    const priya = await customer();
    await bill(await order(priya.id, 2)); // 10 points, expire 15 Feb
    travel(new Date(2026, 1, 1, 12));
    await bill(await order(priya.id, 2)); // 10 more, expire 1 Mar
    expect((await profile(priya.id)).expiringSoon).toMatchObject({ points: 20 });

    travel(new Date(2026, 1, 20, 12));
    // Before any sweep, the balance already leaves out the first 10 points.
    const id = await order(priya.id);
    expect((await request("GET", `/api/orders/${id}`)).json().order.customer.pointsBalance).toBe(10);
    expect((await previewOf(id, { redeemPoints: 11 })).statusCode).toBe(400);
    expect(sweepAllExpiry(app.db)).toBe(10);
    expect(sweepAllExpiry(app.db)).toBe(0);
    const ledger = (await profile(priya.id)).ledger as Array<{ kind: string; points: number }>;
    expect(ledger.filter((l) => l.kind === "expire").map((l) => l.points)).toEqual([-10]);

    // Redeeming 5 uses the second lot, so 5 are left to expire on 1 March.
    await bill(id, { redeemPoints: 5 });
    travel(new Date(2026, 2, 2, 12));
    expect(sweepAllExpiry(app.db)).toBe(5);
    // Left: the 4 points the 20 February bill earned (₹495), which expire on 20 March.
    expect((await profile(priya.id)).customer.pointsBalance).toBe(4);
  });

  it("does not take back points on a void when they have already expired", async () => {
    await loyalty({ expiryMonths: 1 });
    const priya = await customer();
    const first = await bill(await order(priya.id, 2)); // 10 points, expire 15 Feb
    travel(new Date(2026, 1, 20, 12));
    expect(sweepAllExpiry(app.db)).toBe(10);
    expect((await request("POST", `/api/bills/${first.id}/void`, { clientRef: uuidv7(), reason: "Wrong order", refunds: [] })).statusCode).toBe(201);
    expect((await profile(priya.id)).customer.pointsBalance).toBe(0);
  });

  it("caps how much of a bill points may pay and reports the most that can be redeemed", async () => {
    await loyalty({ maxRedeemPercent: 20 });
    const priya = await customer();
    await request("POST", `/api/customers/${priya.id}/loyalty-adjustments`, { clientRef: uuidv7(), points: 500, note: "Welcome" });
    const id = await order(priya.id); // ₹500 subtotal: 20% is ₹100 = 100 points
    const preview = await previewOf(id);
    expect(preview.json().preview.maxRedeemPoints).toBe(100);
    const over = await previewOf(id, { redeemPoints: 101 });
    expect(over.statusCode).toBe(400);
    expect(over.json().error).toMatch(/20%.*100 points/);
    expect((await bill(id, { redeemPoints: 100 })).receipt.customer).toMatchObject({ pointsRedeemed: 100 });
  });

  it("keeps the old settings when an older client saves only the first four", async () => {
    await loyalty({ expiryMonths: 6, tiersEnabled: true, maxRedeemPercent: 50, feedbackEnabled: true });
    const res = await request("PUT", "/api/loyalty-settings", { enabled: true, pointsPer100: 2, pointValuePaise: 100, minRedeemPoints: 0 });
    expect(res.json().settings).toMatchObject({ pointsPer100: 2, expiryMonths: 6, tiersEnabled: true, maxRedeemPercent: 50, feedbackEnabled: true });
  });

  it("dates positive adjustments for expiry and takes negative ones from the oldest points", async () => {
    await loyalty({ expiryMonths: 2 });
    const priya = await customer();
    await request("POST", `/api/customers/${priya.id}/loyalty-adjustments`, { clientRef: uuidv7(), points: 30, note: "Goodwill" });
    await request("POST", `/api/customers/${priya.id}/loyalty-adjustments`, { clientRef: uuidv7(), points: -10, note: "Correction" });
    travel(new Date(2026, 2, 16, 12));
    expect(sweepAllExpiry(app.db)).toBe(20);
    expect((await profile(priya.id)).customer.pointsBalance).toBe(0);
  });
});
