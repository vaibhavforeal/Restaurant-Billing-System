import { session } from "./api";

export interface WsHandlers {
  onEvent: (event: string, data: unknown) => void;
  onStatus: (connected: boolean) => void;
  onAuthFail?: () => void;
}

/** Auto-reconnecting WebSocket client. Backoff 1s..10s. Returns a dispose function. */
export function connectWs(handlers: WsHandlers): () => void {
  let ws: WebSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let backoffMs = 1000;
  let disposed = false;

  function connect() {
    if (disposed) return;
    const protocol = location.protocol === "https:" ? "wss" : "ws";
    const url = `${protocol}://${location.host}/api/ws`;
    ws = new WebSocket(url);

    ws.onopen = () => {
      // Send auth frame immediately
      const token = session.token ?? "";
      ws?.send(JSON.stringify({ type: "auth", token }));
    };

    ws.onmessage = (e) => {
      try {
        const { event, data } = JSON.parse(e.data);

        // Intercept auth.ok
        if (event === "auth.ok") {
          backoffMs = 1000;
          handlers.onStatus(true);
          return; // Do NOT forward to onEvent
        }

        handlers.onEvent(event, data);
      } catch {
        // ignore malformed messages
      }
    };

    ws.onclose = (e) => {
      if (disposed) return;

      // Fatal close on auth failure
      if (e.code === 4401) {
        handlers.onAuthFail?.();
        return; // No reconnect
      }

      handlers.onStatus(false);
      reconnectTimer = setTimeout(() => {
        backoffMs = Math.min(backoffMs * 2, 10000);
        connect();
      }, backoffMs);
    };

    ws.onerror = () => {
      ws?.close();
    };
  }

  connect();

  return () => {
    disposed = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    ws?.close();
  };
}
