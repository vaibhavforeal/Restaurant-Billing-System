import { MIGRATIONS, migrate, openDb } from "@forkflow/domain";
import type { FastifyInstance } from "fastify";
import { buildServer } from "./server.js";
import { makeFakeSink } from "./print/sinks.js";

export function freshApp(): FastifyInstance {
  const db = openDb(":memory:");
  migrate(db, MIGRATIONS);
  return buildServer({ db });
}

export function freshAppWithFakeSink(): {
  app: FastifyInstance;
  fake: ReturnType<typeof makeFakeSink>;
} {
  const db = openDb(":memory:");
  migrate(db, MIGRATIONS);
  const fake = makeFakeSink();
  const app = buildServer({ db, sinkSend: fake.send });
  return { app, fake };
}

export const SETUP = { restaurantName: "Cafe Test", adminName: "Asha", pin: "1234" };

export async function setupAdmin(app: FastifyInstance) {
  const res = await app.inject({ method: "POST", url: "/api/setup", payload: SETUP });
  return res.json() as { token: string; user: { id: string; name: string; role: string } };
}

export function auth(token: string) {
  return { authorization: `Bearer ${token}` };
}

/** Create a user via the API and log them in; returns their token + id. */
export async function createUser(
  app: FastifyInstance,
  adminToken: string,
  u: { name: string; pin: string; role: "admin" | "cashier" | "waiter" | "kitchen" },
) {
  const created = await app.inject({ method: "POST", url: "/api/users", payload: u, headers: auth(adminToken) });
  if (created.statusCode !== 201) throw new Error(`createUser failed: ${created.body}`);
  const login = await app.inject({ method: "POST", url: "/api/login", payload: { pin: u.pin } });
  const { token } = login.json() as { token: string };
  return { id: (created.json() as { user: { id: string } }).user.id, token };
}

export async function wsAuth(app: FastifyInstance, token: string): Promise<import("@fastify/websocket").WebSocket> {
  const ws = await app.injectWS("/api/ws");

  // Wait for connection to open
  await new Promise<void>((resolve) => {
    if (ws.readyState === ws.OPEN) {
      resolve();
    } else {
      ws.on("open", () => resolve());
    }
  });

  // Send auth frame
  ws.send(JSON.stringify({ type: "auth", token }));

  // Wait for auth.ok
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("auth.ok timeout")), 1000);
    ws.on("message", (raw: Buffer) => {
      try {
        const msg = JSON.parse(raw.toString()) as { event?: string };
        if (msg.event === "auth.ok") {
          clearTimeout(timeout);
          resolve();
        }
      } catch {
        // ignore non-JSON
      }
    });
  });

  return ws;
}
