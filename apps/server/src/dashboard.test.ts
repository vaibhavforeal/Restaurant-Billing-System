import { beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { defaultLayout, type DashboardLayoutValue } from "@masalapos/domain/dashboard";
import { freshApp, setupAdmin, createUser, auth, enableIntegration, commercialApp } from "./test-helpers.js";

describe("dashboard layouts", () => {
  let app: FastifyInstance, token: string, adminId: string, cashier: string, cashierId: string;
  const request = (method: "GET" | "PUT" | "DELETE", payload?: object, as = token) =>
    app.inject({ method, url: "/api/dashboard/layout", headers: auth(as), ...(payload ? { payload } : {}) });
  const grant = (overrides: Record<string, boolean>) =>
    app.inject({ method: "PUT", url: `/api/users/${cashierId}/permissions`, headers: auth(token), payload: { overrides } });
  const widgets = (layout: DashboardLayoutValue) => layout.items.map((i) => i.widget);
  const bottom = (layout: DashboardLayoutValue) => Math.max(0, ...layout.items.map((i) => i.y + i.h));
  const opts = defaultLayout().items[0]!.options;
  const extra = (layout: DashboardLayoutValue, widget: "lowStock" | "runningKots", key: string): DashboardLayoutValue =>
    ({ version: 1, items: [...layout.items, { key, widget, x: 0, y: bottom(layout), w: 3, h: 2, options: opts }] });

  beforeEach(async () => {
    app = freshApp(); ({ token, user: { id: adminId } } = await setupAdmin(app));
    ({ token: cashier, id: cashierId } = await createUser(app, token, { name: "Ravi", pin: "5678", role: "cashier" }));
    enableIntegration(app, "dynamicReports");
  });

  it("gives each person the default layout until they save their own", async () => {
    const res = await request("GET");
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    const body = res.json();
    expect(body.isDefault).toBe(true);
    expect(body.layout).toEqual(defaultLayout());
    const saved = await request("PUT", { layout: { version: 1, items: defaultLayout().items.slice(0, 2) } });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json().isDefault).toBe(false);
    expect(saved.json().layout.items).toHaveLength(2);
    expect((await request("GET")).json().isDefault).toBe(false);
  });

  it("keeps one layout per person and resets to the default", async () => {
    await request("PUT", { layout: { version: 1, items: defaultLayout().items.slice(0, 2) } });
    expect((await grant({ "reports.dashboard": true })).statusCode).toBe(200);
    const theirs = (await request("GET", undefined, cashier)).json();
    expect(theirs.isDefault).toBe(true);
    expect(widgets(theirs.layout)).toEqual(widgets(defaultLayout()));
    const reset = await request("DELETE");
    expect(reset.statusCode).toBe(200);
    expect(reset.json()).toEqual({ layout: defaultLayout(), isDefault: true });
    expect((await request("GET")).json().isDefault).toBe(true);
  });

  it("refuses a cashier without reports.dashboard, then lets them in once granted", async () => {
    expect((await request("GET", undefined, cashier)).statusCode).toBe(403);
    await grant({ "reports.dashboard": true });
    expect((await request("GET", undefined, cashier)).statusCode).toBe(200);
  });

  it("refuses everything while Dynamic Reports is switched off", async () => {
    app.db.prepare("UPDATE integration_state SET enabled = 0 WHERE id = 'dynamicReports'").run();
    for (const method of ["GET", "DELETE"] as const) {
      const res = await request(method);
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe("module_off");
    }
    const put = await request("PUT", { layout: defaultLayout() });
    expect(put.statusCode).toBe(409);
    const basic = await commercialApp("basic");
    const res = await basic.app.inject({ method: "GET", url: "/api/dashboard/layout", headers: basic.headers });
    expect(res.statusCode).toBe(403);
  });

  it("refuses a widget the person cannot see", async () => {
    app.db.prepare("INSERT INTO integration_state (id, enabled, updated_at, updated_by) VALUES ('inventory', 1, ?, ?) ON CONFLICT(id) DO UPDATE SET enabled = 1").run(Date.now(), adminId);
    await grant({ "reports.dashboard": true, "stock.read": false });
    const res = await request("PUT", { layout: extra(defaultLayout(), "lowStock", "low") }, cashier);
    expect(res.statusCode, res.body).toBe(403);
    expect((await request("PUT", { layout: extra(defaultLayout(), "lowStock", "low") })).statusCode).toBe(200);
  });

  it("keeps hidden widgets when a layout is saved", async () => {
    enableIntegration(app, "kds");
    const first = extra(defaultLayout(), "runningKots", "kots");
    expect((await request("PUT", { layout: first })).statusCode).toBe(200);
    app.db.prepare("UPDATE integration_state SET enabled = 0 WHERE id = 'kds'").run();
    expect(widgets((await request("GET")).json().layout)).not.toContain("runningKots");
    const second = { version: 1, items: defaultLayout().items.slice(0, 3) };
    const saved = await request("PUT", { layout: second });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(widgets(saved.json().layout)).toEqual(["netSales", "billCount", "averageBill"]);
    enableIntegration(app, "kds");
    const back = (await request("GET")).json().layout as DashboardLayoutValue;
    expect(widgets(back)).toContain("runningKots");
    expect(back.items).toHaveLength(4);
    const kots = back.items.find((i) => i.widget === "runningKots")!;
    expect(kots.y).toBeGreaterThanOrEqual(2);
  });

  it("closes the gap a hidden widget leaves, without changing what is stored", async () => {
    const [a, b] = defaultLayout().items;
    const hiddenItem = { key: "kots", widget: "runningKots", x: 0, y: a!.h, w: 3, h: 2, options: opts };
    const below = { ...b!, x: 0, y: a!.h + 2 };
    const stored = { version: 1, items: [{ ...a!, x: 0, y: 0 }, hiddenItem, below] };
    app.db.prepare("INSERT INTO dashboard_layouts (user_id, layout_json, updated_at) VALUES (?, ?, 1)").run(adminId, JSON.stringify(stored));
    const seen = (await request("GET")).json().layout as DashboardLayoutValue;
    expect(widgets(seen)).not.toContain("runningKots");
    expect(seen.items.find((i) => i.key === below.key)!.y).toBe(a!.h);
    const raw = app.db.prepare("SELECT layout_json FROM dashboard_layouts WHERE user_id = ?").pluck().get(adminId) as string;
    expect(JSON.parse(raw).items.find((i: { key: string }) => i.key === below.key).y).toBe(a!.h + 2);
  });

  it("recovers from a stored layout it cannot read", async () => {
    const put = (json: string) => app.db.prepare(`INSERT INTO dashboard_layouts (user_id, layout_json, updated_at) VALUES (?, ?, 1)
      ON CONFLICT(user_id) DO UPDATE SET layout_json = excluded.layout_json`).run(adminId, json);
    put('{"version":1,"items":[{"key":"x","widget":"gone"}]}');
    const first = await request("GET");
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ layout: { version: 1, items: [] }, isDefault: false });
    put("{}");
    const second = await request("GET");
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual({ layout: defaultLayout(), isDefault: true });
  });

  it("rejects overlapping items with 400", async () => {
    const [a, b] = defaultLayout().items;
    const res = await request("PUT", { layout: { version: 1, items: [a, { ...b, x: a!.x, y: a!.y }] } });
    expect(res.statusCode).toBe(400);
  });
});
