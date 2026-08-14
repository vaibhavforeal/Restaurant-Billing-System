import websocket from "@fastify/websocket";
import type { FastifyInstance } from "fastify";
import type { WebSocket } from "@fastify/websocket";
import { sessionUser } from "./auth.js";

export function registerWs(app: FastifyInstance): void {
  const clients = new Set<WebSocket>();
  app.decorate("broadcast", (event: string, data: unknown) => {
    const msg = JSON.stringify({ event, data });
    for (const ws of clients) {
      if (ws.readyState === ws.OPEN) ws.send(msg);
    }
  });
  app.register(websocket);
  app.register(async (scope) => {
    scope.get("/api/ws", { websocket: true }, (socket, req) => {
      const { token } = req.query as { token?: string };
      if (!token || !sessionUser(app.db, token)) {
        socket.close(4401, "unauthenticated");
        return;
      }
      clients.add(socket);
      socket.on("close", () => clients.delete(socket));
    });
  });
}

declare module "fastify" {
  interface FastifyInstance {
    broadcast(event: string, data: unknown): void;
  }
}
