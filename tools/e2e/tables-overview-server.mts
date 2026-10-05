import { freshAppWithFakeSink, setupAdmin, auth } from "../../apps/server/src/test-helpers.js";
import { localMinute } from "../../apps/server/src/reservation-rules.js";
import fastifyStatic from "@fastify/static";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";

// Disposable data and captured printing: never opens the restaurant database.
const { app } = freshAppWithFakeSink();
await app.register(fastifyStatic, { root: resolve("apps/ui/dist") });
app.setNotFoundHandler((req, reply) => req.method === "GET" && !req.url.startsWith("/api/") ? reply.sendFile("index.html") : reply.code(404).send({ error: "not found" }));
const admin = await setupAdmin(app);
async function post(url: string, payload: object) {
  const result = await app.inject({ method: "POST", url, payload, headers: auth(admin.token) });
  if (result.statusCode >= 400) throw new Error(result.body);
  return result.json();
}
const { category } = await post("/api/categories", { name: "Meals" });
const { product } = await post("/api/products", { name: "Paneer biryani", categoryId: category.id, pricePaise: 18000, acPricePaise: 22000, takeawayPricePaise: 19000, gstRate: 5 });
async function open(tableId: string | null, qty: number, minutes: number, billed = false) {
  const { order } = await post("/api/orders", { clientRef: randomUUID(), type: tableId ? "dine_in" : "parcel", tableId });
  await post(`/api/orders/${order.id}/items`, { items: [{ productId: product.id, qty, clientRef: randomUUID() }] });
  app.db.prepare("UPDATE orders SET opened_at=? WHERE id=?").run(Date.now() - minutes * 60_000, order.id);
  if (billed) {
    const { preview } = await post(`/api/orders/${order.id}/bill-preview`, {});
    await post(`/api/orders/${order.id}/bill`, { clientRef: randomUUID(), previewKey: preview.previewKey });
  }
}
for (let i = 1; i <= 14; i++) {
  const area = i <= 8 ? "Main hall" : "Garden";
  const { table } = await post("/api/tables", { name: `T${String(i).padStart(2, "" )}`, area, priceTier: i <= 8 ? "ac" : "non_ac", sortOrder: i });
  if ([2, 3, 7, 10].includes(i)) await open(table.id, i % 4 + 1, i * 4);
  if (i === 3) await open(table.id, 2, 7);
  if ([5, 12].includes(i)) await open(table.id, 3, 32, true);
  if (i === 6) await post("/api/reservations", { clientRef: randomUUID(), tableId: table.id, customerName: "Meera Shah", partySize: 4, startsLocal: localMinute(Date.now()), durationMinutes: 90 });
}
await open(null, 2, 8); await open(null, 3, 14); await open(null, 1, 19, true);
await post("/api/users", { name: "Captain", pin: "2345", role: "waiter" });
await app.listen({ host: "127.0.0.1", port: 4149 });
const close = async () => { await app.close(); app.db.close(); process.exit(0); };
process.on("SIGINT", () => void close()); process.on("SIGTERM", () => void close());
console.log("Tables fixture: http://127.0.0.1:4149/ - admin 1234, captain 2345");
