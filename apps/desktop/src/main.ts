import { spawn, type ChildProcess } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BrowserWindow, app } from "electron";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
const SERVER_URL = "http://localhost:4100";
const MAX_RESTARTS = 5;

let server: ChildProcess | null = null;
let restarts = 0;
let quitting = false;

function startServer(): void {
  // Dev shell: system Node + tsx keeps better-sqlite3 on the Node ABI.
  // Milestone 6 packaging replaces this with utilityProcess + electron-rebuild.
  server = spawn("node", ["--import", "tsx", "apps/server/src/main.ts"], {
    cwd: repoRoot,
    stdio: "inherit",
    shell: false,
  });
  server.on("exit", (code) => {
    if (quitting) return;
    if (restarts >= MAX_RESTARTS) {
      console.error(`server exited (code ${code}) too many times; giving up`);
      app.quit();
      return;
    }
    const delay = 500 * 2 ** restarts;
    restarts += 1;
    console.error(`server exited (code ${code}); restarting in ${delay}ms`);
    setTimeout(startServer, delay);
  });
}

async function waitForHealth(timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${SERVER_URL}/api/health`);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("server did not become healthy in time");
}

app.whenReady().then(async () => {
  startServer();
  await waitForHealth();
  const win = new BrowserWindow({ width: 1280, height: 800, autoHideMenuBar: true });
  await win.loadURL(SERVER_URL);
});

app.on("before-quit", () => {
  quitting = true;
  server?.kill();
});

app.on("window-all-closed", () => {
  app.quit();
});
