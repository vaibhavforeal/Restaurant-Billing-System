import { freshAppWithFakeSink, setupAdmin, auth } from "../../apps/server/src/test-helpers.js";
import fastifyStatic from "@fastify/static";
import { resolve } from "node:path";
import { uuidv7 } from "@masalapos/domain";

// Disposable in-memory restaurant with four weeks of sales on tomorrow's weekday: never opens the restaurant database.
const { app } = freshAppWithFakeSink();
await app.register(fastifyStatic, { root: resolve("apps/ui/dist"), setHeaders: (reply) => reply.header("Cache-Control", "no-cache") });
app.setNotFoundHandler((req, reply) => req.method === "GET" && !req.url.startsWith("/api/") ? reply.sendFile("index.html") : reply.code(404).send({ error: "not found" }));
const admin = await setupAdmin(app);
const call = async (method: "POST" | "PUT", url: string, payload: object) => {
  const r = await app.inject({ method, url, payload, headers: auth(admin.token) }); if (r.statusCode >= 400) throw Error(r.body); return r.json();
};
const post = (url: string, payload: object) => call("POST", url, payload);
const stock = async (name: string, unit: string, openingQty: number) => (await post("/api/stock-items", { clientRef: uuidv7(), name, unit, openingQty, lowStockThreshold: null })).item;
const paneerStock = await stock("Paneer", "kg", 2.5);
const curd = await stock("Curd", "L", 10);
const { category } = await post("/api/categories", { name: "Mains" });
const dish = async (name: string, link?: { stockItemId: string; qtyPerSale: number }) => {
  const { product } = await post("/api/products", { name, categoryId: category.id, pricePaise: 10_000, gstRate: 5, kotStationId: null });
  if (link) await call("PUT", `/api/products/${product.id}/stock-links`, { expectedVersion: 0, ...link });
  return product.id as string;
};
const tikka = await dish("Paneer tikka", { stockItemId: paneerStock.id, qtyPerSale: 0.2 });
const lassi = await dish("Lassi", { stockItemId: curd.id, qtyPerSale: 0.3 });
const naan = await dish("Naan");
async function sold(daysAgo: number, lines: Array<[string, number]>) {
  const { order } = await post("/api/orders", { type: "parcel", clientRef: uuidv7() });
  await post(`/api/orders/${order.id}/items`, { items: lines.filter(([, qty]) => qty > 0).map(([productId, qty]) => ({ clientRef: uuidv7(), productId, qty })) });
  const { preview } = await post(`/api/orders/${order.id}/bill-preview`, {});
  const { bill } = await post(`/api/orders/${order.id}/bill`, { clientRef: uuidv7(), previewKey: preview.previewKey });
  app.db.prepare("UPDATE bills SET created_at = ? WHERE id = ?").run(Date.now() - daysAgo * 24 * 60 * 60 * 1000, bill.id);
}
// Tomorrow's weekday was 6, 13, 20 and 27 days ago. Paneer tikka 4, 2, 0, 6 (average 3); Naan 2 each time; Lassi once.
await sold(6, [[tikka, 4], [naan, 2], [lassi, 1]]);
await sold(13, [[tikka, 2], [naan, 2]]);
await sold(20, [[naan, 2]]);
await sold(27, [[tikka, 6], [naan, 2]]);
await app.listen({ host: "127.0.0.1", port: 4158 });
const close = async () => { await app.close(); app.db.close(); process.exit(0); };
process.on("SIGINT", () => void close()); process.on("SIGTERM", () => void close());
console.log("Prep forecast fixture: http://127.0.0.1:4158/ - admin / admin-password");
