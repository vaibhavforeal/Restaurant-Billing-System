import { freshAppWithFakeSink, setupAdmin, createUser, auth } from "../../apps/server/src/test-helpers.js";
import fastifyStatic from "@fastify/static";
import { resolve } from "node:path";
import { uuidv7 } from "@masalapos/domain";

// Disposable in-memory restaurant with planted incidents for the Staff activity report: never opens the restaurant database.
const { app } = freshAppWithFakeSink();
await app.register(fastifyStatic, { root: resolve("apps/ui/dist"), setHeaders: (reply) => reply.header("Cache-Control", "no-cache") });
app.setNotFoundHandler((req, reply) => req.method === "GET" && !req.url.startsWith("/api/") ? reply.sendFile("index.html") : reply.code(404).send({ error: "not found" }));
const admin = await setupAdmin(app);
const meena = await createUser(app, admin.token, { name: "Meena", pin: "3333", role: "cashier" });
const ravi = await createUser(app, admin.token, { name: "Ravi", pin: "4444", role: "cashier" });
const call = async (method: "POST" | "PATCH", url: string, payload: object | undefined, token = admin.token) => {
  const r = await app.inject({ method, url, headers: auth(token), ...(payload ? { payload } : {}) }); if (r.statusCode >= 400) throw Error(r.body); return r.json();
};
const { category } = await call("POST", "/api/categories", { name: "Food" });
const kitchen = (app.db.prepare("SELECT id FROM kot_stations LIMIT 1").get() as { id: string }).id;
const { printer } = await call("POST", "/api/printers", { name: "Kitchen", kind: "network", connection: "127.0.0.1:9100", paperWidth: 80 });
await call("PATCH", `/api/kot-stations/${kitchen}`, { printerId: printer.id });
const thali = (await call("POST", "/api/products", { name: "Thali", categoryId: category.id, pricePaise: 25000, gstRate: 0, kotStationId: null })).product.id;
const kebab = (await call("POST", "/api/products", { name: "Kebab", categoryId: category.id, pricePaise: 30000, gstRate: 0, kotStationId: kitchen })).product.id;
async function order(token: string, productId: string, qty = 1) {
  const { order: created } = await call("POST", "/api/orders", { clientRef: uuidv7(), type: "parcel" }, token);
  return (await call("POST", `/api/orders/${created.id}/items`, { items: [{ productId, qty, clientRef: uuidv7() }] }, token)).order as { id: string; items: Array<{ id: string }> };
}
async function bill(token: string, extra: object = {}) {
  const { id } = await order(token, thali);
  const { preview } = await call("POST", `/api/orders/${id}/bill-preview`, extra, token);
  return (await call("POST", `/api/orders/${id}/bill`, { clientRef: uuidv7(), previewKey: preview.previewKey, ...extra }, token)).bill;
}
async function cancelAfterKot(token: string, qty: number) {
  const sent = await order(token, kebab, qty);
  await call("POST", `/api/orders/${sent.id}/send`, undefined, token);
  await call("POST", `/api/order-items/${sent.items[0]!.id}/cancel`, { reason: "Guest left" }, token);
  return sent.items[0]!.id;
}
// Meena: a paid bill voided, a ₹600 pay-out and a drawer ₹300 short.
const { shift } = await call("POST", "/api/shifts", { clientRef: uuidv7(), openingFloatPaise: 100000 }, meena.token);
const paid = await bill(meena.token);
await call("POST", `/api/bills/${paid.id}/settle`, { clientRef: uuidv7(), payments: [{ mode: "cash", amountPaise: paid.totalPaise }] }, meena.token);
await call("POST", `/api/bills/${paid.id}/void`, { clientRef: uuidv7(), reason: "Wrong order", approverPin: "1234", refunds: [{ mode: "cash", amountPaise: paid.totalPaise }] }, meena.token);
await call("POST", `/api/shifts/${shift.id}/cash-movements`, { clientRef: uuidv7(), kind: "pay_out", amountPaise: 60000, reason: "Vegetables" }, meena.token);
await call("POST", `/api/shifts/${shift.id}/close`, { clientRef: uuidv7(), countedCashPaise: 10000, note: "" }, meena.token);
// Asha (admin): a 30% discount.
await bill(admin.token, { discountPaise: 7500, discountNote: "Friend" });
// Ravi: cancelled 1 kebab after KOT 10 days ago, and 4 today.
const earlier = await cancelAfterKot(ravi.token, 1);
app.db.prepare("UPDATE order_items SET cancelled_at = ? WHERE id = ?").run(Date.now() - 10 * 24 * 60 * 60 * 1000, earlier);
await cancelAfterKot(ravi.token, 4);
await app.listen({ host: "127.0.0.1", port: 4159 });
const close = async () => { await app.close(); app.db.close(); process.exit(0); };
process.on("SIGINT", () => void close()); process.on("SIGTERM", () => void close());
console.log("Staff activity fixture: http://127.0.0.1:4159/ - admin / admin-password");
