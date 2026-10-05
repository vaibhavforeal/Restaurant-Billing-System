// Disposable browser fixture: real host discovery, captured print output, no physical printing.
import { resolve } from "node:path";
import fastifyStatic from "@fastify/static";
import { MIGRATIONS, migrate, openDb } from "@forkflow/domain";
import { buildServer } from "../../apps/server/src/server.js";
import { makeFakeSink } from "../../apps/server/src/print/sinks.js";
const db = openDb(":memory:"); migrate(db, MIGRATIONS);
const fake = makeFakeSink();
const app = buildServer({ db, sinkSend: fake.send });
await app.register(fastifyStatic, { root: resolve("apps/ui/dist"), wildcard: true });
app.setNotFoundHandler((req, reply) => req.url.startsWith("/api/") ? reply.status(404).send({ error: "not found" }) : reply.sendFile("index.html"));
app.get("/__qa/prints", { preHandler: app.requirePermission("printers.manage") }, async () => ({
  prints: fake.sent.map(entry => ({ connection: entry.target.connection, hex: entry.bytes.toString("hex"), text: entry.bytes.toString() })),
}));
const setup = await app.inject({ method: "POST", url: "/api/setup", payload: { restaurantName: "Printer QA Cafe", adminName: "Printer Admin", pin: "1234" } });
const headers = { authorization: `Bearer ${setup.json().token}` };
const create = await app.inject({ method: "POST", url: "/api/printers", headers,
  payload: { name: "Counter thermal", kind: "network", connection: "127.0.0.1:9100", paperWidth: 80 } });
const printer = create.json().printer;
const job = app.printQueue.enqueue(printer, "receipt", "Interrupted sample", Buffer.from("sample"));
db.prepare("UPDATE print_jobs SET status = 'unknown', job_json = ? WHERE id = ?").run(JSON.stringify({ ...job, status: "unknown", error: "Interrupted test job. Check paper." }), job.id);
await app.listen({ host: "127.0.0.1", port: 4153 });
const close = async () => { await app.close(); db.close(); process.exit(0); };
process.on("SIGINT", () => void close()); process.on("SIGTERM", () => void close());
console.log("Printer QA ready at http://127.0.0.1:4153 — PIN 1234; all printing is captured.");
