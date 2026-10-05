// Disposable in-memory restaurant: no real records or printers.
import { freshAppWithFakeSink, setupAdmin, createUser, auth } from "../../apps/server/src/test-helpers.js";
import fastifyStatic from "@fastify/static";
import { resolve } from "node:path";
import { uuidv7 } from "@forkflow/domain";

const { app } = freshAppWithFakeSink();
await app.register(fastifyStatic, { root: resolve("apps/ui/dist") });
app.setNotFoundHandler((req, reply) => req.method === "GET" && !req.url.startsWith("/api/") ? reply.sendFile("index.html") : reply.code(404).send({ error: "not found" }));
const admin = await setupAdmin(app);
const cashier = await createUser(app, admin.token, { name: "Counter 2", role: "cashier", pin: "2345" });
const captain = await createUser(app, admin.token, { name: "Ravi", role: "waiter", pin: "3456" });
await createUser(app, admin.token, { name: "Kitchen", role: "kitchen", pin: "4567" });
const call = async (method: "POST" | "PUT", url: string, payload: object, token = admin.token) => {
  const res = await app.inject({ method, url, payload, headers: auth(token) });
  if (res.statusCode >= 400) throw new Error(res.body); return res.json();
};
const table = (await call("POST", "/api/tables", { name: "T1" })).table;
await call("POST", "/api/tables", { name: "T2" });
const category = (await call("POST", "/api/categories", { name: "Meals" })).category;
const station = app.db.prepare("SELECT id FROM kot_stations LIMIT 1").get() as { id: string };
const product = (await call("POST", "/api/products", { name: "Lunch thali", categoryId: category.id, pricePaise: 28000, gstRate: 5, kotStationId: station.id })).product;
let stock = (await call("POST", "/api/stock-items", { clientRef: uuidv7(), name: "Rice", unit: "kg", openingQty: 20 })).item;
await call("PUT", `/api/products/${product.id}/stock-links`, { expectedVersion: 0, stockItemId: stock.id, qtyPerSale: 0.125 });
for (let n = 0; n < 3; n++) {
  let order = (await call("POST", "/api/orders", { clientRef: uuidv7(), type: n === 0 ? "dine_in" : "parcel", ...(n === 0 ? { tableId: table.id, captainId: captain.id } : {}) })).order;
  order = (await call("POST", `/api/orders/${order.id}/items`, { items: [{ clientRef: uuidv7(), productId: product.id, qty: n + 1 }] })).order;
  const sent = await call("POST", `/api/orders/${order.id}/send`, { clientRef: uuidv7(), itemIds: order.items.map((i: { id: string }) => i.id) });
  const kot = sent.kots[0];
  if (n === 2) { await call("POST", `/api/order-items/${order.items[0].id}/cancel`, { reason: "Guest changed mind" }); await call("POST", `/api/orders/${order.id}/cancel`, { reason: "Guest left" }); continue; }
  if (n === 0) { await call("POST", `/api/kots/${kot.id}/done`, {}); app.db.prepare("UPDATE kots SET created_at = done_at - 720000 WHERE id = ?").run(kot.id); }
  const options = { discountPaise: 101, discountNote: "Demo discount" };
  const { preview } = await call("POST", `/api/orders/${order.id}/bill-preview`, options);
  const { bill } = await call("POST", `/api/orders/${order.id}/bill`, { ...options, clientRef: uuidv7(), previewKey: preview.previewKey });
  await call("POST", `/api/bills/${bill.id}/settle`, { clientRef: uuidv7(), payments: [{ mode: "cash", amountPaise: 10000 }, { mode: "upi", amountPaise: bill.totalPaise - 10000 }] }, cashier.token);
}
stock = (await app.inject({ url: "/api/stock-items", headers: auth(admin.token) })).json().items[0];
await call("POST", `/api/stock-items/${stock.id}/movements`, { clientRef: uuidv7(), expectedVersion: stock.version, reason: "wastage", quantity: 0.25, note: "Spillage" });
await app.listen({ host: "127.0.0.1", port: 4157 });
const close = async () => { await app.close(); app.db.close(); process.exit(0); };
process.on("SIGINT", () => void close()); process.on("SIGTERM", () => void close());
console.log("Report/captain fixture: http://127.0.0.1:4157 · admin 1234 · cashier 2345 · captain 3456");
