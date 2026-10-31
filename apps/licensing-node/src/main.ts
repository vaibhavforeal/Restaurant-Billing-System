// Entry point: reads the configuration from the environment, opens the SQLite file (running any new migrations) and starts serving.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import worker from "../../licensing-worker/src/index.js";
import type { Env } from "../../licensing-worker/src/env.js";
import { createApp } from "./app.js";
import { directoryAssets } from "./assets.js";
import { memoryLimiter } from "./limiter.js";
import { readSecret } from "./secrets.js";
import { fileD1 } from "./sqlite-d1.js";

const here = dirname(fileURLToPath(import.meta.url));
const config = process.env;

const secret = (name: string) => readSecret(config, name);

const values = {
  LICENSE_SIGNING_KEY: secret("LICENSE_SIGNING_KEY"),
  RAZORPAY_KEY_ID: secret("RAZORPAY_KEY_ID"),
  RAZORPAY_KEY_SECRET: secret("RAZORPAY_KEY_SECRET"),
  RAZORPAY_WEBHOOK_SECRET: secret("RAZORPAY_WEBHOOK_SECRET"),
};
const publicOrigin = config["PUBLIC_ORIGIN"];
const missing = [...Object.entries(values).filter(([, value]) => !value).map(([name]) => name), ...(publicOrigin ? [] : ["PUBLIC_ORIGIN"])];
if (missing.length) { console.error(`licensing-node: missing configuration: ${missing.join(", ")}`); process.exit(1); }

const dataDir = config["DATA_DIR"] ?? "./data";
const { d1, db, applied } = fileD1(join(dataDir, "licensing.db"), config["MIGRATIONS_DIR"] ?? join(here, "migrations"));
if (applied.length) console.log(`licensing-node: applied migrations: ${applied.join(", ")}`);

// The same limits wrangler.jsonc gives the Cloudflare bindings.
const env: Env = {
  DB: d1,
  LIMITER: memoryLimiter(20, 60),
  LOGIN_LIMITER: memoryLimiter(10, 60),
  ASSETS: directoryAssets(config["PORTAL_DIST"] ?? join(here, "web")),
  ...(values as { LICENSE_SIGNING_KEY: string; RAZORPAY_KEY_ID: string; RAZORPAY_KEY_SECRET: string; RAZORPAY_WEBHOOK_SECRET: string }),
};

const port = Number(config["PORT"] ?? 8787);
// Loopback only: Caddy is the one public door, so nothing can reach this port (or spoof X-Forwarded-For) from outside.
const server = createApp(worker, env, { publicOrigin: publicOrigin as string }).listen(port, config["HOST"] ?? "127.0.0.1", () => console.log(`licensing-node: listening on port ${port}`));

function shutdown() {
  console.log("licensing-node: shutting down");
  server.close(() => { db.close(); process.exit(0); });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
