// Disposable in-memory fixture. No restaurant data or physical printers.
import { freshAppWithFakeSink, setupAdmin, createUser, auth } from "../../apps/server/src/test-helpers.js";
import fastifyStatic from "@fastify/static";
import { resolve } from "node:path";
import { uuidv7 } from "@forkflow/domain";

const { app } = freshAppWithFakeSink();
await app.register(fastifyStatic, { root: resolve("apps/ui/dist") });
app.setNotFoundHandler((req, reply) => req.method === "GET" && !req.url.startsWith("/api/") ? reply.sendFile("index.html") : reply.code(404).send({ error: "not found" }));
const admin = await setupAdmin(app);
await createUser(app, admin.token, { name: "Counter", role: "cashier", pin: "2345" });
const post = async (url: string, payload: object) => {
  const res = await app.inject({ method: "POST", url, payload, headers: auth(admin.token) });
  if (res.statusCode >= 400) throw new Error(res.body); return res.json();
};
const tables = [];
for (let n = 1; n <= 8; n++) tables.push((await post("/api/tables", { name: `T${n}` })).table);
const categories = [];
for (const name of ["Main course", "Starters", "Beverages"]) categories.push((await post("/api/categories", { name })).category);
const products = [];
for (const [n, name] of ["Chicken biryani", "Veg fried rice", "Paneer butter masala", "Butter naan", "Dal tadka", "Masala dosa", "Chicken tikka", "Gobi manchurian", "French fries", "Fresh lime soda", "Mango lassi", "Mineral water"].entries()) {
  products.push((await post("/api/products", { name, categoryId: categories[Math.floor(n / 6) + (n >= 9 ? 1 : 0)]!.id, pricePaise: (80 + n * 25) * 100, gstRate: 5, kotStationId: null })).product);
}
for (let offset = 6; offset >= 0; offset--) {
  for (let n = 0; n < 6; n++) {
    const type = n % 3 === 0 ? "dine_in" : "parcel";
    const order = (await post("/api/orders", { type, clientRef: uuidv7(), ...(type === "dine_in" ? { tableId: tables[(offset + n) % tables.length]!.id } : {}) })).order;
    const first = (offset + n) % products.length, second = (first + 4) % products.length;
    await post(`/api/orders/${order.id}/items`, { items: [first, second].map((i, index) => ({ clientRef: uuidv7(), productId: products[i]!.id, qty: index === 0 ? n + 1 : 2 })) });
    const options = n === 1 ? { discountPaise: 101, discountNote: "Fixture offer" } : {};
    const { preview } = await post(`/api/orders/${order.id}/bill-preview`, options);
    const { bill } = await post(`/api/orders/${order.id}/bill`, { ...options, clientRef: uuidv7(), previewKey: preview.previewKey });
    if (n !== 2) await post(`/api/bills/${bill.id}/settle`, { clientRef: uuidv7(), payments: [{ mode: "cash", amountPaise: bill.totalPaise }] });
    const day = new Date(); day.setDate(day.getDate() - offset); day.setHours(11 + n * 2, 15, 0, 0);
    app.db.prepare("UPDATE bills SET created_at = ? WHERE id = ?").run(day.getTime(), bill.id);
    app.db.prepare("UPDATE payments SET created_at = ? WHERE bill_id = ?").run(day.getTime(), bill.id);
  }
}
await app.listen({ host: "127.0.0.1", port: 4163 });
const close = async () => { await app.close(); app.db.close(); process.exit(0); };
process.on("SIGINT", () => void close()); process.on("SIGTERM", () => void close());
console.log("Analytics fixture: http://127.0.0.1:4163 · Admin 1234 · Cashier 2345");
