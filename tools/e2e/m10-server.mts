// Disposable signed-Pro M10 fixture. Build the UI, then run: node --import tsx tools/e2e/m10-server.mts
import { generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import fastifyStatic from "@fastify/static";
import { MIGRATIONS, PLANS, migrate, openDb } from "@forkflow/domain";
import { Backups } from "../../apps/server/src/backups.js";
import { makeFakeSink } from "../../apps/server/src/print/sinks.js";
import { buildServer } from "../../apps/server/src/server.js";

export async function createM10Fixture() {
  const scratchRoot = resolve(".e2e-scratch");
  mkdirSync(scratchRoot, { recursive: true });
  const dataDir = mkdtempSync(join(scratchRoot, "m10-"));
  const db = openDb(join(dataDir, "forkflow.db"));
  migrate(db, MIGRATIONS);
  const keys = generateKeyPairSync("ed25519");
  const installationId = randomUUID();
  const identity = { version: 1, licenseId: randomUUID(), organizationId: randomUUID(), outletId: randomUUID(), installationId };
  const now = Date.now();
  const grant = (revision: number, plan: "pro" | "basic") => {
    const claims = { ...identity, revision, plan, maxDevices: PLANS[plan].maxDevices, features: PLANS[plan].features,
      issuedAt: now - 1000, expiresAt: now + 86_400_000, graceUntil: now + 2 * 86_400_000 };
    const message = `ff1.${Buffer.from(JSON.stringify(claims)).toString("base64url")}`;
    return `${message}.${sign(null, Buffer.from(message), keys.privateKey).toString("base64url")}`;
  };
  const proLicense = grant(1, "pro");
  const basicLicense = grant(2, "basic");
  const browserDevice = randomBytes(32).toString("hex");
  const fake = makeFakeSink();
  const app = buildServer({ db, backups: new Backups(db, dataDir), port: 4121, sinkSend: fake.send,
    licensing: { publicKey: keys.publicKey.export({ type: "spki", format: "pem" }).toString(), installationId } });
  await app.register(fastifyStatic, { root: resolve("apps/ui/dist"), setHeaders: (reply) => reply.header("Cache-Control", "no-cache") });
  app.setNotFoundHandler((req, reply) => req.method === "GET" && !req.url.startsWith("/api/")
    ? reply.sendFile("index.html") : reply.code(404).send({ error: "not found" }));
  app.get("/__qa/prints", { preHandler: app.requirePermission("printers.manage") }, async () => ({
    prints: fake.sent.map((entry) => entry.bytes.toString("utf8")),
  }));

  const browserHeaders = { "x-forkflow-device": browserDevice };
  const setup = await app.inject({ method: "POST", url: "/api/setup", headers: browserHeaders,
    payload: { restaurantName: "M10 QA Cafe", adminName: "QA Admin", pin: "1234" } });
  if (setup.statusCode >= 400) throw new Error(`M10 setup failed: ${setup.body}`);
  const adminToken = setup.json().token as string;
  const headers = { ...browserHeaders, authorization: `Bearer ${adminToken}` };
  const post = async (url: string, payload: object) => {
    const response = await app.inject({ method: "POST", url, headers, payload });
    if (response.statusCode >= 400) throw new Error(`${url}: ${response.body}`);
    return response.json();
  };
  const activated = await app.inject({ method: "PUT", url: "/api/license", headers, payload: { license: proLicense } });
  if (activated.statusCode !== 200) throw new Error(`M10 Pro activation failed: ${activated.body}`);
  await post("/api/license/devices", { name: "M10 browser" });
  const { printer } = await post("/api/printers", { name: "M10 fake kitchen printer", kind: "network", connection: "127.0.0.1:9999", paperWidth: 80 });
  const stations = await app.inject({ url: "/api/kot-stations", headers });
  if (stations.statusCode !== 200 || stations.json().stations.length !== 1) throw new Error(`M10 default station missing: ${stations.body}`);
  const stationId = stations.json().stations[0].id as string;
  const assigned = await app.inject({ method: "PATCH", url: `/api/kot-stations/${stationId}`, headers, payload: { printerId: printer.id } });
  if (assigned.statusCode !== 200) throw new Error(`M10 printer assignment failed: ${assigned.body}`);

  const browserSetupPath = join(dataDir, "browser-setup.js");
  writeFileSync(browserSetupPath,
    `localStorage.setItem("forkflow.device.v1", ${JSON.stringify(browserDevice)});\nwindow.__m10BasicLicense = ${JSON.stringify(basicLicense)};\n"M10 disposable browser setup loaded";\n`,
    { flag: "wx" });
  return { app, dataDir, browserSetupPath, browserDevice, basicLicense, adminToken,
    close: async () => { await app.close(); db.close(); } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const fixture = await createM10Fixture();
  await fixture.app.listen({ host: "127.0.0.1", port: 4121 });
  const close = async () => { await fixture.close(); process.exit(0); };
  process.on("SIGINT", () => void close());
  process.on("SIGTERM", () => void close());
  console.log(`M10 fixture ready: http://127.0.0.1:4121/\nBrowser setup: ${fixture.browserSetupPath}\nAdmin PIN: 1234\nScratch data: ${fixture.dataDir}`);
}
