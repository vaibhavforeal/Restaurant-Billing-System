import { freshAppWithFakeSink, setupAdmin, auth } from "../../apps/server/src/test-helpers.js";
import fastifyStatic from "@fastify/static";
import { resolve } from "node:path";

// Disposable in-memory restaurant; printing is captured and never reaches hardware.
const { app, fake } = freshAppWithFakeSink();
await app.register(fastifyStatic, { root: resolve("apps/ui/dist") });
app.setNotFoundHandler((req, reply) => req.method === "GET" && !req.url.startsWith("/api/") ? reply.sendFile("index.html") : reply.code(404).send({ error: "not found" }));
app.get("/__qa/prints", async () => ({ prints: fake.sent.map((p) => p.bytes.toString("base64")) }));
const admin = await setupAdmin(app);
const post = async (url: string, payload: object) => {
  const res = await app.inject({ method: "POST", url, payload, headers: auth(admin.token) });
  if (res.statusCode >= 400) throw new Error(res.body);
  return res.json();
};
const { category } = await post("/api/categories", { name: "Meals" });
await post("/api/products", { name: "Lunch meal", categoryId: category.id, pricePaise: 12345, gstRate: 5, kotStationId: null });
await post("/api/printers", { name: "Receipt 58mm", kind: "network", connection: "127.0.0.1:9999", paperWidth: 58 });
await post("/api/printers", { name: "Receipt 80mm", kind: "network", connection: "127.0.0.1:9999", paperWidth: 80 });
await app.listen({ host: "127.0.0.1", port: 4147 });
const close = async () => { await app.close(); app.db.close(); process.exit(0); };
process.on("SIGINT", () => void close()); process.on("SIGTERM", () => void close());
console.log("UPI fixture: http://127.0.0.1:4147/ — admin PIN 1234");
