import { resolve } from "node:path";
import fastifyStatic from "@fastify/static";
import { MIGRATIONS, migrate, openDb, ZOMATO_CSV_COLUMNS, zomatoCsv } from "../../packages/domain/src/index.js";
import { buildServer } from "../../apps/server/src/server.js";
import { setupAdmin, createUser } from "../../apps/server/src/test-helpers.js";
import { makeFakeSink } from "../../apps/server/src/print/sinks.js";

const db = openDb(":memory:"); migrate(db, MIGRATIONS);
const app = buildServer({ db, port: 4177, sinkSend: makeFakeSink().send });
await app.register(fastifyStatic, { root: resolve("apps/ui/dist"), setHeaders: reply => reply.header("Cache-Control", "no-cache") });
app.setNotFoundHandler((req, reply) => req.method === "GET" && !req.url.startsWith("/api/") ? reply.sendFile("index.html") : reply.code(404).send({ error: "not found" }));
app.addHook("onClose", async () => { db.close(); });
const admin = await setupAdmin(app);
await createUser(app, admin.token, { name: "Counter", pin: "2345", role: "cashier" });
await createUser(app, admin.token, { name: "Captain", pin: "3456", role: "waiter" });
const headers = { authorization: `Bearer ${admin.token}` };
await app.inject({ method: "PATCH", url: "/api/zomato/settings", headers, payload: { restaurantId: "123456", restaurantName: "Demo restaurant", posId: "", webhookBaseUrl: "", enabled: false, version: 1 } });
const today = new Date();
const day = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
const orderedAt = today.toISOString();
for (const [kind, rows] of [
  ["orders", [
    ["123456", "000101", orderedAt, "delivered", "500.01", "prepaid"],
    ["123456", "000102", orderedAt, "delivered", "750", "prepaid"],
    ["123456", "000103", orderedAt, "delivered", "320", "cod"],
    ["123456", "000104", orderedAt, "cancelled", "400", "prepaid"],
    ["123456", "000105", orderedAt, "received", "250", "prepaid"],
  ]],
  ["settlements", [
    ["123456", "000101", "E1", "PAYOUT-001", day, "500.01", "100", "0", "400.01"],
    ["123456", "000102", "E2", "PAYOUT-001", day, "750", "150", "0", "580"],
    ["123456", "000104", "E4", "PAYOUT-001", day, "400", "400", "0", "0"],
    ["123456", "000106", "E6", "PAYOUT-002", day, "180", "36", "0", "144"],
  ]],
] as const) {
  const csv = zomatoCsv([ZOMATO_CSV_COLUMNS[kind], ...rows]);
  const preview = await app.inject({ method: "POST", url: "/api/zomato/import/preview", headers, payload: { kind, csv } });
  if (preview.statusCode !== 200) throw new Error(preview.body);
  const result = await app.inject({ method: "POST", url: "/api/zomato/import/commit", headers, payload: { kind, csv, revision: preview.json().revision } });
  if (result.statusCode !== 200) throw new Error(result.body);
}
await app.listen({ host: "127.0.0.1", port: 4177 });
process.on("SIGINT", () => { void app.close().then(() => process.exit(0)); });
process.on("SIGTERM", () => { void app.close().then(() => process.exit(0)); });
console.log("Disposable Zomato fixture: http://127.0.0.1:4177/ (admin 1234, cashier 2345, waiter 3456). No Zomato API calls.");
