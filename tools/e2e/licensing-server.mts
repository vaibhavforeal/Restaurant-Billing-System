// Disposable commercial server. Its signing key stays in memory and is never bundled.
// Run: node --import tsx tools/e2e/licensing-server.mts
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import fastifyStatic from "@fastify/static";
import { MIGRATIONS, PLANS, migrate, openDb } from "../../packages/domain/src/index.js";
import { buildServer } from "../../apps/server/src/server.js";
import { Backups } from "../../apps/server/src/backups.js";
import { subscribePage } from "../../apps/licensing-worker/src/subscribe-page.js";

const dataDir = resolve('.e2e-scratch', `licensing-${Date.now()}`);
mkdirSync(dataDir, { recursive: true });
const clockFile = join(dataDir, "clock-offset.txt"); writeFileSync(clockFile, "0", { flag: "wx" });
// Fixed test values; the session token is 43 base64url characters like a real one.
const installationSecret = "0123456789abcdef".repeat(4), sessionToken = "e2e".padEnd(43, "x");
const keys = generateKeyPairSync("ed25519"), now = Date.now(), installationId = randomUUID();
const identity = { version: 1, licenseId: randomUUID(), organizationId: randomUUID(), outletId: randomUUID(), installationId };
function grant(revision: number, plan: "basic" | "pro", extended = false, trial = false) {
  const expiresAt = now + (extended ? 172800000 : 3600000);
  const claims = { ...identity, revision, plan, maxDevices: PLANS[plan].maxDevices, features: PLANS[plan].features,
    issuedAt: now - 1000, expiresAt, graceUntil: trial ? expiresAt : now + (extended ? 259200000 : 7200000), ...(trial ? { trial: true } : {}) };
  const message = `ff1.${Buffer.from(JSON.stringify(claims)).toString("base64url")}`;
  return `${message}.${sign(null, Buffer.from(message), keys.privateKey).toString("base64url")}`;
}
const fixtures = { pro: grant(1, "pro"), basic: grant(2, "basic"), upgrade: grant(3, "pro"), renewal: grant(6, "pro", true),
  // What the fake licensing service hands out, newer than the revision-3 upgrade. Both expire within the hour (the trial one has
  // no grace, like a real trial) so licensing-recovery.js can still expire them with its three-hour clock offset and renew with `renewal`.
  trialFromService: grant(4, "pro", false, true), renewalFromService: grant(5, "pro"), installationId, installationSecret, sessionToken };
writeFileSync(join(dataDir, "browser-fixtures.js"), `window.__licenseFixtures = ${JSON.stringify(fixtures)}; "License fixtures loaded";\n`);
// Fake licensing service, shaped like the real Worker. /v1/activate and /v1/subscribe-sessions need the installation secret header (401 without
// it). Activate answers with the next queued licence (or "none yet") and registers the installation; subscribe-sessions answers 404 until the
// installation is registered, then hands out one fixed session token. GET /subscribe serves the Worker's real checkout page (minus the Razorpay
// script, so the check makes no third-party request) and POST /v1/subscriptions always answers 401 session_expired, so licensing-expired-link.js
// can check the expired-link behaviour in a browser. The browser script fills the queue and can stop the service through the two
// /__fake-service routes below.
const serviceUrl = "http://127.0.0.1:4129", queued: string[] = [];
let registered = false;
const readBody = (req: IncomingMessage) => new Promise<string>((done) => { let text = ""; req.on("data", (chunk) => { text += chunk; }); req.on("end", () => done(text)); });
const answer = (res: ServerResponse, status: number, body: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
const service: Server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", serviceUrl);
  if (req.method === "GET" && url.pathname === "/subscribe") {
    const session = url.searchParams.get("session") ?? "", valid = session === sessionToken;
    res.writeHead(valid ? 200 : 404, { "content-type": "text/html; charset=utf-8" });
    res.end(subscribePage(session, valid).replace(/<script src="https:\/\/checkout\.razorpay\.com[^>]*><\/script>/, ""));
    return;
  }
  if (req.method !== "POST") { res.writeHead(404).end(); return; }
  const body = await readBody(req);
  if (url.pathname === "/v1/subscriptions") return answer(res, 401, { error: "session_expired" });
  if (url.pathname !== "/v1/activate" && url.pathname !== "/v1/subscribe-sessions") { res.writeHead(404).end(); return; }
  if (req.headers["x-masalapos-installation-secret"] !== installationSecret) return answer(res, 401, { error: "unauthorized" });
  let requested: unknown;
  try { requested = (JSON.parse(body) as { installationId?: unknown }).installationId; } catch { /* an unreadable body names no installation */ }
  if (url.pathname === "/v1/activate") { registered ||= requested === installationId; return answer(res, 200, { license: queued.shift() ?? null }); }
  if (!registered || requested !== installationId) return answer(res, 404, { error: "unknown_installation" });
  answer(res, 200, { session: sessionToken, expiresAt: Date.now() + 30 * 60_000 });
});
await new Promise<void>((resolveListen) => service.listen(4129, "127.0.0.1", resolveListen));
const db = openDb(join(dataDir, "masalapos.db")); migrate(db, MIGRATIONS);
const app = buildServer({ db, backups: new Backups(db, dataDir), port: 4128, logger: { level: "warn" }, licensing: {
  publicKey: keys.publicKey.export({ type: "spki", format: "pem" }).toString(), installationId, serviceUrl,
  installationSecret,
  now: () => Date.now() + Number(readFileSync(clockFile, "utf8").trim().replace(/^\uFEFF/, "")),
} });
app.post("/__fake-service/queue", async (req) => { queued.push(...(req.body as { licenses: string[] }).licenses); return { queued: queued.length }; });
app.post("/__fake-service/stop", async () => { service.close(); service.closeAllConnections(); return { stopped: true }; });
await app.register(fastifyStatic, { root: resolve("apps/ui/dist") });
app.setNotFoundHandler((req, reply) => req.method === "GET" && !req.url.startsWith("/api/") ? reply.sendFile("index.html") : reply.status(404).send({ error: "not found" }));
app.addHook("onClose", () => { service.close(); service.closeAllConnections(); db.close(); });
process.on("SIGINT", () => { void app.close(); });
process.on("SIGTERM", () => { void app.close(); });
await app.listen({ host: "127.0.0.1", port: 4128 });
console.log(`Commercial QA server: http://127.0.0.1:4128\nFixtures: ${join(dataDir, "browser-fixtures.js")}\nClock offset: ${clockFile}\nFake licensing service: ${serviceUrl}`);
