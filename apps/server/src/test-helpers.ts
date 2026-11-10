import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { MIGRATIONS, PLANS, featuresFromModules, migrate, openDb, resolveModules, type DeviceKind, type ModuleOverrides, type IntegrationId, type Plan } from "@masalapos/domain";
import type { FastifyInstance } from "fastify";
import { buildServer, type ServerOptions } from "./server.js";
import { makeFakeSink } from "./print/sinks.js";

export function freshApp(): FastifyInstance {
  const db = openDb(":memory:");
  migrate(db, MIGRATIONS);
  return buildServer({ db });
}

export function freshAppWithFakeSink(options: Partial<Omit<ServerOptions, "db" | "sinkSend">> = {}): {
  app: FastifyInstance;
  fake: ReturnType<typeof makeFakeSink>;
} {
  const db = openDb(":memory:");
  migrate(db, MIGRATIONS);
  const fake = makeFakeSink();
  const app = buildServer({ ...options, db, sinkSend: fake.send });
  return { app, fake };
}

/** The restaurant details first-run setup requires. */
export const SETUP_PROFILE = { restaurantName: "Cafe Test", address: "12 MG Road", city: "Bengaluru", stateCode: "29", pincode: "560001", phone: "9845012345" };
/** The first admin, Asha: signs in as admin / admin-password and approves with PIN 1234. */
export const SETUP = { ...SETUP_PROFILE, adminName: "Asha", username: "admin", password: "admin-password", pin: "1234" };
export const ADMIN_LOGIN = { username: SETUP.username, password: SETUP.password };

export async function setupAdmin(app: FastifyInstance) {
  const res = await app.inject({ method: "POST", url: "/api/setup", payload: SETUP });
  return res.json() as { token: string; user: { id: string; name: string; role: string } };
}

export function auth(token: string) {
  return { authorization: `Bearer ${token}` };
}

/** The sign-in a test user gets from `createUser`: a username from their name, and a password from their test PIN. */
export const testLogin = (u: { name: string; pin: string }) => ({
  username: u.name.toLowerCase().replace(/[^a-z0-9]/g, "").padEnd(3, "x").slice(0, 32),
  password: `password-${u.pin}`,
});

/**
 * Create a user via the API and sign them in; returns their token + id. Tests describe people by name and PIN: the PIN becomes
 * an admin's approval PIN, and `testLogin` turns name and PIN into the username and password they sign in with.
 */
export async function createUser(
  app: FastifyInstance,
  adminToken: string,
  u: { name: string; pin: string; role: "admin" | "cashier" | "waiter" | "kitchen" },
) {
  const login = testLogin(u);
  const payload = { name: u.name, role: u.role, ...login, ...(u.role === "admin" ? { pin: u.pin } : {}) };
  const created = await app.inject({ method: "POST", url: "/api/users", payload, headers: auth(adminToken) });
  if (created.statusCode !== 201) throw new Error(`createUser failed: ${created.body}`);
  const signedIn = await app.inject({ method: "POST", url: "/api/login", payload: login });
  const { token } = signedIn.json() as { token: string };
  return { id: (created.json() as { user: { id: string } }).user.id, token };
}

/** Opens a socket and signs it in. `device` is the browser's device credential, as the POS sends it. */
export async function wsAuth(app: FastifyInstance, token: string, device?: string): Promise<import("@fastify/websocket").WebSocket> {
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
  ws.send(JSON.stringify({ type: "auth", token, ...(device ? { device } : {}) }));

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

/** Joins another browser as a device, the way staff do it: an admin (`adminHeaders`) makes a code and the new browser enters it. */
export async function joinDevice(app: FastifyInstance, adminHeaders: Record<string, string>, credential: string,
  device: { kind: DeviceKind; name: string } = { kind: "counter", name: "Counter 2" }): Promise<void> {
  const made = await app.inject({ method: "POST", url: "/api/devices/join-codes", payload: device, headers: adminHeaders });
  if (made.statusCode !== 201) throw new Error(`joinDevice could not make a code: ${made.body}`);
  const joined = await app.inject({ method: "POST", url: "/api/devices/join", payload: { code: (made.json() as { code: string }).code }, headers: { "x-masalapos-device": credential } });
  if (joined.statusCode !== 200) throw new Error(`joinDevice could not join: ${joined.body}`);
}

/** Turn a Marketplace integration on directly in the database (the first admin is recorded as the actor). */
export function enableIntegration(app: FastifyInstance, id: IntegrationId): void {
  const admin = app.db.prepare("SELECT id FROM users WHERE role='admin' ORDER BY created_at, id LIMIT 1").get() as { id: string } | undefined;
  if (!admin) throw new Error("enableIntegration needs an admin user; call setupAdmin first");
  app.db.prepare(`INSERT INTO integration_state (id, enabled, updated_at, updated_by) VALUES (?,1,?,?)
    ON CONFLICT(id) DO UPDATE SET enabled=1, updated_at=excluded.updated_at, updated_by=excluded.updated_by`).run(id, Date.now(), admin.id);
}

/**
 * A commercial installation activated on `plan`. The browser that set it up is its one device, the main counter ("Main counter");
 * requests must send `headers` (token + device).
 * `overrides` are the MasalaPOS owner's module choices signed into the licence.
 */
export async function commercialApp(plan: Plan, overrides: ModuleOverrides = {}) {
  const keys = generateKeyPairSync("ed25519");
  const installationId = randomUUID(), device = "d".repeat(64);
  const db = openDb(":memory:");
  migrate(db, MIGRATIONS);
  const app = buildServer({ db, licensing: { publicKey: keys.publicKey.export({ type: "spki", format: "pem" }).toString(), installationId } });
  const setup = await app.inject({ method: "POST", url: "/api/setup", payload: SETUP, headers: { "x-masalapos-device": device } });
  const headers = { authorization: `Bearer ${setup.json().token}`, "x-masalapos-device": device };
  const now = Date.now();
  const claims = { version: 1, installationId, licenseId: randomUUID(), organizationId: randomUUID(), outletId: randomUUID(), revision: 1, plan,
    maxDevices: PLANS[plan].maxDevices, features: featuresFromModules(resolveModules(plan, overrides)), modules: resolveModules(plan, overrides), issuedAt: now - 1000, expiresAt: now + 86_400_000, graceUntil: now + 2 * 86_400_000 };
  const message = `ff1.${Buffer.from(JSON.stringify(claims)).toString("base64url")}`;
  const license = `${message}.${sign(null, Buffer.from(message), keys.privateKey).toString("base64url")}`;
  const activated = await app.inject({ method: "PUT", url: "/api/license", payload: { license }, headers });
  if (activated.statusCode !== 200) throw new Error(`commercialApp activation failed: ${activated.body}`);
  return { app, headers };
}
