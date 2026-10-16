import { MIGRATIONS, migrate, openDb } from "@forkflow/domain";
import { afterEach, describe, expect, it } from "vitest";
import { buildServer } from "./server.js";

export function testDb() {
  const db = openDb(":memory:");
  migrate(db, MIGRATIONS);
  return db;
}

let app: Awaited<ReturnType<typeof buildServer>>;
afterEach(async () => {
  await app?.close();
});

describe("GET /api/health", () => {
  it('rejects requests from a browser bound to another outlet or recovery generation', async () => {
    app = buildServer({ db: testDb(), outletIdentity: 'outlet-a', generation: 'generation-a' });
    expect((await app.inject({ method: 'POST', url: '/api/setup', headers: { 'x-forkflow-outlet-identity': 'outlet-b', 'x-forkflow-generation': 'generation-a' }, payload: {} })).statusCode).toBe(409);
    expect((await app.inject({ method: 'POST', url: '/api/setup', headers: { 'x-forkflow-outlet-identity': 'outlet-a', 'x-forkflow-generation': 'old' }, payload: {} })).statusCode).toBe(409);
  });
  it("exposes release identity while an update probe refuses every business request", async () => {
    app = buildServer({ db: testDb(), appVersion: '1.0-test', maintenanceProbe: true });
    expect((await app.inject({ method: 'GET', url: '/api/health' })).json()).toMatchObject({ ok: true, version: '1.0-test', maintenance: true });
    expect((await app.inject({ method: 'POST', url: '/api/setup', payload: { restaurantName: 'Cafe', adminName: 'Asha', pin: '1234' } })).statusCode).toBe(503);
    expect((await app.inject({ method: 'GET', url: '/api/ws' })).statusCode).toBe(503);
  });
  it("returns ok", async () => {
    app = buildServer({ db: testDb() });
    const res = await app.inject({ method: "GET", url: "/api/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });
});
