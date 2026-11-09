import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { uuidv7 } from "@masalapos/domain";
import { auth, freshApp, setupAdmin } from "./test-helpers.js";

/** Local wall-clock time on a fixed date, so the tests do not depend on the machine's time zone. */
const at = (y: number, m: number, d: number, h: number, min = 0) => new Date(y, m - 1, d, h, min).getTime();

describe("business day start hour", () => {
  let app: FastifyInstance;
  let token: string;
  let productId: string;
  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(at(2026, 11, 9, 20));
    app = freshApp();
    ({ token } = await setupAdmin(app));
    const station = (await app.inject({ url: "/api/kot-stations", headers: auth(token) })).json().stations[0].id as string;
    const category = await app.inject({ method: "POST", url: "/api/categories", headers: auth(token), payload: { name: "Food" } });
    const product = await app.inject({ method: "POST", url: "/api/products", headers: auth(token), payload: { name: "Meal", categoryId: category.json().category.id, pricePaise: 10500, gstRate: 5, kotStationId: station } });
    productId = product.json().product.id;
  });
  afterEach(async () => { vi.useRealTimers(); await app.close(); });

  const startAt = (dayStartHour: number) => app.inject({ method: "PUT", url: "/api/settings", headers: auth(token), payload: { restaurantName: "Cafe Test", dayStartHour } });
  async function orderWithItem() {
    const created = await app.inject({ method: "POST", url: "/api/orders", headers: auth(token), payload: { clientRef: uuidv7(), type: "parcel", tableId: null } });
    const id = created.json().order.id as string;
    await app.inject({ method: "POST", url: `/api/orders/${id}/items`, headers: auth(token), payload: { items: [{ productId, qty: 1, clientRef: uuidv7() }] } });
    return id;
  }
  async function billAt(ms: number) {
    vi.setSystemTime(ms);
    const id = await orderWithItem();
    await app.inject({ method: "POST", url: `/api/orders/${id}/send`, headers: auth(token) });
    const preview = await app.inject({ method: "POST", url: `/api/orders/${id}/bill-preview`, headers: auth(token), payload: { discountPaise: 0 } });
    expect(preview.statusCode, preview.body).toBe(200);
    const bill = await app.inject({ method: "POST", url: `/api/orders/${id}/bill`, headers: auth(token), payload: { clientRef: uuidv7(), previewKey: preview.json().preview.previewKey, discountPaise: 0 } });
    expect(bill.statusCode, bill.body).toBe(201);
    return bill.json().bill as { totalPaise: number };
  }
  async function kotNumberAt(ms: number) {
    vi.setSystemTime(ms);
    const id = await orderWithItem();
    const sent = await app.inject({ method: "POST", url: `/api/orders/${id}/send`, headers: auth(token) });
    expect(sent.statusCode, sent.body).toBe(200);
    return sent.json().kots[0].kotNo as number;
  }

  it("puts a 1:30 a.m. bill on the night before in the day-end and sales reports", async () => {
    expect((await startAt(4)).statusCode).toBe(200);
    await billAt(at(2026, 11, 9, 21));
    await billAt(at(2026, 11, 10, 1, 30));
    await billAt(at(2026, 11, 10, 9));
    const dayEnd = (date: string) => app.inject({ url: `/api/reports/day-end?date=${date}`, headers: auth(token) }).then((r) => r.json().report.sales.billCount as number);
    expect(await dayEnd("2026-11-09")).toBe(2);
    expect(await dayEnd("2026-11-10")).toBe(1);
    const sales = (await app.inject({ url: "/api/reports/sales?from=2026-11-09&to=2026-11-10", headers: auth(token) })).json().report;
    expect(sales.daily.map((d: { date: string; sales: { billCount: number } }) => [d.date, d.sales.billCount])).toEqual([["2026-11-09", 2], ["2026-11-10", 1]]);
  });

  it("keeps the calendar date when the day starts at midnight", async () => {
    await billAt(at(2026, 11, 9, 21));
    await billAt(at(2026, 11, 10, 1, 30));
    const dayEnd = (date: string) => app.inject({ url: `/api/reports/day-end?date=${date}`, headers: auth(token) }).then((r) => r.json().report.sales.billCount as number);
    expect(await dayEnd("2026-11-09")).toBe(1);
    expect(await dayEnd("2026-11-10")).toBe(1);
  });

  it("treats the night before as today until the start hour, for day close and report defaults", async () => {
    await startAt(4);
    vi.setSystemTime(at(2026, 11, 10, 1, 30));
    expect((await app.inject({ url: "/api/day-close", headers: auth(token) })).json()).toMatchObject({ date: "2026-11-09" });
    expect((await app.inject({ url: "/api/reports/day-end", headers: auth(token) })).json().report.date).toBe("2026-11-09");
    expect((await app.inject({ url: "/api/reports/sales", headers: auth(token) })).json().report).toMatchObject({ to: "2026-11-09", today: "2026-11-09" });
    // The 10th has not started yet, so it cannot be closed.
    const close = await app.inject({ method: "POST", url: "/api/day-close", headers: auth(token), payload: { clientRef: uuidv7(), date: "2026-11-10" } });
    expect(close.statusCode).toBe(400);
  });

  it("keeps counting KOT numbers past midnight until the start hour", async () => {
    await startAt(4);
    expect(await kotNumberAt(at(2026, 11, 9, 23, 30))).toBe(1);
    expect(await kotNumberAt(at(2026, 11, 10, 1, 30))).toBe(2);
    expect(await kotNumberAt(at(2026, 11, 10, 4, 5))).toBe(1);
  });
});
