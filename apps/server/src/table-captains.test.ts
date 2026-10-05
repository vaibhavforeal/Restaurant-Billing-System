import { afterEach, beforeEach, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { uuidv7 } from "@forkflow/domain";
import { freshAppWithFakeSink, setupAdmin, createUser, auth } from "./test-helpers.js";
let app: FastifyInstance, token: string;
beforeEach(async () => { ({ app } = freshAppWithFakeSink()); ({ token } = await setupAdmin(app)); });
afterEach(async () => { await app.close(); app.db.close(); });
const request = (method: "POST" | "PATCH" | "GET", url: string, payload?: object, as = token) => app.inject({ method, url, headers: auth(as), ...(payload ? { payload } : {}) });
const open = async (tableId: string, captainId?: string) => (await request("POST", "/api/orders", { type: "dine_in", tableId, clientRef: uuidv7(), ...(captainId ? { captainId } : {}) })).json().order;

it("selects captains per customer order and never inherits the previous visit's captain", async () => {
  const ravi = await createUser(app, token, { name: "Ravi", role: "waiter", pin: "2345" });
  const maya = await createUser(app, token, { name: "Maya", role: "waiter", pin: "3456" });
  const table = (await request("POST", "/api/tables", { name: "T1" })).json().table;
  const first = await open(table.id);
  expect(first.captainId).toBeNull();
  let result = await request("PATCH", `/api/orders/${first.id}/captain`, { captainId: ravi.id, expectedCaptainId: null }, ravi.token);
  expect(result.statusCode).toBe(200); expect(result.json().order.captainName).toBe("Ravi");
  result = await request("PATCH", `/api/orders/${first.id}/captain`, { captainId: maya.id, expectedCaptainId: ravi.id });
  expect(result.json().order.captainName).toBe("Maya");
  await request("POST", `/api/orders/${first.id}/cancel`, { reason: "Visit ended" });
  expect((await open(table.id)).captainId).toBeNull();
  expect((await open(table.id, ravi.id)).captainName).toBe("Ravi");
  expect((await request("GET", `/api/orders/${first.id}`)).json().order.captainName).toBe("Maya");
  expect((await request("GET", "/api/tables")).json().tables[0]).not.toHaveProperty("captainId");
});

it("rejects fixed assignments, invalid captains, stale changes and edits after billing", async () => {
  const ravi = await createUser(app, token, { name: "Ravi", role: "waiter", pin: "2345" });
  const maya = await createUser(app, token, { name: "Maya", role: "waiter", pin: "3456" });
  const cashier = await createUser(app, token, { name: "Counter", role: "cashier", pin: "4567" });
  expect((await request("POST", "/api/tables", { name: "Fixed", captainId: ravi.id })).statusCode).toBe(400);
  const table = (await request("POST", "/api/tables", { name: "T1" })).json().table;
  expect((await request("PATCH", `/api/tables/${table.id}`, { captainId: ravi.id })).statusCode).toBe(400);
  const order = await open(table.id);
  for (const captainId of ["missing", cashier.id]) expect((await request("PATCH", `/api/orders/${order.id}/captain`, { captainId, expectedCaptainId: null })).statusCode).toBe(400);
  expect((await request("PATCH", `/api/orders/${order.id}/captain`, { captainId: ravi.id, expectedCaptainId: null }, cashier.token)).statusCode).toBe(200);
  expect((await request("PATCH", `/api/orders/${order.id}/captain`, { captainId: maya.id, expectedCaptainId: null })).statusCode).toBe(409);
  expect((await request("PATCH", `/api/orders/${order.id}/captain`, { captainId: ravi.id, expectedCaptainId: null })).statusCode).toBe(200);
  await request("PATCH", `/api/users/${maya.id}`, { isActive: false });
  expect((await request("PATCH", `/api/orders/${order.id}/captain`, { captainId: maya.id, expectedCaptainId: ravi.id })).statusCode).toBe(400);
  app.db.prepare("UPDATE orders SET status='billed' WHERE id=?").run(order.id);
  expect((await request("PATCH", `/api/orders/${order.id}/captain`, { captainId: null, expectedCaptainId: ravi.id })).statusCode).toBe(409);
});

it("limits the captain directory to active names/IDs and restricts assignment to order staff", async () => {
  const ravi = await createUser(app, token, { name: "Ravi", role: "waiter", pin: "2345" });
  const kitchen = await createUser(app, token, { name: "Cook", role: "kitchen", pin: "3456" });
  expect((await request("GET", "/api/captains", undefined, ravi.token)).json()).toEqual({ captains: [{ id: ravi.id, name: "Ravi" }] });
  const table = (await request("POST", "/api/tables", { name: "T1" })).json().table;
  const order = await open(table.id);
  expect((await request("PATCH", `/api/orders/${order.id}/captain`, { captainId: ravi.id, expectedCaptainId: null }, kitchen.token)).statusCode).toBe(403);
  expect((await app.inject({ method: "PATCH", url: `/api/orders/${order.id}/captain`, payload: { captainId: ravi.id, expectedCaptainId: null } })).statusCode).toBe(401);
  await request("PATCH", `/api/users/${ravi.id}`, { isActive: false });
  expect((await request("GET", "/api/captains")).json().captains).toEqual([]);
});
