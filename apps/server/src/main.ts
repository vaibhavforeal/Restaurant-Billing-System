import { openDb } from "@forkflow/domain";
import fastifyStatic from "@fastify/static";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { lockDataDirectory } from "./data-lock.js";
import { buildServer } from "./server.js";
import { redactUrl } from "./log-redact.js";
import { Backups } from "./backups.js";
import { prepareDatabase } from "./startup.js";
import { restoreDatabase } from "./recovery.js";

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = resolve(process.env["FORKFLOW_DATA_DIR"] ?? "./data");
const port = Number(process.env["FORKFLOW_PORT"] ?? 4100);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid FORKFLOW_PORT");
mkdirSync(dataDir, { recursive: true });
const release = await lockDataDirectory(dataDir);
let db: ReturnType<typeof openDb> | undefined;
let closing = false;
try {
  restoreDatabase(dataDir);
  if (process.env["FORKFLOW_RESTORE"]) restoreDatabase(dataDir, resolve(process.env["FORKFLOW_RESTORE"]));
  db = openDb(join(dataDir, "forkflow.db"));
  const backups = new Backups(db, dataDir);
  const version = process.env["FORKFLOW_APP_VERSION"] ?? "development";
  prepareDatabase(db, backups, version);
  const generationPath = join(dataDir, "recovery-generation.json");
  const generation = existsSync(generationPath) ? JSON.parse(readFileSync(generationPath, "utf8")).generation as string : "initial";
  const app = buildServer({ db, backups, port, generation, instanceId: process.env["FORKFLOW_INSTANCE_ID"] ?? "standalone", logger: {
    serializers: { req: (req: { method: string; url: string }) => ({ method: req.method, url: redactUrl(req.url) }) },
  } });
  const daily = () => { try { backups.daily(); } catch (error) { app.log.error(error, "Daily backup failed; see Settings"); } };
  daily();
  const timer = setInterval(daily, 60 * 60 * 1000); timer.unref();
  app.addHook("onClose", async () => { clearInterval(timer); db?.close(); await release(); });
  const uiDist = process.env["FORKFLOW_UI_DIR"] ?? resolve(here, "../../ui/dist");
  if (existsSync(uiDist)) {
    await app.register(fastifyStatic, { root: uiDist, wildcard: true });
    app.setNotFoundHandler((req, reply) => {
      if (req.method === "GET" && !req.url.startsWith("/api/") && !req.url.startsWith("/assets/")) return reply.sendFile("index.html");
      return reply.status(404).send({ error: "not found" });
    });
  }
  const close = async () => { if (closing) return; closing = true; await app.close(); };
  process.on("SIGTERM", () => { void close(); });
  process.on("SIGINT", () => { void close(); });
  const parent = (process as unknown as { parentPort?: { on(event: string, fn: (event: { data: unknown }) => void): void } }).parentPort;
  parent?.on("message", ({ data }) => { if (data === "shutdown") void close().then(() => process.exit(0)); });
  await app.listen({ host: "0.0.0.0", port });
  console.log(`ForkFlow server on http://localhost:${port} (db: ${join(dataDir, "forkflow.db")})`);
} catch (error) {
  if (db?.open) db.close();
  await release().catch(() => {});
  throw error;
}
