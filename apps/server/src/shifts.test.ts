import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { localDateKey, uuidv7, type Bill } from "@masalapos/domain";
import { auth, createUser, freshApp, setupAdmin } from "./test-helpers.js";

describe("shifts and day close", () => {
  let app: FastifyInstance; let token: string; let productId: string;
  let cashier: { id: string; token: string };
  const today = () => localDateKey(Date.now());
  beforeEach(async () => {
    app = freshApp(); ({ token } = await setupAdmin(app));
    const c = await app.inject({ method: "POST", url: "/api/categories", headers: auth(token), payload: { name: "Food" } });
    const p = await app.inject({ method: "POST", url: "/api/products", headers: auth(token), payload: { name: "Thali", categoryId: c.json().category.id, pricePaise: 25000, gstRate: 5, kotStationId: null } });
    productId = p.json().product.id;
    cashier = await createUser(app, token, { name: "Meena", pin: "3333", role: "cashier" });
  });
  afterEach(async () => { await app.close(); app.db.close(); });

  const request = (method: "GET" | "POST", url: string, payload?: object, as = token) => app.inject({ method, url, headers: auth(as), ...(payload ? { payload } : {}) });
  async function open(as: string, openingFloatPaise = 100000) {
    const res = await request("POST", "/api/shifts", { clientRef: uuidv7(), openingFloatPaise }, as);
    expect(res.statusCode).toBe(201); return res.json().shift as { id: string };
  }
  /** Bills and settles one thali (₹250) as `as`, paid by `mode`. */
  async function sale(as: string, mode: "cash" | "upi" = "cash") {
    const o = await request("POST", "/api/orders", { clientRef: uuidv7(), type: "parcel" }, as);
    const id = o.json().order.id;
    await request("POST", `/api/orders/${id}/items`, { items: [{ productId, qty: 1, clientRef: uuidv7() }] }, as);
    const preview = await request("POST", `/api/orders/${id}/bill-preview`, {}, as);
    const bill = (await request("POST", `/api/orders/${id}/bill`, { clientRef: uuidv7(), previewKey: preview.json().preview.previewKey }, as)).json().bill as Bill;
    expect((await request("POST", `/api/bills/${bill.id}/settle`, { clientRef: uuidv7(), payments: [{ mode, amountPaise: bill.totalPaise }] }, as)).statusCode).toBe(200);
    return bill;
  }

  it("expects float + cash sales − cash refunds + pay-ins − pay-outs, and saves the variance at close", async () => {
    const shift = await open(cashier.token);
    await sale(cashier.token); await sale(cashier.token); await sale(cashier.token, "upi");
    await sale(token); // the admin's cash is not in Meena's drawer
    const refunded = await sale(cashier.token);
    expect((await request("POST", `/api/bills/${refunded.id}/void`, { clientRef: uuidv7(), reason: "Wrong order", approverPin: "1234", refunds: [{ mode: "cash", amountPaise: 25000 }] }, cashier.token)).statusCode).toBe(201);
    const move = (kind: string, amountPaise: number, clientRef = uuidv7()) => request("POST", `/api/shifts/${shift.id}/cash-movements`, { clientRef, kind, amountPaise, reason: kind === "pay_in" ? "Change from bank" : "Milk" }, cashier.token);
    expect((await move("pay_in", 20000)).statusCode).toBe(201);
    const ref = uuidv7();
    expect((await move("pay_out", 5000, ref)).statusCode).toBe(201);
    expect((await move("pay_out", 5000, ref)).statusCode).toBe(200);
    const current = (await request("GET", "/api/shifts/current", undefined, cashier.token)).json().shift;
    expect(current).toMatchObject({ cashSalesPaise: 75000, cashRefundsPaise: 25000, payInPaise: 20000, payOutPaise: 5000, expectedCashPaise: 165000 });
    const close = { clientRef: uuidv7(), countedCashPaise: 164000, note: "₹10 short" };
    const closed = await request("POST", `/api/shifts/${shift.id}/close`, close, cashier.token);
    expect(closed.json().shift).toMatchObject({ expectedCashPaise: 165000, countedCashPaise: 164000, variancePaise: -1000, closedByName: "Meena" });
    expect((await request("POST", `/api/shifts/${shift.id}/close`, close, cashier.token)).statusCode).toBe(200);
    expect((await request("POST", `/api/shifts/${shift.id}/close`, { ...close, clientRef: uuidv7() }, cashier.token)).statusCode).toBe(409);
    expect((await move("pay_in", 100)).statusCode).toBe(409);
    // Later sales do not change a closed shift.
    await sale(cashier.token);
    expect((await request("GET", `/api/shifts?from=${today()}&to=${today()}`)).json().shifts[0]).toMatchObject({ expectedCashPaise: 165000, variancePaise: -1000 });
  });

  it("allows one open shift per person; others cannot see or close it, an admin can", async () => {
    const shift = await open(cashier.token);
    expect((await request("POST", "/api/shifts", { clientRef: uuidv7(), openingFloatPaise: 0 }, cashier.token)).statusCode).toBe(409);
    const other = await createUser(app, token, { name: "Ravi", pin: "4444", role: "cashier" });
    expect((await request("POST", `/api/shifts/${shift.id}/close`, { clientRef: uuidv7(), countedCashPaise: 0 }, other.token)).statusCode).toBe(404);
    const waiter = await createUser(app, token, { name: "Arun", pin: "5555", role: "waiter" });
    expect((await request("GET", "/api/shifts/current", undefined, waiter.token)).statusCode).toBe(403);
    const closed = await request("POST", `/api/shifts/${shift.id}/close`, { clientRef: uuidv7(), countedCashPaise: 100000 });
    expect(closed.json().shift).toMatchObject({ variancePaise: 0, closedByName: "Asha" });
  });

  it("closes a day only when drawers are closed and orders are finished, and saves the day-end report", async () => {
    const shift = await open(cashier.token);
    await sale(cashier.token);
    const pending = (await request("POST", "/api/orders", { clientRef: uuidv7(), type: "parcel" })).json().order;
    const state = (await request("GET", `/api/day-close?date=${today()}`)).json();
    expect(state.blockers).toEqual({ openShifts: ["Meena"], openOrders: 1, unpaidBills: 0 });
    const attempt = { clientRef: uuidv7(), date: today(), note: "" };
    const blocked = await request("POST", "/api/day-close", attempt);
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json()).toMatchObject({ code: "day_open" });
    expect(blocked.json().error).toContain("Meena");
    expect((await request("POST", "/api/day-close", { ...attempt, clientRef: uuidv7() }, cashier.token)).statusCode).toBe(403);

    await request("POST", `/api/shifts/${shift.id}/close`, { clientRef: uuidv7(), countedCashPaise: 125000 }, cashier.token);
    await request("POST", `/api/orders/${pending.id}/cancel`, {});
    const closed = await request("POST", "/api/day-close", attempt);
    expect(closed.statusCode).toBe(201);
    expect(closed.json().close.report.dayEnd.sales.billCount).toBe(1);
    expect(closed.json().close.report.shifts).toHaveLength(1);
    expect((await request("POST", "/api/day-close", attempt)).statusCode).toBe(200);
    expect((await request("POST", "/api/day-close", { ...attempt, clientRef: uuidv7() })).statusCode).toBe(409);
    const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1);
    expect((await request("POST", "/api/day-close", { clientRef: uuidv7(), date: localDateKey(tomorrow.getTime()) })).statusCode).toBe(400);
    expect((await request("GET", `/api/day-close?date=${today()}`, undefined, cashier.token)).json().close.closedByName).toBe("Asha");
  });
});
