import { afterEach, describe, expect, it } from "vitest";
import { MIGRATIONS, migrate, openDb, uuidv7 } from "@forkflow/domain";
import { ZOMATO_CSV_COLUMNS, zomatoCsv, type ZomatoImportKind, type ZomatoReconciliation } from "@forkflow/domain";
import type { FastifyInstance } from "fastify";
import { buildServer } from "./server.js";
import { auth, createUser, enableIntegration, setupAdmin } from "./test-helpers.js";
import type { ZomatoProvider } from "./zomato.js";

let app: FastifyInstance;
afterEach(async () => { if (app) { await app.close(); app.db.close(); } });
const csv = (kind: ZomatoImportKind, rows: (string | number)[][]) => zomatoCsv([ZOMATO_CSV_COLUMNS[kind], ...rows]);
const order = (id = "001", total = "500.00", state = "delivered", date = "2026-10-02T12:30:00+05:30") => ["R1", id, date, state, total, "prepaid"];
const settlement = (id = "001", entry = "S1", gross = "500.00", deductions = "100.00", paid = "400.00", date = "2026-10-03") => ["R1", id, entry, "BATCH-1", date, gross, deductions, "0", paid];
async function fixture(provider?: ZomatoProvider) {
  const db = openDb(":memory:"); migrate(db, MIGRATIONS);
  app = buildServer({ db, ...(provider ? { zomatoProvider: provider } : {}) });
  const admin = await setupAdmin(app);
  const api = (method: "GET" | "POST" | "PATCH", url: string, payload?: object, token = admin.token) => app.inject({ method, url, headers: auth(token), ...(payload ? { payload } : {}) });
  const settings = { restaurantId: "R1", restaurantName: "Test restaurant", posId: "", webhookBaseUrl: "", enabled: false, version: 1 };
  expect((await api("PATCH", "/api/zomato/settings", settings)).statusCode).toBe(200);
  const preview = (kind: ZomatoImportKind, rows: (string | number)[][]) => api("POST", "/api/zomato/import/preview", { kind, csv: csv(kind, rows) });
  const commit = async (kind: ZomatoImportKind, rows: (string | number)[][]) => {
    const p = await preview(kind, rows); expect(p.statusCode, p.body).toBe(200);
    const payload = { kind, csv: csv(kind, rows), revision: p.json().revision };
    const response = await api("POST", "/api/zomato/import/commit", payload);
    expect(response.statusCode, response.body).toBe(200); return { response, payload };
  };
  const report = async (from = "2026-10-02", to = "2026-10-03") => {
    const r = await api("GET", `/api/zomato/reconciliation?from=${from}&to=${to}`);
    expect(r.statusCode, r.body).toBe(200); return r.json() as ZomatoReconciliation;
  };
  return { admin, api, settings, preview, commit, report };
}

describe("Zomato setup and reconciliation", () => {
  it("upgrades existing data additively and reruns safely", () => {
    const db = openDb(":memory:");
    try {
      migrate(db, MIGRATIONS.filter(m => m.version < 21));
      db.prepare("UPDATE settings SET restaurant_name='Existing restaurant' WHERE id=1").run();
      migrate(db, MIGRATIONS); migrate(db, MIGRATIONS);
      expect(db.prepare("SELECT restaurant_name FROM settings").get()).toEqual({ restaurant_name: "Existing restaurant" });
      expect(db.prepare("SELECT enabled,version FROM zomato_settings").get()).toEqual({ enabled: 0, version: 1 });
    } finally { db.close(); }
  });
  it("keeps setup honest and rejects unsupported activation and stale edits", async () => {
    const f = await fixture();
    const read = await f.api("GET", "/api/zomato/settings");
    expect(read.headers["cache-control"]).toBe("no-store");
    expect(read.json()).toMatchObject({ adapterConfigured: false, enabled: false, lastEventAt: null });
    expect((await f.api("PATCH", "/api/zomato/settings", { ...f.settings, version: 2, enabled: true })).statusCode).toBe(409);
    expect((await f.api("PATCH", "/api/zomato/settings", f.settings)).statusCode).toBe(409);
    for (const webhookBaseUrl of ["http://orders.example.com", "https://localhost", "https://10.0.0.1", "https://user:secret@example.com", "https://example.com/?key=secret", "https://example.com/path"]) {
      expect((await f.api("PATCH", "/api/zomato/settings", { ...f.settings, version: 2, webhookBaseUrl })).statusCode).toBe(400);
    }
    const off = await app.inject({ method: "POST", url: "/api/integrations/zomato/webhook", payload: {} });
    expect(off.statusCode).toBe(503);
    expect(off.json().error).toBe("Zomato is turned off in the Marketplace");
  });
  it("reports live integration as not configured when the Marketplace is on but there is no provider or it is disabled", async () => {
    await fixture();
    enableIntegration(app, "zomato");
    const missing = await app.inject({ method: "POST", url: "/api/integrations/zomato/webhook", payload: {} });
    expect(missing.statusCode).toBe(503);
    expect(missing.json().error).toMatch(/not configured/);
    await app.close(); app.db.close();
    await fixture({ async verifyAndDecode() { throw new Error("must not be called"); } });
    enableIntegration(app, "zomato");
    expect(app.db.prepare("SELECT enabled FROM zomato_settings").get()).toEqual({ enabled: 0 });
    const disabled = await app.inject({ method: "POST", url: "/api/integrations/zomato/webhook", payload: {} });
    expect(disabled.statusCode).toBe(503);
    expect(disabled.json().error).toMatch(/not configured/);
  });
  it("enforces role and anonymous access at every data boundary", async () => {
    const f = await fixture();
    const cashier = await createUser(app, f.admin.token, { name: "Cash", pin: "2345", role: "cashier" });
    const waiter = await createUser(app, f.admin.token, { name: "Wait", pin: "3456", role: "waiter" });
    const kitchen = await createUser(app, f.admin.token, { name: "Cook", pin: "4567", role: "kitchen" });
    for (const path of ["settings", "orders", "reconciliation", "imports"]) {
      expect((await app.inject({ url: `/api/zomato/${path}` })).statusCode).toBe(401);
      for (const staff of [waiter, kitchen]) expect((await f.api("GET", `/api/zomato/${path}`, undefined, staff.token)).statusCode).toBe(403);
      expect((await f.api("GET", `/api/zomato/${path}`, undefined, cashier.token)).statusCode).toBe(200);
    }
    expect((await f.api("PATCH", "/api/zomato/settings", { ...f.settings, version: 2 }, cashier.token)).statusCode).toBe(403);
    for (const action of ["preview", "commit"]) for (const staff of [waiter, kitchen])
      expect((await f.api("POST", `/api/zomato/import/${action}`, { kind: "orders", csv: csv("orders", [order()]) }, staff.token)).statusCode).toBe(403);
    expect((await f.api("POST", "/api/zomato/import/preview", { kind: "orders", csv: csv("orders", [order()]) }, cashier.token)).statusCode).toBe(200);
  });
  it("previews without writes, imports once, replays a lost response and audits the actor", async () => {
    const f = await fixture();
    expect((await f.preview("orders", [order()])).json()).toMatchObject({ added: 1, skipped: 0 });
    expect((await f.report()).rows).toHaveLength(0);
    const { payload } = await f.commit("orders", [order()]);
    expect((await f.api("POST", "/api/zomato/import/commit", payload)).statusCode).toBe(200);
    expect((await f.preview("orders", [order()])).json()).toMatchObject({ added: 0, skipped: 1 });
    expect((await f.report()).rows).toHaveLength(1);
    expect((await f.api("GET", "/api/zomato/imports")).json().imports).toHaveLength(1);
    expect(app.db.prepare("SELECT COUNT(*) AS n FROM orders").get()).toEqual({ n: 0 });
    expect(app.db.prepare("SELECT COUNT(*) AS n FROM bills").get()).toEqual({ n: 0 });
    expect(app.db.prepare("SELECT COUNT(*) AS n FROM payments").get()).toEqual({ n: 0 });
  });
  it("reconciles exact paise and distinguishes all review cases", async () => {
    const f = await fixture();
    await f.commit("orders", [order("matched", "500.01"), order("underpaid"), order("gross"), order("missing"), order("cancelled", "500.00", "cancelled")]);
    await f.commit("settlements", [settlement("matched", "a", "500.01", "100", "400.01"), settlement("underpaid", "b", "500", "100", "399.99"),
      settlement("gross", "c", "490", "90", "400"), settlement("orphan", "d"), settlement("cancelled", "e")]);
    const r = await f.report(), byId = Object.fromEntries(r.rows.map(row => [row.orderId, row]));
    expect(byId.matched).toMatchObject({ state: "matched", expectedNetPaise: 40001, payoutDifferencePaise: 0 });
    expect(byId.underpaid).toMatchObject({ state: "mismatch", payoutDifferencePaise: -1 });
    expect(byId.gross).toMatchObject({ state: "mismatch", orderDifferencePaise: -1000, payoutDifferencePaise: 0 });
    expect(byId.missing).toMatchObject({ state: "awaiting_statement", entries: 0, orderDifferencePaise: null });
    expect(byId.orphan).toMatchObject({ state: "missing_order", orderTotalPaise: null });
    expect(byId.cancelled).toMatchObject({ state: "review_cancellation" });
    expect(r.totals).toMatchObject({ matched: 1, needsReview: 5, payoutDifferencePaise: -1 });
    expect(r.totals.expectedNetPaise).toBe(r.totals.statementGrossPaise - r.totals.deductionsPaise + r.totals.additionsPaise);
  });
  it("keeps cross-period adjustments and missing orders visible without double counting", async () => {
    const f = await fixture();
    await f.commit("orders", [order()]);
    await f.commit("settlements", [settlement(), settlement("001", "adjustment", "0", "10.05", "-10.05", "2026-11-01"), settlement("orphan", "orphan", "100", "10", "90")]);
    const r = await f.report("2026-10-02", "2026-10-02");
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]).toMatchObject({ state: "matched", entries: 2, expectedNetPaise: 38995, paidPaise: 38995 });
    const later = await f.report("2026-11-01", "2026-11-01");
    expect(later.rows[0]).toEqual(r.rows[0]);
    expect((await f.report("2026-10-03", "2026-10-03")).rows).toHaveLength(2);
    await f.commit("orders", [order("orphan", "100")]);
    expect((await f.report()).rows.find(row => row.orderId === "orphan")?.state).toBe("matched");
  });
  it("rejects mismatched outlets, unsafe amounts, invalid dates and malformed files atomically", async () => {
    const f = await fixture();
    const invalidOrders = [order("bad", "1.001"), order("bad", "NaN"), order("bad", "-10"), order("bad", "10", "unknown"),
      order("bad", "10", "delivered", "2026-02-30T12:00:00Z"), order("bad", "10", "delivered", "2026-10-02T12:00:00"), ["R2", ...order().slice(1)]];
    for (const row of invalidOrders) expect((await f.preview("orders", [order(), row])).statusCode).toBe(400);
    for (const source of ['wrong,headers\n1,2', '"unclosed', csv("orders", [order(), order()])]) {
      expect((await f.api("POST", "/api/zomato/import/preview", { kind: "orders", csv: source })).statusCode).toBe(400);
    }
    expect((await f.preview("settlements", [settlement(), settlement("002", "S1")])).statusCode).toBe(400);
    expect((await f.preview("settlements", [settlement("001", "S1", "10", "-1")])).statusCode).toBe(400);
    expect((await f.report()).rows).toHaveLength(0);
  });
  it("refuses conflicting duplicate data, stale previews, missing preview and outlet reassignment", async () => {
    const f = await fixture();
    const before = (await f.preview("orders", [order(), order("002")])).json();
    await f.commit("orders", [order()]);
    expect((await f.api("POST", "/api/zomato/import/commit", { kind: "orders", csv: csv("orders", [order(), order("002")]), revision: before.revision })).statusCode).toBe(409);
    expect((await f.preview("orders", [order("001", "600")])).statusCode).toBe(409);
    expect((await f.api("POST", "/api/zomato/import/commit", { kind: "orders", csv: csv("orders", [order("002")]) })).statusCode).toBe(400);
    expect((await f.api("PATCH", "/api/zomato/settings", { ...f.settings, version: 2, restaurantId: "R2" })).statusCode).toBe(409);
    expect((await f.report()).rows).toHaveLength(1);
  });
  it("validates report ranges and shows open imported records honestly", async () => {
    const f = await fixture(); await f.commit("orders", [order("open", "100", "received"), order()]);
    const live = await f.api("GET", "/api/zomato/orders");
    expect(live.json().orders).toMatchObject([{ orderId: "open", source: "import", items: [] }]);
    expect(live.headers["cache-control"]).toBe("no-store");
    for (const range of ["from=2026-02-30&to=2026-03-01", "from=2026-10-03&to=2026-10-02", "from=2020-01-01&to=2026-01-01"])
      expect((await f.api("GET", `/api/zomato/reconciliation?${range}`)).statusCode).toBe(400);
    expect((await f.report("2025-01-01", "2025-01-02")).totals.needsReview).toBe(0);
  });
});

describe("reconciliation of POS Zomato orders", () => {
  const placed = Date.parse("2026-10-02T12:30:00+05:30");
  /** A POS Zomato order worth Rs 580 at the Zomato price, opened on 2 Oct 2026. */
  async function posOrder(f: Awaited<ReturnType<typeof fixture>>, zomatoOrderId: string, outcome: "picked_up" | "cancelled" | "open", pricePaise = 58000) {
    const category = (await f.api("POST", "/api/categories", { name: `Mains ${uuidv7()}` })).json().category;
    const product = (await f.api("POST", "/api/products", { categoryId: category.id, name: `Dal ${uuidv7()}`, pricePaise, zomatoPricePaise: pricePaise, gstRate: 5 })).json().product;
    const created = await f.api("POST", "/api/orders", { clientRef: uuidv7(), type: "zomato", zomatoOrderId });
    expect(created.statusCode, created.body).toBe(201);
    const id = created.json().order.id as string;
    expect((await f.api("POST", `/api/orders/${id}/items`, { items: [{ productId: product.id, variantId: null, qty: 1 }] })).statusCode).toBe(200);
    if (outcome === "cancelled") expect((await f.api("POST", `/api/orders/${id}/cancel`, {})).statusCode).toBe(200);
    if (outcome === "picked_up") {
      expect((await f.api("POST", `/api/orders/${id}/zomato-status`, { status: "ready", clientRef: uuidv7() })).statusCode).toBe(200);
      const closed = await f.api("POST", `/api/orders/${id}/zomato-status`, { status: "picked_up", clientRef: uuidv7() });
      expect(closed.statusCode, closed.body).toBe(200);
    }
    app.db.prepare("UPDATE orders SET opened_at = ? WHERE id = ?").run(placed, id);
    return id;
  }
  async function posFixture() {
    const f = await fixture();
    enableIntegration(app, "zomato");
    return f;
  }

  it("matches a picked-up POS order to its settlement using the bill total", async () => {
    const f = await posFixture();
    await posOrder(f, "5821", "picked_up");
    await f.commit("settlements", [settlement("5821", "P1", "580.00", "100.00", "480.00")]);
    const row = (await f.report()).rows.find(r => r.orderId === "5821");
    expect(row).toMatchObject({ state: "matched", orderTotalPaise: 58000, orderStatus: "delivered", placedAt: placed, orderDifferencePaise: 0, entries: 1 });
  });
  it("sends a POS-cancelled order with a settlement to cancellation review", async () => {
    const f = await posFixture();
    await posOrder(f, "5822", "cancelled");
    await f.commit("settlements", [settlement("5822", "P2", "580.00", "100.00", "480.00")]);
    const row = (await f.report()).rows.find(r => r.orderId === "5822");
    expect(row).toMatchObject({ state: "review_cancellation", orderTotalPaise: 0, orderStatus: "cancelled" });
  });
  it("still lists imported orders that have no POS order", async () => {
    const f = await posFixture();
    await posOrder(f, "5821", "picked_up");
    await f.commit("orders", [order("4000", "250.00")]);
    const r = await f.report();
    expect(r.rows.map(row => row.orderId).sort()).toEqual(["4000", "5821"]);
    expect(r.rows.find(row => row.orderId === "4000")).toMatchObject({ state: "awaiting_statement", orderTotalPaise: 25000, orderStatus: "delivered" });
  });
  it("prefers the POS order over an imported order with the same ID", async () => {
    const f = await posFixture();
    await posOrder(f, "5821", "picked_up");
    await f.commit("orders", [order("5821", "999.00")]);
    await f.commit("settlements", [settlement("5821", "P1", "580.00", "100.00", "480.00")]);
    const r = await f.report();
    expect(r.rows.filter(row => row.orderId === "5821")).toHaveLength(1);
    expect(r.rows[0]).toMatchObject({ state: "matched", orderTotalPaise: 58000 });
    expect(r.totals.orderTotalPaise).toBe(58000);
  });
  it("marks a POS order with no settlement as awaiting its statement", async () => {
    const f = await posFixture();
    await posOrder(f, "5821", "picked_up");
    const r = await f.report();
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]).toMatchObject({ orderId: "5821", state: "awaiting_statement", orderTotalPaise: 58000, entries: 0, orderDifferencePaise: null });
    expect(r.totals).toMatchObject({ orderTotalPaise: 58000, matched: 0, needsReview: 1 });
  });
  it("reports a POS order opened outside the range only through its settlement, and skips orders still open", async () => {
    const f = await posFixture();
    await posOrder(f, "5821", "picked_up");
    await posOrder(f, "5823", "open");
    expect((await f.report("2026-10-02", "2026-10-02")).rows.map(r => r.orderId)).toEqual(["5821"]);
    expect((await f.report("2026-09-01", "2026-09-02")).rows).toHaveLength(0);
    await f.commit("settlements", [settlement("5821", "P1", "580.00", "100.00", "480.00", "2026-10-20")]);
    const later = (await f.report("2026-10-20", "2026-10-20")).rows;
    expect(later).toHaveLength(1);
    expect(later[0]).toMatchObject({ orderId: "5821", state: "matched", orderTotalPaise: 58000 });
  });
});

describe("verified provider boundary (local fake, not a Zomato contract)", () => {
  const provider: ZomatoProvider = { async verifyAndDecode({ headers, rawBody }) {
    if (headers["x-test-signature"] !== "test-only") throw new Error("invalid");
    return { events: JSON.parse(rawBody.toString()), acknowledgement: { statusCode: 200, body: { fixtureAck: true } } };
  } };
  const event = (eventId: string, status: string, occurredAt: number, extra = {}) => ({ eventId, status, occurredAt, restaurantId: "R1", orderId: "W1", ...extra });
  const base = Date.parse("2026-10-02T07:00:00Z");
  const snapshot = { placedAt: base, totalPaise: 50000, paymentMode: "prepaid", items: [{ name: "Rice", quantity: 2, note: "No chilli" }] };
  const push = (events: unknown[], signed = true) => app.inject({ method: "POST", url: "/api/integrations/zomato/webhook", headers: signed ? { "x-test-signature": "test-only" } : {}, payload: events });
  async function enabled() {
    const f = await fixture(provider);
    enableIntegration(app, "zomato");
    expect((await f.api("PATCH", "/api/zomato/settings", { ...f.settings, version: 2, enabled: true, posId: "P1", webhookBaseUrl: "https://orders.example.com" })).statusCode).toBe(200);
    return f;
  }
  it("rejects unauthenticated and wrong-outlet events without writes", async () => {
    const f = await enabled();
    expect((await push([event("a", "received", base, { order: snapshot })], false)).statusCode).toBe(401);
    expect((await push([event("a", "received", base, { order: snapshot, restaurantId: "R2" })])).statusCode).toBe(403);
    expect((await f.report()).rows).toHaveLength(0);
    expect(app.db.prepare("SELECT COUNT(*) AS n FROM zomato_events").get()).toEqual({ n: 0 });
  });
  it("persists out-of-order updates, deduplicates replay and prevents status regression", async () => {
    const f = await enabled();
    expect((await push([event("b", "ready", base + 2000)])).statusCode).toBe(200);
    const relay = [event("a", "received", base, { order: snapshot })];
    expect((await push(relay)).json()).toEqual({ fixtureAck: true });
    expect((await push(relay)).statusCode).toBe(200);
    expect((await f.api("GET", "/api/zomato/orders")).json().orders[0]).toMatchObject({ status: "ready", items: snapshot.items, source: "webhook" });
    await push([event("c", "confirmed", base + 3000)]);
    expect((await f.api("GET", "/api/zomato/orders")).json().orders[0].status).toBe("ready");
    await push([event("d", "delivered", base + 4000)]);
    await push([event("e", "ready", base + 5000)]);
    expect((await f.api("GET", "/api/zomato/orders")).json().orders).toHaveLength(0);
    expect((await f.report()).rows[0]?.orderStatus).toBe("delivered");
    expect((await f.api("GET", "/api/zomato/settings")).json().lastEventAt).toBeTypeOf("number");
    expect((await push([event("a", "received", base, { order: { ...snapshot, totalPaise: 60000 } })])).statusCode).toBe(409);
    expect((await f.report()).rows[0]?.orderTotalPaise).toBe(50000);
  });
  it("rejects a batch when the Marketplace flag is turned off while the provider is verifying", async () => {
    const racing: ZomatoProvider = { async verifyAndDecode({ rawBody }) {
      app.db.prepare("UPDATE integration_state SET enabled=0 WHERE id='zomato'").run();
      return { events: JSON.parse(rawBody.toString()), acknowledgement: { statusCode: 200, body: { fixtureAck: true } } };
    } };
    const f = await fixture(racing);
    enableIntegration(app, "zomato");
    expect((await f.api("PATCH", "/api/zomato/settings", { ...f.settings, version: 2, enabled: true, posId: "P1", webhookBaseUrl: "https://orders.example.com" })).statusCode).toBe(200);
    const response = await push([event("a", "received", base, { order: snapshot })]);
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toMatch(/turned off in the Marketplace/);
    expect(app.db.prepare("SELECT COUNT(*) AS n FROM zomato_events").get()).toEqual({ n: 0 });
    expect(app.db.prepare("SELECT COUNT(*) AS n FROM zomato_orders").get()).toEqual({ n: 0 });
  });
  it("rolls back a mixed invalid batch and returns success only after persistence", async () => {
    await enabled();
    expect((await push([event("a", "received", base, { order: snapshot }), event("b", "ready", base + 1, { restaurantId: "R2" })])).statusCode).toBe(403);
    expect(app.db.prepare("SELECT COUNT(*) AS n FROM zomato_orders").get()).toEqual({ n: 0 });
    expect(app.db.prepare("SELECT COUNT(*) AS n FROM zomato_events").get()).toEqual({ n: 0 });
  });
});
