import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { MIGRATIONS, PLANS, migrate, openDb, type IntegrationId, type Plan } from "@forkflow/domain";
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

/** Turn a Marketplace integration on directly in the database (the first admin is recorded as the actor). */
export function enableIntegration(app: FastifyInstance, id: IntegrationId): void {
  const admin = app.db.prepare("SELECT id FROM users WHERE role='admin' ORDER BY created_at, id LIMIT 1").get() as { id: string } | undefined;
  if (!admin) throw new Error("enableIntegration needs an admin user; call setupAdmin first");
  app.db.prepare(`INSERT INTO integration_state (id, enabled, updated_at, updated_by) VALUES (?,1,?,?)
    ON CONFLICT(id) DO UPDATE SET enabled=1, updated_at=excluded.updated_at, updated_by=excluded.updated_by`).run(id, Date.now(), admin.id);
}

/** A commercial installation activated on `plan` with one registered device; requests must send `headers` (token + device). */
export async function commercialApp(plan: Plan) {
  const keys = generateKeyPairSync("ed25519");
  const installationId = randomUUID(), device = "d".repeat(64);
  const db = openDb(":memory:");
  migrate(db, MIGRATIONS);
  const app = buildServer({ db, licensing: { publicKey: keys.publicKey.export({ type: "spki", format: "pem" }).toString(), installationId } });
  const setup = await app.inject({ method: "POST", url: "/api/setup", payload: SETUP, headers: { "x-forkflow-device": device } });
  const headers = { authorization: `Bearer ${setup.json().token}`, "x-forkflow-device": device };
  const now = Date.now();
  const claims = { version: 1, installationId, licenseId: randomUUID(), organizationId: randomUUID(), outletId: randomUUID(), revision: 1, plan,
    maxDevices: PLANS[plan].maxDevices, features: PLANS[plan].features, issuedAt: now - 1000, expiresAt: now + 86_400_000, graceUntil: now + 2 * 86_400_000 };
  const message = `ff1.${Buffer.from(JSON.stringify(claims)).toString("base64url")}`;
  const license = `${message}.${sign(null, Buffer.from(message), keys.privateKey).toString("base64url")}`;
  const activated = await app.inject({ method: "PUT", url: "/api/license", payload: { license }, headers });
  if (activated.statusCode !== 200) throw new Error(`commercialApp activation failed: ${activated.body}`);
  const registered = await app.inject({ method: "POST", url: "/api/license/devices", payload: { name: "Counter" }, headers });
  if (registered.statusCode !== 200) throw new Error(`commercialApp device registration failed: ${registered.body}`);
  return { app, headers };
}
