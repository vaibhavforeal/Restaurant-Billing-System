import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freshAppWithFakeSink, setupAdmin, auth, enableIntegration } from "../../apps/server/src/test-helpers.js";
import fastifyStatic from "@fastify/static";
import { resolve } from "node:path";
import { uuidv7 } from "@masalapos/domain";

// Disposable restaurant on 127.0.0.1:4160 whose AI assistant talks to the fake OpenRouter (tools/e2e/fake-openrouter.mts,
// start it first). A customer, Priya Sharma, is on the bills so the gate can check her details never reach the provider.
const { app } = freshAppWithFakeSink({ ai: { dataDir: mkdtempSync(join(tmpdir(), "masalapos-ai-")), secretKey: randomBytes(32), baseUrl: "http://127.0.0.1:4161/api/v1" } });
await app.register(fastifyStatic, { root: resolve("apps/ui/dist"), setHeaders: (reply) => reply.header("Cache-Control", "no-cache") });
app.setNotFoundHandler((req, reply) => req.method === "GET" && !req.url.startsWith("/api/") ? reply.sendFile("index.html") : reply.code(404).send({ error: "not found" }));
const admin = await setupAdmin(app);
enableIntegration(app, "crm");
const call = async (method: "POST" | "PATCH", url: string, payload: object) => {
  const r = await app.inject({ method, url, payload, headers: auth(admin.token) }); if (r.statusCode >= 400) throw Error(r.body); return r.json();
};
const { category } = await call("POST", "/api/categories", { name: "Starters" });
const paneer = (await call("POST", "/api/products", { name: "Paneer tikka", categoryId: category.id, pricePaise: 24000, gstRate: 5, kotStationId: null })).product.id;
const naan = (await call("POST", "/api/products", { name: "Butter naan", categoryId: category.id, pricePaise: 6000, gstRate: 5, kotStationId: null })).product.id;
const { customer } = await call("POST", "/api/customers", { name: "Priya Sharma", phone: "98765 43210" });
for (const lines of [[[paneer, 3], [naan, 4]], [[paneer, 1]]] as Array<Array<[string, number]>>) {
  const { order } = await call("POST", "/api/orders", { type: "parcel", clientRef: uuidv7() });
  await call("POST", `/api/orders/${order.id}/items`, { items: lines.map(([productId, qty]) => ({ clientRef: uuidv7(), productId, qty })) });
  await call("PATCH", `/api/orders/${order.id}/customer`, { customerId: customer.id });
  const { preview } = await call("POST", `/api/orders/${order.id}/bill-preview`, {});
  await call("POST", `/api/orders/${order.id}/bill`, { clientRef: uuidv7(), previewKey: preview.previewKey });
}
await app.listen({ host: "127.0.0.1", port: 4160 });
const close = async () => { await app.close(); app.db.close(); process.exit(0); };
process.on("SIGINT", () => void close()); process.on("SIGTERM", () => void close());
console.log("AI assistant fixture: http://127.0.0.1:4160/ - admin / admin-password");
