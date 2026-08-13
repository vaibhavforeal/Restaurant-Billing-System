import { MIGRATIONS, migrate, openDb } from "@forkflow/domain";
import fastifyStatic from "@fastify/static";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildServer } from "./server.js";

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = resolve(process.env["FORKFLOW_DATA_DIR"] ?? "./data");
mkdirSync(dataDir, { recursive: true });

const db = openDb(join(dataDir, "forkflow.db"));
migrate(db, MIGRATIONS);

const app = buildServer({ db });

// Serve the built UI when it exists (production / packaged). In dev, Vite serves the UI.
const uiDist = resolve(here, "../../ui/dist");
if (existsSync(uiDist)) {
  await app.register(fastifyStatic, { root: uiDist, wildcard: false });
  app.setNotFoundHandler((req, reply) => {
    if (req.method === "GET" && !req.url.startsWith("/api/")) {
      return reply.sendFile("index.html");
    }
    return reply.status(404).send({ error: "not found" });
  });
}

const PORT = Number(process.env["FORKFLOW_PORT"] ?? 4100);
await app.listen({ host: "0.0.0.0", port: PORT });
console.log(`ForkFlow server on http://localhost:${PORT} (db: ${join(dataDir, "forkflow.db")})`);
