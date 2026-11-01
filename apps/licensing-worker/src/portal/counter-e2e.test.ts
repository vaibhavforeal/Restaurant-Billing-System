import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../env.js";
import { addMonths } from "../dates.js";
import worker from "../index.js";
import { keyPair, ORIGIN, testEnv } from "../testing/harness.js";
import { as, type PortalClient } from "../testing/portal.js";
import { TEST_SECRET } from "../testing/secret.js";
import type { CustomerDetail, OrderDetail } from "./api-types.js";
// Test-only: the Worker source never imports the counter server or the domain index.
import { MIGRATIONS, migrate, openDb } from "../../../../packages/domain/src/index.js";
import { buildServer } from "../../../server/src/server.js";

const T0 = Date.UTC(2026, 9, 30, 4, 30, 0);
const keys = keyPair();
const COUNTER = "99999999-9999-4999-8999-999999999999";
const DEVICE = "f".repeat(64);
let env: Env;
let admin: PortalClient;
beforeAll(() => { vi.useFakeTimers({ toFake: ["Date"] }); });
beforeEach(async () => {
  vi.setSystemTime(T0);
  env = testEnv(keys.privatePem);
  admin = await as(env, "admin");
  await admin.ok("PUT", "/settings", {
    seller: { legalName: "MasalaPOS Technologies LLP", gstin: "", address: "", city: "Pune", stateCode: "27", pincode: "", email: "", phone: "" },
    invoice: { prefix: "FF", sac: "997331", gstRateBp: 1800, bankDetails: "", terms: "" }, prices: [], extraDevicePaise: 0, trialDays: 7,
  });
});
afterEach(() => { vi.restoreAllMocks(); });

describe("a real counter against the portal", () => {
  it("activates at setup with the IDs from its setup card, bills, and collects a paid renewal at its next check", async () => {
    const { customer } = await admin.ok<{ customer: CustomerDetail }>("POST", "/customers", {
      businessName: "Spice Route", contactName: "", phone: "98220 12345", email: "", gstin: "", address: "", city: "Pune", stateCode: "27", pincode: "", notes: "",
    });
    const order = (body: Record<string, unknown>) => admin.ok<{ order: OrderDetail }>("POST", "/orders", { customerId: customer.id, plan: "basic", termMonths: 12, outlets: 1, maxDevices: 3,
      modules: { kds: true }, discountPaise: 0, extras: [], notes: "", installationIds: [], ...body }).then((r) => r.order);
    const first = await order({ kind: "new", pricePerOutletPaise: 900_000 });
    await admin.ok("POST", `/orders/${first.id}/confirm`);
    const accounts = await as(env, "accounts");
    await accounts.ok("POST", `/orders/${first.id}/payments`, { amountPaise: 1_062_000, method: "bank", reference: "NEFT 1", receivedAt: T0, note: "" });

    const db = openDb(":memory:"); migrate(db, MIGRATIONS);
    const counter = buildServer({ db, appVersion: "0.7.0", licensing: {
      publicKey: keys.publicPem, installationId: COUNTER, installationSecret: TEST_SECRET, serviceUrl: ORIGIN, now: () => Date.now(),
      fetch: (async (input: string | URL | Request, init?: RequestInit) => worker.fetch(new Request(String(input), init), env)) as typeof fetch,
    } });
    try {
      // Setup: the IDs typed the way people type them, then the admin.
      expect((await counter.inject({ url: "/api/needs-setup" })).json()).toEqual({ needsSetup: true, activation: "online", licensed: false });
      const activated = await counter.inject({ method: "POST", url: "/api/setup/activate", headers: { "x-masalapos-device": DEVICE },
        payload: { customerId: customer.code.toLowerCase(), orderId: first.code.replace(/-/g, " ") } });
      expect(activated.statusCode, activated.body).toBe(200);
      expect(activated.json()).toMatchObject({ customer: { name: "Spice Route" }, order: { code: first.code, plan: "basic", trial: false } });
      const setup = await counter.inject({ method: "POST", url: "/api/setup", headers: { "x-masalapos-device": DEVICE }, payload: { restaurantName: "Spice Route", adminName: "Meera", pin: "1234" } });
      const headers = { authorization: `Bearer ${setup.json().token}`, "x-masalapos-device": DEVICE };
      const status = (await counter.inject({ url: "/api/license", headers })).json();
      expect(status).toMatchObject({ state: "active", canOperate: true, plan: "basic", maxDevices: 3, customerCode: customer.code, orderCode: first.code, expiresAt: addMonths(T0, 12) });
      expect(status.modules.kds).toBe(true);
      expect((await counter.inject({ url: "/api/products", headers })).statusCode).toBe(200);

      // The portal sees the counter, with the name and version it reported.
      const { installations } = await admin.ok<{ installations: Array<{ id: string; outletName: string; appVersion: string; licence: { delivered: boolean } }> }>("GET", `/customers/${customer.id}/installations`);
      expect(installations).toEqual([expect.objectContaining({ id: COUNTER, appVersion: "0.7.0", licence: expect.objectContaining({ delivered: true }) })]);

      // A paid renewal reaches the counter at its next check.
      const renewal = await order({ kind: "renewal", plan: "pro", maxDevices: 5, pricePerOutletPaise: 1_400_000, installationIds: [COUNTER], outlets: 0 });
      await admin.ok("POST", `/orders/${renewal.id}/confirm`);
      await accounts.ok("POST", `/orders/${renewal.id}/payments`, { amountPaise: renewal.totalPaise, method: "upi", reference: "", receivedAt: T0, note: "" });
      expect((await counter.licensing.fetchLatest()).outcome).toBe("installed");
      expect((await counter.inject({ url: "/api/license", headers })).json()).toMatchObject({ plan: "pro", maxDevices: 5, orderCode: renewal.code, expiresAt: addMonths(addMonths(T0, 12), 12) });
      expect((await counter.licensing.fetchLatest()).outcome).toBe("up_to_date");
    } finally { await counter.close(); db.close(); }
  });
});
