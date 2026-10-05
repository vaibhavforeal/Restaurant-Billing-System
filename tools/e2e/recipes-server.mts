// Isolated recipe workflow fixture: in-memory database, signed licenses, fake printer.
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { resolve } from "node:path";
import fastifyStatic from "@fastify/static";
import { MIGRATIONS, PLANS, migrate, openDb } from "../../packages/domain/src/index.js";
import { buildServer } from "../../apps/server/src/server.js";
import { makeFakeSink } from "../../apps/server/src/print/sinks.js";

const db = openDb(":memory:"); migrate(db, MIGRATIONS);
const keys = generateKeyPairSync("ed25519"), now = Date.now(), installationId = randomUUID();
const claims = { version: 1, installationId, organizationId: randomUUID(), outletId: randomUUID(), licenseId: randomUUID(),
  issuedAt: now - 1000, expiresAt: now + 86_400_000, graceUntil: now + 172_800_000 };
function grant(plan: "basic" | "pro", revision: number) {
  const message = `ff1.${Buffer.from(JSON.stringify({ ...claims, revision, plan, maxDevices: PLANS[plan].maxDevices, features: PLANS[plan].features })).toString("base64url")}`;
  return `${message}.${sign(null, Buffer.from(message), keys.privateKey).toString("base64url")}`;
}
const fake = makeFakeSink();
const app = buildServer({ db, sinkSend: fake.send, port: 4155, logger: { level: "warn" },
  licensing: { publicKey: keys.publicKey.export({ type: "spki", format: "pem" }).toString(), installationId } });
await app.register(fastifyStatic, { root: resolve("apps/ui/dist"), setHeaders: (reply) => reply.header("Cache-Control", "no-cache") });
app.setNotFoundHandler((req, reply) => req.method === "GET" && !req.url.startsWith("/api/") ? reply.sendFile("index.html") : reply.code(404).send({ error: "not found" }));
const products: Array<{ id: string; name: string }> = [];
const stocks: Array<{ id: string; name: string }> = [];
app.get("/__qa/recipes", async () => ({ products, stocks, basic: grant("basic", 2), pro: grant("pro", 3) }));
app.addHook("onClose", () => db.close());
const headers = { "x-forkflow-device": "a".repeat(64), authorization: "" };
const setup = await app.inject({ method: "POST", url: "/api/setup", headers, payload: { restaurantName: "Recipe QA Cafe", adminName: "Test Admin", pin: "1234" } });
if (setup.statusCode !== 201) throw new Error(setup.body);
headers.authorization = `Bearer ${setup.json().token}`;
app.licensing.activate(grant("pro", 1));
async function post(url: string, payload: object) {
  const result = await app.inject({ method: "POST", url, headers, payload });
  if (result.statusCode >= 400) throw new Error(result.body);
  return result.json();
}
await post("/api/license/devices", { name: "Fixture counter" });
await post("/api/users", { name: "Cashier", pin: "2345", role: "cashier" });
const { category } = await post("/api/categories", { name: "Main course" });
for (const name of ["Vegetable biryani", "Jeera rice", "Dal tadka", "Paneer butter masala", "Butter naan", "Masala tea", "Sweet lassi", "Gulab jamun"]) {
  products.push((await post("/api/products", { name, categoryId: category.id, pricePaise: 12000, gstRate: 5, kotStationId: null,
    ...(name === "Vegetable biryani" ? { variants: [{ name: "Regular", pricePaise: 12000 }, { name: "Large", pricePaise: 18000 }] } : {}) })).product);
}
for (const [name, unit, openingQty] of [["Rice", "kg", 25], ["Oil", "L", 8], ["Salt", "g", 500], ["Packaging", "pcs", 100], ["Archived spice", "g", 0]] as const) {
  stocks.push((await post("/api/stock-items", { clientRef: randomUUID(), name, unit, openingQty })).item);
}
await app.inject({ method: "PATCH", url: `/api/stock-items/${stocks[4].id}`, headers, payload: { expectedVersion: 0, isActive: false } });
await app.inject({ method: "PUT", url: `/api/products/${products[0].id}/recipe`, headers, payload: { expectedVersion: 0,
  ingredients: [{ stockItemId: stocks[0].id, qtyPerSale: 0.25 }, { stockItemId: stocks[1].id, qtyPerSale: 0.015 }, { stockItemId: stocks[2].id, qtyPerSale: 2 }] } });
process.on("SIGINT", () => { void app.close(); });
process.on("SIGTERM", () => { void app.close(); });
await app.listen({ host: "127.0.0.1", port: 4155 });
console.log("Recipe QA: http://127.0.0.1:4155 — admin 1234, cashier 2345");
