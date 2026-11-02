// One remote session at a time on this PC, run from the main process: the hidden sharing window, a red frame on every screen, the
// banner with Stop, and the viewer's input. The server only starts a session someone here has just allowed; this side makes sure it is
// visible the whole time and ends cleanly (keys released, windows closed, the server told) however it ends.
import { BrowserWindow, desktopCapturer, ipcMain, screen, session as electronSession, type Display, type IpcMainEvent, type IpcMainInvokeEvent } from "electron";
import { join } from "node:path";
import type { RemoteToDesktop, RemoteToServer } from "../../domain/src/remote-support.js";
import { blockedByProtected, isRelease, parseInput, pointOn, type Injector } from "./input.js";

type Start = Extract<RemoteToDesktop, { type: "remote-start" }>;

export interface RemoteSupportDeps {
  /** Folder holding agent.html, agent.js and the preloads (the staged app root). */
  here: string;
  transport?: { send(message: unknown): void; subscribe(listener: (message: unknown) => void): void };
  protectedWindows?: () => BrowserWindow[];
  toServer(message: RemoteToServer): void;
  log(text: string): void;
  injector(): Promise<Injector>;
  /** Shows that a session is running (the tray's tooltip). */
  onActive?(active: boolean, agentName: string): void;
  onMode?(viewOnly: boolean): void;
}

interface Running {
  start: Start;
  agent: BrowserWindow;
  frames: BrowserWindow[];
  banner: BrowserWindow | null;
  displayIndex: number;
  viewOnly: boolean;
  sharing: boolean;
  injector: Injector | null;
  limit: ReturnType<typeof setTimeout>;
}

const BORDER = "#d32f2f";
const frameHtml = `<!doctype html><html><body style="margin:0;overflow:hidden;background:transparent">
<div style="position:fixed;inset:0;border:4px solid ${BORDER};box-sizing:border-box;pointer-events:none"></div></body></html>`;
const bannerHtml = `<!doctype html><html><head><meta charset="utf-8"><style>
body{margin:0;font:13px/18px "Segoe UI",system-ui,sans-serif;background:${BORDER};color:#fff;-webkit-user-select:none;user-select:none;overflow:hidden}
.bar{display:flex;align-items:center;gap:10px;height:44px;padding:0 8px 0 12px;-webkit-app-region:drag}
.dot{width:9px;height:9px;border-radius:50%;background:#fff;flex:none}
.text{flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
button{-webkit-app-region:no-drag;font:inherit;font-weight:600;border-radius:6px;padding:5px 12px;cursor:pointer;border:1px solid #fff}
.ghost{background:transparent;color:#fff}.stop{background:#fff;color:${BORDER};border-color:#fff}
</style></head><body><div class="bar"><span class="dot"></span><span class="text" id="t">MasalaPOS support is connecting…</span>
<button class="ghost" id="mode" hidden></button><button class="stop" id="stop">Stop</button></div>
<script>
const t=document.getElementById("t"),m=document.getElementById("mode");let s=null;
document.getElementById("stop").onclick=()=>window.remoteBanner.stop();
m.onclick=()=>{if(s)window.remoteBanner.setViewOnly(!s.viewOnly)};
window.remoteBanner.onState((st)=>{s=st;const control=st.granted==="control"&&!st.viewOnly;
t.textContent=st.agentName+" from MasalaPOS support "+(st.sharing?(control?"can see and control this PC":"can see this PC"):"is connecting…");
m.hidden=st.granted!=="control";m.textContent=st.viewOnly?"Allow control":"View only";});
</script></body></html>`;

const dataUrl = (html: string) => `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;

export class RemoteSupport {
  private running: Running | null = null;
  private transportReady = false;
  private events: unknown[] = [];

  constructor(private readonly deps: RemoteSupportDeps) {
    const displaysChanged = () => this.stopAll("Display configuration changed; reconnect support");
    screen.on("display-added", displaysChanged);
    screen.on("display-removed", displaysChanged);
    screen.on("display-metrics-changed", displaysChanged);
    deps.transport?.subscribe((message) => {
      if (this.transportReady && this.running) this.running.agent.webContents.send("remote:event", message);
      else if (this.events.length < 100) this.events.push(message);
    });
    ipcMain.on("remote:send", (event, message: unknown) => { if (this.from(event)) deps.transport?.send(message); });
    ipcMain.on("remote:transport-ready", (event) => { if (this.from(event)) { this.transportReady = true; for (const message of this.events.splice(0)) event.sender.send("remote:event", message); } });
    ipcMain.handle("remote:config", (event) => {
      const run = this.from(event);
      return run && { externalTransport: !!deps.transport, agentUrl: run.start.agentUrl, iceServers: run.start.iceServers, mode: this.mode(run), agentName: run.start.agentName };
    });
    ipcMain.handle("remote:screens", (event) => { const run = this.from(event); return run && this.screens(run); });
    ipcMain.handle("remote:choose-screen", (event, index: unknown) => {
      const run = this.from(event);
      if (!run) return null;
      if (this.mode(run) === "control" && Number.isInteger(index) && (index as number) >= 0 && (index as number) < screen.getAllDisplays().length) run.displayIndex = index as number;
      return this.screens(run);
    });
    ipcMain.on("remote:input", (event, message: unknown) => { const run = this.from(event); if (run) this.input(run, message); });
    ipcMain.on("remote:state", (event, state: unknown, reason: unknown) => {
      const run = this.from(event);
      if (!run) return;
      if (state === "sharing" && !run.sharing) {
        run.sharing = true;
        this.deps.toServer({ type: "remote-state", sessionId: run.start.sessionId, state: "sharing" });
        this.pushBanner(run);
      } else if (state === "stopped") this.finish(typeof reason === "string" ? reason.slice(0, 200) : "Screen sharing stopped", true);
    });
    ipcMain.on("remote-banner:stop", (event) => {
      const run = this.running;
      if (!run || run.banner?.webContents.id !== event.sender.id) return;
      // Stop works on this PC whatever the server or the network is doing: tell the server, then end it here.
      this.deps.toServer({ type: "remote-stop-request", sessionId: run.start.sessionId });
      this.finish("Stopped at the PC", true);
    });
    ipcMain.on("remote-banner:view-only", (event, viewOnly: unknown) => {
      const run = this.running;
      if (!run || run.banner?.webContents.id !== event.sender.id || typeof viewOnly !== "boolean") return;
      // Control can only come back if the PC allowed it in the first place.
      run.viewOnly = viewOnly || run.start.mode !== "control";
      if (run.viewOnly) run.injector?.releaseAll();
      run.agent.webContents.send("remote:mode", this.mode(run));
      this.pushBanner(run);
      this.deps.onMode?.(run.viewOnly);
    });
  }

  /** From the server: start the allowed session, or stop one. */
  handle(message: RemoteToDesktop): void {
    if (message.type === "connector-open") return;
    if (message.type === "remote-stop") { if (this.running?.start.sessionId === message.sessionId) this.finish(message.reason, false); return; }
    if (this.running) {
      this.deps.toServer({ type: "remote-state", sessionId: message.sessionId, state: "stopped", reason: "Another remote session is running" });
      return;
    }
    void this.begin(message).catch((error: unknown) => {
      this.deps.log(`Remote support failed to start: ${String(error)}\n`);
      this.finish("Screen sharing couldn't start on this PC", true);
    });
  }

  /** Ends whatever is running, e.g. when MasalaPOS quits. */
  stopAll(reason: string): void { if (this.running) this.finish(reason, true); }

  setViewOnly(viewOnly: boolean): void {
    const run = this.running;
    if (!run) return;
    run.viewOnly = viewOnly || run.start.mode !== "control";
    if (run.viewOnly) run.injector?.releaseAll();
    run.agent.webContents.send("remote:mode", this.mode(run));
    this.pushBanner(run);
    this.deps.onMode?.(run.viewOnly);
  }

  private from(event: IpcMainEvent | IpcMainInvokeEvent): Running | null {
    const run = this.running;
    return run && !run.agent.isDestroyed() && run.agent.webContents.id === event.sender.id ? run : null;
  }
  private mode(run: Running): "view" | "control" { return run.start.mode === "control" && !run.viewOnly ? "control" : "view"; }
  private display(run: Running): Display {
    const displays = screen.getAllDisplays();
    return displays[run.displayIndex] ?? screen.getPrimaryDisplay();
  }
  private screens(run: Running) {
    const primary = screen.getPrimaryDisplay().id;
    return {
      screens: screen.getAllDisplays().map((d, index) => ({ index, label: d.id === primary ? `Screen ${index + 1} (main)` : `Screen ${index + 1}`,
        width: Math.round(d.size.width * d.scaleFactor), height: Math.round(d.size.height * d.scaleFactor) })),
      current: run.displayIndex,
    };
  }

  private async begin(start: Start): Promise<void> {
    const { here } = this.deps;
    const primaryIndex = Math.max(0, screen.getAllDisplays().findIndex((d) => d.id === screen.getPrimaryDisplay().id));
    // Its own in-memory session: the capture permission and anything the page stores never touch the POS window's.
    const partition = electronSession.fromPartition(`remote-${start.sessionId}`);
    partition.setPermissionRequestHandler((_wc, permission, callback) => callback(permission === "media" || permission === "display-capture"));
    const agent = new BrowserWindow({ show: false, width: 320, height: 200, skipTaskbar: true,
      webPreferences: { preload: join(here, "remote-agent-preload.cjs"), sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, session: partition } });
    agent.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    agent.webContents.on("will-navigate", (event) => event.preventDefault());
    const run: Running = { start, agent, frames: [], banner: null, displayIndex: primaryIndex, viewOnly: false, sharing: false, injector: null,
      limit: setTimeout(() => this.finish("Time limit reached", true), start.maxMs) };
    this.running = run;
    partition.setDisplayMediaRequestHandler((_request, callback) => {
      const display = this.display(run);
      // The callback may be called once only, whatever happens.
      void desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width: 0, height: 0 } })
        .then((sources) => sources.find((s) => s.display_id === String(display.id)) ?? sources[0] ?? null, () => null)
        .then((source) => { try { callback(source ? { video: source } : {}); } catch (error) { this.deps.log(`Remote support: capture refused: ${String(error)}\n`); } });
    });
    agent.webContents.on("render-process-gone", () => { if (this.running === run) this.finish("Screen sharing stopped", true); });
    agent.on("closed", () => { if (this.running === run) this.finish("Screen sharing stopped", true); });
    this.showFrames(run);
    this.showBanner(run);
    this.deps.onActive?.(true, start.agentName);
    if (start.mode === "control") run.injector = await this.deps.injector();
    await agent.loadFile(join(here, "remote-agent.html"));
  }

  private showFrames(run: Running) {
    for (const display of screen.getAllDisplays()) {
      const frame = new BrowserWindow({ ...display.bounds, frame: false, transparent: true, resizable: false, movable: false, focusable: false, skipTaskbar: true,
        hasShadow: false, alwaysOnTop: true, show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
      frame.setAlwaysOnTop(true, "screen-saver");
      frame.setIgnoreMouseEvents(true);
      frame.setVisibleOnAllWorkspaces(true);
      void frame.loadURL(dataUrl(frameHtml)).then(() => { if (!frame.isDestroyed()) frame.showInactive(); });
      run.frames.push(frame);
    }
  }

  private showBanner(run: Running) {
    const area = screen.getPrimaryDisplay().workArea, width = 560;
    const banner = new BrowserWindow({ x: Math.round(area.x + (area.width - width) / 2), y: area.y + 8, width, height: 44, frame: false, resizable: false, minimizable: false,
      maximizable: false, closable: false, skipTaskbar: true, alwaysOnTop: true, show: false,
      webPreferences: { preload: join(this.deps.here, "remote-banner-preload.cjs"), sandbox: true, contextIsolation: true, nodeIntegration: false } });
    banner.setAlwaysOnTop(true, "screen-saver");
    banner.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    banner.webContents.on("will-navigate", (event) => event.preventDefault());
    void banner.loadURL(dataUrl(bannerHtml)).then(() => { if (!banner.isDestroyed()) { banner.showInactive(); this.pushBanner(run); } });
    run.banner = banner;
  }

  private pushBanner(run: Running) {
    if (run.banner && !run.banner.isDestroyed()) {
      run.banner.webContents.send("remote-banner:state", { agentName: run.start.agentName, granted: run.start.mode, viewOnly: run.viewOnly || run.start.mode !== "control", sharing: run.sharing });
    }
  }

  private input(run: Running, raw: unknown) {
    const message = parseInput(raw);
    if (!message || message.t === "screen" || this.mode(run) !== "control" || !run.injector || !run.sharing) return;
    const injector = run.injector;
    const protectedWindows = [run.banner, ...(this.deps.protectedWindows?.() ?? [])].filter((w): w is BrowserWindow => !!w && !w.isDestroyed());
    const focused = protectedWindows.some((w) => w.isFocused());
    if (message.t === "move" || message.t === "button") {
      const display = this.display(run);
      const point = pointOn(display.bounds, message.x, message.y);
      const over = protectedWindows.some((w) => { const b = w.getBounds(); return point.x >= b.x && point.y >= b.y && point.x < b.x + b.width && point.y < b.y + b.height; });
      if (blockedByProtected(message, focused, over)) return;
      // A release over a protected window still goes through (where the pointer already is), so nothing stays held down.
      if (!isRelease(message) || !over) {
        const physical = screen.dipToScreenPoint(point);
        injector.moveTo(physical.x, physical.y);
      }
      if (message.t === "button") injector.button(message.button, message.down);
    } else if (message.t === "wheel") { if (!blockedByProtected(message, focused, false)) injector.wheel(message.dx, message.dy); }
    else if (!blockedByProtected(message, focused, false)) injector.key(message.code, message.down);
  }

  private finish(reason: string, tellServer: boolean) {
    const run = this.running;
    if (!run) return;
    this.running = null;
    this.transportReady = false;
    this.events = [];
    clearTimeout(run.limit);
    try { run.injector?.releaseAll(); } catch { /* nothing held */ }
    for (const win of [run.agent, run.banner, ...run.frames]) if (win && !win.isDestroyed()) { win.setClosable(true); win.destroy(); }
    this.deps.onActive?.(false, run.start.agentName);
    this.deps.log(`Remote support session ${run.start.sessionId} ended: ${reason}\n`);
    if (tellServer) this.deps.toServer({ type: "remote-state", sessionId: run.start.sessionId, state: "stopped", reason });
  }
}
