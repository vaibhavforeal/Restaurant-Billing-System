import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { uuidv7 } from "@forkflow/domain";
import { auth, createUser, freshAppWithFakeSink, setupAdmin } from "./test-helpers.js";

type Fake = ReturnType<typeof freshAppWithFakeSink>["fake"];

describe("moving an order to another table", () => {
  let app: FastifyInstance;
  let fake: Fake;
  let token: string;
  let userId: string;
  let tables: Record<string, string>;
  let kitchenStationId: string;
  let grillStationId: string;
  let kitchenProductId: string;
  let grillProductId: string;
  const request = (method: "GET" | "POST", url: string, payload?: object, as = token) =>
    app.inject({ method, url, headers: auth(as), ...(payload ? { payload } : {}) });

  beforeEach(async () => {
    ({ app, fake } = freshAppWithFakeSink());
    const admin = await setupAdmin(app);
    token = admin.token; userId = admin.user.id;
    const category = (await request("POST", "/api/categories", { name: "Food" })).json().category.id as string;
    kitchenStationId = ((await request("GET", "/api/kot-stations")).json().stations[0] as { id: string }).id;
    grillStationId = uuidv7();
    app.db.prepare("INSERT INTO kot_stations (id, name, is_active) VALUES (?, 'Grill', 1)").run(grillStationId);
    for (const [stationId, name] of [[kitchenStationId, "Kitchen printer"], [grillStationId, "Grill printer"]] as const) {
      const printer = (await request("POST", "/api/printers", { name, kind: "network", connection: "127.0.0.1" })).json().printer;
      app.db.prepare("UPDATE kot_stations SET printer_id = ? WHERE id = ?").run(printer.id, stationId);
    }
    kitchenProductId = (await request("POST", "/api/products", { name: "Biryani", categoryId: category, pricePaise: 20000, acPricePaise: 25000, gstRate: 5, kotStationId: kitchenStationId })).json().product.id;
    grillProductId = (await request("POST", "/api/products", { name: "Kebab", categoryId: category, pricePaise: 15000, gstRate: 5, kotStationId: grillStationId })).json().product.id;
    tables = {};
    for (const [index, [name, priceTier]] of ([["T3", "non_ac"], ["T4", "non_ac"], ["T7", "ac"]] as const).entries()) {
      const res = await request("POST", "/api/tables", { name, area: null, sortOrder: index, priceTier });
      expect(res.statusCode).toBe(201);
      tables[name] = res.json().table.id;
    }
  });
  afterEach(async () => { await app.close(); app.db.close(); });

  async function openOrder(tableId: string) {
    const created = await request("POST", "/api/orders", { clientRef: uuidv7(), type: "dine_in", tableId });
    expect(created.statusCode).toBe(201);
    return created.json().order.id as string;
  }
  async function addAndSend(orderId: string, productIds: string[]) {
    const added = await request("POST", `/api/orders/${orderId}/items`, { items: productIds.map((productId) => ({ productId, qty: 1, clientRef: uuidv7() })) });
    expect(added.statusCode, added.body).toBe(200);
    const sent = await request("POST", `/api/orders/${orderId}/send`);
    expect(sent.statusCode, sent.body).toBe(200);
    return sent.json().kots as Array<{ id: string; stationId: string }>;
  }
  const move = (orderId: string, tableId: string, clientRef = uuidv7(), as = token) => request("POST", `/api/orders/${orderId}/move`, { clientRef, tableId }, as);
  const events = () => app.db.prepare("SELECT * FROM order_table_events").all() as Array<{ kind: string; order_id: string; from_table_id: string; to_table_id: string; created_by: string }>;

  it("moves an open order to a free table with a new split letter and the destination tier", async () => {
    const orderId = await openOrder(tables["T3"]!);
    await addAndSend(orderId, [kitchenProductId]);
    const res = await move(orderId, tables["T7"]!);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().printErrors).toEqual([]);
    expect(res.json().order).toMatchObject({ id: orderId, tableId: tables["T7"], splitLabel: "A", priceTier: "ac", tableLabel: "T7", status: "open" });
    expect(res.json().order.items[0].pricePaise).toBe(20000);
    expect(events()).toEqual([expect.objectContaining({ kind: "move", order_id: orderId, from_table_id: tables["T3"], to_table_id: tables["T7"], created_by: userId })]);
    const table3 = ((await request("GET", "/api/tables")).json().tables as Array<{ id: string; status: string }>).find((t) => t.id === tables["T3"])!;
    expect(table3.status).toBe("free");
    // New items now use the destination tier; the sent item kept its snapshot.
    await request("POST", `/api/orders/${orderId}/items`, { items: [{ productId: kitchenProductId, qty: 1, clientRef: uuidv7() }] });
    const prices = (app.db.prepare("SELECT price_paise_snapshot AS p FROM order_items WHERE order_id = ? ORDER BY id").all(orderId) as Array<{ p: number }>).map((r) => r.p);
    expect(prices).toEqual([20000, 25000]);
  });

  it("takes the next free split letter at a destination that is free but has history", async () => {
    const settled = await openOrder(tables["T7"]!);
    app.db.prepare("UPDATE orders SET status = 'settled', closed_at = ? WHERE id = ?").run(Date.now(), settled);
    const orderId = await openOrder(tables["T3"]!);
    const res = await move(orderId, tables["T7"]!);
    expect(res.statusCode).toBe(200);
    expect(res.json().order.splitLabel).toBe("A");
  });

  it("refuses occupied, linked, inactive, reserved-now and non-open moves", async () => {
    const orderId = await openOrder(tables["T3"]!);
    const other = await openOrder(tables["T4"]!);

    const occupied = await move(orderId, tables["T4"]!);
    expect(occupied.statusCode).toBe(409);
    expect(occupied.json().error).toBe("That table is occupied — merge instead");

    // A billed order still occupies its table; a link occupies the linked table.
    app.db.prepare("UPDATE orders SET status = 'billed' WHERE id = ?").run(other);
    expect((await move(orderId, tables["T4"]!)).json().error).toBe("That table is occupied — merge instead");
    app.db.prepare("UPDATE orders SET status = 'settled', closed_at = ? WHERE id = ?").run(Date.now(), other);
    app.db.prepare("INSERT INTO table_links (id, table_id, order_id, linked_at, linked_by) VALUES (?, ?, ?, ?, ?)").run(uuidv7(), tables["T7"], orderId, Date.now(), userId);
    // T7 is linked to this very order, so the table is still not free for a move.
    const linked = await move(orderId, tables["T7"]!);
    expect(linked.statusCode).toBe(409);
    expect(linked.json().error).toBe("That table is occupied — merge instead");
    app.db.prepare("DELETE FROM table_links").run();

    app.db.prepare("UPDATE dining_tables SET is_active = 0 WHERE id = ?").run(tables["T7"]);
    const inactive = await move(orderId, tables["T7"]!);
    expect(inactive.statusCode).toBe(409);
    expect(inactive.json().error).toBe("Choose an active table");
    app.db.prepare("UPDATE dining_tables SET is_active = 1 WHERE id = ?").run(tables["T7"]);

    const now = Date.now();
    app.db.prepare(`INSERT INTO reservations (id, client_ref, request_json, table_id, customer_name, party_size, starts_at, ends_at, status, version, created_at, created_by, updated_at, updated_by)
      VALUES (?, ?, '{}', ?, 'Rao', 2, ?, ?, 'booked', 1, ?, ?, ?, ?)`).run(uuidv7(), uuidv7(), tables["T7"], now - 60_000, now + 3_600_000, now, userId, now, userId);
    const reserved = await move(orderId, tables["T7"]!);
    expect(reserved.statusCode).toBe(409);
    expect(reserved.json().error).toMatch(/reserved now/);
    app.db.prepare("DELETE FROM reservations").run();

    expect((await move(orderId, "no-such-table")).statusCode).toBe(400);

    app.db.prepare("UPDATE orders SET status = 'billed' WHERE id = ?").run(orderId);
    const billed = await move(orderId, tables["T7"]!);
    expect(billed.statusCode).toBe(409);
    expect(billed.json().error).toBe("Only open orders can be moved");
    expect((await move(uuidv7(), tables["T7"]!)).statusCode).toBe(404);
    expect(events()).toEqual([]);
    expect(app.db.prepare("SELECT table_id FROM orders WHERE id = ?").get(orderId)).toEqual({ table_id: tables["T3"] });
  });

  it("replays an identical move without moving twice", async () => {
    const orderId = await openOrder(tables["T3"]!);
    const clientRef = uuidv7();
    const first = await move(orderId, tables["T7"]!, clientRef);
    const second = await move(orderId, tables["T7"]!, clientRef);
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(second.json().order).toMatchObject({ id: orderId, tableId: tables["T7"], splitLabel: "A" });
    expect(second.json().printErrors).toEqual([]);
    expect(events()).toHaveLength(1);
    const different = await move(orderId, tables["T4"]!, clientRef);
    expect(different.statusCode).toBe(409);
    expect(different.json().error).toBe("Table change reference already used for a different request");
    expect(app.db.prepare("SELECT table_id FROM orders WHERE id = ?").get(orderId)).toEqual({ table_id: tables["T7"] });
  });

  it("prints a table-change slip per station with open tickets", async () => {
    const orderId = await openOrder(tables["T3"]!);
    const kots = await addAndSend(orderId, [kitchenProductId, grillProductId]);
    const kitchenKot = kots.find((k) => k.stationId === kitchenStationId)!;
    await vi.waitFor(() => expect(fake.sent).toHaveLength(2));
    // A kitchen station whose ticket is done gets no slip.
    app.db.prepare("UPDATE kots SET accepted_at = 1, done_at = 2 WHERE id = ?").run(kitchenKot.id);
    await addAndSend(orderId, [grillProductId]);
    await vi.waitFor(() => expect(fake.sent).toHaveLength(3));
    const before = fake.sent.length;

    const res = await move(orderId, tables["T7"]!);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().printErrors).toEqual([]);
    const jobs = app.db.prepare("SELECT job_json FROM print_jobs").all() as Array<{ job_json: string }>;
    const tableJobs = jobs.map((j) => JSON.parse(j.job_json) as { kind: string; label: string }).filter((j) => j.kind === "table");
    expect(tableJobs).toHaveLength(1);
    expect(tableJobs[0]!.label).toContain("T3 -> T7");
    await vi.waitFor(() => expect(fake.sent).toHaveLength(before + 1));
    const slip = fake.sent.at(-1)!.bytes;
    expect(slip.toString("latin1")).toContain("TABLE CHANGE");
    expect(slip.toString("latin1")).toContain("T3 -> T7");
    expect(slip.toString("latin1")).toContain("Grill");
    expect(slip.toString("latin1")).not.toContain("#");

    // Both stations open: two slips.
    app.db.prepare("UPDATE kots SET done_at = NULL WHERE id = ?").run(kitchenKot.id);
    const back = await move(orderId, tables["T3"]!);
    expect(back.statusCode, back.body).toBe(200);
    await vi.waitFor(() => expect(fake.sent).toHaveLength(before + 3));
    const texts = fake.sent.slice(before + 1).map((s) => s.bytes.toString("latin1"));
    expect(texts.every((t) => t.includes("T7 -> T3") && !t.includes("#"))).toBe(true);
    expect(texts.some((t) => t.includes("Kitchen"))).toBe(true);
    expect(texts.some((t) => t.includes("Grill"))).toBe(true);
  });

  it("broadcasts order, table and kitchen ticket updates and survives a slip that cannot be rendered", async () => {
    const orderId = await openOrder(tables["T3"]!);
    await addAndSend(orderId, [kitchenProductId]);
    const events: Array<{ event: string; data: unknown }> = [];
    const original = app.broadcast;
    app.broadcast = ((event: string, data: unknown) => { events.push({ event, data }); return original.call(app, event, data as never); }) as typeof app.broadcast;
    app.db.prepare("UPDATE printers SET kot_profile = 'not json'").run();
    const res = await move(orderId, tables["T7"]!);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().printErrors).toHaveLength(1);
    expect(app.db.prepare("SELECT table_id FROM orders WHERE id = ?").get(orderId)).toEqual({ table_id: tables["T7"] });
    expect(events.map((e) => e.event).sort()).toEqual(["kot.updated", "order.updated", "table.changed", "table.changed"]);
    const tableIds = events.filter((e) => e.event === "table.changed").map((e) => (e.data as { tableId: string }).tableId).sort();
    expect(tableIds).toEqual([tables["T3"], tables["T7"]].sort());
    expect((events.find((e) => e.event === "kot.updated")!.data as { kot: { tableName: string } }).kot.tableName).toBe("T7");
  });

  it("lets a waiter move tables", async () => {
    const waiter = await createUser(app, token, { name: "Ravi", pin: "4321", role: "waiter" });
    const orderId = await openOrder(tables["T3"]!);
    const res = await move(orderId, tables["T7"]!, uuidv7(), waiter.token);
    expect(res.statusCode, res.body).toBe(200);
    expect(events()[0]!.created_by).toBe(waiter.id);
    expect((await app.inject({ method: "POST", url: `/api/orders/${orderId}/move`, payload: { clientRef: uuidv7(), tableId: tables["T3"] } })).statusCode).toBe(401);
  });
});
