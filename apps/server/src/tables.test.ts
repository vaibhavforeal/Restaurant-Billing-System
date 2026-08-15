import { afterEach, describe, expect, it } from "vitest";
import { auth, createUser, freshApp, setupAdmin } from "./test-helpers.js";
import { uuidv7 } from "@forkflow/domain";

let app: ReturnType<typeof freshApp>;
afterEach(async () => {
  await app?.close();
});

async function addTable(adminToken: string, name: string, area: string | null = null, sortOrder = 0) {
  const res = await app.inject({
    method: "POST",
    url: "/api/tables",
    payload: { name, area, sortOrder },
    headers: auth(adminToken),
  });
  return res.json() as { table: { id: string; name: string; area: string | null; sortOrder: number; isActive: boolean } };
}

describe("tables", () => {
  it("creates and lists tables in sort order", async () => {
    app = freshApp();
    const admin = await setupAdmin(app);

    const res = await app.inject({
      method: "POST",
      url: "/api/tables",
      payload: { name: "T1", area: "Main", sortOrder: 0 },
      headers: auth(admin.token),
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().table).toMatchObject({ name: "T1", area: "Main", sortOrder: 0, isActive: true, status: "free", activeOrders: [] });

    await addTable(admin.token, "T3", "Patio", 2);
    await addTable(admin.token, "T2", "Main", 1);

    const list = await app.inject({ method: "GET", url: "/api/tables", headers: auth(admin.token) });
    expect(list.statusCode).toBe(200);
    const tables = list.json().tables;
    expect(tables.map((t: { name: string }) => t.name)).toEqual(["T1", "T2", "T3"]);
    expect(tables.every((t: { status: string }) => t.status === "free")).toBe(true);
  });

  it("renames, changes area, reorders, and deactivates via PATCH; 404s on unknown id", async () => {
    app = freshApp();
    const admin = await setupAdmin(app);
    const { table } = await addTable(admin.token, "T1", "Main");

    const patched = await app.inject({
      method: "PATCH",
      url: `/api/tables/${table.id}`,
      payload: { name: "Table One", area: "Patio", sortOrder: 5, isActive: false },
      headers: auth(admin.token),
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().table).toMatchObject({ name: "Table One", area: "Patio", sortOrder: 5, isActive: false });

    const missing = await app.inject({
      method: "PATCH",
      url: "/api/tables/nope",
      payload: { name: "X" },
      headers: auth(admin.token),
    });
    expect(missing.statusCode).toBe(404);
  });

  it("derives occupied/billed status from the latest open/billed order", async () => {
    app = freshApp();
    const admin = await setupAdmin(app);
    const { table } = await addTable(admin.token, "T1");

    // Seed an open order directly in the database (orders API doesn't exist yet)
    const orderId = uuidv7();
    app.db
      .prepare(
        "INSERT INTO orders (id, client_ref, type, table_id, split_label, status, opened_by, opened_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(orderId, "test-ref-1", "dine_in", table.id, "A", "open", admin.user.id, Date.now());

    const occupied = await app.inject({ method: "GET", url: "/api/tables", headers: auth(admin.token) });
    expect(occupied.json().tables[0]).toMatchObject({
      id: table.id,
      status: "occupied",
      activeOrders: [{ id: orderId, splitLabel: "A", status: "open" }],
    });

    // Update the order to billed
    app.db.prepare("UPDATE orders SET status = ? WHERE id = ?").run("billed", orderId);
    const billed = await app.inject({ method: "GET", url: "/api/tables", headers: auth(admin.token) });
    expect(billed.json().tables[0]).toMatchObject({
      status: "billed",
      activeOrders: [{ id: orderId, splitLabel: "A", status: "billed" }],
    });

    // Close the order (settled)
    app.db.prepare("UPDATE orders SET status = ?, closed_at = ? WHERE id = ?").run("settled", Date.now(), orderId);
    const free = await app.inject({ method: "GET", url: "/api/tables", headers: auth(admin.token) });
    expect(free.json().tables[0]).toMatchObject({ status: "free", activeOrders: [] });
  });

  it("refuses to deactivate a table with an open order (409)", async () => {
    app = freshApp();
    const admin = await setupAdmin(app);
    const { table } = await addTable(admin.token, "T1");

    // Seed an open order
    app.db
      .prepare(
        "INSERT INTO orders (id, client_ref, type, table_id, status, opened_by, opened_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(uuidv7(), "test-ref-2", "dine_in", table.id, "open", admin.user.id, Date.now());

    const deactivate = await app.inject({
      method: "PATCH",
      url: `/api/tables/${table.id}`,
      payload: { isActive: false },
      headers: auth(admin.token),
    });
    expect(deactivate.statusCode).toBe(409);
    expect(deactivate.json().error).toBe("table has an open order");
  });

  it("read is open to waiters, write is not; anonymous is 401", async () => {
    app = freshApp();
    const admin = await setupAdmin(app);
    const waiter = await createUser(app, admin.token, { name: "Wren", pin: "5678", role: "waiter" });

    expect((await app.inject({ method: "GET", url: "/api/tables", headers: auth(waiter.token) })).statusCode).toBe(200);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/tables",
          payload: { name: "X" },
          headers: auth(waiter.token),
        })
      ).statusCode,
    ).toBe(403);
    expect((await app.inject({ method: "GET", url: "/api/tables" })).statusCode).toBe(401);
  });

  it("derives occupied status when table has multiple open orders", async () => {
    app = freshApp();
    const admin = await setupAdmin(app);
    const { table } = await addTable(admin.token, "T1");

    const order1Id = uuidv7();
    const order2Id = uuidv7();
    app.db
      .prepare(
        "INSERT INTO orders (id, client_ref, type, table_id, split_label, status, opened_by, opened_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
      )
      .run(order1Id, "ref-1", "dine_in", table.id, "A", "open", admin.user.id, Date.now());
    app.db
      .prepare(
        "INSERT INTO orders (id, client_ref, type, table_id, split_label, status, opened_by, opened_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
      )
      .run(order2Id, "ref-2", "dine_in", table.id, "B", "open", admin.user.id, Date.now());

    const res = await app.inject({ method: "GET", url: "/api/tables", headers: auth(admin.token) });
    expect(res.json().tables[0]).toMatchObject({
      status: "occupied",
      activeOrders: [
        { id: order1Id, splitLabel: "A", status: "open" },
        { id: order2Id, splitLabel: "B", status: "open" },
      ],
    });
  });

  it("derives occupied status when table has one open and one billed order", async () => {
    app = freshApp();
    const admin = await setupAdmin(app);
    const { table } = await addTable(admin.token, "T1");

    const order1Id = uuidv7();
    const order2Id = uuidv7();
    app.db
      .prepare(
        "INSERT INTO orders (id, client_ref, type, table_id, split_label, status, opened_by, opened_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
      )
      .run(order1Id, "ref-1", "dine_in", table.id, "A", "open", admin.user.id, Date.now());
    app.db
      .prepare(
        "INSERT INTO orders (id, client_ref, type, table_id, split_label, status, opened_by, opened_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
      )
      .run(order2Id, "ref-2", "dine_in", table.id, "B", "billed", admin.user.id, Date.now());

    const res = await app.inject({ method: "GET", url: "/api/tables", headers: auth(admin.token) });
    expect(res.json().tables[0]).toMatchObject({
      status: "occupied",
      activeOrders: [
        { id: order1Id, splitLabel: "A", status: "open" },
        { id: order2Id, splitLabel: "B", status: "billed" },
      ],
    });
  });

  it("derives billed status when table has only billed orders", async () => {
    app = freshApp();
    const admin = await setupAdmin(app);
    const { table } = await addTable(admin.token, "T1");

    const order1Id = uuidv7();
    app.db
      .prepare(
        "INSERT INTO orders (id, client_ref, type, table_id, split_label, status, opened_by, opened_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
      )
      .run(order1Id, "ref-1", "dine_in", table.id, "A", "billed", admin.user.id, Date.now());

    const res = await app.inject({ method: "GET", url: "/api/tables", headers: auth(admin.token) });
    expect(res.json().tables[0]).toMatchObject({
      status: "billed",
      activeOrders: [{ id: order1Id, splitLabel: "A", status: "billed" }],
    });
  });

  it("derives free status when all orders are settled or cancelled (activeOrders empty)", async () => {
    app = freshApp();
    const admin = await setupAdmin(app);
    const { table } = await addTable(admin.token, "T1");

    const order1Id = uuidv7();
    const order2Id = uuidv7();
    app.db
      .prepare(
        "INSERT INTO orders (id, client_ref, type, table_id, split_label, status, opened_by, opened_at, closed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
      )
      .run(order1Id, "ref-1", "dine_in", table.id, "A", "settled", admin.user.id, Date.now(), Date.now());
    app.db
      .prepare(
        "INSERT INTO orders (id, client_ref, type, table_id, split_label, status, opened_by, opened_at, closed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
      )
      .run(order2Id, "ref-2", "dine_in", table.id, "B", "cancelled", admin.user.id, Date.now(), Date.now());

    const res = await app.inject({ method: "GET", url: "/api/tables", headers: auth(admin.token) });
    expect(res.json().tables[0]).toMatchObject({ status: "free", activeOrders: [] });
  });
});
