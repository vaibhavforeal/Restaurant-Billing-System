import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import fastifyStatic from "@fastify/static";
import { uuidv7 } from "@masalapos/domain";
import { freshAppWithFakeSink, setupAdmin, auth, enableIntegration } from "../../apps/server/src/test-helpers.js";
import worker from "../../apps/licensing-worker/src/index.js";
import { seedCustomer, seedOrder } from "../../apps/licensing-worker/src/testing/fixtures.js";
import { activation, keyPair, send, testEnv, withSecret } from "../../apps/licensing-worker/src/testing/harness.js";
import { TEST_SECRET } from "../../apps/licensing-worker/src/testing/secret.js";
import { createApp } from "../../apps/licensing-node/src/app.js";

// The AI assistant end to end, all on 127.0.0.1 (start tools/e2e/fake-openrouter.mts first):
// - 4162: the real licensing service (Worker code on the Node adapter), whose AI relay calls the fake OpenRouter on 4161 with a vendor key.
// - 4160: a disposable restaurant connected to it as an enrolled counter. A customer, Priya Sharma, is on the bills so the gate can check
//   her details never reach the provider.
// - 4163: QA switches standing in for the portal: POST /__qa/ai?enabled=1&limit=40, and POST /__qa/service-offline to stop 4162.
const keys = keyPair();
const env = testEnv(keys.privatePem, { OPENROUTER_API_KEY: "sk-or-v1-vendor-e2e", OPENROUTER_BASE_URL: "http://127.0.0.1:4161/api/v1" });
const installationId = crypto.randomUUID();
const customer = await seedCustomer(env.DB, { name: "Spice Route" });
const order = await seedOrder(env.DB, customer);
const enrolled = await send(env, "POST", "/v1/enroll", { activation: activation(installationId, await keys.fingerprint(), { outletName: "Spice Route Baner" }), customerId: customer.code, orderId: order.code }, withSecret());
if (enrolled.status !== 200) throw new Error(`enrol failed: ${enrolled.status} ${await enrolled.text()}`);
const service: Server = createApp(worker, env).listen(4162, "127.0.0.1");
const setAi = (enabled: boolean, limit: number) => env.DB.prepare(`INSERT INTO ai_settings (installation_id, order_id, enabled, daily_limit, updated_at)
    VALUES (?, (SELECT order_id FROM installations WHERE installation_id = ?), ?, ?, ?)
  ON CONFLICT(installation_id) DO UPDATE SET order_id = excluded.order_id, enabled = excluded.enabled, daily_limit = excluded.daily_limit, updated_at = excluded.updated_at`)
  .bind(installationId, installationId, enabled ? 1 : 0, limit, Date.now()).run();

createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1:4163");
  const done = (body: unknown) => { res.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*" }); res.end(JSON.stringify(body)); };
  if (url.pathname === "/__qa/ai") void setAi(url.searchParams.get("enabled") === "1", Number(url.searchParams.get("limit") ?? 40)).then(() => done({ ok: true }));
  else if (url.pathname === "/__qa/service-offline") { service.closeAllConnections(); service.close(); done({ offline: true }); }
  else { res.writeHead(404); res.end(); }
}).listen(4163, "127.0.0.1");

const { app } = freshAppWithFakeSink({ ai: { dataDir: mkdtempSync(join(tmpdir(), "masalapos-ai-")), service: { serviceUrl: "http://127.0.0.1:4162", installationId, installationSecret: TEST_SECRET } } });
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
const { customer: guest } = await call("POST", "/api/customers", { name: "Priya Sharma", phone: "98765 43210" });
for (const lines of [[[paneer, 3], [naan, 4]], [[paneer, 1]]] as Array<Array<[string, number]>>) {
  const { order: bill } = await call("POST", "/api/orders", { type: "parcel", clientRef: uuidv7() });
  await call("POST", `/api/orders/${bill.id}/items`, { items: lines.map(([productId, qty]) => ({ clientRef: uuidv7(), productId, qty })) });
  await call("PATCH", `/api/orders/${bill.id}/customer`, { customerId: guest.id });
  const { preview } = await call("POST", `/api/orders/${bill.id}/bill-preview`, {});
  await call("POST", `/api/orders/${bill.id}/bill`, { clientRef: uuidv7(), previewKey: preview.previewKey });
}
await app.listen({ host: "127.0.0.1", port: 4160 });
const close = async () => { await app.close(); app.db.close(); process.exit(0); };
process.on("SIGINT", () => void close()); process.on("SIGTERM", () => void close());
console.log("AI assistant fixture: http://127.0.0.1:4160/ - admin / admin-password (AI off until /__qa/ai switches it on)");
