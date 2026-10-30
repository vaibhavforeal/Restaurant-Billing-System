// Disposable commercial server. Its signing key stays in memory and is never bundled.
// Run: node --import tsx tools/e2e/licensing-server.mts
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import fastifyStatic from "@fastify/static";
import { MIGRATIONS, PLANS, migrate, openDb, planModules } from "../../packages/domain/src/index.js";
import { buildServer } from "../../apps/server/src/server.js";
import { Backups } from "../../apps/server/src/backups.js";

const dataDir = resolve('.e2e-scratch', `licensing-${Date.now()}`);
mkdirSync(dataDir, { recursive: true });
const clockFile = join(dataDir, "clock-offset.txt"); writeFileSync(clockFile, "0", { flag: "wx" });
// Fixed test values; the codes are valid portal codes (their check characters match).
const installationSecret = "0123456789abcdef".repeat(4), customerCode = "FC-7M3N-9QK", orderCode = "FO-2X8H-PDD";
const keys = generateKeyPairSync("ed25519"), now = Date.now(), installationId = randomUUID();
const identity = { version: 1, licenseId: randomUUID(), organizationId: randomUUID(), outletId: randomUUID(), installationId };
function grant(revision: number, plan: "basic" | "pro", extended = false, trial = false, codes = false) {
  const expiresAt = now + (extended ? 172800000 : 3600000);
  const claims = { ...identity, revision, plan, maxDevices: PLANS[plan].maxDevices, features: PLANS[plan].features, modules: planModules(plan),
    issuedAt: now - 1000, expiresAt, graceUntil: trial ? expiresAt : now + (extended ? 259200000 : 7200000), ...(trial ? { trial: true } : {}),
    ...(codes ? { customerCode, orderCode } : {}) };
  const message = `ff1.${Buffer.from(JSON.stringify(claims)).toString("base64url")}`;
  return `${message}.${sign(null, Buffer.from(message), keys.privateKey).toString("base64url")}`;
}
const fixtures = { pro: grant(1, "pro"), basic: grant(2, "basic"), upgrade: grant(3, "pro"), renewal: grant(7, "pro", true),
  // What the fake licensing service hands out, newer than the revision-3 upgrade: a trial, the paid order it moves to, and a renewal.
  // All expire within the hour (the trial one has no grace, like a real trial) so licensing-recovery.js can still expire them with its
  // three-hour clock offset and renew with `renewal`.
  trialFromService: grant(4, "pro", false, true, true), enrolledFromService: grant(5, "pro", false, false, true), renewalFromService: grant(6, "pro", false, false, true),
  installationId, installationSecret, customerCode, orderCode };
writeFileSync(join(dataDir, "browser-fixtures.js"), `window.__licenseFixtures = ${JSON.stringify(fixtures)}; "License fixtures loaded";\n`);
// Fake licensing service, shaped like the real Worker. /v1/activate and /v1/enroll need the installation secret header (401 without it).
// Activate answers with the next queued licence (or "none yet"). Enroll answers the fixture Customer ID and Order ID with the paid order's
// licence and anything else with the Worker's 404. The browser script fills the queue and can stop the service through the two
// /__fake-service routes below.
const serviceUrl = "http://127.0.0.1:4129", queued: string[] = [];
let enrolled = false;
const readBody = (req: IncomingMessage) => new Promise<string>((done) => { let text = ""; req.on("data", (chunk) => { text += chunk; }); req.on("end", () => done(text)); });
const answer = (res: ServerResponse, status: number, body: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
const service: Server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", serviceUrl);
  if (req.method !== "POST" || (url.pathname !== "/v1/activate" && url.pathname !== "/v1/enroll")) { res.writeHead(404).end(); return; }
  const body = await readBody(req);
  if (req.headers["x-forkflow-installation-secret"] !== installationSecret) return answer(res, 401, { error: "unauthorized" });
  if (url.pathname === "/v1/activate") return answer(res, 200, { license: queued.shift() ?? null, enrolled });
  let codes: { customerId?: unknown; orderId?: unknown } = {};
  try { codes = JSON.parse(body) as typeof codes; } catch { /* an unreadable body names no order */ }
  if (codes.customerId !== customerCode || codes.orderId !== orderCode) return answer(res, 404, { error: "not_found", message: "Check the Customer ID and Order ID." });
  enrolled = true;
  answer(res, 200, { license: fixtures.enrolledFromService, customer: { code: customerCode, name: "Spice Route" }, order: { code: orderCode, plan: "pro", trial: false, expiresAt: now + 3600000 } });
});
await new Promise<void>((resolveListen) => service.listen(4129, "127.0.0.1", resolveListen));
const db = openDb(join(dataDir, "forkflow.db")); migrate(db, MIGRATIONS);
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
