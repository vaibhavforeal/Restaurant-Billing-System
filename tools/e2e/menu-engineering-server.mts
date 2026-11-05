import { freshAppWithFakeSink, setupAdmin, auth } from "../../apps/server/src/test-helpers.js";
import fastifyStatic from "@fastify/static";
import { resolve } from "node:path";
import { uuidv7 } from "@masalapos/domain";

// Disposable in-memory restaurant with costed recipes and a day of sales: never opens the restaurant database.
const { app } = freshAppWithFakeSink();
await app.register(fastifyStatic, { root: resolve("apps/ui/dist"), setHeaders: (reply) => reply.header("Cache-Control", "no-cache") });
app.setNotFoundHandler((req, reply) => req.method === "GET" && !req.url.startsWith("/api/") ? reply.sendFile("index.html") : reply.code(404).send({ error: "not found" }));
const admin = await setupAdmin(app);
const call = async (method: "POST" | "PUT", url: string, payload: object) => {
  const r = await app.inject({ method, url, payload, headers: auth(admin.token) }); if (r.statusCode >= 400) throw Error(r.body); return r.json();
};
const post = (url: string, payload: object) => call("POST", url, payload);
// Paneer at ₹320/kg.
const { item: paneer } = await post("/api/stock-items", { clientRef: uuidv7(), name: "Paneer", unit: "kg", openingQty: 50, lowStockThreshold: null });
await post(`/api/stock-items/${paneer.id}/unit-cost`, { clientRef: uuidv7(), expectedVersion: paneer.version, unitCostMilliPaise: 32_000_000, note: "Opening cost" });
const { category } = await post("/api/categories", { name: "Mains" });
// Every dish is ₹100 with no GST. Food cost per plate: Tikka ₹48, Bhurji ₹80, Kofta ₹16, Shahi ₹96; Water has no recipe.
async function dish(name: string, paneerKg: number | null) {
  const { product } = await post("/api/products", { name, categoryId: category.id, pricePaise: 10_000, gstRate: 0, kotStationId: null });
  if (paneerKg !== null) await call("PUT", `/api/products/${product.id}/recipe`, { expectedVersion: 0, ingredients: [{ stockItemId: paneer.id, qtyPerSale: paneerKg }] });
  return product.id as string;
}
// 15 plates over 5 dishes: high sellers need 70% of an even share (2.1 plates). Average margin ₹500 / 13 plates = ₹38.46.
const sales: Array<[string, number | null, number]> = [["Paneer Tikka", 0.15, 6], ["Paneer Bhurji", 0.25, 5], ["Malai Kofta", 0.05, 1], ["Shahi Paneer", 0.3, 1], ["Water", null, 2]];
for (const [name, kg, plates] of sales) {
  const productId = await dish(name, kg);
  const { order } = await post("/api/orders", { type: "parcel", clientRef: uuidv7() });
  await post(`/api/orders/${order.id}/items`, { items: [{ clientRef: uuidv7(), productId, qty: plates }] });
  const { preview } = await post(`/api/orders/${order.id}/bill-preview`, {});
  await post(`/api/orders/${order.id}/bill`, { clientRef: uuidv7(), previewKey: preview.previewKey });
}
await app.listen({ host: "127.0.0.1", port: 4157 });
const close = async () => { await app.close(); app.db.close(); process.exit(0); };
process.on("SIGINT", () => void close()); process.on("SIGTERM", () => void close());
console.log("Menu engineering fixture: http://127.0.0.1:4157/ - admin / admin-password");
