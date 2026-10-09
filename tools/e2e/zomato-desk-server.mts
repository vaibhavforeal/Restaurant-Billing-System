// Disposable in-memory restaurant for tools/e2e/zomato-desk.js. No real POS data or printers are used.
// Zomato and the Kitchen Display are ON, with a restaurant ID saved. "Paneer tikka" costs 300 base, 260 Takeaway and 240 Zomato, on a kitchen station.
import { freshAppWithFakeSink, setupAdmin, createUser, auth } from "../../apps/server/src/test-helpers.js";
import fastifyStatic from "@fastify/static";
import { resolve } from "node:path";

const { app } = freshAppWithFakeSink();
await app.register(fastifyStatic, { root: resolve("apps/ui/dist") });
app.setNotFoundHandler((req, reply) => req.method === "GET" && !req.url.startsWith("/api/") ? reply.sendFile("index.html") : reply.code(404).send({ error: "not found" }));
const admin = await setupAdmin(app);
await createUser(app, admin.token, { name: "Counter", pin: "2345", role: "cashier" });
await createUser(app, admin.token, { name: "Ravi", pin: "3456", role: "waiter" });
const call = async (url: string, payload: object, method: "POST" | "PATCH" = "POST") => {
  const response = await app.inject({ method, url, payload, headers: auth(admin.token) });
  if (response.statusCode >= 400) throw new Error(`${method} ${url}: ${response.body}`); return response.json();
};
const { printer } = await call("/api/printers", { name: "Kitchen printer", kind: "network", connection: "127.0.0.1:9999", paperWidth: 80 });
const { station } = await call("/api/kot-stations", { name: "Hot kitchen", printerId: printer.id });
const { category } = await call("/api/categories", { name: "Starters" });
await call("/api/products", { name: "Paneer tikka", categoryId: category.id, pricePaise: 30000, takeawayPricePaise: 26000, zomatoPricePaise: 24000, gstRate: 5, kotStationId: station.id });
for (let n = 1; n <= 4; n++) await call("/api/tables", { name: `T${n}`, area: "Dining" });
await call("/api/zomato/settings", { restaurantId: "123456", restaurantName: "Demo restaurant", posId: "", webhookBaseUrl: "", enabled: false, version: 1 }, "PATCH");
await call("/api/integrations/zomato", { enabled: true }, "PATCH");
await call("/api/integrations/kds", { enabled: true }, "PATCH"); // the gate reads the KOT back through the kitchen API
await app.listen({ host: "127.0.0.1", port: 4150 });
const close = async () => { await app.close(); app.db.close(); process.exit(0); };
process.on("SIGINT", () => void close()); process.on("SIGTERM", () => void close());
console.log("Zomato desk fixture: http://127.0.0.1:4150/ · Admin 1234 · Cashier 2345 · Waiter 3456 · Zomato and KDS ON");
