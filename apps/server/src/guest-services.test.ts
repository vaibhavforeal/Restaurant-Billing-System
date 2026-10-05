import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { MIGRATIONS, PLANS, migrate, openDb, type LicenseClaims, type ServiceReceipt, type ServiceSubmission } from "@forkflow/domain";
import { buildServer } from "./server.js";
import { makeFakeSink } from "./print/sinks.js";
import { SETUP } from "./test-helpers.js";

const keys = generateKeyPairSync("ed25519");
const publicKey = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
const apps: FastifyInstance[] = [];
type Headers = { authorization: string; "x-forkflow-device": string };
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
afterEach(async () => {
  vi.restoreAllMocks();
  for (const app of apps.splice(0)) { await app.close(); app.db.close(); }
});

async function fixture() {
  let licenseNow = Date.now();
  const installationId = randomUUID();
  const db = openDb(":memory:"); migrate(db, MIGRATIONS);
  let app = buildServer({ db, sinkSend: makeFakeSink().send, licensing: { publicKey, installationId, now: () => licenseNow } });
  apps.push(app);
  const device = "a".repeat(64);
  const setup = await app.inject({ method: "POST", url: "/api/setup", payload: SETUP, headers: { "x-forkflow-device": device } });
  expect(setup.statusCode, setup.body).toBe(201);
  const headers: Headers = { authorization: `Bearer ${setup.json().token}`, "x-forkflow-device": device };
  const api = (method: "GET" | "POST" | "PUT" | "PATCH", url: string, payload?: object, as = headers) =>
    app.inject({ method, url, headers: as, ...(payload === undefined ? {} : { payload }) });
  const claims: LicenseClaims = { version: 1, installationId, licenseId: randomUUID(), organizationId: randomUUID(), outletId: randomUUID(),
    revision: 1, plan: "pro", features: PLANS.pro.features, maxDevices: PLANS.pro.maxDevices,
    issuedAt: licenseNow - 1000, expiresAt: licenseNow + 600_000, graceUntil: licenseNow + 1_200_000 };
  async function activate(plan: "basic" | "pro", revision: number, features: object = PLANS[plan].features) {
    const next = { ...claims, plan, revision, features, maxDevices: PLANS[plan].maxDevices };
    const message = `ff1.${Buffer.from(JSON.stringify(next)).toString("base64url")}`;
    const license = `${message}.${sign(null, Buffer.from(message), keys.privateKey).toString("base64url")}`;
    const response = await api("PUT", "/api/license", { license });
    expect(response.statusCode, response.body).toBe(200);
  }
  await activate("pro", 1);
  const registered = await api("POST", "/api/license/devices", { name: "Main counter" });
  expect(registered.statusCode, registered.body).toBe(200);
  async function table(name = "T1") {
    const response = await api("POST", "/api/tables", { name, area: "Patio" });
    expect(response.statusCode, response.body).toBe(201);
    const table = response.json().table as { id: string; name: string };
    const enabled = await api("PUT", `/api/qr/tables/${table.id}`, { enabled: true });
    expect(enabled.statusCode, enabled.body).toBe(200);
    return { ...table, qrToken: enabled.json().table.path.split("#")[1] as string };
  }
  const diningTable = await table();
  const submission = (kind: ServiceSubmission["kind"] = "waiter"): ServiceSubmission => ({
    clientRef: randomUUID(), receiptToken: randomBytes(32).toString("hex"), kind,
  });
  const submit = (body: object, token = diningTable.qrToken) => app.inject({ method: "POST", url: "/api/guest/service-requests", headers: { "x-qr-token": token }, payload: body });
  async function request(kind: ServiceSubmission["kind"] = "waiter", token = diningTable.qrToken) {
    const body = submission(kind), response = await submit(body, token);
    expect(response.statusCode, response.body).toBe(201);
    expect(response.headers["cache-control"]).toBe("no-store");
    return { body, request: response.json().request as ServiceReceipt };
  }
  const receipt = (id: string, token: string) => app.inject({ url: `/api/guest/service-requests/${id}`, headers: { "x-guest-receipt": token } });
  const resolve = (id: string, as = headers) => api("POST", `/api/qr/service-requests/${id}/resolve`, {}, as);
  const count = () => (db.prepare("SELECT COUNT(*) AS n FROM guest_service_requests").get() as { n: number }).n;
  async function staff(role: "cashier" | "waiter" | "kitchen"): Promise<Headers> {
    const pin = { cashier: "2345", waiter: "3456", kitchen: "4567" }[role];
    const created = await api("POST", "/api/users", { name: role, role, pin });
    expect(created.statusCode, created.body).toBe(201);
    const loggedIn = await api("POST", "/api/login", { pin });
    expect(loggedIn.statusCode, loggedIn.body).toBe(200);
    return { authorization: `Bearer ${loggedIn.json().token}`, "x-forkflow-device": device };
  }
  async function restart() {
    await app.close(); apps.splice(apps.indexOf(app), 1);
    app = buildServer({ db, sinkSend: makeFakeSink().send, licensing: { publicKey, installationId, now: () => licenseNow } });
    apps.push(app);
  }
  return { app, api, headers, claims, activate, diningTable, table, submission, submit, request, receipt, resolve, count, staff, restart,
    setLicenseNow: (value: number) => { licenseNow = value; }, setTime: (value: number) => vi.spyOn(Date, "now").mockReturnValue(value) };
}

describe("guest service requests", () => {
  it("notifies staff of waiter and bill requests without creating or modifying a sale", async () => {
    const f = await fixture();
    const category = await f.api("POST", "/api/categories", { name: "Food" });
    const product = await f.api("POST", "/api/products", { categoryId: category.json().category.id, name: "Meal", pricePaise: 10000, gstRate: 5 });
    const stock = await f.api("POST", "/api/stock-items", { clientRef: randomUUID(), name: "Rice", unit: "kg", openingQty: 5 });
    expect(stock.statusCode, stock.body).toBe(201);
    const opened = await f.api("POST", "/api/orders", { clientRef: randomUUID(), type: "dine_in", tableId: f.diningTable.id });
    expect((await f.api("POST", `/api/orders/${opened.json().order.id}/items`, { items: [{ productId: product.json().product.id, qty: 1, clientRef: randomUUID() }] })).statusCode).toBe(200);
    const salesTables = ["orders", "order_items", "bills", "payments", "kots", "stock_items", "stock_moves", "sequences"];
    const snapshot = () => Object.fromEntries(salesTables.map((table) => [table, f.app.db.prepare(`SELECT * FROM ${table}`).all()]));
    const before = snapshot();
    const broadcast = vi.spyOn(f.app, "broadcast");
    const waiter = await f.request(), bill = await f.request("bill");
    expect(waiter.request).toMatchObject({ kind: "waiter", status: "pending", tableName: "T1", resolvedAt: null });
    expect(bill.request.kind).toBe("bill");
    expect(waiter.request.expiresAt - waiter.request.createdAt).toBe(600_000);
    expect((await f.resolve(waiter.request.id)).statusCode).toBe(200);
    expect((await f.resolve(bill.request.id)).statusCode).toBe(200);
    expect(snapshot()).toEqual(before);
    expect(broadcast).toHaveBeenCalledTimes(4);
    for (const call of broadcast.mock.calls) expect(call).toEqual(["service-request.changed", {}]);
    expect((await f.api("GET", "/api/license/devices")).json().devices).toHaveLength(1);
  });

  it("exposes only a guest's own receipt and never uses guest capabilities to authorize staff APIs", async () => {
    const f = await fixture(); const waiter = await f.request(), bill = await f.request("bill");
    const own = await f.receipt(waiter.request.id, waiter.body.receiptToken);
    expect(own.statusCode, own.body).toBe(200);
    expect(own.headers["cache-control"]).toBe("no-store");
    expect(Object.keys(own.json().request).sort()).toEqual(["createdAt", "expiresAt", "id", "kind", "resolvedAt", "status", "tableName"]);
    expect(JSON.stringify(own.json())).not.toContain(waiter.body.receiptToken);
    expect(JSON.stringify(own.json())).not.toContain(f.diningTable.id);
    expect(f.app.db.prepare("SELECT receipt_hash FROM guest_service_requests WHERE id = ?").get(waiter.request.id))
      .toEqual({ receipt_hash: hash(waiter.body.receiptToken) });
    expect((await f.receipt(bill.request.id, waiter.body.receiptToken)).statusCode).toBe(404);
    expect((await f.receipt(waiter.request.id, f.diningTable.qrToken)).statusCode).toBe(404);
    expect((await f.app.inject({ url: `/api/guest/service-requests/${waiter.request.id}` })).statusCode).toBe(404);
    for (const url of ["/api/qr/service-requests", "/api/orders", "/api/bills", "/api/stock-items"]) {
      const response = await f.app.inject({ url, headers: { "x-qr-token": f.diningTable.qrToken, "x-guest-receipt": waiter.body.receiptToken } });
      expect(response.statusCode, response.body).toBe(401);
    }
    const forbidden = await f.app.inject({ method: "POST", url: `/api/qr/service-requests/${waiter.request.id}/resolve`, headers: { "x-guest-receipt": waiter.body.receiptToken }, payload: {} });
    expect(forbidden.statusCode).toBe(401);
    expect(forbidden.headers["cache-control"]).toBe("no-store");
  });

  it("recovers exact retries but rejects changed kinds, receipt secrets and original QR capabilities", async () => {
    const f = await fixture(); const pending = await f.request();
    const broadcast = vi.spyOn(f.app, "broadcast");
    const again = await f.submit(pending.body);
    expect(again.statusCode, again.body).toBe(200);
    expect(again.json().request).toEqual(pending.request);
    expect((await f.submit({ ...pending.body, kind: "bill" })).statusCode).toBe(409);
    expect((await f.submit({ ...pending.body, receiptToken: randomBytes(32).toString("hex") })).statusCode).toBe(404);
    expect((await f.submit(pending.body, "f".repeat(64))).statusCode).toBe(409);
    expect(f.count()).toBe(1);
    expect(broadcast).not.toHaveBeenCalled();
  });

  it("serializes both simultaneous retries and independent calls of the same kind", async () => {
    const f = await fixture(); const body = f.submission();
    const retries = await Promise.all([f.submit(body), f.submit(body)]);
    expect(retries.map((response) => response.statusCode).sort()).toEqual([200, 201]);
    expect(retries[0]!.json().request).toEqual(retries[1]!.json().request);
    const fresh = await Promise.all([f.submit(f.submission("bill")), f.submit(f.submission("bill"))]);
    expect(fresh.map((response) => response.statusCode).sort()).toEqual([201, 409]);
    expect(f.count()).toBe(2);
    expect(f.app.db.prepare("SELECT kind, COUNT(*) AS n FROM guest_service_requests WHERE status = 'pending' GROUP BY kind ORDER BY kind").all())
      .toEqual([{ kind: "bill", n: 1 }, { kind: "waiter", n: 1 }]);
  });

  it("enforces one pending call per table and kind independently of the 60-second cooldown", async () => {
    const f = await fixture(); const waiter = await f.request();
    expect((await f.submit(f.submission())).statusCode).toBe(409);
    const otherTable = await f.table("T2");
    expect((await f.submit(f.submission(), otherTable.qrToken)).statusCode).toBe(201);
    expect((await f.submit(f.submission("bill"))).statusCode).toBe(201);
    expect((await f.resolve(waiter.request.id)).statusCode).toBe(200);
    f.setTime(waiter.request.createdAt + 59_999);
    expect((await f.submit(f.submission())).statusCode).toBe(429);
    f.setTime(waiter.request.createdAt + 60_000);
    expect((await f.submit(f.submission())).statusCode).toBe(201);
    expect(f.count()).toBe(4);
  });

  it("allows active and grace Pro calls but blocks Basic and legacy licenses without the QR entitlement", async () => {
    const f = await fixture(); const pending = await f.request();
    await f.activate("basic", 2);
    expect((await f.submit(f.submission("bill"))).statusCode).toBe(403);
    expect((await f.api("GET", "/api/qr/service-requests")).statusCode).toBe(200);
    expect((await f.resolve(pending.request.id)).statusCode).toBe(200);
    await f.activate("pro", 3, { recipes: true });
    expect((await f.submit(f.submission("bill"))).statusCode).toBe(403);
    await f.activate("pro", 4);
    f.setLicenseNow(f.claims.expiresAt);
    expect((await f.submit(f.submission("bill"))).statusCode).toBe(201);
  });

  it("preserves receipt and retry recovery after QR rotation, disablement and license expiry", async () => {
    const f = await fixture(); const pending = await f.request();
    const rotated = await f.api("PUT", `/api/qr/tables/${f.diningTable.id}`, { enabled: true, rotate: true });
    expect(rotated.statusCode, rotated.body).toBe(200);
    const newToken = rotated.json().table.path.split("#")[1] as string;
    expect(newToken).not.toBe(f.diningTable.qrToken);
    expect((await f.submit(f.submission("bill"))).statusCode).toBe(404);
    expect((await f.submit(pending.body)).statusCode).toBe(200);
    expect((await f.submit(pending.body, newToken)).statusCode).toBe(409);
    expect((await f.api("PUT", `/api/qr/tables/${f.diningTable.id}`, { enabled: false })).statusCode).toBe(200);
    expect((await f.submit(f.submission("bill"), newToken)).statusCode).toBe(404);
    f.setLicenseNow(f.claims.graceUntil);
    expect((await f.submit(f.submission("bill"), newToken)).statusCode).toBe(403);
    expect((await f.submit(pending.body)).statusCode).toBe(200);
    const receipt = await f.receipt(pending.request.id, pending.body.receiptToken);
    expect(receipt.statusCode, receipt.body).toBe(200);
    expect(receipt.json().request).toEqual(pending.request);
    expect(f.count()).toBe(1);
  });

  it("rejects new requests for inactive or unknown tables and invalid QR credentials", async () => {
    const f = await fixture();
    expect((await f.submit(f.submission(), "bad")).statusCode).toBe(404);
    expect((await f.submit(f.submission(), "f".repeat(64))).statusCode).toBe(404);
    expect((await f.app.inject({ method: "POST", url: "/api/guest/service-requests", payload: f.submission() })).statusCode).toBe(404);
    expect((await f.api("PATCH", `/api/tables/${f.diningTable.id}`, { isActive: false })).statusCode).toBe(200);
    expect((await f.submit(f.submission())).statusCode).toBe(404);
    expect(f.count()).toBe(0);
  });

  it("validates strict payloads and rejects bodies larger than 4 KiB without writing a request", async () => {
    const f = await fixture(); const body = f.submission();
    const invalid = [{ ...body, kind: "payment" }, { ...body, clientRef: "invalid" }, { ...body, receiptToken: "A".repeat(64) },
      { ...body, receiptToken: "a".repeat(63) }, { ...body, tableId: randomUUID() }, { ...body, amountPaise: 10000 }];
    for (const input of invalid) {
      const response = await f.submit(input);
      expect(response.statusCode, response.body).toBe(400);
      expect(response.headers["cache-control"]).toBe("no-store");
    }
    const oversized = await f.submit({ ...body, padding: "x".repeat(4096) });
    expect(oversized.statusCode, oversized.body).toBe(413);
    expect(oversized.headers["cache-control"]).toBe("no-store");
    expect(f.count()).toBe(0);
  });

  it("permits waiter and cashier review and resolution but denies kitchen staff", async () => {
    const f = await fixture(); const waiter = await f.staff("waiter"), cashier = await f.staff("cashier"), kitchen = await f.staff("kitchen");
    const pending = await f.request(), bill = await f.request("bill");
    for (const headers of [waiter, cashier]) expect((await f.api("GET", "/api/qr/service-requests", undefined, headers)).statusCode).toBe(200);
    expect((await f.api("GET", "/api/qr/service-requests", undefined, kitchen)).statusCode).toBe(403);
    expect((await f.resolve(pending.request.id, kitchen)).statusCode).toBe(403);
    expect((await f.resolve(pending.request.id, waiter)).json().request.resolvedByName).toBe("waiter");
    expect((await f.resolve(bill.request.id, cashier)).json().request.resolvedByName).toBe("cashier");
    const publicReceipt = (await f.receipt(pending.request.id, pending.body.receiptToken)).json().request;
    expect(publicReceipt.status).toBe("resolved");
    expect(publicReceipt).not.toHaveProperty("resolvedByName");
    expect(publicReceipt).not.toHaveProperty("tableId");
  });

  it("resolves exactly once across simultaneous retries and preserves the first staff member and timestamp", async () => {
    const f = await fixture(); const pending = await f.request(); const waiter = await f.staff("waiter");
    const broadcast = vi.spyOn(f.app, "broadcast");
    const responses = await Promise.all([f.resolve(pending.request.id), f.resolve(pending.request.id)]);
    expect(responses.map((response) => response.statusCode)).toEqual([200, 200]);
    expect(responses[0]!.json().request).toEqual(responses[1]!.json().request);
    expect(responses[0]!.json().request).toMatchObject({ status: "resolved", resolvedByName: SETUP.adminName, resolvedAt: expect.any(Number) });
    const late = await f.resolve(pending.request.id, waiter);
    expect(late.statusCode, late.body).toBe(200);
    expect(late.json().request).toEqual(responses[0]!.json().request);
    expect(broadcast).toHaveBeenCalledTimes(1);
    expect((await f.submit(pending.body)).json().request.status).toBe("resolved");
    expect((await f.api("GET", "/api/qr/service-requests")).json().requests).toEqual([]);
    expect((await f.api("GET", "/api/qr/service-requests?status=resolved")).json().requests).toHaveLength(1);
  });

  it("persists expiry at ten minutes, keeps the receipt readable and releases the pending slot", async () => {
    const f = await fixture(); const pending = await f.request();
    f.setTime(pending.request.expiresAt - 1);
    expect((await f.receipt(pending.request.id, pending.body.receiptToken)).json().request.status).toBe("pending");
    const broadcast = vi.spyOn(f.app, "broadcast");
    f.setTime(pending.request.expiresAt);
    const expired = await f.receipt(pending.request.id, pending.body.receiptToken);
    expect(expired.json().request).toMatchObject({ status: "expired", resolvedAt: null });
    expect(f.app.db.prepare("SELECT status FROM guest_service_requests WHERE id = ?").get(pending.request.id)).toEqual({ status: "expired" });
    expect((await f.resolve(pending.request.id)).statusCode).toBe(409);
    expect((await f.submit(pending.body)).json().request.status).toBe("expired");
    expect((await f.api("GET", "/api/qr/service-requests")).json().requests).toEqual([]);
    expect((await f.api("GET", "/api/qr/service-requests?status=expired")).json().requests).toHaveLength(1);
    expect(broadcast).toHaveBeenCalledTimes(1);
    expect((await f.submit(f.submission())).statusCode).toBe(201);
    expect(f.count()).toBe(2);
  });

  it("retains receipt secrets, pending uniqueness and resolved history across a server restart", async () => {
    const f = await fixture(); const waiter = await f.request(), bill = await f.request("bill");
    const resolved = await f.resolve(waiter.request.id);
    expect(resolved.statusCode).toBe(200);
    await f.restart();
    expect((await f.receipt(waiter.request.id, waiter.body.receiptToken)).json().request.status).toBe("resolved");
    expect((await f.receipt(bill.request.id, bill.body.receiptToken)).json().request).toEqual(bill.request);
    expect((await f.submit(bill.body)).statusCode).toBe(200);
    expect((await f.submit(f.submission("bill"))).statusCode).toBe(409);
    expect((await f.resolve(waiter.request.id)).json().request).toEqual(resolved.json().request);
    expect((await f.api("GET", "/api/qr/service-requests?status=all")).json().requests).toHaveLength(2);
  });

  it("does not publish or reserve a cooldown slot when a service request insert fails", async () => {
    const f = await fixture(); const body = f.submission();
    f.app.db.exec("CREATE TRIGGER fail_service_insert BEFORE INSERT ON guest_service_requests BEGIN SELECT RAISE(ABORT, 'test'); END");
    const broadcast = vi.spyOn(f.app, "broadcast");
    expect((await f.submit(body)).statusCode).toBe(500);
    expect(f.count()).toBe(0);
    expect(broadcast).not.toHaveBeenCalled();
    f.app.db.exec("DROP TRIGGER fail_service_insert");
    expect((await f.submit(body)).statusCode).toBe(201);
  });

  it("rolls back a failed resolution and permits a later retry", async () => {
    const f = await fixture(); const pending = await f.request();
    f.app.db.exec("CREATE TRIGGER fail_service_resolve BEFORE UPDATE ON guest_service_requests WHEN NEW.status = 'resolved' BEGIN SELECT RAISE(ABORT, 'test'); END");
    const broadcast = vi.spyOn(f.app, "broadcast");
    expect((await f.resolve(pending.request.id)).statusCode).toBe(500);
    expect((await f.receipt(pending.request.id, pending.body.receiptToken)).json().request).toEqual(pending.request);
    expect(f.app.db.prepare("SELECT resolved_at, resolved_by FROM guest_service_requests WHERE id = ?").get(pending.request.id))
      .toEqual({ resolved_at: null, resolved_by: null });
    expect(broadcast).not.toHaveBeenCalled();
    f.app.db.exec("DROP TRIGGER fail_service_resolve");
    expect((await f.resolve(pending.request.id)).statusCode).toBe(200);
  });

  it("limits repeated submissions to 30 per minute while preserving exact retry recovery after the window", async () => {
    const f = await fixture(); const pending = await f.request();
    for (let index = 1; index < 30; index++) expect((await f.submit(pending.body)).statusCode).toBe(200);
    const limited = await f.submit(pending.body);
    expect(limited.statusCode, limited.body).toBe(429);
    expect(limited.headers["cache-control"]).toBe("no-store");
    expect(f.count()).toBe(1);
    f.setTime(pending.request.createdAt + 60_001);
    expect((await f.submit(pending.body)).statusCode).toBe(200);
  });

  it("bounds public receipt polling separately at 600 per minute", async () => {
    const f = await fixture(); const pending = await f.request();
    for (let index = 0; index < 600; index++) expect((await f.receipt(pending.request.id, pending.body.receiptToken)).statusCode).toBe(200);
    expect((await f.receipt(pending.request.id, pending.body.receiptToken)).statusCode).toBe(429);
    expect((await f.submit(pending.body)).statusCode).toBe(200);
    f.setTime(Date.now() + 60_001);
    expect((await f.receipt(pending.request.id, pending.body.receiptToken)).statusCode).toBe(200);
  });

  it("returns at most 100 newest requests and filters status without exposing receipt credentials", async () => {
    const f = await fixture(); const now = Date.now();
    const insert = f.app.db.prepare(`INSERT INTO guest_service_requests
      (id, client_ref, table_id, table_name, kind, receipt_hash, fingerprint, status, created_at, expires_at)
      VALUES (?, ?, ?, ?, 'waiter', ?, ?, 'expired', ?, ?)`);
    f.app.db.transaction(() => {
      for (let index = 0; index < 105; index++) insert.run(randomUUID(), randomUUID(), f.diningTable.id, "T1", hash(`receipt-${index}`), hash(`fingerprint-${index}`), now - 10000 + index, now - 1000 + index);
    })();
    const response = await f.api("GET", "/api/qr/service-requests?status=all");
    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json().requests).toHaveLength(100);
    expect(response.json().requests[0].createdAt).toBe(now - 10000 + 104);
    expect(response.json().requests[99].createdAt).toBe(now - 10000 + 5);
    expect(response.json().requests[0]).not.toHaveProperty("receipt_hash");
    expect(response.json().requests[0]).not.toHaveProperty("fingerprint");
    expect((await f.api("GET", "/api/qr/service-requests")).json().requests).toEqual([]);
    expect((await f.api("GET", "/api/qr/service-requests?status=invalid")).statusCode).toBe(400);
  });
});
