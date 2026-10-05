import { app, BrowserWindow, ipcMain, Menu } from "electron";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { kitchenAddress } from "./server-address.js";

const here = dirname(fileURLToPath(import.meta.url));
app.setName("ForkFlow Kitchen");
app.setPath("userData", join(app.getPath("appData"), "forkflow-kitchen"));
const config = join(app.getPath("userData"), "connection.json");
const connectionPage = pathToFileURL(join(here, "connect.html")).href;
let window: BrowserWindow;
let target = "";
let connecting = false;
function savedAddress() {
  try { return kitchenAddress(JSON.parse(readFileSync(config, "utf8")).address as string); } catch { return ""; }
}
function saveAddress(address: string) {
  mkdirSync(dirname(config), { recursive: true });
  writeFileSync(config + ".tmp", JSON.stringify({ address })); renameSync(config + ".tmp", config);
}
async function showConnection(error = "") {
  await window.loadURL(`${connectionPage}?error=${encodeURIComponent(error)}`);
}
async function connect(address: string) {
  const url = kitchenAddress(address);
  const response = await fetch(new URL("/api/health", url), { signal: AbortSignal.timeout(5000), redirect: "error" });
  if (!response.ok || (await response.json() as { ok?: boolean }).ok !== true) throw new Error("The address did not respond as a ForkFlow POS server.");
  target = url;
  await window.loadURL(url);
  saveAddress(url);
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", () => { window?.show(); window?.focus(); });
  app.whenReady().then(async () => {
    window = new BrowserWindow({ width: 1280, height: 800, title: "ForkFlow Kitchen", show: false, webPreferences: { preload: join(here, "preload.cjs"), sandbox: true, contextIsolation: true, nodeIntegration: false } });
    window.once("ready-to-show", () => window.show());
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-navigate", (event, url) => { if (url !== target) event.preventDefault(); });
    window.webContents.on("will-redirect", (event, url) => { if (url !== target) event.preventDefault(); });
    window.webContents.on("did-fail-load", (_event, code, _description, url, mainFrame) => {
      if (mainFrame && code !== -3 && !url.startsWith(connectionPage) && !connecting) void showConnection("Connection lost. Check the main POS and reconnect.");
    });
    const trusted = (event: Electron.IpcMainInvokeEvent) => event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame && event.senderFrame.url.startsWith(connectionPage + "?");
    ipcMain.handle("kitchen:address", event => { if (!trusted(event)) throw new Error("Unavailable"); return savedAddress(); });
    ipcMain.handle("kitchen:connect", async (event, address: unknown) => {
      if (!trusted(event) || typeof address !== "string" || connecting) throw new Error("Unavailable");
      connecting = true;
      try { await connect(address); return { ok: true }; }
      catch (error) {
        const message = error instanceof Error ? error.message : "Cannot connect to the main POS.";
        if (!window.webContents.getURL().startsWith(connectionPage)) await showConnection(message);
        return { ok: false, error: message };
      } finally { connecting = false; }
    });
    Menu.setApplicationMenu(Menu.buildFromTemplate([{ label: "Kitchen", submenu: [
      { label: "Connect to a different POS…", click: () => { void showConnection(); } },
      { role: "reload" }, { role: "togglefullscreen", accelerator: "F11" }, { type: "separator" }, { role: "quit" },
    ] }]));
    const address = savedAddress();
    if (address) {
      connecting = true;
      try { await connect(address); } catch { await showConnection("Cannot reach the saved POS. Check its address and restaurant network."); }
      finally { connecting = false; }
    } else await showConnection();
  }).catch(error => { console.error(error); app.quit(); });
  app.on("window-all-closed", () => app.quit());
}
