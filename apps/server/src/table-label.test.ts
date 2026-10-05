import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { localDateKey, uuidv7, type Bill } from "@forkflow/domain";
import { auth, freshAppWithFakeSink, setupAdmin } from "./test-helpers.js";
import { activeLinkedTableNames, activeLinkForTable, orderTableLabel } from "./table-label.js";

describe("table labels and link-aware table status", () => {
  let app: FastifyInstance;
  let token: string;
  let userId: string;
  let tables: Record<string, string>;
  let stationProductId: string;
  let plainProductId: string;
  const request = (method: "GET" | "POST", url: string, payload?: object) =>
    app.inject({ method, url, headers: auth(token), ...(payload ? { payload } : {}) });

  beforeEach(async () => {
    ({ app } = freshAppWithFakeSink());
    const admin = await setupAdmin(app);
    token = admin.token; userId = admin.user.id;
    const category = (await request("POST", "/api/categories", { name: "Food" })).json().category.id as string;
    const station = ((await request("GET", "/api/kot-stations")).json().stations[0] as { id: string }).id;
    stationProductId = (await request("POST", "/api/products", { name: "Biryani", categoryId: category, pricePaise: 20000, gstRate: 5, kotStationId: station })).json().product.id;
    plainProductId = (await request("POST", "/api/products", { name: "Water", categoryId: category, pricePaise: 1000, gstRate: 5, kotStationId: null })).json().product.id;
    tables = {};
    for (const [index, name] of ["T3", "T4", "T5"].entries()) {
      const res = await request("POST", "/api/tables", { name, area: null, sortOrder: index, priceTier: "non_ac" });
      expect(res.statusCode).toBe(201);
      tables[name] = res.json().table.id;
    }
  });
  afterEach(async () => { await app.close(); app.db.close(); });

  async function order(tableId: string | null, productId = plainProductId) {
    const created = await request("POST", "/api/orders", { clientRef: uuidv7(), type: tableId ? "dine_in" : "parcel", tableId });
    expect(created.statusCode).toBe(201);
    const id = created.json().order.id as string;
    const added = await request("POST", `/api/orders/${id}/items`, { items: [{ productId, qty: 1, clientRef: uuidv7() }] });
    expect(added.statusCode).toBe(200);
    return id;
  }
  async function issue(orderId: string) {
    const preview = await request("POST", `/api/orders/${orderId}/bill-preview`, { discountPaise: 0 });
    expect(preview.statusCode, preview.body).toBe(200);
    const res = await request("POST", `/api/orders/${orderId}/bill`, { discountPaise: 0, previewKey: preview.json().preview.previewKey, clientRef: uuidv7() });
    expect(res.statusCode, res.body).toBe(201);
    return res.json().bill as Bill;
  }
  const settle = async (bill: Bill) => {
    const res = await request("POST", `/api/bills/${bill.id}/settle`, { clientRef: uuidv7(), payments: [{ mode: "cash", amountPaise: bill.totalPaise }] });
    expect(res.statusCode, res.body).toBe(200);
  };
  let linkNo = 0;
  const link = (tableId: string, orderId: string) =>
    app.db.prepare("INSERT INTO table_links (id, table_id, order_id, linked_at, linked_by) VALUES (?, ?, ?, ?, ?)").run(uuidv7(), tableId, orderId, 1_000 + linkNo++, userId);
  const tableJson = async (name: string) =>
    ((await request("GET", "/api/tables")).json().tables as Array<{ id: string; name: string; status: string; link: unknown }>).find((t) => t.name === name)!;

  it("labels an order with its active linked tables", async () => {
    const orderId = await order(tables["T3"]!);
    link(tables["T4"]!, orderId);
    expect(activeLinkedTableNames(app.db, orderId)).toEqual(["T4"]);
    expect(orderTableLabel(app.db, orderId)).toBe("T3, T4");
    link(tables["T5"]!, orderId);
    expect(orderTableLabel(app.db, orderId)).toBe("T3, T4, T5");
    expect(activeLinkForTable(app.db, tables["T4"]!)).toEqual({ orderId, status: "open", label: "T3, T4, T5" });
    expect((await request("GET", `/api/orders/${orderId}`)).json().order.tableLabel).toBe("T3, T4, T5");
    expect(orderTableLabel(app.db, await order(null))).toBeNull();

    await settle(await issue(orderId));
    expect(activeLinkedTableNames(app.db, orderId)).toEqual([]);
    expect(activeLinkForTable(app.db, tables["T4"]!)).toBeNull();
    expect(orderTableLabel(app.db, orderId)).toBe("T3");
  });

  it("keeps a linked table occupied until the combined bill is paid", async () => {
    const own = await issue(await order(tables["T4"]!));
    await settle(own);
    const orderId = await order(tables["T3"]!);
    link(tables["T4"]!, orderId);
    expect(await tableJson("T4")).toMatchObject({ status: "occupied", link: { orderId, status: "open", label: "T3, T4", tableName: "T3" } });
    expect((await tableJson("T3")).link).toBeNull();

    const bill = await issue(orderId);
    expect(await tableJson("T4")).toMatchObject({ status: "billed", link: { orderId, status: "billed", tableName: "T3" } });
    await settle(bill);
    expect(await tableJson("T4")).toMatchObject({ status: "free", link: null });
  });

  it("shows the combined label on the kitchen board and receipt", async () => {
    const orderId = await order(tables["T3"]!, stationProductId);
    link(tables["T4"]!, orderId);
    const send = await request("POST", `/api/orders/${orderId}/send`);
    expect(send.statusCode, send.body).toBe(200);
    expect(send.json().kots[0].tableName).toBe("T3, T4");
    const board = (await request("GET", "/api/kots")).json().kots as Array<{ tableName: string }>;
    expect(board.map((k) => k.tableName)).toEqual(["T3, T4"]);
    app.db.prepare("UPDATE kots SET accepted_at = 1, done_at = 1").run();
    const bill = await issue(orderId);
    expect(bill.receipt.tableName).toBe("T3, T4");
  });

  it("excludes merged orders from cancellation counts", async () => {
    const receiving = await order(null);
    const folded = await order(null);
    const plain = await order(null);
    const cancel = app.db.prepare("UPDATE orders SET status = 'cancelled', closed_at = ?, cancelled_by = ?, cancel_reason = 'x', merged_into = ? WHERE id = ?");
    cancel.run(Date.now(), userId, receiving, folded);
    const date = localDateKey(Date.now());
    const dayEnd = async () => (await request("GET", `/api/reports/day-end?date=${date}`)).json().report.cancellations.orderCount;
    const listed = async () => ((await request("GET", `/api/reports/operations/cancellations?from=${date}&to=${date}`)).json().report.tables[1].rows as Array<{ orderId: string }>).map((r) => r.orderId);
    expect(await dayEnd()).toBe(0);
    expect(await listed()).toEqual([]);

    app.db.prepare("UPDATE orders SET status = 'cancelled', closed_at = ?, cancelled_by = ?, cancel_reason = 'x' WHERE id = ?").run(Date.now(), userId, plain);
    expect(await dayEnd()).toBe(1);
    expect(await listed()).toEqual([plain]);
  });
});
