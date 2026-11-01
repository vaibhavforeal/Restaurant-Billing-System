import { app, BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent } from "electron";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import koffi from "koffi";
import { z } from "zod";
import { RemoteSupport } from "../../../packages/remote-agent/src/session.js";
import { windowsInjector } from "../../../packages/remote-agent/src/input.js";
import type { IceServer } from "../../../packages/domain/src/remote-support.js";
import type { RemoteSession, VisitorMessage } from "../../licensing-worker/src/portal/api-types.js";
import type { ConnectorState } from "./contracts.js";
import { consentAllowed, TOKEN } from "./arguments.js";
import { PromptRecovery } from "./recovery.js";

declare const __CONNECTOR_ORIGIN__: string;
const origin = __CONNECTOR_ORIGIN__, here = dirname(fileURLToPath(import.meta.url));
let win: BrowserWindow | null = null, remote: RemoteSupport | null = null, ws: WebSocket | null = null;
let consentToken: string | null = null, busy = false, closing = false;
let stopping: Promise<void> | null = null;
let heartbeat: ReturnType<typeof setInterval> | null = null;
let lastPong = Date.now();
let relay: ((event: unknown) => void) | null = null;
const queued: unknown[] = [];
const state: ConnectorState = { session: null, elevated: false, sharing: false, ended: false, viewOnly: true, error: null, messages: [] };
const publish = () => { if (win && !win.isDestroyed()) win.webContents.send("connector:state", state); };
const recovery = new PromptRecovery(here, () => { if (!state.ended) void stop("Windows recovery stopped"); });
function local(event: IpcMainInvokeEvent) { if (!win || event.sender.id !== win.webContents.id || event.senderFrame !== win.webContents.mainFrame) throw new Error("Invalid window"); }
async function request<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`${origin}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000), redirect: "error" });
  const result = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(result.error ?? "MasalaPOS support could not be reached");
  return result;
}
function stop(reason: string): Promise<void> {
  // Window close and before-quit can arrive together. Both must await the same
  // restoration, rather than letting the second call quit during the first.
  return stopping ??= Promise.resolve().then(() => stopSession(reason));
}
async function stopSession(reason: string) {
  if (state.ended) return;
  state.ended = true; state.sharing = false;
  if (heartbeat) clearInterval(heartbeat); heartbeat = null;
  remote?.stopAll(reason);
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "remote.end", reason }));
  ws?.close(); ws = null;
  if (consentToken) {
    const token = consentToken; consentToken = null;
    void request("/v1/connector/consent", { token, mode: "deny", approvedBy: "Person at the PC", elevated: state.elevated, adminPrompts: false }).catch(() => {});
  }
  await restorePolicy(); publish();
}
async function restorePolicy() {
  try { await recovery.restore(); }
  catch (error) { state.error = error instanceof Error ? error.message : "Windows recovery needs attention"; publish(); dialog.showErrorBox("Windows recovery needs attention", state.error); }
}
const Consent = z.object({ mode: z.enum(["deny","view","control"]), approvedBy: z.string().trim().min(1).max(80), adminPrompts: z.boolean() }).strict();
async function consent(raw: unknown) {
  if (busy || state.ended || !state.session || !consentToken) throw new Error("This invitation is no longer available");
  const input = Consent.parse(raw);
  if (!consentAllowed(state.session.modeRequested,input.mode,state.elevated,input.adminPrompts)) throw new Error("That access was not requested or is unavailable");
  busy = true; state.error = null;
  try {
    if (input.adminPrompts) await recovery.enable();
    const allowed = await request<{ session: RemoteSession; token?: string; agentPath?: string; iceServers?: IceServer[]; maxMs?: number }>("/v1/connector/consent", { ...input, token: consentToken, elevated: state.elevated });
    consentToken = null; state.session = allowed.session;
    if (input.mode === "deny") { await stop("Declined at the PC"); return; }
    if (!allowed.token || !TOKEN.test(allowed.token) || allowed.agentPath !== "/v1/connector/live") throw new Error("Invalid connection setup");
    state.viewOnly = allowed.session.mode !== "control";
    const socket = new WebSocket(`${origin.replace(/^https:/,"wss:")}${allowed.agentPath}?t=${allowed.token}`);
    ws = socket;
    socket.onmessage = (event) => {
      let message: { type?: string; messages?: VisitorMessage[]; session?: RemoteSession; error?: string };
      try { message = JSON.parse(String(event.data)); } catch { return; }
      if (message.type === "pong") { lastPong = Date.now(); return; }
      if (message.type === "chat.updated" && Array.isArray(message.messages)) {
        const merged = new Map(state.messages.map((m) => [m.id,m]));
        for (const m of message.messages) merged.set(m.id,m);
        state.messages = [...merged.values()].sort((a,b) => a.id-b.id).slice(-500); publish();
      }
      if (message.type === "chat.error") { state.error = message.error ?? "Message could not be sent"; publish(); }
      if (message.type === "remote.updated" && message.session) {
        state.session = message.session;
        if (["ended","expired","denied"].includes(message.session.status)) { void stop("Support ended the session"); return; }
        publish();
      }
      if (relay) relay(message); else if (queued.length < 100) queued.push(message);
    };
    socket.onclose = () => { void stop("The connection to support ended"); };
    socket.onerror = () => { state.error = "The connection to support failed"; void stop(state.error); };
    await new Promise<void>((resolve,reject) => {
      const timeout = setTimeout(() => reject(new Error("Connecting to support timed out")),20_000);
      socket.addEventListener("open", () => { clearTimeout(timeout); resolve(); },{once:true});
      socket.addEventListener("close", () => { clearTimeout(timeout); reject(new Error("Support connection closed")); },{once:true});
    });
    if (state.ended) return;
    lastPong = Date.now();
    heartbeat = setInterval(() => { if (Date.now()-lastPong > 15_000) void stop("Support connection timed out"); else if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({type:"ping"})); },5000);
    remote!.handle({ type: "remote-start", sessionId: allowed.session.id, agentUrl: "", mode: allowed.session.mode ?? "view", iceServers: allowed.iceServers ?? [], agentName: allowed.session.requestedBy.name, maxMs: Math.min(allowed.maxMs ?? 3_600_000,3_600_000) });
  } catch (error) {
    await restorePolicy();
    state.error = error instanceof Error ? error.message : "Support could not connect";
    if (!consentToken) await stop("Support could not connect");
    throw new Error(state.error);
  } finally { busy = false; publish(); }
}
async function bootstrap() {
  if (app.commandLine.hasSwitch("bootstrap")) {
    const line = await new Promise<string>((resolve,reject) => {
      let text = "";
      const timeout = setTimeout(() => reject(new Error("The launcher did not send an invitation")),10_000);
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (part: string) => { text += part; if (text.length > 20_000) { clearTimeout(timeout); reject(new Error("Invalid launcher response")); process.stdin.pause(); } else if (text.includes("\n")) { clearTimeout(timeout); resolve(text.slice(0,text.indexOf("\n"))); process.stdin.pause(); } });
    });
    return JSON.parse(line) as { token: string; session: RemoteSession };
  }
  const code = app.commandLine.getSwitchValue("code"), token = app.commandLine.getSwitchValue("token");
  return request<{ token: string; session: RemoteSession }>("/v1/connector/redeem", code ? { code } : { token });
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", () => { win?.show(); win?.focus(); });
  app.on("before-quit", (event) => {
    if (closing) return;
    event.preventDefault(); closing = true;
    void stop("Connector closed").finally(() => app.quit());
  });
  await app.whenReady();
  if (process.platform !== "win32") throw new Error("Support Connector requires Windows");
  state.elevated = !!koffi.load("shell32.dll").func("bool __stdcall IsUserAnAdmin()")();
  win = new BrowserWindow({ width: 780, height: 680, minWidth: 520, minHeight: 520, title: "MasalaPOS Support", autoHideMenuBar: true,
    webPreferences: { preload: join(here,"preload.cjs"), sandbox: true, contextIsolation: true, nodeIntegration: false } });
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event) => event.preventDefault());
  win.webContents.on("render-process-gone", () => { void stop("Support window stopped"); });
  win.on("closed", () => { void stop("Support window closed"); app.quit(); });
  remote = new RemoteSupport({ here, injector: windowsInjector, log: () => {}, protectedWindows: () => win ? [win] : [],
    transport: { send: (message) => { if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message)); }, subscribe: (listener) => { relay = listener; for (const m of queued.splice(0)) listener(m); } },
    onMode: (viewOnly) => { state.viewOnly = viewOnly; publish(); },
    toServer: (message) => { if (message.type === "remote-stop-request" || message.state === "stopped") void stop("Stopped at the PC"); else { state.sharing = true; publish(); } } });
  ipcMain.handle("connector:state", (event) => { local(event); return state; });
  ipcMain.handle("connector:consent", async (event,input: unknown) => { local(event); await consent(input); });
  ipcMain.handle("connector:stop", async (event) => { local(event); await stop("Stopped at the PC"); });
  ipcMain.handle("connector:view-only", (event,on: unknown) => { local(event); if (typeof on !== "boolean") return; state.viewOnly = on || state.session?.mode !== "control"; remote?.setViewOnly(state.viewOnly); publish(); });
  ipcMain.handle("connector:chat", (event,body: unknown) => { local(event); if (typeof body !== "string" || !body.trim() || body.length > 2000 || state.ended || ws?.readyState !== WebSocket.OPEN) throw new Error("Cannot send this message"); ws.send(JSON.stringify({type:"chat.send",body:body.trim()})); });
  await win.loadFile(join(here,"renderer/index.html"));
  try {
    if (!state.elevated) throw new Error("Close this window and run the Support Connector launcher as administrator");
    const data = await bootstrap();
    if (!TOKEN.test(data.token) || !data.session?.id || data.session.origin !== "connector" || data.session.status !== "requested") throw new Error("The launcher invitation is invalid");
    state.session = data.session; consentToken = data.token;
  } catch (error) { state.error = error instanceof Error ? error.message : "Cannot open this invitation"; state.ended = true; }
  publish();
}
