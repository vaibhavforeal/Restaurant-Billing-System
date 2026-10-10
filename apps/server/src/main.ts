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
import { licenseConfig } from "./license-config.js";
import { loadCaptainHttps, startCaptainHttps, type CaptainHttpsInfo } from "./captain-https.js";
import { seedDemo } from "./demo-seed.js";
import { makeFakeSink } from "./print/sinks.js";

declare const __FORKFLOW_DEMO__: boolean;
const demo = typeof __FORKFLOW_DEMO__ !== "undefined" && __FORKFLOW_DEMO__;

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
  const licensing = demo ? undefined : licenseConfig(dataDir);
  let captainTls: ReturnType<typeof loadCaptainHttps> = null;
  const captainInfo: CaptainHttpsInfo = { enabled: false };
  try { captainTls = loadCaptainHttps(dataDir); if (captainTls) Object.assign(captainInfo, captainTls.info); }
  catch (error) { captainInfo.error = error instanceof Error ? error.message : "Captain HTTPS configuration could not be loaded"; }
  const app = buildServer({ db, backups, port, generation, demo, ...(demo ? { sinkSend: makeFakeSink().send } : {}), captainHttps: captainInfo, ...(licensing ? { licensing } : {}), instanceId: process.env["FORKFLOW_INSTANCE_ID"] ?? "standalone", logger: {
    serializers: { req: (req: { method: string; url: string }) => ({ method: req.method, url: redactUrl(req.url) }) },
  } });
  const daily = () => { try { backups.daily(); } catch (error) { app.log.error(error, "Daily backup failed; see Settings"); } };
  let closeCaptain: (() => Promise<void>) | undefined;
  app.addHook("preClose", async () => { await closeCaptain?.(); });
  daily();
  const timer = setInterval(daily, 60 * 60 * 1000); timer.unref();
  let stopRenewals: (() => void) | undefined;
  app.addHook("onClose", async () => { clearInterval(timer); stopRenewals?.(); db?.close(); await release(); });
  const uiDist = process.env["FORKFLOW_UI_DIR"] ?? resolve(here, "../../ui/dist");
  if (existsSync(uiDist)) {
    await app.register(fastifyStatic, { root: uiDist, wildcard: true, setHeaders: (response, filePath) => {
      if (filePath.endsWith("sw.js") || filePath.endsWith("index.html") || filePath.endsWith("manifest.webmanifest")) response.header("Cache-Control", "no-cache");
    } });
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
  if (demo) await seedDemo(app);
  await app.listen({ host: "0.0.0.0", port });
  // Billing never waits on the licensing service: this only fetches in the background and logs failures.
  if (!demo) stopRenewals = app.licensing.startRenewalChecks((message) => app.log.warn(message));
  if (captainTls) {
    try {
      if (captainTls.port === port) throw new Error("Captain HTTPS must use a different port from the desktop POS");
      const captain = await startCaptainHttps(app, { ...captainTls, info: captainInfo });
      closeCaptain = captain.close;
      app.log.info(`Captain HTTPS ready on port ${captainTls.port}`);
    } catch (error) { captainInfo.error = error instanceof Error ? error.message : "Captain HTTPS could not start"; app.log.error(captainInfo.error); }
  }
  console.log(`ForkFlow server on http://localhost:${port} (db: ${join(dataDir, "forkflow.db")})`);
} catch (error) {
  if (db?.open) db.close();
  await release().catch(() => {});
  throw error;
}
