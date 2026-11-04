import { freshAppWithFakeSink, setupAdmin, createUser, auth } from "../../apps/server/src/test-helpers.js";
import fastifyStatic from "@fastify/static";
import { resolve } from "node:path";

// Disposable data and captured printing: never opens the restaurant database.
const { app, fake } = freshAppWithFakeSink();
await app.register(fastifyStatic, { root: resolve("apps/ui/dist"), setHeaders: (reply) => reply.header("Cache-Control", "no-cache") });
app.setNotFoundHandler((req, reply) => req.method === "GET" && !req.url.startsWith("/api/") ? reply.sendFile("index.html") : reply.code(404).send({ error: "not found" }));
/** Fixture-only: how many kitchen tickets printed, and what they said. */
app.get("/__qa/prints", async () => ({ prints: fake.sent.map((p) => p.bytes.toString("utf8")) }));
const admin = await setupAdmin(app);
await createUser(app, admin.token, { name: "Counter", pin: "2345", role: "cashier" });
await createUser(app, admin.token, { name: "Ravi", pin: "3456", role: "waiter" });
const post = async (url: string, payload: object) => { const r = await app.inject({ method: "POST", url, payload, headers: auth(admin.token) }); if (r.statusCode >= 400) throw Error(r.body); return r.json(); };
const { printer } = await post("/api/printers", { name: "Kitchen printer", kind: "network", connection: "127.0.0.1:9999", paperWidth: 80 });
const { station } = await post("/api/kot-stations", { name: "Hot kitchen", printerId: printer.id });
const { category } = await post("/api/categories", { name: "Food" });
for (const [name, pricePaise] of [["Paneer tikka", 24000], ["Butter chicken", 38000], ["Butter naan", 6000]] as const) {
  await post("/api/products", { name, categoryId: category.id, pricePaise, gstRate: 5, isVeg: true, kotStationId: station.id });
}
await post("/api/products", { name: "Mineral water", categoryId: category.id, pricePaise: 2000, gstRate: 18, isVeg: true, kotStationId: null });
for (let n = 1; n <= 4; n++) await post("/api/tables", { name: `T${n}`, area: "Dining", sortOrder: n });
await app.listen({ host: "127.0.0.1", port: 4153 });
const close = async () => { await app.close(); app.db.close(); process.exit(0); };
process.on("SIGINT", () => void close()); process.on("SIGTERM", () => void close());
console.log("Hold order fixture: http://127.0.0.1:4153/ - admin 1234, cashier 2345, waiter 3456");
