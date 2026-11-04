import { freshAppWithFakeSink, setupAdmin, auth, enableIntegration } from "../../apps/server/src/test-helpers.js";
import fastifyStatic from "@fastify/static";
import { resolve } from "node:path";
import { uuidv7 } from "@masalapos/domain";

// Disposable in-memory restaurant with CRM on and one regular customer: never opens the restaurant database.
const { app } = freshAppWithFakeSink();
await app.register(fastifyStatic, { root: resolve("apps/ui/dist"), setHeaders: (reply) => reply.header("Cache-Control", "no-cache") });
app.setNotFoundHandler((req, reply) => req.method === "GET" && !req.url.startsWith("/api/") ? reply.sendFile("index.html") : reply.code(404).send({ error: "not found" }));
const admin = await setupAdmin(app);
enableIntegration(app, "crm");
const call = async (method: "POST" | "PATCH", url: string, payload: object) => {
  const r = await app.inject({ method, url, payload, headers: auth(admin.token) }); if (r.statusCode >= 400) throw Error(r.body); return r.json();
};
const post = (url: string, payload: object) => call("POST", url, payload);
const { category } = await post("/api/categories", { name: "Food" });
const dish = async (name: string, pricePaise: number, extra: object = {}) =>
  (await post("/api/products", { name, categoryId: category.id, pricePaise, gstRate: 5, kotStationId: null, ...extra })).product;
const paneer = await dish("Paneer tikka", 24000, { variants: [{ name: "Half", pricePaise: 14000 }, { name: "Full", pricePaise: 24000 }] });
const naan = await dish("Butter naan", 6000);
const dal = await dish("Dal tadka", 18000);
const lassi = await dish("Lassi", 9000);
// A combo whose main must be chosen, so Repeat last order cannot rebuild it.
const thali = await dish("Thali", 30000, { kind: "combo", combo: [{ name: "Main", minPicks: 1, maxPicks: 1, options: [{ productId: dal.id }, { productId: naan.id }] }] });
const full = paneer.variants.find((v: { name: string }) => v.name === "Full").id;
const { customer } = await post("/api/customers", { name: "Priya Sharma", phone: "98765 43210" });
async function visit(items: object[], daysAgo: number) {
  const { order } = await post("/api/orders", { clientRef: uuidv7(), type: "parcel" });
  await post(`/api/orders/${order.id}/items`, { items: items.map((item) => ({ clientRef: uuidv7(), ...item })) });
  await call("PATCH", `/api/orders/${order.id}/customer`, { customerId: customer.id });
  const { preview } = await post(`/api/orders/${order.id}/bill-preview`, {});
  const { bill } = await post(`/api/orders/${order.id}/bill`, { clientRef: uuidv7(), previewKey: preview.previewKey });
  app.db.prepare("UPDATE bills SET created_at = ? WHERE id = ?").run(Date.now() - daysAgo * 24 * 60 * 60 * 1000, bill.id);
}
// Usual: Paneer tikka (Full) and Butter naan are on both bills. Last order also has Dal, the Thali and a Lassi.
await visit([{ productId: paneer.id, variantId: full, qty: 1 }, { productId: naan.id, qty: 2 }], 20);
await visit([{ productId: paneer.id, variantId: full, qty: 2 }, { productId: naan.id, qty: 1 }, { productId: dal.id, qty: 1 },
  { productId: thali.id, qty: 1, comboPicks: [thali.combo[0].options[0].id] }, { productId: lassi.id, qty: 1 }], 3);
await call("PATCH", `/api/products/${lassi.id}`, { isSoldOut: true });
await app.listen({ host: "127.0.0.1", port: 4156 });
const close = async () => { await app.close(); app.db.close(); process.exit(0); };
process.on("SIGINT", () => void close()); process.on("SIGTERM", () => void close());
console.log("Customer usual fixture: http://127.0.0.1:4156/ - admin / admin-password; customer Priya Sharma 98765 43210");
