import websocket from "@fastify/websocket";
import type { FastifyInstance } from "fastify";
import type { WebSocket } from "@fastify/websocket";
import { sessionUser } from "./auth.js";

interface ClientInfo {
  token: string;
  userId: string;
}

export function registerWs(app: FastifyInstance, authTimeoutMs: number = 5000): void {
  const clients = new Map<WebSocket, ClientInfo>();

  app.decorate("broadcast", (event: string, data: unknown) => {
    const msg = JSON.stringify({ event, data });
    for (const ws of clients.keys()) {
      if (ws.readyState === ws.OPEN) ws.send(msg);
    }
  });

  app.decorate("wsRevalidate", () => {
    for (const [ws, info] of clients.entries()) {
      const user = sessionUser(app.db, info.token);
      if (!user) {
        ws.close(4401, "unauthenticated");
        clients.delete(ws);
      }
    }
  });

  // Periodic revalidation every 60s
  const revalidateInterval = setInterval(() => {
    app.wsRevalidate();
  }, 60000);
  revalidateInterval.unref();
  app.addHook("onClose", () => clearInterval(revalidateInterval));

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
          const frame = JSON.parse(raw.toString()) as { type?: string; token?: string };
          if (frame.type !== "auth" || typeof frame.token !== "string") {
            socket.close(4401, "unauthenticated");
            return;
          }

          const user = sessionUser(app.db, frame.token);
          if (!user) {
            socket.close(4401, "unauthenticated");
            return;
          }

          clearTimeout(timeout);
          authenticated = true;
          clients.set(socket, { token: frame.token, userId: user.id });
          socket.send(JSON.stringify({ event: "auth.ok", data: {} }));
        } catch {
          socket.close(4401, "unauthenticated");
        }
      });

      socket.on("close", () => {
        clearTimeout(timeout);
        clients.delete(socket);
      });
    });
  });
}

declare module "fastify" {
  interface FastifyInstance {
    broadcast(event: string, data: unknown): void;
    wsRevalidate(): void;
  }
}
