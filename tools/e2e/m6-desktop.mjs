// Against a running scratch packaged app with --inspect=9233 and port 4112.
// Verifies packaged SQLite, backup creation, forced-child restart and tray close.
import assert from "node:assert/strict";
const base = "http://127.0.0.1:4112";
const targets = await (await fetch("http://127.0.0.1:9233/json/list")).json();
const ws = new WebSocket(targets[0].webSocketDebuggerUrl);
await new Promise((resolve) => ws.addEventListener("open", resolve, { once: true }));
let id = 0;
const pending = new Map();
ws.addEventListener("message", ({ data }) => {
  const message = JSON.parse(data); const job = pending.get(message.id);
  if (job) { pending.delete(message.id); message.error || message.result?.exceptionDetails ? job.reject(new Error(JSON.stringify(message))) : job.resolve(message.result.result.value); }
});
function evaluate(expression) {
  return new Promise((resolve, reject) => {
    const key = ++id; pending.set(key, { resolve, reject });
    ws.send(JSON.stringify({ id: key, method: "Runtime.evaluate", params: { expression, returnByValue: true, awaitPromise: true } }));
  });
}
const electron = "process.getBuiltinModule('module').createRequire(process.execPath)('electron')";
const checks = [];
try {
  const context = await evaluate("({path: process.execPath, data: process.env.FORKFLOW_DATA_DIR, autostart: process.env.FORKFLOW_DISABLE_AUTOSTART})");
  assert.match(context.path.replaceAll("\\", "/"), /win-unpacked\/ForkFlow\.exe$/i);
  assert.match(context.data.replaceAll("\\", "/"), /\.e2e-scratch\//);
  assert.equal(context.autostart, "1");
  const health = await (await fetch(base + "/api/health")).json(); assert.equal(health.ok, true);
  checks.push("Packaged Electron runtime starts the bundled SQLite server");
  const needsSetup = (await (await fetch(base + "/api/needs-setup")).json()).needsSetup;
  const login = await fetch(base + (needsSetup ? "/api/setup" : "/api/login"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(needsSetup ? { restaurantName: "Packaged QA Cafe", adminName: "Test Admin", pin: "1234" } : { pin: "1234" }) });
  assert.ok(login.ok); const { token } = await login.json();
  checks.push("First-run setup and PIN login work inside the package");
  const headers = { authorization: `Bearer ${token}` };
  const backup = await fetch(base + "/api/system/backups", { method: "POST", headers }); assert.ok(backup.ok);
  const snapshot = await backup.json(); assert.ok(snapshot.name); checks.push("Packaged server creates a verified backup");
  const metrics = await evaluate(`${electron}.app.getAppMetrics().map(m => ({pid:m.pid,type:m.type,name:m.name,serviceName:m.serviceName}))`);
  const child = metrics.find((m) => m.name === "ForkFlow POS server" || m.serviceName === "ForkFlow POS server");
  assert.ok(child, JSON.stringify(metrics));
  process.kill(child.pid);
  let restarted;
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try { const next = await (await fetch(base + "/api/health", { signal: AbortSignal.timeout(1000) })).json(); if (next.instanceId !== health.instanceId) { restarted = next; break; } } catch { /* watchdog restarting */ }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.ok(restarted); checks.push("Watchdog relaunches a forcibly terminated server with a new instance identity");
  assert.equal((await fetch(base + "/api/settings", { headers })).status, 200); checks.push("SQLite data and staff session survive the server crash");
  await evaluate(`${electron}.BrowserWindow.getAllWindows()[0].close()`);
  assert.equal(await evaluate(`${electron}.BrowserWindow.getAllWindows()[0].isVisible()`), false);
  assert.equal((await fetch(base + "/api/health")).status, 200); checks.push("Closing the window keeps the LAN server running in the tray");
  await evaluate(`${electron}.BrowserWindow.getAllWindows()[0].show()`);
  console.log(JSON.stringify({ passed: checks.length, checks }, null, 2));
} finally { ws.close(); }
