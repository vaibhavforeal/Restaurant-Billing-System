// Runs built servers against newly created scratch data; never uses restaurant data.
// node tools/e2e/distribution-smoke.mjs C:\secure\license-private.pem
import assert from "node:assert/strict";
import { createPrivateKey, randomUUID, sign } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { resolve, join } from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const root = resolve(import.meta.dirname, "../..");
if (!process.argv[2]) throw new Error("Supply the private signing key path for the customer build being tested");
const signingKey = createPrivateKey(readFileSync(process.argv[2]));
mkdirSync(join(root, ".e2e-scratch"), { recursive: true });
const scratch = mkdtempSync(join(root, ".e2e-scratch/distribution-"));
for (const edition of ["demo", "commercial"]) {
  const listener = createServer();
  await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  const stage = join(root, "build/desktop", edition);
  const env = { ...process.env, FORKFLOW_DATA_DIR: join(scratch, edition), FORKFLOW_PORT: String(port),
    FORKFLOW_UI_DIR: join(stage, "ui"), FORKFLOW_LICENSE_PUBLIC_KEY: "", FORKFLOW_APP_VERSION: "distribution-smoke" };
  delete env.FORKFLOW_RESTORE;
  const child = spawn(process.execPath, [join(stage, "server/main.mjs")], { cwd: root, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let logs = "";
  child.stdout.on("data", (data) => { logs = (logs + data).slice(-6000); });
  child.stderr.on("data", (data) => { logs = (logs + data).slice(-6000); });
  const base = `http://127.0.0.1:${port}`;
  const headers = { "content-type": "application/json", "x-forkflow-device": "d".repeat(64) };
  const api = (path, method = "GET", body) => fetch(base + path, { method, headers,
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(5000) });
  try {
    let ready = false;
    for (let attempt = 0; attempt < 80; attempt++) {
      if (child.exitCode !== null) throw new Error(`Server exited: ${logs}`);
      try { if ((await api("/api/health")).ok) { ready = true; break; } } catch {}
      await delay(250);
    }
    assert.ok(ready, `Server startup failed: ${logs}`);
    const setup = await (await api("/api/needs-setup")).json();
    if (edition === "demo") {
      assert.deepEqual(setup, { needsSetup: false, demo: true });
      const login = await api("/api/login", "POST", { pin: "1234" });
      assert.equal(login.status, 200);
      headers.authorization = `Bearer ${(await login.json()).token}`;
      const tables = await (await api("/api/tables")).json();
      assert.equal(tables.tables.length, 8);
      console.log("Demo: sample login and 8 sample tables verified in isolated data.");
    } else {
      assert.deepEqual(setup, { needsSetup: true });
      const created = await api("/api/setup", "POST", { restaurantName: "Distribution QA", adminName: "QA admin", pin: "9876" });
      assert.equal(created.status, 201);
      headers.authorization = `Bearer ${(await created.json()).token}`;
      const status = await (await api("/api/license")).json();
      assert.equal(status.mode, "commercial");
      assert.equal(status.canOperate, false);
      assert.equal((await api("/api/tables")).status, 403);
      const activation = await (await api("/api/license/activation-request")).json();
      const info = JSON.parse(readFileSync(join(stage, "build-info.json"), "utf8"));
      assert.equal(activation.verificationKeyFingerprint, info.verificationKeyFingerprint);
      const now = Date.now();
      const claims = { version: 1, licenseId: randomUUID(), organizationId: randomUUID(), outletId: randomUUID(),
        installationId: activation.installationId, revision: 1, plan: "basic", maxDevices: 2,
        features: { recipes: false, qrOrdering: false }, issuedAt: now - 1000, expiresAt: now + 3600000, graceUntil: now + 7200000 };
      const message = `ff1.${Buffer.from(JSON.stringify(claims)).toString("base64url")}`;
      const license = `${message}.${sign(null, Buffer.from(message), signingKey).toString("base64url")}`;
      assert.equal((await api("/api/license", "PUT", { license })).status, 200);
      assert.equal((await api("/api/license/devices", "POST", { name: "QA counter" })).status, 200);
      const active = await (await api("/api/license")).json();
      assert.equal(active.canOperate, true);
      const tables = await (await api("/api/tables")).json();
      assert.equal(tables.tables.length, 0);
      console.log("Customer: clean setup, blocked before activation, valid signed activation and device registration verified with runtime key unset.");
    }
  } finally {
    if (child.exitCode === null) {
      const stopped = new Promise((resolve) => child.once("exit", resolve));
      child.kill();
      await stopped;
    }
  }
}
console.log(`Distribution smoke passed. Scratch data: ${scratch}`);
