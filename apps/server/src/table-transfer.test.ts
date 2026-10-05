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
  let waterProductId: string;
  const request = (method: "GET" | "POST" | "PUT", url: string, payload?: object, as = token) =>
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
    waterProductId = (await request("POST", "/api/products", { name: "Water", categoryId: category, pricePaise: 2000, gstRate: 5, kotStationId: null })).json().product.id;
    tables = {};
    for (const [index, [name, priceTier]] of ([["T3", "non_ac"], ["T4", "non_ac"], ["T7", "ac"], ["T5", "non_ac"], ["T9", "non_ac"]] as const).entries()) {
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

  describe("merging orders", () => {
    const merge = (foldedId: string, targetOrderId: string, clientRef = uuidv7(), as = token) =>
      request("POST", `/api/orders/${foldedId}/merge`, { clientRef, targetOrderId }, as);
    const links = () => app.db.prepare("SELECT table_id, order_id FROM table_links ORDER BY linked_at, id").all() as Array<{ table_id: string; order_id: string }>;
    const orderRow = (id: string) => app.db.prepare("SELECT status, merged_into, closed_at, table_id FROM orders WHERE id = ?").get(id) as { status: string; merged_into: string | null; closed_at: number | null; table_id: string };
    const tableState = async (name: string) =>
      ((await request("GET", "/api/tables")).json().tables as Array<{ id: string; status: string; link: { orderId: string; status: string; label: string; tableName: string } | null }>).find((t) => t.id === tables[name])!;
    async function addItems(orderId: string, productIds: string[]) {
      const added = await request("POST", `/api/orders/${orderId}/items`, { items: productIds.map((productId) => ({ productId, qty: 1, clientRef: uuidv7() })) });
      expect(added.statusCode, added.body).toBe(200);
    }
    async function bill(orderId: string) {
      const preview = await request("POST", `/api/orders/${orderId}/bill-preview`, {});
      expect(preview.statusCode, preview.body).toBe(200);
      const billed = await request("POST", `/api/orders/${orderId}/bill`, { clientRef: uuidv7(), previewKey: preview.json().preview.previewKey });
      expect(billed.statusCode, billed.body).toBe(201);
      return preview.json().preview as { subtotalPaise: number; receipt: { tableName: string; items: Array<{ name: string }> } };
    }

    it("merges two tables into one bill and keeps the other table linked", async () => {
      const stock = await request("POST", "/api/stock-items", { clientRef: uuidv7(), name: "Mutton", unit: "kg", openingQty: 10 });
      expect(stock.statusCode, stock.body).toBe(201);
      expect((await request("PUT", `/api/products/${grillProductId}/stock-links`, { expectedVersion: 0, stockItemId: stock.json().item.id, qtyPerSale: 0.25 })).statusCode).toBe(200);

      const receiving = await openOrder(tables["T3"]!);
      const [receivingKot] = await addAndSend(receiving, [kitchenProductId]);
      expect((await request("POST", `/api/kots/${receivingKot!.id}/accept`)).statusCode).toBe(200);
      const folded = await openOrder(tables["T4"]!);
      const [foldedKot] = await addAndSend(folded, [grillProductId]);
      await addItems(folded, [waterProductId]);
      app.db.prepare("UPDATE orders SET captain_name = 'Meena' WHERE id = ?").run(receiving);
      app.db.prepare("UPDATE orders SET captain_name = 'Ravi' WHERE id = ?").run(folded);
      const foldedItemIds = (app.db.prepare("SELECT id FROM order_items WHERE order_id = ? ORDER BY id").all(folded) as Array<{ id: string }>).map((r) => r.id);
      const saleMoves = () => app.db.prepare("SELECT id, order_item_id FROM stock_moves WHERE reason = 'sale' ORDER BY id").all();
      const movesBefore = saleMoves();
      expect(movesBefore).toHaveLength(1);

      const res = await merge(folded, receiving);
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().printErrors).toEqual([]);
      const order = res.json().order as { id: string; tableId: string; tableLabel: string; mergedInto: string | null; captainName: string; status: string; items: Array<{ id: string; status: string }>; kots: Array<{ id: string; acceptedAt: number | null }> };
      expect(order).toMatchObject({ id: receiving, tableId: tables["T3"], tableLabel: "T3, T4", captainName: "Meena", status: "open" });
      expect(order.items).toHaveLength(3);
      expect(order.items.map((i) => i.id)).toEqual(expect.arrayContaining(foldedItemIds));
      expect(order.items.map((i) => i.status).sort()).toEqual(["pending", "sent", "sent"]);
      expect(order.kots).toHaveLength(2);
      expect(order.kots.find((k) => k.id === receivingKot!.id)!.acceptedAt).not.toBeNull();
      expect(order.kots.find((k) => k.id === foldedKot!.id)!.acceptedAt).toBeNull();

      expect(orderRow(folded)).toMatchObject({ status: "cancelled", merged_into: receiving, table_id: tables["T4"] });
      expect(order.mergedInto).toBeNull();
      expect((await request("GET", `/api/orders/${folded}`)).json().order).toMatchObject({ status: "cancelled", mergedInto: receiving });
      expect(orderRow(folded).closed_at).toEqual(expect.any(Number));
      expect(app.db.prepare("SELECT COUNT(*) AS n FROM order_items WHERE order_id = ?").get(folded)).toEqual({ n: 0 });
      expect(links()).toEqual([{ table_id: tables["T4"], order_id: receiving }]);
      expect(events()).toEqual([expect.objectContaining({ kind: "merge", order_id: folded, target_order_id: receiving, from_table_id: tables["T4"], to_table_id: tables["T3"], folded_captain_name: "Ravi", created_by: userId })]);

      const linkedTable = await tableState("T4");
      expect(linkedTable.status).toBe("occupied");
      expect(linkedTable.link).toMatchObject({ orderId: receiving, status: "open", label: "T3, T4", tableName: "T3" });
      expect((await tableState("T3")).status).toBe("occupied");

      // Stock moves are keyed by order item, so the folded order's sale moves are untouched.
      expect(saleMoves()).toEqual(movesBefore);
      expect(app.db.prepare("SELECT order_id FROM order_items WHERE id = ?").get((movesBefore[0] as { order_item_id: string }).order_item_id)).toEqual({ order_id: receiving });

      expect((await request("POST", `/api/kots/${foldedKot!.id}/accept`)).statusCode).toBe(200);
      const preview = await bill(receiving);
      expect(preview.subtotalPaise).toBe(20000 + 15000 + 2000);
      expect(preview.receipt.tableName).toBe("T3, T4");
      expect(preview.receipt.items.map((i) => i.name).sort()).toEqual(["Biryani", "Kebab", "Water"]);
      expect(app.db.prepare("SELECT order_id FROM bills").all()).toEqual([{ order_id: receiving }]);
      expect((await tableState("T4")).status).toBe("billed");
    });

    it("merges two bill groups at the same table without a link", async () => {
      const receiving = await openOrder(tables["T3"]!);
      const folded = await openOrder(tables["T3"]!);
      await addItems(folded, [waterProductId]);
      const res = await merge(folded, receiving);
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().order).toMatchObject({ id: receiving, tableLabel: "T3", splitLabel: "A" });
      expect(res.json().order.items).toHaveLength(1);
      expect(orderRow(folded)).toMatchObject({ status: "cancelled", merged_into: receiving });
      expect(links()).toEqual([]);
      expect(events()).toEqual([expect.objectContaining({ kind: "merge", from_table_id: tables["T3"], to_table_id: tables["T3"] })]);
    });

    it("does not duplicate a link when a linked table's other group joins", async () => {
      const receiving = await openOrder(tables["T3"]!);
      const firstGroup = await openOrder(tables["T4"]!);
      const secondGroup = await openOrder(tables["T4"]!);
      expect((await merge(firstGroup, receiving)).statusCode).toBe(200);
      const res = await merge(secondGroup, receiving);
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().order.tableLabel).toBe("T3, T4");
      expect(links()).toEqual([{ table_id: tables["T4"], order_id: receiving }]);
    });

    it("carries links when a combined order is merged or moved", async () => {
      const receiving = await openOrder(tables["T3"]!);
      const folded = await openOrder(tables["T4"]!);
      expect((await merge(folded, receiving)).statusCode).toBe(200);

      const moved = await move(receiving, tables["T9"]!);
      expect(moved.statusCode, moved.body).toBe(200);
      expect(moved.json().order.tableLabel).toBe("T9, T4");
      expect((await tableState("T3")).status).toBe("free");
      expect((await tableState("T4")).link).toMatchObject({ orderId: receiving, tableName: "T9", label: "T9, T4" });

      // Folding the combined order into another group at T4: the T4 link would point at its own
      // table, so it is dropped; T9 joins as a link.
      const atLinkedTable = await openOrder(tables["T4"]!);
      const res = await merge(receiving, atLinkedTable);
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().order.tableLabel).toBe("T4, T9");
      expect(links().filter((l) => ["open", "billed"].includes(orderRow(l.order_id).status))).toEqual([{ table_id: tables["T9"], order_id: atLinkedTable }]);
      expect((await tableState("T9")).link).toMatchObject({ orderId: atLinkedTable, tableName: "T4" });

      // A further merge re-points the links that targeted the folded order, keeping their order.
      const atT5 = await openOrder(tables["T5"]!);
      const chained = await merge(atLinkedTable, atT5);
      expect(chained.statusCode, chained.body).toBe(200);
      expect(chained.json().order.tableLabel).toBe("T5, T4, T9");
      expect((await tableState("T4")).link).toMatchObject({ orderId: atT5, label: "T5, T4, T9" });
    });

    it("refuses to merge a billed order", async () => {
      const receiving = await openOrder(tables["T3"]!);
      const folded = await openOrder(tables["T4"]!);
      await addItems(receiving, [waterProductId]);
      await addItems(folded, [waterProductId]);
      expect((await merge(folded, receiving)).statusCode).toBe(200);
      await bill(receiving);

      const late = await openOrder(tables["T5"]!);
      await addItems(late, [waterProductId]);
      const refused = await merge(late, receiving);
      expect(refused.statusCode).toBe(409);
      expect(refused.json().error).toBe("Both orders must be open to merge");
      const reversed = await merge(receiving, late);
      expect(reversed.statusCode).toBe(409);
      expect(reversed.json().error).toBe("Both orders must be open to merge");
      expect(orderRow(late)).toMatchObject({ status: "open", merged_into: null });
      expect(orderRow(receiving)).toMatchObject({ status: "billed", merged_into: null });
      expect(app.db.prepare("SELECT COUNT(*) AS n FROM order_items WHERE order_id = ?").get(late)).toEqual({ n: 1 });
      expect(app.db.prepare("SELECT COUNT(*) AS n FROM order_items WHERE order_id = ?").get(receiving)).toEqual({ n: 2 });

      // Self, already-merged, parcel and unknown orders are refused too.
      expect((await merge(late, late)).json().error).toBe("Both orders must be open to merge");
      const another = await openOrder(tables["T5"]!);
      expect((await merge(folded, another)).json().error).toBe("Both orders must be open to merge");
      const parcel = (await request("POST", "/api/orders", { clientRef: uuidv7(), type: "parcel" })).json().order.id as string;
      const parcelMerge = await merge(parcel, another);
      expect(parcelMerge.statusCode).toBe(409);
      expect(parcelMerge.json().error).toBe("Both orders must be open to merge");
      expect((await merge(late, uuidv7())).statusCode).toBe(404);
      expect(events()).toHaveLength(1);
    });

    it("replays an identical merge and refuses a reused reference with a different target", async () => {
      const receiving = await openOrder(tables["T3"]!);
      const folded = await openOrder(tables["T4"]!);
      const clientRef = uuidv7();
      const first = await merge(folded, receiving, clientRef);
      const second = await merge(folded, receiving, clientRef);
      expect(first.statusCode, first.body).toBe(200);
      expect(second.statusCode, second.body).toBe(200);
      expect(second.json().order).toMatchObject({ id: receiving, tableLabel: "T3, T4" });
      expect(second.json().printErrors).toEqual([]);
      expect(events()).toHaveLength(1);
      expect(links()).toHaveLength(1);

      const other = await openOrder(tables["T5"]!);
      const different = await merge(folded, other, clientRef);
      expect(different.statusCode).toBe(409);
      expect(different.json().error).toBe("Table change reference already used for a different request");
      // A move reference cannot be replayed as a merge either.
      const moveRef = uuidv7();
      expect((await move(other, tables["T7"]!, moveRef)).statusCode).toBe(200);
      expect((await merge(other, receiving, moveRef)).json().error).toBe("Table change reference already used for a different request");
      expect(orderRow(other)).toMatchObject({ status: "open", merged_into: null });
    });

    it("prints the merged label to each station", async () => {
      const receiving = await openOrder(tables["T3"]!);
      await addAndSend(receiving, [kitchenProductId]);
      const folded = await openOrder(tables["T4"]!);
      await addAndSend(folded, [grillProductId]);
      await vi.waitFor(() => expect(fake.sent).toHaveLength(2));
      const broadcasts: Array<{ event: string; data: unknown }> = [];
      const original = app.broadcast;
      app.broadcast = ((event: string, data: unknown) => { broadcasts.push({ event, data }); return original.call(app, event, data as never); }) as typeof app.broadcast;

      const res = await merge(folded, receiving);
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().printErrors).toEqual([]);
      const tableJobs = (app.db.prepare("SELECT job_json FROM print_jobs").all() as Array<{ job_json: string }>)
        .map((j) => JSON.parse(j.job_json) as { kind: string; label: string }).filter((j) => j.kind === "table");
      expect(tableJobs).toHaveLength(2);
      expect(tableJobs.every((j) => j.label.includes("T3, T4"))).toBe(true);
      await vi.waitFor(() => expect(fake.sent).toHaveLength(4));
      const texts = fake.sent.slice(2).map((s) => s.bytes.toString("latin1"));
      expect(texts.every((t) => t.includes("TABLE CHANGE") && t.includes("T3, T4") && !t.includes("#"))).toBe(true);
      expect(texts.some((t) => t.includes("Kitchen"))).toBe(true);
      expect(texts.some((t) => t.includes("Grill"))).toBe(true);

      expect(broadcasts.filter((b) => b.event === "order.updated").map((b) => (b.data as { order: { id: string } }).order.id).sort()).toEqual([folded, receiving].sort());
      expect(broadcasts.filter((b) => b.event === "table.changed").map((b) => (b.data as { tableId: string }).tableId).sort()).toEqual([tables["T3"], tables["T4"]].sort());
      const kotUpdates = broadcasts.filter((b) => b.event === "kot.updated").map((b) => (b.data as { kot: { orderId: string; tableName: string } }).kot);
      expect(kotUpdates).toHaveLength(2);
      expect(kotUpdates.every((k) => k.orderId === receiving && k.tableName === "T3, T4")).toBe(true);
    });

    it("lets a waiter merge orders", async () => {
      const waiter = await createUser(app, token, { name: "Ravi", pin: "4321", role: "waiter" });
      const receiving = await openOrder(tables["T3"]!);
      const folded = await openOrder(tables["T4"]!);
      const res = await merge(folded, receiving, uuidv7(), waiter.token);
      expect(res.statusCode, res.body).toBe(200);
      expect(events()[0]!.created_by).toBe(waiter.id);
      expect(links()).toEqual([{ table_id: tables["T4"], order_id: receiving }]);
    });
  });
});
