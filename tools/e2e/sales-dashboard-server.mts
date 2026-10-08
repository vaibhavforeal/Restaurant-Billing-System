// Disposable in-memory restaurant. No real POS data or printers are used.
import { freshAppWithFakeSink, setupAdmin, createUser, auth } from "../../apps/server/src/test-helpers.js";
import fastifyStatic from "@fastify/static";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { uuidv7, localDateKey, ZOMATO_CSV_COLUMNS, zomatoCsv } from "@forkflow/domain";

const { app } = freshAppWithFakeSink();
await app.register(fastifyStatic, { root: resolve("apps/ui/dist") });
app.setNotFoundHandler((req, reply) => req.method === "GET" && !req.url.startsWith("/api/") ? reply.sendFile("index.html") : reply.code(404).send({ error: "not found" }));
const admin = await setupAdmin(app);
await createUser(app, admin.token, { name: "Counter", pin: "2345", role: "cashier" });
await createUser(app, admin.token, { name: "Ravi", pin: "3456", role: "waiter" });
const post = async (url: string, payload: object, method: "POST" | "PATCH" = "POST") => {
  const response = await app.inject({ method, url, payload, headers: auth(admin.token) });
  if (response.statusCode >= 400) throw new Error(response.body); return response.json();
};
const { category } = await post("/api/categories", { name: "Meals" });
const { product } = await post("/api/products", { name: "Lunch thali", categoryId: category.id, pricePaise: 28000, gstRate: 5, kotStationId: null });
for (let n = 1; n <= 12; n++) await post("/api/tables", { name: `T${n}`, area: "Dining" });
for (let offset = 29; offset >= 0; offset--) {
  if (offset === 8) continue;
  const day = new Date(); day.setDate(day.getDate() - offset); day.setHours(12, 0, 0, 0);
  for (let n = 0; n < 3 + offset % 5; n++) {
    const { order } = await post("/api/orders", { clientRef: uuidv7(), type: "parcel" });
    await post(`/api/orders/${order.id}/items`, { items: [{ clientRef: uuidv7(), productId: product.id, qty: 2 + (offset + n) % 6 }] });
    const options = n === 1 ? { discountPaise: 1500, discountNote: "Demo offer" } : {};
    const { preview } = await post(`/api/orders/${order.id}/bill-preview`, options);
    const { bill } = await post(`/api/orders/${order.id}/bill`, { ...options, clientRef: uuidv7(), previewKey: preview.previewKey });
    app.db.prepare("UPDATE bills SET created_at = ? WHERE id = ?").run(day.getTime(), bill.id);
    if (offset === 0 && n === 0) continue;
    const mode = ["cash", "upi", "card"][(offset + n) % 3];
    const payments = n === 2 ? [{ mode: "cash", amountPaise: 10000 }, { mode: "upi", amountPaise: bill.totalPaise - 10000 }] : [{ mode, amountPaise: bill.totalPaise }];
    await post(`/api/bills/${bill.id}/settle`, { clientRef: uuidv7(), payments });
    const collected = new Date(day); if (offset > 0 && n === 0) collected.setDate(collected.getDate() + 1);
    app.db.prepare("UPDATE payments SET created_at = ? WHERE bill_id = ?").run(collected.getTime(), bill.id);
  }
}
// Today also gets dine-in and takeaway bills in several four-hour slots, including 00:30 (the LAST slot, 21:00-01:00),
// plus an open order, a cancelled order and an open Zomato order. Zomato stays OFF in the Marketplace until a check turns it on.
const tables = (await (await app.inject({ url: "/api/tables", headers: auth(admin.token) })).json()).tables as Array<{ id: string }>;
const todayAt = (hour: number, minute: number) => { const d = new Date(); d.setHours(hour, minute, 0, 0); return d; };
let tableCursor = 0;
for (const [type, hour, minute, qty] of [["dine_in", 0, 30, 3], ["parcel", 0, 45, 1], ["parcel", 6, 10, 2], ["dine_in", 11, 15, 2], ["dine_in", 19, 0, 4]] as const) {
  const { order } = await post("/api/orders", { clientRef: uuidv7(), type, ...(type === "dine_in" ? { tableId: tables[tableCursor++ % tables.length]!.id } : {}) });
  await post(`/api/orders/${order.id}/items`, { items: [{ clientRef: uuidv7(), productId: product.id, qty }] });
  const { preview } = await post(`/api/orders/${order.id}/bill-preview`, {});
  const { bill } = await post(`/api/orders/${order.id}/bill`, { clientRef: uuidv7(), previewKey: preview.previewKey });
  await post(`/api/bills/${bill.id}/settle`, { clientRef: uuidv7(), payments: [{ mode: "cash", amountPaise: bill.totalPaise }] });
  const at = todayAt(hour, minute).getTime();
  app.db.prepare("UPDATE bills SET created_at = ? WHERE id = ?").run(at, bill.id);
  app.db.prepare("UPDATE payments SET created_at = ? WHERE bill_id = ?").run(at, bill.id);
}
const openOrder = (await post("/api/orders", { clientRef: uuidv7(), type: "parcel" })).order;
await post(`/api/orders/${openOrder.id}/items`, { items: [{ clientRef: uuidv7(), productId: product.id, qty: 1 }] });
const cancelledOrder = (await post("/api/orders", { clientRef: uuidv7(), type: "parcel" })).order;
await post(`/api/orders/${cancelledOrder.id}/cancel`, { reason: "Fixture cancel" });
await post("/api/zomato/settings", { restaurantId: "123456", restaurantName: "Demo restaurant", posId: "", webhookBaseUrl: "", enabled: false, version: 1 }, "PATCH");
const zomatoCsvText = zomatoCsv([ZOMATO_CSV_COLUMNS.orders, ["123456", "000201", new Date().toISOString(), "received", "420", "prepaid"]]);
const zomatoPreview = await post("/api/zomato/import/preview", { kind: "orders", csv: zomatoCsvText });
await post("/api/zomato/import/commit", { kind: "orders", csv: zomatoCsvText, revision: zomatoPreview.revision });
mkdirSync("output/sales-dashboard", { recursive: true }); mkdirSync(".e2e-scratch", { recursive: true });
const expected = (await app.inject({ url: "/api/reports/sales", headers: auth(admin.token) })).json().report;
writeFileSync(".e2e-scratch/sales-dashboard-expected.json", JSON.stringify(expected, null, 2));
await app.listen({ host: "127.0.0.1", port: 4145 });
const close = async () => { await app.close(); app.db.close(); process.exit(0); };
process.on("SIGINT", () => void close()); process.on("SIGTERM", () => void close());
console.log(`Sales dashboard fixture: http://127.0.0.1:4145/ · Admin 1234 · Cashier 2345 · Waiter 3456 · Zomato OFF in the Marketplace · ${localDateKey(Date.now())}`);
