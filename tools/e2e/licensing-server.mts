// Disposable commercial server. Its signing key stays in memory and is never bundled.
// Run: node --import tsx tools/e2e/licensing-server.mts
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import fastifyStatic from "@fastify/static";
import { MIGRATIONS, PLANS, migrate, openDb } from "../../packages/domain/src/index.js";
import { buildServer } from "../../apps/server/src/server.js";
import { Backups } from "../../apps/server/src/backups.js";

const dataDir = resolve('.e2e-scratch', `licensing-${Date.now()}`);
mkdirSync(dataDir, { recursive: true });
const clockFile = join(dataDir, "clock-offset.txt"); writeFileSync(clockFile, "0", { flag: "wx" });
const keys = generateKeyPairSync("ed25519"), now = Date.now(), installationId = randomUUID();
const identity = { version: 1, licenseId: randomUUID(), organizationId: randomUUID(), outletId: randomUUID(), installationId };
function grant(revision: number, plan: "basic" | "pro", extended = false) {
  const claims = { ...identity, revision, plan, maxDevices: PLANS[plan].maxDevices, features: PLANS[plan].features,
    issuedAt: now - 1000, expiresAt: now + (extended ? 172800000 : 3600000), graceUntil: now + (extended ? 259200000 : 7200000) };
  const message = `ff1.${Buffer.from(JSON.stringify(claims)).toString("base64url")}`;
  return `${message}.${sign(null, Buffer.from(message), keys.privateKey).toString("base64url")}`;
}
const fixtures = { pro: grant(1, "pro"), basic: grant(2, "basic"), upgrade: grant(3, "pro"), renewal: grant(4, "pro", true), installationId };
writeFileSync(join(dataDir, "browser-fixtures.js"), `window.__licenseFixtures = ${JSON.stringify(fixtures)}; "License fixtures loaded";\n`);
const db = openDb(join(dataDir, "forkflow.db")); migrate(db, MIGRATIONS);
const app = buildServer({ db, backups: new Backups(db, dataDir), port: 4128, logger: { level: "warn" }, licensing: {
  publicKey: keys.publicKey.export({ type: "spki", format: "pem" }).toString(), installationId,
  now: () => Date.now() + Number(readFileSync(clockFile, "utf8").trim().replace(/^\uFEFF/, "")),
} });
await app.register(fastifyStatic, { root: resolve("apps/ui/dist") });
app.setNotFoundHandler((req, reply) => req.method === "GET" && !req.url.startsWith("/api/") ? reply.sendFile("index.html") : reply.status(404).send({ error: "not found" }));
app.addHook("onClose", () => db.close());
process.on("SIGINT", () => { void app.close(); });
process.on("SIGTERM", () => { void app.close(); });
await app.listen({ host: "127.0.0.1", port: 4128 });
console.log(`Commercial QA server: http://127.0.0.1:4128\nFixtures: ${join(dataDir, "browser-fixtures.js")}\nClock offset: ${clockFile}`);
