import { afterEach, describe, expect, it } from "vitest";
import { uuidv7 } from "@forkflow/domain";
import type { FastifyInstance } from "fastify";
import { auth, commercialApp, enableIntegration, freshApp, setupAdmin } from "./test-helpers.js";

let app: FastifyInstance;
afterEach(async () => { await app?.close(); });

const KDS_OFF = { error: "Kitchen Display is turned off", code: "kds_off" };

/** Sends one dine-in KOT for a product routed to the default kitchen station; returns the ticket id. */
async function sendKot(headers: Record<string, string>, printerId?: string) {
  const call = (method: "GET" | "POST" | "PATCH", url: string, payload?: object) => app.inject({ method, url, headers, ...(payload ? { payload } : {}) });
  const station = (await call("GET", "/api/kot-stations")).json().stations[0];
  if (printerId) await call("PATCH", `/api/kot-stations/${station.id}`, { printerId });
  const categoryId = (await call("POST", "/api/categories", { name: "Mains" })).json().category.id;
  const productId = (await call("POST", "/api/products", { categoryId, name: "Biryani", pricePaise: 30000, gstRate: 5, kotStationId: station.id })).json().product.id;
  const tableId = (await call("POST", "/api/tables", { name: "T1" })).json().table.id;
  const orderId = (await call("POST", "/api/orders", { clientRef: uuidv7(), type: "dine_in", tableId })).json().order.id;
  await call("POST", `/api/orders/${orderId}/items`, { items: [{ productId, qty: 1 }] });
  const sent = await call("POST", `/api/orders/${orderId}/send`);
  expect(sent.statusCode, sent.body).toBe(200);
  return sent.json().kots[0].id as string;
}

describe("kitchen display gate", () => {
  it("refuses the kitchen board and Done while KDS is off", async () => {
    app = freshApp();
    const { token } = await setupAdmin(app);
    const kotId = await sendKot(auth(token));
    for (const res of [
      await app.inject({ method: "GET", url: "/api/kots", headers: auth(token) }),
      await app.inject({ method: "POST", url: `/api/kots/${kotId}/done`, headers: auth(token) }),
    ]) {
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual(KDS_OFF);
    }
    expect(app.db.prepare("SELECT done_at FROM kots WHERE id = ?").get(kotId)).toEqual({ done_at: null });
  });

  it("serves the kitchen once KDS is on", async () => {
    app = freshApp();
    const { token } = await setupAdmin(app);
    const kotId = await sendKot(auth(token));
    enableIntegration(app, "kds");
    const board = await app.inject({ method: "GET", url: "/api/kots", headers: auth(token) });
    expect(board.statusCode).toBe(200);
    expect(board.json().kots.map((k: { id: string }) => k.id)).toEqual([kotId]);
    expect((await app.inject({ method: "POST", url: `/api/kots/${kotId}/done`, headers: auth(token) })).statusCode).toBe(200);
  });

  it("sends and prints KOTs with KDS off", async () => {
    app = freshApp();
    const { token } = await setupAdmin(app);
    const printer = await app.inject({ method: "POST", url: "/api/printers", headers: auth(token), payload: { name: "Kitchen", kind: "network", connection: "127.0.0.1:9100", paperWidth: 58 } });
    await sendKot(auth(token), printer.json().printer.id);
    const jobs = app.db.prepare("SELECT printer_id, job_json FROM print_jobs").all() as Array<{ printer_id: string; job_json: string }>;
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.printer_id).toBe(printer.json().printer.id);
    expect(JSON.parse(jobs[0]!.job_json)).toMatchObject({ kind: "kot" });
  });

  it("commercial installation without kds refuses the kitchen", async () => {
    const c = await commercialApp("basic"); app = c.app;
    enableIntegration(app, "kds");
    const res = await app.inject({ method: "GET", url: "/api/kots", headers: c.headers });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual(KDS_OFF);
  });

  it("keeps open tickets while off and shows them again when turned back on", async () => {
    app = freshApp();
    const { token } = await setupAdmin(app);
    const kotId = await sendKot(auth(token));
    const board = () => app.inject({ method: "GET", url: "/api/kots", headers: auth(token) });
    enableIntegration(app, "kds");
    expect((await board()).json().kots).toHaveLength(1);
    app.db.prepare("UPDATE integration_state SET enabled = 0 WHERE id = 'kds'").run();
    expect((await board()).statusCode).toBe(403);
    enableIntegration(app, "kds");
    expect((await board()).json().kots.map((k: { id: string }) => k.id)).toEqual([kotId]);
  });
});
