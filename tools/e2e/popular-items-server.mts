import { freshAppWithFakeSink, setupAdmin, createUser, auth } from "../../apps/server/src/test-helpers.js";
import fastifyStatic from "@fastify/static";
import { resolve } from "node:path";
import { uuidv7 } from "@masalapos/domain";

// Disposable in-memory restaurant with a week of billed sales: never opens the restaurant database.
const { app } = freshAppWithFakeSink();
await app.register(fastifyStatic, { root: resolve("apps/ui/dist"), setHeaders: (reply) => reply.header("Cache-Control", "no-cache") });
app.setNotFoundHandler((req, reply) => req.method === "GET" && !req.url.startsWith("/api/") ? reply.sendFile("index.html") : reply.code(404).send({ error: "not found" }));
let qrPath = "";
/** Fixture-only: the QR menu address for T1. */
app.get("/__qa/qr", async () => ({ path: qrPath }));
const admin = await setupAdmin(app);
await createUser(app, admin.token, { name: "Ravi", pin: "3456", role: "waiter" });
const call = async (method: "POST" | "PUT", url: string, payload: object) => {
  const r = await app.inject({ method, url, payload, headers: auth(admin.token) }); if (r.statusCode >= 400) throw Error(r.body); return r.json();
};
const post = (url: string, payload: object) => call("POST", url, payload);
const ids: Record<string, string> = {};
for (const [categoryName, dishes] of [["Starters", ["Paneer tikka", "Samosa", "Chicken tikka"]], ["Mains", ["Dal tadka", "Biryani"]], ["Drinks", ["Lassi"]]] as const) {
  const { category } = await post("/api/categories", { name: categoryName });
  for (const name of dishes) ids[name] = (await post("/api/products", { name, categoryId: category.id, pricePaise: 15000, gstRate: 5, kotStationId: null })).product.id;
}
// Samosa leads Starters, Biryani leads Mains; Lassi is alone in Drinks, so it is never badged.
for (const [name, qty] of [["Samosa", 5], ["Paneer tikka", 2], ["Biryani", 4], ["Dal tadka", 1], ["Lassi", 9]] as const) {
  const { order } = await post("/api/orders", { type: "parcel", clientRef: uuidv7() });
  await post(`/api/orders/${order.id}/items`, { items: [{ clientRef: uuidv7(), productId: ids[name], qty }] });
  const { preview } = await post(`/api/orders/${order.id}/bill-preview`, {});
  await post(`/api/orders/${order.id}/bill`, { clientRef: uuidv7(), previewKey: preview.previewKey });
}
const { table } = await post("/api/tables", { name: "T1", area: "Dining" });
qrPath = ((await call("PUT", `/api/qr/tables/${table.id}`, { enabled: true })).table as { path: string }).path;
await app.listen({ host: "127.0.0.1", port: 4155 });
const close = async () => { await app.close(); app.db.close(); process.exit(0); };
process.on("SIGINT", () => void close()); process.on("SIGTERM", () => void close());
console.log("Popular items fixture: http://127.0.0.1:4155/ - admin 1234, waiter 3456");
