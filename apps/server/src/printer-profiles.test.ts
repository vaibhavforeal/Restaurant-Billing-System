import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MIGRATIONS, migrate, openDb, uuidv7 } from "@forkflow/domain";
import { buildServer } from "./server.js";
import { makeFakeSink } from "./print/sinks.js";
import { auth, createUser, setupAdmin } from "./test-helpers.js";

describe("printer discovery and profiles", () => {
  let app: ReturnType<typeof buildServer>, token: string;
  let fake: ReturnType<typeof makeFakeSink>;
  const discovery = vi.fn(async () => ({ supported: true, printers: [{ name: 'Counter "$"', driver: "Thermal", port: "USB001", isDefault: true }] }));
  beforeEach(async () => {
    const db = openDb(":memory:"); migrate(db, MIGRATIONS); fake = makeFakeSink();
    app = buildServer({ db, sinkSend: fake.send, discoverPrinters: discovery });
    ({ token } = await setupAdmin(app));
  });
  afterEach(async () => { await app.close(); app.db.close(); discovery.mockClear(); });
  const call = (method: "GET" | "POST" | "PATCH", url: string, payload?: object) => app.inject({ method, url, headers: auth(token), ...(payload ? { payload } : {}) });

  it("lists host printers only for administrators and reports discovery failures", async () => {
    expect((await app.inject({ method: "GET", url: "/api/printers/discover" })).statusCode).toBe(401);
    const cashier = await createUser(app, token, { name: "Cashier", pin: "4567", role: "cashier" });
    expect((await app.inject({ method: "GET", url: "/api/printers/discover", headers: auth(cashier.token) })).statusCode).toBe(403);
    const result = await call("GET", "/api/printers/discover");
    expect(result.statusCode).toBe(200); expect(result.json().printers[0].name).toBe('Counter "$"');
    discovery.mockRejectedValueOnce(new Error("spooler unavailable"));
    expect((await call("GET", "/api/printers/discover")).statusCode).toBe(503);
  });

  it("validates combined connection edits and independently applies saved bill/KOT profiles", async () => {
    const created = await call("POST", "/api/printers", { name: "Counter", kind: "network", connection: "127.0.0.1",
      receiptProfile: { copies: 2, feedLines: 0, autoCut: false }, kotProfile: { copies: 3, feedLines: 7, autoCut: true } });
    expect(created.statusCode).toBe(201); const printer = created.json().printer;
    expect((await call("PATCH", `/api/printers/${printer.id}`, { kind: "bluetooth" })).statusCode).toBe(400);
    expect((await call("PATCH", `/api/printers/${printer.id}`, { receiptProfile: { copies: 99 } })).statusCode).toBe(400);
    expect((await call("PATCH", `/api/printers/${printer.id}`, { connection: "127.0.0.1:70000" })).statusCode).toBe(400);
    await call("POST", `/api/printers/${printer.id}/test-print`, { profile: "receipt" });
    await vi.waitFor(() => expect(fake.sent).toHaveLength(2));
    expect(fake.sent[0]!.bytes.subarray(-3)).toEqual(Buffer.from([27, 100, 0]));
    await call("POST", `/api/printers/${printer.id}/test-print`, { profile: "kot" });
    await vi.waitFor(() => expect(fake.sent).toHaveLength(5));
    expect(fake.sent[2]!.bytes.subarray(-7)).toEqual(Buffer.from([27, 100, 7, 29, 86, 66, 0]));
    expect((await call("GET", "/api/printers")).json().printers[0].receiptProfile).toEqual(printer.receiptProfile);
    await call("PATCH", `/api/printers/${printer.id}`, { isActive: false });
    expect((await call("POST", `/api/printers/${printer.id}/test-print`)).statusCode).toBe(409);
  });

  it("prints routed KOT/cancellation and bills with their own profiles, without duplicating a replay", async () => {
    const { printer } = (await call("POST", "/api/printers", { name: "Shared printer", kind: "network", connection: "localhost",
      receiptProfile: { copies: 2, feedLines: 1, autoCut: false }, kotProfile: { copies: 3, feedLines: 6, autoCut: true } })).json();
    const station = (await call("GET", "/api/kot-stations")).json().stations[0];
    await call("PATCH", `/api/kot-stations/${station.id}`, { printerId: printer.id });
    const { category } = (await call("POST", "/api/categories", { name: "Food" })).json();
    const { product } = (await call("POST", "/api/products", { name: "Dosa", pricePaise: 10000, gstRate: 5, categoryId: category.id, kotStationId: station.id })).json();
    const { order } = (await call("POST", "/api/orders", { type: "parcel", clientRef: uuidv7() })).json();
    await call("POST", `/api/orders/${order.id}/items`, { items: [{ productId: product.id, qty: 1, clientRef: uuidv7() }, { productId: product.id, qty: 2, clientRef: uuidv7() }] });
    const items = (app.db.prepare("SELECT id FROM order_items WHERE order_id = ?").all(order.id) as { id: string }[]).map(item => item.id);
    const send = { clientRef: uuidv7(), itemIds: items };
    app.db.exec("CREATE TRIGGER reject_print BEFORE INSERT ON print_jobs BEGIN SELECT RAISE(ABORT, 'disk write failed'); END");
    expect((await call("POST", `/api/orders/${order.id}/send`, send)).statusCode).toBe(500);
    expect(app.db.prepare("SELECT COUNT(*) AS n FROM kots").get()).toEqual({ n: 0 });
    expect(app.db.prepare("SELECT COUNT(*) AS n FROM order_items WHERE status = 'pending'").get()).toEqual({ n: 2 });
    app.db.exec("DROP TRIGGER reject_print");
    expect((await call("POST", `/api/orders/${order.id}/send`, send)).statusCode).toBe(200);
    await call("POST", `/api/orders/${order.id}/send`, send);
    await vi.waitFor(() => expect(fake.sent).toHaveLength(3));
    expect(fake.sent[0]!.bytes.subarray(-7)).toEqual(Buffer.from([27, 100, 6, 29, 86, 66, 0]));
    app.db.exec("CREATE TRIGGER reject_print BEFORE INSERT ON print_jobs BEGIN SELECT RAISE(ABORT, 'disk write failed'); END");
    expect((await call("POST", `/api/order-items/${items[0]}/cancel`, { reason: "Changed order" })).statusCode).toBe(500);
    expect(app.db.prepare("SELECT status FROM order_items WHERE id = ?").get(items[0])).toEqual({ status: "sent" });
    app.db.exec("DROP TRIGGER reject_print");
    const cancel = await call("POST", `/api/order-items/${items[0]}/cancel`, { reason: "Changed order" });
    expect(cancel.statusCode).toBe(200);
    await vi.waitFor(() => expect(fake.sent).toHaveLength(6));
    expect(fake.sent[3]!.bytes.toString()).toContain("CANCELLED");
    const { preview } = (await call("POST", `/api/orders/${order.id}/bill-preview`, {})).json();
    const issue = { clientRef: uuidv7(), previewKey: preview.previewKey, printerId: printer.id };
    app.db.exec("CREATE TRIGGER reject_print BEFORE INSERT ON print_jobs BEGIN SELECT RAISE(ABORT, 'disk write failed'); END");
    expect((await call("POST", `/api/orders/${order.id}/bill`, issue)).statusCode).toBe(500);
    expect(app.db.prepare("SELECT COUNT(*) AS n FROM bills").get()).toEqual({ n: 0 });
    expect(app.db.prepare("SELECT status FROM orders WHERE id = ?").get(order.id)).toEqual({ status: "open" });
    app.db.exec("DROP TRIGGER reject_print");
    expect((await call("POST", `/api/orders/${order.id}/bill`, issue)).statusCode).toBe(201);
    expect((await call("POST", `/api/orders/${order.id}/bill`, issue)).statusCode).toBe(200);
    await vi.waitFor(() => expect(fake.sent).toHaveLength(8));
    expect(fake.sent[6]!.bytes.subarray(-3)).toEqual(Buffer.from([27, 100, 1]));
  });

  it("rejects an unconfirmed retry of interrupted work", async () => {
    const job = app.printQueue.enqueue({ id: "p", name: "P", kind: "network", connection: "localhost" }, "test", "T", Buffer.from("T"));
    await vi.waitFor(() => expect(fake.sent).toHaveLength(1));
    const unknown = { ...job, status: "unknown", error: "Interrupted" };
    app.db.prepare("UPDATE print_jobs SET status = 'unknown', job_json = ? WHERE id = ?").run(JSON.stringify(unknown), job.id);
    expect((await call("POST", `/api/print-jobs/${job.id}/retry`)).statusCode).toBe(409);
    expect((await call("POST", `/api/print-jobs/${job.id}/retry`, { checkedPaper: true })).statusCode).toBe(200);
    await vi.waitFor(() => expect(fake.sent).toHaveLength(2));
  });
});
