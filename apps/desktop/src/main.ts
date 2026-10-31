import { join, dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { appendFileSync, mkdirSync, existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import { app, BrowserWindow, dialog, Menu, nativeImage, safeStorage, shell, Tray, utilityProcess, type UtilityProcess } from "electron";
import { startupDocument } from "../../ui/src/startup-screen.js";
import { prepareDemoDirectory, resetDemoDatabase } from "./demo-data.js";
import { createUpdater, type AutoUpdaterLike } from "./updater.js";
import { isToDesktop } from "../../../packages/domain/src/updates.js";

declare const __FORKFLOW_DEMO__: boolean;
declare const __FORKFLOW_COMMERCIAL__: boolean;
const demo = typeof __FORKFLOW_DEMO__ !== "undefined" && __FORKFLOW_DEMO__;
const commercial = typeof __FORKFLOW_COMMERCIAL__ !== "undefined" && __FORKFLOW_COMMERCIAL__;
if (demo) { app.setName("ForkFlow Demo"); app.setPath("userData", join(app.getPath("appData"), "forkflow-demo")); }

const here = dirname(fileURLToPath(import.meta.url));
const port = demo ? "4110" : process.env["FORKFLOW_PORT"] ?? "4100";
const url = `http://127.0.0.1:${port}`;
const dataDir = demo ? prepareDemoDirectory(join(app.getPath("userData"), "data")) : process.env["FORKFLOW_DATA_DIR"] ?? join(app.getPath("userData"), "data");
let server: UtilityProcess | null = null;
let window: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;
let stopping = false;
let restarts = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
let recovering = false;
let errorShown = false;
let updates: ReturnType<typeof createUpdater> | null = null;

if (!app.requestSingleInstanceLock()) app.quit();
else {
  mkdirSync(dataDir, { recursive: true });
  const log = join(dataDir, "server.log");
  const writeLog = (text: string) => {
    try {
      if (existsSync(log) && statSync(log).size > 5_000_000) renameSync(log, log + ".previous");
      appendFileSync(log, text);
    } catch { /* read-only disk will be surfaced by server startup */ }
  };
  writeLog(`Desktop ${app.getVersion()} starting at ${new Date().toISOString()}\n`);
  function showWindow() { window?.show(); window?.focus(); }
  /** Key that seals cloud-backup credentials, protected by Windows for this user and PC. Kept outside the data folder. */
  let secretKey: string | undefined;
  function cloudSecretKey(): string | undefined {
    if (secretKey !== undefined || demo) return secretKey || undefined;
    secretKey = "";
    try {
      if (!safeStorage.isEncryptionAvailable()) throw new Error("Windows credential protection is unavailable");
      const path = join(app.getPath("userData"), "cloud-secret.bin");
      if (existsSync(path)) secretKey = safeStorage.decryptString(readFileSync(path));
      else { secretKey = randomBytes(32).toString("base64"); writeFileSync(path, safeStorage.encryptString(secretKey)); }
    } catch (error) { writeLog(`Cloud backup key unavailable: ${String(error)}
`); secretKey = ""; }
    return secretKey || undefined;
  }
  async function failure(message: string) {
    if (errorShown || quitting || recovering) return;
    errorShown = true;
    const { response } = await dialog.showMessageBox({ type: "error", title: "ForkFlow needs attention", message,
      detail: `Your data is in ${dataDir}. See server.log for details.`, buttons: ["Retry", "Open data folder", "Restore backup", "Quit"], cancelId: 3 });
    errorShown = false;
    if (response === 0) { restarts = 0; startServer(); }
    else if (response === 1) { await shell.openPath(dataDir); void failure(message); }
    else if (response === 2) await restore();
    else app.quit();
  }
  function startServer(restorePath?: string) {
    if (quitting || server) return;
    writeLog("Starting server utility process\n");
    const instanceId = randomUUID();
    const child = utilityProcess.fork(join(here, "server", "main.mjs"), [], {
      cwd: dataDir, stdio: "pipe", serviceName: "ForkFlow POS server",
      env: { ...process.env, FORKFLOW_DATA_DIR: dataDir, FORKFLOW_UI_DIR: join(here, "ui"), FORKFLOW_PORT: port,
        FORKFLOW_APP_VERSION: app.getVersion(), FORKFLOW_INSTANCE_ID: instanceId, ...(restorePath ? { FORKFLOW_RESTORE: restorePath } : {}),
        ...(cloudSecretKey() ? { FORKFLOW_SECRET_KEY: cloudSecretKey() } : {}) },
    });
    server = child;
    child.on("spawn", () => writeLog(`Server spawned (${child.pid})\n`));
    let healthy = false;
    let healthyAt = 0;
    let failures = 0;
    const started = Date.now();
    const spawnCheck = setTimeout(() => {
      if (server === child && child.pid === undefined) {
        server = null; clearInterval(watchdog);
        writeLog("Server failed to spawn; verify its entry point and working directory\n");
        void failure("The server process could not be launched. Open the data folder to inspect server.log.");
      }
    }, 5000);
    // The server relays Settings -> Updates; the shell answers with the updater's status.
    child.on("message", (data: unknown) => {
      if (!isToDesktop(data) || server !== child) return;
      if (data.type === "restore") {
        // Settings staged and verified this file and the admin confirmed it on this PC; accept only that folder.
        const staged = resolve(data.path), incoming = resolve(dataDir, "restore-incoming") + sep;
        if (staged.startsWith(incoming) && existsSync(staged)) void runRestore(staged);
        else writeLog(`Ignored restore request outside ${incoming}
`);
      } else if (data.type === "update-config") updates?.configure(data.channel);
      else if (data.type === "update-check") updates?.check();
      else void updates?.install();
    });
    child.stdout?.on("data", (data: Buffer) => writeLog(data.toString()));
    child.stderr?.on("data", (data: Buffer) => writeLog(data.toString()));
    const watchdog = setInterval(() => { void (async () => {
      try {
        const res = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(2000) });
        const data = await res.json() as { instanceId?: string };
        if (!res.ok || data.instanceId !== instanceId) throw new Error("This port belongs to another server");
        failures = 0;
        if (!healthy) { healthy = true; healthyAt = Date.now(); if (window?.webContents.getURL() !== url + "/") await window?.loadURL(url); }
        if (Date.now() - healthyAt > 60_000) restarts = 0;
      } catch {
        failures++;
        // Allow migration/backup work to finish at startup. A live hung server is
        // killed only after repeated failed probes; its OS data lock then releases.
        if ((healthy && failures >= 15) || (!healthy && Date.now() - started > 120_000)) child.kill();
      }
    })(); }, 2000);
    child.once("exit", (code) => {
      clearTimeout(spawnCheck);
      clearInterval(watchdog);
      if (server === child) server = null;
      writeLog(`\nServer exited (${code}) at ${new Date().toISOString()}\n`);
      if (quitting || stopping || recovering) return;
      if (restarts >= 5) { void failure("The POS server could not start. Your saved data has been kept."); return; }
      timer = setTimeout(() => startServer(), Math.min(500 * 2 ** restarts++, 10_000));
    });
  }
  async function stopServer() {
    if (timer) clearTimeout(timer);
    const child = server;
    if (!child) return;
    stopping = true;
    await new Promise<void>((resolve) => {
      const force = setTimeout(() => child.kill(), 10_000);
      child.once("exit", () => { clearTimeout(force); resolve(); });
      child.postMessage("shutdown");
    });
    stopping = false;
  }
  async function restore() {
    const selection = await dialog.showOpenDialog({ title: "Choose a ForkFlow backup", defaultPath: join(dataDir, "backups"), filters: [{ name: "SQLite backup", extensions: ["db"] }], properties: ["openFile"] });
    if (selection.canceled || !selection.filePaths[0]) return;
    const { response } = await dialog.showMessageBox({ type: "warning", title: "Restore backup", message: "Stop work on all counters before restoring.",
      detail: `Restore ${selection.filePaths[0]}? Current data will be archived; all changes since this snapshot will leave the live database. Staff must sign in again and review open orders.`, buttons: ["Cancel", "Restore this backup"], defaultId: 0, cancelId: 0 });
    if (response !== 1) return;
    await runRestore(selection.filePaths[0]);
  }
  async function runRestore(path: string) {
    if (recovering) return;
    recovering = true;
    writeLog(`Restoring backup ${path}
`);
    await stopServer();
    await window?.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(startupDocument("restoring"))}`);
    showWindow();
    restarts = 5; // invalid backups produce a reviewable error, never silently fall back
    startServer(path);
    recovering = false;
  }
  async function resetDemo() {
    if (!demo || recovering) return;
    const { response } = await dialog.showMessageBox({ type: "question", title: "Reset ForkFlow Demo", message: "Start a fresh customer demo?", detail: "Demo orders and edits will be archived, then replaced with the sample restaurant. Connected demo kitchen displays will need to sign in again.", buttons: ["Cancel", "Reset sample data"], defaultId: 0, cancelId: 0 });
    if (response !== 1) return;
    recovering = true;
    try {
      await stopServer();
      resetDemoDatabase(dataDir);
      await window?.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(startupDocument("restoring"))}`);
      restarts = 0; startServer();
    } catch (error) { recovering = false; void failure(error instanceof Error ? error.message : "Demo reset failed."); }
    finally { recovering = false; }
  }
  app.on("second-instance", showWindow);
  app.whenReady().then(async () => {
    window = new BrowserWindow({ width: 1280, height: 800, show: false, backgroundColor: "#f6f7f9", autoHideMenuBar: true, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true } });
    if (demo) {
      window.setAutoHideMenuBar(false);
      Menu.setApplicationMenu(Menu.buildFromTemplate([{ label: "Demo", submenu: [
        { label: "Open Kitchen display in browser", click: () => { void shell.openExternal(`${url}/kitchen/`); } },
        { label: "Reset sample data", click: () => { void resetDemo(); } },
        { type: "separator" }, { role: "quit" },
      ] }, { role: "viewMenu" }]));
    }
    window.once("ready-to-show", showWindow);
    window.webContents.setWindowOpenHandler(({ url: target }) => { if (/^https?:\/\//.test(target)) void shell.openExternal(target); return { action: "deny" }; });
    window.webContents.on("will-navigate", (event, target) => { if (!target.startsWith(url + "/") && target !== url) event.preventDefault(); });
    window.on("close", (event) => { if (!quitting) { event.preventDefault(); window?.hide(); } });
    // Paint the self-contained splash before starting the server; no blank window or CDN dependency.
    await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(startupDocument())}`);
    if (!demo && app.isPackaged && process.env["FORKFLOW_DISABLE_AUTOSTART"] !== "1" && !existsSync(join(dataDir, "desktop-initialized"))) {
      app.setLoginItemSettings({ openAtLogin: true });
      appendFileSync(join(dataDir, "desktop-initialized"), "1");
    }
    // Only the installed customer edition updates itself; Demo and development builds report why not.
    const unsupportedReason = !commercial ? "This is not the customer edition of ForkFlow, so it does not update automatically."
      : !app.isPackaged ? "Updates install only into an installed copy of ForkFlow." : null;
    let autoUpdater: AutoUpdaterLike | null = null;
    if (!unsupportedReason) {
      try { autoUpdater = (await import("electron-updater")).default.autoUpdater as unknown as AutoUpdaterLike; }
      catch (error) { writeLog(`Updater unavailable: ${String(error)}\n`); }
    }
    updates = createUpdater({
      updater: autoUpdater, currentVersion: app.getVersion(),
      unsupportedReason: unsupportedReason ?? (autoUpdater ? null : "The updater could not start; see server.log."),
      publish: (status) => server?.postMessage({ type: "update-status", status }), log: writeLog,
      beforeInstall: async () => {
        // The installer replaces the app: stop serving cleanly (the server takes a pre-update backup at next start).
        quitting = true;
        await stopServer();
        tray?.destroy();
      },
    });
    startServer();
    writeLog("Creating tray menu\n");
    tray = new Tray(nativeImage.createFromPath(join(here, "icon.png")));
    tray.setToolTip("ForkFlow — restaurant POS server");
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: "Open ForkFlow", click: showWindow },
      { label: "Open data and backups", click: () => { void shell.openPath(dataDir); } },
      ...(demo ? [{ label: "Reset sample data", click: () => { void resetDemo(); } }] : [
        { label: "Restore backup…", click: () => { void restore(); } },
        { label: "Start with Windows", type: "checkbox" as const, checked: app.getLoginItemSettings().openAtLogin, click: (item: Electron.MenuItem) => app.setLoginItemSettings({ openAtLogin: item.checked }) },
      ]),
      { type: "separator" }, { label: "Quit ForkFlow (stops all counters)", click: () => app.quit() },
    ]));
    tray.on("double-click", showWindow);
    writeLog("Tray menu ready\n");
  }).catch((error: unknown) => { writeLog(String(error)); void failure("ForkFlow startup failed."); });
  app.on("before-quit", (event) => {
    if (quitting) return;
    event.preventDefault(); quitting = true;
    void stopServer().finally(() => { tray?.destroy(); app.quit(); });
  });
}
