import { afterEach, describe, expect, it, vi } from "vitest";
import { MIGRATIONS, migrate, openDb, uuidv7, type Reservation } from "@forkflow/domain";
import { auth, createUser, freshApp, setupAdmin } from "./test-helpers.js";
import { localMinute } from "./reservation-rules.js";

let app: ReturnType<typeof freshApp>;
afterEach(async () => { vi.restoreAllMocks(); if (app) { await app.close(); app.db.close(); } });

async function fixture() {
  app = freshApp();
  const admin = await setupAdmin(app);
  let now = Math.floor(Date.now() / 60000) * 60000 + 30000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  const api = (method: "GET" | "POST" | "PATCH", url: string, payload?: object, token = admin.token) =>
    app.inject({ method, url, headers: auth(token), ...(payload ? { payload } : {}) });
  const table = (await api("POST", "/api/tables", { name: "T1", area: "Patio" })).json().table;
  const second = (await api("POST", "/api/tables", { name: "T2" })).json().table;
  const body = (patch = {}) => ({ clientRef: uuidv7(), tableId: table.id, customerName: "Asha", phone: "+91 98765 43210",
    partySize: 4, startsLocal: localMinute(now), durationMinutes: 90, notes: "Window seat", ...patch });
  const create = async (patch = {}): Promise<Reservation> => {
    const response = await api("POST", "/api/reservations", body(patch));
    expect(response.statusCode, response.body).toBe(201); return response.json().reservation;
  };
  const list = async (date?: string): Promise<Reservation[]> => (await api("GET", `/api/reservations${date ? `?date=${date}` : ""}`)).json().reservations;
  const seat = (r: Reservation) => api("POST", `/api/reservations/${r.id}/seat`, { version: r.version });
  const status = (r: Reservation, value: string) => api("POST", `/api/reservations/${r.id}/status`, { version: r.version, status: value });
  const edit = (r: Reservation, patch = {}) => api("PATCH", `/api/reservations/${r.id}`, { ...body(), ...r, ...patch });
  const countOrders = () => (app.db.prepare("SELECT count(*) AS n FROM orders").get() as { n: number }).n;
  return { api, admin, table, second, body, create, list, seat, status, edit, countOrders, now, setNow: (value: number) => { now = value; } };
}

describe("table reservations", () => {
  it("upgrades an existing database without changing tables and safely reruns migrations", () => {
    const db = openDb(":memory:");
    try {
      migrate(db, MIGRATIONS.filter((m) => m.version < 12));
      db.prepare("INSERT INTO dining_tables (id, name, area, sort_order) VALUES ('existing', 'Window', 'Patio', 8)").run();
      migrate(db, MIGRATIONS); migrate(db, MIGRATIONS);
      expect(db.prepare("SELECT * FROM dining_tables WHERE id='existing'").get()).toMatchObject({ name: "Window", area: "Patio", sort_order: 8 });
      expect(db.prepare("SELECT count(*) AS n FROM reservations").get()).toEqual({ n: 0 });
    } finally { db.close(); }
  });

  it("creates and lists normalized customer details with restaurant time", async () => {
    const f = await fixture();
    const r = await f.create({ customerName: "  Asha  ", notes: "  Window seat  " });
    expect(r).toMatchObject({ tableName: "T1", area: "Patio", customerName: "Asha", partySize: 4, durationMinutes: 90, status: "booked", orderId: null, version: 1, notes: "Window seat" });
    const response = await f.api("GET", "/api/reservations");
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toMatchObject({ timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, nowLocal: localMinute(f.now), reservations: [r] });
    expect(f.countOrders()).toBe(0);
  });

  it("allows cashiers to manage and waiters only to read; rejects kitchen and anonymous access", async () => {
    const f = await fixture();
    const cashier = await createUser(app, f.admin.token, { name: "Cash", pin: "2345", role: "cashier" });
    const waiter = await createUser(app, f.admin.token, { name: "Wait", pin: "3456", role: "waiter" });
    const kitchen = await createUser(app, f.admin.token, { name: "Cook", pin: "4567", role: "kitchen" });
    const created = await f.api("POST", "/api/reservations", f.body(), cashier.token);
    expect(created.statusCode).toBe(201);
    const r = created.json().reservation as Reservation;
    expect((await f.api("GET", "/api/reservations", undefined, waiter.token)).statusCode).toBe(200);
    for (const [method, path, body] of [
      ["POST", "/api/reservations", f.body()],
      ["PATCH", `/api/reservations/${r.id}`, { ...f.body(), version: 1 }],
      ["POST", `/api/reservations/${r.id}/status`, { version: 1, status: "cancelled" }],
      ["POST", `/api/reservations/${r.id}/seat`, { version: 1 }],
    ] as const) expect((await f.api(method, path, body, waiter.token)).statusCode).toBe(403);
    expect((await f.api("GET", "/api/reservations", undefined, kitchen.token)).statusCode).toBe(403);
    expect((await app.inject({ url: "/api/reservations" })).statusCode).toBe(401);
    expect((await f.api("PATCH", `/api/reservations/${r.id}`, { ...f.body(), version: 1, partySize: 5 }, cashier.token)).statusCode).toBe(200);
    expect((await f.api("POST", `/api/reservations/${r.id}/seat`, { version: 2 }, cashier.token)).statusCode).toBe(200);
  });

  it("rejects invalid details, dates, past bookings, and inactive or missing tables without writes", async () => {
    const f = await fixture();
    await f.api("PATCH", `/api/tables/${f.second.id}`, { isActive: false });
    for (const patch of [{ customerName: " " }, { partySize: 0 }, { partySize: 1.5 }, { phone: "abc1234567" },
      { phone: "123" }, { durationMinutes: 14 }, { durationMinutes: 481 }, { startsLocal: "2027-02-30T12:00" },
      { startsLocal: localMinute(f.now - 3600000) }, { tableId: f.second.id }, { tableId: "missing" }, { notes: "x".repeat(501) }]) {
      const response = await f.api("POST", "/api/reservations", f.body(patch));
      expect(response.statusCode, JSON.stringify(patch)).toBe(400);
    }
    expect((await f.api("GET", "/api/reservations?date=2027-02-30")).statusCode).toBe(400);
    expect(await f.list()).toEqual([]); expect(f.countOrders()).toBe(0);
  });

  it("makes creation retries idempotent and rejects reuse with changed details", async () => {
    const f = await fixture(), payload = f.body();
    const responses = await Promise.all([f.api("POST", "/api/reservations", payload), f.api("POST", "/api/reservations", payload)]);
    expect(responses.map((r) => r.statusCode).sort()).toEqual([200, 201]);
    expect(responses[0]!.json().reservation.id).toBe(responses[1]!.json().reservation.id);
    expect((await f.api("POST", "/api/reservations", { ...payload, partySize: 7 })).statusCode).toBe(409);
    expect(await f.list()).toHaveLength(1);
  });

  it("prevents same-table overlaps while allowing adjacent slots and other tables", async () => {
    const f = await fixture(), start = Math.floor(f.now / 60000) * 60000 + 3600000;
    await f.create({ startsLocal: localMinute(start) });
    for (const delta of [-30, 0, 30, 89]) expect((await f.api("POST", "/api/reservations", f.body({ startsLocal: localMinute(start + delta * 60000) }))).statusCode).toBe(409);
    await f.create({ startsLocal: localMinute(start + 90 * 60000) });
    await f.create({ tableId: f.second.id, startsLocal: localMinute(start) });
    const concurrent = await Promise.all([1, 2].map(() => f.api("POST", "/api/reservations", f.body({ startsLocal: localMinute(start + 180 * 60000) }))));
    expect(concurrent.map((r) => r.statusCode).sort()).toEqual([201, 409]);
  });

  it("edits with optimistic versions, moves tables, and rolls back conflicts", async () => {
    const f = await fixture(), r = await f.create();
    const other = await f.create({ tableId: f.second.id });
    expect((await f.edit(r, { tableId: f.second.id })).statusCode).toBe(409);
    expect((await f.list()).find((v) => v.id === r.id)).toMatchObject({ tableId: f.table.id, version: 1 });
    await f.status(other, "cancelled");
    const moved = await f.edit(r, { tableId: f.second.id, partySize: 6 });
    expect(moved.json().reservation).toMatchObject({ tableId: f.second.id, partySize: 6, version: 2 });
    expect((await f.edit(r, { customerName: "Stale writer" })).statusCode).toBe(409);
    expect((await f.status(r, "cancelled")).statusCode).toBe(409);
    expect((await f.seat(r)).statusCode).toBe(409);
  });

  it("cancellation and no-show release slots and prevent further changes", async () => {
    const f = await fixture(), r = await f.create();
    expect((await f.status(r, "cancelled")).statusCode).toBe(200);
    expect((await f.status(r, "cancelled")).statusCode).toBe(200);
    expect((await f.edit({ ...r, version: 2 })).statusCode).toBe(409);
    expect((await f.seat({ ...r, version: 2 })).statusCode).toBe(409);
    const replacement = await f.create();
    expect((await f.status(replacement, "no_show")).statusCode).toBe(200);
    await f.create();
    const future = await f.create({ tableId: f.second.id, startsLocal: localMinute(f.now + 3600000) });
    expect((await f.status(future, "no_show")).statusCode).toBe(409);
  });

  it("holds current tables, blocks walk-ins, and seats exactly once with a linked bill group", async () => {
    const f = await fixture(), r = await f.create();
    const tables = (await f.api("GET", "/api/tables")).json().tables;
    expect(tables.find((t: { id: string }) => t.id === f.table.id)).toMatchObject({ status: "reserved", activeOrders: [], reservation: { id: r.id, customerName: "Asha" } });
    expect((await f.api("POST", "/api/orders", { clientRef: uuidv7(), type: "dine_in", tableId: f.table.id })).statusCode).toBe(409);
    expect(f.countOrders()).toBe(0);
    const responses = await Promise.all([f.seat(r), f.seat(r)]);
    expect(responses.every((v) => v.statusCode === 200)).toBe(true);
    const result = responses[0]!.json();
    expect(result.reservation).toMatchObject({ status: "seated", orderId: result.order.id, version: 2 });
    expect(result.order).toMatchObject({ type: "dine_in", tableId: f.table.id, status: "open", splitLabel: "A" });
    expect(responses[1]!.json().order.id).toBe(result.order.id); expect(f.countOrders()).toBe(1);
    expect((await f.api("GET", "/api/tables")).json().tables[0].status).toBe("occupied");
    expect((await f.api("POST", "/api/reservations", f.body())).statusCode).toBe(409);
    app.db.prepare("UPDATE orders SET status='settled' WHERE id=?").run(result.order.id);
    await f.create();
  });

  it("rejects early, expired and occupied seating without creating orders", async () => {
    const f = await fixture(), r = await f.create({ startsLocal: localMinute(f.now + 3600000) });
    expect((await f.seat(r)).statusCode).toBe(409); expect(f.countOrders()).toBe(0);
    f.setNow(r.startsAt - 30 * 60000);
    const walkIn = await f.api("POST", "/api/orders", { clientRef: uuidv7(), type: "dine_in", tableId: f.table.id });
    expect(walkIn.statusCode).toBe(201);
    expect((await f.seat(r)).statusCode).toBe(409); expect(f.countOrders()).toBe(1);
    app.db.prepare("UPDATE orders SET status='cancelled' WHERE id=?").run(walkIn.json().order.id);
    f.setNow(r.endsAt);
    expect((await f.seat(r)).statusCode).toBe(409); expect(f.countOrders()).toBe(1);
    expect((await f.edit(r)).statusCode).toBe(400);
    const rescheduled = await f.edit(r, { startsLocal: localMinute(r.endsAt) });
    expect(rescheduled.statusCode).toBe(200);
    expect((await f.seat(rescheduled.json().reservation)).statusCode).toBe(200);
  });

  it("refuses to seat a party at a table that is occupied through a merge link", async () => {
    const f = await fixture();
    const open = async (tableId: string) => (await f.api("POST", "/api/orders", { clientRef: uuidv7(), type: "dine_in", tableId })).json().order.id as string;
    // A walk-in at T1 was merged into T2's bill before the booking began, so T1 stays linked and occupied.
    const walkIn = await open(f.table.id), receiving = await open(f.second.id);
    expect((await f.api("POST", `/api/orders/${walkIn}/merge`, { clientRef: uuidv7(), targetOrderId: receiving })).statusCode).toBe(200);
    const r = await f.create();
    const refused = await f.seat(r);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toBe("This table is still occupied. Finish its current orders or move the reservation to another table.");
    expect(f.countOrders()).toBe(2);
    app.db.prepare("UPDATE orders SET status='settled' WHERE id=?").run(receiving);
    expect((await f.seat(r)).statusCode).toBe(200);
  });

  it("keeps a seated party's slot while its order lives on inside a combined bill", async () => {
    const f = await fixture(), r = await f.create();
    const seated = (await f.seat(r)).json().order.id as string;
    const third = (await f.api("POST", "/api/tables", { name: "T3" })).json().table.id as string;
    const open = async (tableId: string) => (await f.api("POST", "/api/orders", { clientRef: uuidv7(), type: "dine_in", tableId })).json().order.id as string;
    const merge = (folded: string, target: string) => f.api("POST", `/api/orders/${folded}/merge`, { clientRef: uuidv7(), targetOrderId: target });
    // Bill at T2: the seated party's order is folded away, but the party is still at T1.
    const atSecond = await open(f.second.id);
    expect((await merge(seated, atSecond)).statusCode).toBe(200);
    expect((await f.api("POST", "/api/reservations", f.body())).statusCode).toBe(409);
    // Folding the combined order again still holds the slot.
    const atThird = await open(third);
    expect((await merge(atSecond, atThird)).statusCode).toBe(200);
    expect((await f.api("POST", "/api/reservations", f.body())).statusCode).toBe(409);
    app.db.prepare("UPDATE orders SET status='billed' WHERE id=?").run(atThird);
    expect((await f.api("POST", "/api/reservations", f.body())).statusCode).toBe(409);
    app.db.prepare("UPDATE orders SET status='settled' WHERE id=?").run(atThird);
    await f.create();
  });

  it("does not allow early seating to consume an adjacent party's booked slot", async () => {
    const f = await fixture(), r = await f.create({ durationMinutes: 15 });
    const next = await f.create({ startsLocal: localMinute(r.endsAt), durationMinutes: 30 });
    expect((await f.seat(next)).statusCode).toBe(409);
    expect(f.countOrders()).toBe(0);
    f.setNow(r.endsAt);
    expect((await f.seat(next)).statusCode).toBe(200);
  });

  it("supports ongoing edits, clock-based holds, and deactivation after release", async () => {
    const f = await fixture(), r = await f.create({ startsLocal: localMinute(f.now + 3600000) });
    expect((await f.api("GET", "/api/tables")).json().tables[0].status).toBe("free");
    expect((await f.api("PATCH", `/api/tables/${f.table.id}`, { isActive: false })).statusCode).toBe(409);
    f.setNow(r.startsAt + 15 * 60000);
    expect((await f.api("GET", "/api/tables")).json().tables[0].status).toBe("reserved");
    expect((await f.edit(r, { notes: "Arriving soon" })).statusCode).toBe(200);
    f.setNow(r.endsAt);
    expect((await f.api("GET", "/api/tables")).json().tables[0]).toMatchObject({ status: "free", reservation: null });
    expect((await f.api("PATCH", `/api/tables/${f.table.id}`, { isActive: false })).statusCode).toBe(200);
  });

  it("lists cross-midnight bookings on both days and excludes non-overlapping dates", async () => {
    const f = await fixture();
    const day = new Date(f.now); day.setDate(day.getDate() + 1); day.setHours(23, 30, 0, 0);
    const r = await f.create({ startsLocal: localMinute(day.getTime()), durationMinutes: 90 });
    expect(await f.list(localMinute(day.getTime()).slice(0, 10))).toEqual([r]);
    day.setDate(day.getDate() + 1);
    expect(await f.list(localMinute(day.getTime()).slice(0, 10))).toEqual([r]);
    day.setDate(day.getDate() + 1);
    expect(await f.list(localMinute(day.getTime()).slice(0, 10))).toEqual([]);
  });
});
