import websocket from "@fastify/websocket";
import type { FastifyInstance } from "fastify";
import type { WebSocket } from "@fastify/websocket";
import { canSeeCustomers, sessionUser, withoutCustomers } from "./auth.js";
import { DevicePresence } from "./device-presence.js";

interface ClientInfo {
  token: string;
  userId: string;
  device: unknown;
  /** The device this socket counts for, fixed when it signed in; null for a browser that is not a device. */
  deviceId: string | null;
  /** Whether this person may view customers; refreshed whenever sockets are revalidated. */
  canSeeCustomers: boolean;
}

/** How often connected screens hear from the hub, even when nothing else happens. */
export const HEARTBEAT_MS = 20_000;

export function registerWs(app: FastifyInstance, authTimeoutMs: number = 5000, now: () => number = Date.now): void {
  const clients = new Map<WebSocket, ClientInfo>();
  // Sockets report that they closed after the server, and with it the database, has shut down. Nobody is left to tell
  // by then, and "last seen" cannot be written.
  let closing = false;
  app.addHook("preClose", async () => { closing = true; });
  const presence = new DevicePresence((deviceId, online) => {
    if (closing) return;
    // Builds without licensing never note when a device was last used, so going offline does.
    if (!online) app.devices.touch(deviceId, now());
    app.broadcast("devices.presence", { deviceId, online });
  });
  app.decorate("deviceOnline", (deviceId: string) => presence.online(deviceId));
  /** The one way a socket leaves the hub, so the hub closing it and the browser closing it count it out once. */
  const drop = (ws: WebSocket) => {
    const info = clients.get(ws);
    if (!info) return;
    clients.delete(ws);
    if (info.deviceId) presence.close(info.deviceId);
  };

  app.decorate("broadcast", (event: string, data: unknown) => {
    const msg = JSON.stringify({ event, data });
    let redacted: string | undefined;
    for (const [ws, info] of clients.entries()) {
      if (ws.readyState !== ws.OPEN) continue;
      ws.send(info.canSeeCustomers ? msg : (redacted ??= JSON.stringify({ event, data: withoutCustomers(data) })));
    }
  });

  app.decorate("wsRevalidate", () => {
    for (const [ws, info] of clients.entries()) {
      const user = sessionUser(app.db, info.token);
      if (!user) {
        ws.close(4401, "unauthenticated");
        drop(ws);
      } else if (!app.licensing.sessionAllowed(info.token, info.device) || !app.licensing.status(info.device).canOperate) {
        ws.close(4403, "device or license unavailable");
        drop(ws);
      } else {
        info.canSeeCustomers = canSeeCustomers(user);
      }
    }
  });

  // Sessions, licenses and permissions are rechecked every 60s, and immediately by the code that changes them (logout,
  // user and permission changes, license/device changes). Broadcasts do not recheck: that cost every client's session and
  // license verification on each event.
  const revalidateInterval = setInterval(() => {
    app.wsRevalidate();
  }, 60000);
  revalidateInterval.unref();
  // A heartbeat every 20 s lets counters tell a live connection from one the network silently dropped.
  const heartbeat = setInterval(() => app.broadcast("ping", {}), HEARTBEAT_MS);
  heartbeat.unref();
  app.addHook("onClose", () => { clearInterval(revalidateInterval); clearInterval(heartbeat); });

  app.register(websocket);
  app.register(async (scope) => {
    scope.get("/api/ws", { websocket: true }, (socket, _req) => {
      let authenticated = false;
      const timeout = setTimeout(() => {
        if (!authenticated) {
          socket.close(4401, "unauthenticated");
        }
      }, authTimeoutMs);

      socket.on("message", (raw: Buffer) => {
        if (authenticated) return; // Ignore subsequent frames

        try {
          const frame = JSON.parse(raw.toString()) as { type?: string; token?: string; device?: string };
          if (frame.type !== "auth" || typeof frame.token !== "string") {
            socket.close(4401, "unauthenticated");
            return;
          }

          const user = sessionUser(app.db, frame.token);
          if (!user) {
            socket.close(4401, "unauthenticated");
            return;
          }
          if (!app.licensing.sessionAllowed(frame.token, frame.device) || !app.licensing.status(frame.device).canOperate) {
            socket.close(4403, "device or license unavailable");
            return;
          }

          clearTimeout(timeout);
          authenticated = true;
          const deviceId = app.devices.findByCredential(frame.device)?.id ?? null;
          clients.set(socket, { token: frame.token, userId: user.id, device: frame.device, deviceId, canSeeCustomers: canSeeCustomers(user) });
          socket.send(JSON.stringify({ event: "auth.ok", data: {} }));
          if (deviceId) presence.open(deviceId);
        } catch {
          socket.close(4401, "unauthenticated");
        }
      });

      socket.on("close", () => {
        clearTimeout(timeout);
        drop(socket);
      });
    });
  });
}

declare module "fastify" {
  interface FastifyInstance {
    broadcast(event: string, data: unknown): void;
    wsRevalidate(): void;
    /** Whether the device has a signed-in screen connected right now. */
    deviceOnline(deviceId: string): boolean;
  }
}
