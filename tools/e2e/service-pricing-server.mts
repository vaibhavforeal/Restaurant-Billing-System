import { freshAppWithFakeSink, setupAdmin, auth } from "../../apps/server/src/test-helpers.js";
import fastifyStatic from "@fastify/static";
import { resolve } from "node:path";

const { app } = freshAppWithFakeSink();
await app.register(fastifyStatic, { root: resolve("apps/ui/dist") });
app.setNotFoundHandler((req, reply) => req.method === "GET" && !req.url.startsWith("/api/") ? reply.sendFile("index.html") : reply.code(404).send({ error: "not found" }));
const admin = await setupAdmin(app);
const post = async (url: string, payload: object) => {
  const res = await app.inject({ method: "POST", url, payload, headers: auth(admin.token) });
  if (res.statusCode >= 400) throw new Error(res.body);
  return res.json();
};
const { category } = await post("/api/categories", { name: "Meals" });
await post("/api/products", { name: "Paneer biryani", categoryId: category.id, pricePaise: 18000, acPricePaise: 22000, takeawayPricePaise: 19000, gstRate: 5,
  variants: [{ name: "Half", pricePaise: 10000, acPricePaise: 12000, takeawayPricePaise: 11000 }] });
await post("/api/products", { name: "Lime soda", categoryId: category.id, pricePaise: 4000, acPricePaise: 5000, takeawayPricePaise: 4500, gstRate: 5 });
await post("/api/tables", { name: "AC 1", area: "Indoor", priceTier: "ac" });
await post("/api/tables", { name: "Garden 1", area: "Garden", priceTier: "non_ac" });
await app.listen({ host: "127.0.0.1", port: 4148 });
const close = async () => { await app.close(); app.db.close(); process.exit(0); };
process.on("SIGINT", () => void close()); process.on("SIGTERM", () => void close());
console.log("Pricing fixture: http://127.0.0.1:4148/ - admin PIN 1234");
