import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../env.js";
import type { InstallationDetail } from "../portal/api-types.js";
import { seedCustomer, seedOrder } from "../testing/fixtures.js";
import { activation, keyPair, send, testEnv, withSecret } from "../testing/harness.js";
import { as, type PortalClient } from "../testing/portal.js";
import { createInstallation } from "../store.js";
import { addTokens, aiDay, reserveRequest } from "./store.js";

const T0 = Date.UTC(2026, 10, 4, 6, 0, 0);
const keys = keyPair();
let fingerprint: string;
let env: Env;
let admin: PortalClient;
const COUNTER = "99999999-9999-4999-8999-999999999999";
const detail = async () => (await admin.ok<{ installation: InstallationDetail }>("GET", `/installations/${COUNTER}`)).installation;

beforeAll(async () => { vi.useFakeTimers({ toFake: ["Date"] }); fingerprint = await keys.fingerprint(); });
beforeEach(async () => {
  vi.setSystemTime(T0);
  env = testEnv(keys.privatePem);
  admin = await as(env, "admin", { name: "Asha" });
  const customer = await seedCustomer(env.DB);
  const order = await seedOrder(env.DB, customer);
  expect((await send(env, "POST", "/v1/enroll", { activation: activation(COUNTER, fingerprint), customerId: customer.code, orderId: order.code }, withSecret())).status).toBe(200);
});

describe("the AI assistant in the portal", () => {
  it("shows a counter as off with the default limit and a week of empty usage", async () => {
    const { ai } = await detail();
    expect(ai).toMatchObject({ enabled: false, dailyLimit: 40, updatedAt: null, usedToday: 0 });
    expect(ai.usage).toHaveLength(7);
    expect(ai.usage[0]).toEqual({ day: "2026-11-04", requests: 0, inputTokens: 0, outputTokens: 0 });
    expect(ai.usage[6]!.day).toBe("2026-10-29");
  });

  it("an admin switches it on and sets the limit; the change is logged and a stale page is refused", async () => {
    const before = await detail();
    vi.setSystemTime(T0 + 60_000);
    const { installation } = await admin.ok<{ installation: InstallationDetail }>("PATCH", `/installations/${COUNTER}/ai`, { enabled: true, dailyLimit: 25, expectedUpdatedAt: before.ai.updatedAt });
    expect(installation.ai).toMatchObject({ enabled: true, dailyLimit: 25, updatedAt: T0 + 60_000 });
    const stale = await admin.call("PATCH", `/installations/${COUNTER}/ai`, { enabled: false, dailyLimit: 25, expectedUpdatedAt: before.ai.updatedAt });
    expect(stale.status).toBe(409);
    const log = await admin.ok<{ entries: Array<{ action: string; summary: string }> }>("GET", "/activity?entityType=installation");
    expect(log.entries[0]).toMatchObject({ action: "installation.ai" });
    expect(log.entries[0]!.summary).toContain("AI assistant on, 25 requests a day");
  });

  it("only admins change it, within 1 to 1,000 a day", async () => {
    const support = await as(env, "support");
    expect((await support.call("PATCH", `/installations/${COUNTER}/ai`, { enabled: true, dailyLimit: 40, expectedUpdatedAt: null })).status).toBe(403);
    expect((await support.ok<{ installation: InstallationDetail }>("GET", `/installations/${COUNTER}`)).installation.ai.enabled).toBe(false);
    for (const dailyLimit of [0, 1001, 2.5]) {
      expect((await admin.call("PATCH", `/installations/${COUNTER}/ai`, { enabled: true, dailyLimit, expectedUpdatedAt: null })).status).toBe(400);
    }
  });

  it("a replacement computer takes over the AI assistant, and the old one loses it", async () => {
    const { installation } = await admin.ok<{ installation: InstallationDetail }>("GET", `/installations/${COUNTER}`);
    await admin.ok("PATCH", `/installations/${COUNTER}/ai`, { enabled: true, dailyLimit: 25, expectedUpdatedAt: installation.ai.updatedAt });
    const NEW = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    await createInstallation(env.DB, { installationId: NEW, licenseId: crypto.randomUUID(), organizationId: crypto.randomUUID(), outletId: crypto.randomUUID(), revisionFloor: 0, createdAt: Date.now(), secretHash: null });
    await admin.ok("POST", `/installations/${COUNTER}/replace`, { installationId: NEW });
    expect((await admin.ok<{ installation: InstallationDetail }>("GET", `/installations/${NEW}`)).installation.ai).toMatchObject({ enabled: true, dailyLimit: 25 });
    expect((await detail()).ai.enabled).toBe(false);
  });

  it("releasing a seat switches the AI assistant off, and a counter that gets a seat again starts off", async () => {
    const { installation } = await admin.ok<{ installation: InstallationDetail }>("GET", `/installations/${COUNTER}`);
    await admin.ok("PATCH", `/installations/${COUNTER}/ai`, { enabled: true, dailyLimit: 25, expectedUpdatedAt: installation.ai.updatedAt });
    await admin.ok("POST", `/installations/${COUNTER}/release`);
    expect((await detail()).ai.enabled).toBe(false);
    expect((await admin.call("PATCH", `/installations/${COUNTER}/ai`, { enabled: true, dailyLimit: 25, expectedUpdatedAt: (await detail()).ai.updatedAt })).status).toBe(409);
    // The saved switch stays on, but it was for the old seat: activated again on a new order, the counter starts off.
    const customer = (await env.DB.prepare(`SELECT c.id, c.code FROM customers c JOIN installations i ON i.customer_id = c.id WHERE i.installation_id = ?`).bind(COUNTER).first<{ id: string; code: string }>())!;
    const order = await seedOrder(env.DB, customer);
    expect((await send(env, "POST", "/v1/enroll", { activation: activation(COUNTER, fingerprint), customerId: customer.code, orderId: order.code }, withSecret())).status).toBe(200);
    expect((await detail()).ai.enabled).toBe(false);
  });

  it("a replacement computer never keeps an AI setting of its own", async () => {
    const NEW = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    await createInstallation(env.DB, { installationId: NEW, licenseId: crypto.randomUUID(), organizationId: crypto.randomUUID(), outletId: crypto.randomUUID(), revisionFloor: 0, createdAt: Date.now(), secretHash: null });
    await env.DB.prepare(`INSERT INTO ai_settings (installation_id, enabled, daily_limit, updated_at) VALUES (?, 1, 999, ?)`).bind(NEW, Date.now()).run();
    await admin.ok("POST", `/installations/${COUNTER}/replace`, { installationId: NEW });
    expect((await admin.ok<{ installation: InstallationDetail }>("GET", `/installations/${NEW}`)).installation.ai).toMatchObject({ enabled: false, dailyLimit: 40 });
  });

  it("shows today's use and the last 7 days' requests and tokens", async () => {
    const yesterday = aiDay(T0 - 86_400_000);
    await reserveRequest(env.DB, COUNTER, yesterday, 40);
    await addTokens(env.DB, COUNTER, yesterday, 500, 80);
    for (let i = 0; i < 3; i++) await reserveRequest(env.DB, COUNTER, aiDay(T0), 40);
    const { ai } = await detail();
    expect(ai.usedToday).toBe(3);
    expect(ai.usage[1]).toEqual({ day: yesterday, requests: 1, inputTokens: 500, outputTokens: 80 });
  });
});
