import { session, deviceCredential } from "./api";

export interface WsHandlers {
  onEvent: (event: string, data: unknown) => void;
  onStatus: (connected: boolean) => void;
  onAuthFail?: () => void;
}

/** How long the socket stays open after its last subscriber leaves, so a screen swap does not reconnect. */
const CLOSE_GRACE_MS = 1000;

const subscribers = new Set<WsHandlers>();
let ws: WebSocket | null = null;
/** The session token the current socket authenticated with; a different signed-in token needs a new socket. */
let socketToken: string | null = null;
let connected = false;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let closeTimer: ReturnType<typeof setTimeout> | null = null;
let backoffMs = 1000;

/** Call every current subscriber; one failing handler must not starve the rest. */
function notify(call: (handlers: WsHandlers) => void) {
  for (const handlers of [...subscribers]) {
    try { call(handlers); } catch (error) { console.error(error); }
  }
}

function teardown() {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  if (closeTimer) clearTimeout(closeTimer);
  reconnectTimer = closeTimer = null;
  if (ws) { ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null; ws.close(); }
  ws = null; socketToken = null; connected = false; backoffMs = 1000;
}

function connect() {
  const protocol = location.protocol === "https:" ? "wss" : "ws";
  const token = session.token ?? "";
  const socket = new WebSocket(`${protocol}://${location.host}/api/ws`);
  ws = socket; socketToken = token;

  socket.onopen = () => {
    // Send auth frame immediately
    socket.send(JSON.stringify({ type: "auth", token, device: deviceCredential() }));
  };

  socket.onmessage = (e) => {
    let message: { event: string; data: unknown };
    try { message = JSON.parse(e.data); } catch { return; } // ignore malformed messages
    // Intercept auth.ok
    if (message.event === "auth.ok") {
      backoffMs = 1000; connected = true;
      notify((h) => h.onStatus(true));
      return; // Do NOT forward to onEvent
    }
    if (message.event === "license.changed") window.dispatchEvent(new Event("forkflow:license-changed"));
    notify((h) => h.onEvent(message.event, message.data));
  };

  socket.onclose = (e) => {
    if (ws !== socket) return;
    connected = false; ws = null;
    // Fatal close on auth failure
    if (e.code === 4401) {
      socketToken = null;
      notify((h) => h.onAuthFail?.());
      return; // No reconnect
    }
    notify((h) => h.onStatus(false));
    if (e.code === 4403) {
      socketToken = null;
      window.dispatchEvent(new Event("forkflow:license-changed"));
      return;
    }
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      backoffMs = Math.min(backoffMs * 2, 10000);
      if (subscribers.size > 0) connect();
    }, backoffMs);
  };

  socket.onerror = () => {
    socket.close();
  };
}

/**
 * Subscribe to server events over one shared, auto-reconnecting WebSocket (backoff 1s..10s). Every caller shares the
 * same socket; it opens with the first subscriber and closes shortly after the last one leaves. Returns a dispose function.
 */
export function connectWs(handlers: WsHandlers): () => void {
  if (closeTimer) { clearTimeout(closeTimer); closeTimer = null; }
  // A socket left over from another sign-in (or one that ended on an auth/licence close) cannot be reused.
  if (socketToken !== (session.token ?? "")) teardown();
  subscribers.add(handlers);
  if (!ws && !reconnectTimer) connect();
  else if (connected) queueMicrotask(() => { if (connected && subscribers.has(handlers)) handlers.onStatus(true); });

  return () => {
    if (!subscribers.delete(handlers) || subscribers.size > 0) return;
    closeTimer = setTimeout(teardown, CLOSE_GRACE_MS);
  };
}
