import { hashPassword, verifyPassword } from "@masalapos/core";
import { KNOWN_PERMISSIONS, LoginBody, SetupBody, effectivePermissions, staffCan, uuidv7, type PermissionOverrides, type RoleName, type Database } from "@masalapos/domain";
import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerHookHandler } from "fastify";
import { randomBytes } from "node:crypto";
import { deviceHash, enrollBody } from "./licensing.js";
import { createPinThrottle } from "./pin-throttle.js";

const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
export interface AuthedUser {
  id: string;
  name: string;
  role: RoleName;
  /** Every known permission this person holds: their role's, with the admin's changes for them applied. */
  permissions: string[];
}

/** The admin's per-person changes for one staff member (slug → allowed). */
export function permissionOverrides(db: Database, userId: string): PermissionOverrides {
  const rows = db.prepare("SELECT permission, allowed FROM user_permissions WHERE user_id = ?").all(userId) as Array<{ permission: string; allowed: number }>;
  return Object.fromEntries(rows.map((r) => [r.permission, r.allowed === 1]));
}

export const authedUser = (db: Database, row: { id: string; name: string; role: RoleName }): AuthedUser =>
  ({ id: row.id, name: row.name, role: row.role, permissions: effectivePermissions(row.role, permissionOverrides(db, row.id)) });

/**
 * Whether the signed-in person may do something. Known permissions come from their resolved list; anything else falls back
 * to their role, since per-person changes only exist for known permissions.
 */
export function userCan(user: AuthedUser, slug: string): boolean {
  return KNOWN_PERMISSIONS.includes(slug) ? user.permissions.includes(slug) : staffCan(user.role, {}, slug);
}

interface SessionRow {
  device: string | null;
  user_id: string;
  expires_at: number;
  name: string;
  role: RoleName;
  is_active: number;
}

/** The live session's user plus the device it was created on, from a single lookup. */
function sessionRecord(db: Database, token: string): { user: AuthedUser; device: string | null } | null {
  const row = db
    .prepare(
      `SELECT s.user_id, s.expires_at, s.device, u.name, u.role, u.is_active
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token = ?`,
    )
    .get(token) as SessionRow | undefined;
  if (!row || row.expires_at < Date.now() || !row.is_active) return null;
  return { user: authedUser(db, { id: row.user_id, name: row.name, role: row.role }), device: row.device };
}

export function sessionUser(db: Database, token: string): AuthedUser | null {
  return sessionRecord(db, token)?.user ?? null;
}

export function registerAuth(app: FastifyInstance, demo = false): void {
  // Plugin-scoped: each server instance gets its own throttle state. Admin approval of refunds and voids has an independent
  // counter, so a successful sign-in can never reset approval failures.
  const throttle = createPinThrottle();
  app.decorate("loginThrottle", throttle);
  app.decorate("approvalThrottle", createPinThrottle());
  // Activation at setup needs no sign-in, so wrong Customer ID / Order ID guesses from the LAN are slowed down like wrong PINs.
  const activationThrottle = createPinThrottle();

  const createSession = (userId: string, credential: unknown): string => {
    const token = randomBytes(32).toString("hex");
    const now = Date.now();
    // opportunistic housekeeping: drop expired sessions on each new login
    app.db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(now);
    app.db
      .prepare("INSERT INTO sessions (token, user_id, created_at, expires_at, device) VALUES (?, ?, ?, ?, ?)")
      .run(token, userId, now, now + SESSION_TTL_MS, deviceHash(credential));
    return token;
  };

  /** The signed-in user for this request, or null when the token is missing, expired, or from another device. */
  const authenticate = (req: FastifyRequest): AuthedUser | null => {
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) return null;
    const session = sessionRecord(app.db, header.slice("Bearer ".length));
    if (!session || !app.licensing.deviceAllowed(session.device, req.headers["x-masalapos-device"])) return null;
    return session.user;
  };

  const requireAuth: preHandlerHookHandler = async (req: FastifyRequest, reply: FastifyReply) => {
    const user = authenticate(req);
    if (!user) return reply.status(401).send({ error: "unauthenticated" });
    req.user = user;
    app.licensing.assertAccess(req);
  };

  app.decorate("requireAuth", requireAuth);
  app.decorate("requirePermission", (slug: string): preHandlerHookHandler => {
    return async (req, reply) => {
      const user = authenticate(req);
      if (!user) return reply.status(401).send({ error: "unauthenticated" });
      if (!userCan(user, slug)) {
        return reply.status(403).send({ error: "forbidden", permission: slug });
      }
      req.user = user;
      app.licensing.assertAccess(req);
    };
  });

  const noUsers = () => (app.db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number }).n === 0;
  app.get("/api/needs-setup", async () => {
    // users-count is the canonical signal; settings.setup_complete is informational only
    const needsSetup = noUsers();
    if (!needsSetup) return { needsSetup, ...(demo ? { demo: true } : {}) };
    // How setup starts: "online" asks for the Customer ID and Order ID, "offline" (no licensing service in this build) uses a licence
    // file after setup, and "none" (development and demo builds) needs no activation.
    const status = app.licensing.status();
    return {
      needsSetup, ...(demo ? { demo: true } : {}),
      activation: status.mode === "development" ? "none" : status.onlineActivation ? "online" : "offline",
      licensed: status.state === "active" || status.state === "grace" || status.state === "development",
    };
  });

  // The first step of setup on a commercial counter. Open only until the first user exists, so it can never become a way round sign-in.
  app.post("/api/setup/activate", async (req, reply) => {
    if (!app.licensing.enabled) return reply.status(409).send({ error: "This build does not need activation" });
    if (!deviceHash(req.headers["x-masalapos-device"])) return reply.status(400).send({ error: "A device credential is required" });
    if (!noUsers()) return reply.status(409).send({ error: "already set up" });
    const body = enrollBody.parse(req.body);
    if (!activationThrottle.beginPinAttempt(req.ip)) return reply.status(429).send({ error: "Too many attempts. Wait a minute and try again." });
    reply.header("Cache-Control", "no-store");
    const result = await app.licensing.enroll(body, "Setup");
    if ("error" in result) return reply.status(result.status).send({ error: result.error });
    activationThrottle.clearPinFailures(req.ip);
    return result;
  });

  app.post("/api/setup", async (req, reply) => {
    if (app.licensing.enabled && !deviceHash(req.headers["x-masalapos-device"])) return reply.status(400).send({ error: "A device credential is required" });
    const body = SetupBody.parse(req.body);
    const existing = app.db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number };
    if (existing.n > 0) return reply.status(409).send({ error: "already set up" });

    const id = uuidv7();
    const pinHash = await hashPassword(body.pin);
    const write = app.db.transaction(() => {
      // TOCTOU guard: recheck user count after async hashing
      const recheck = app.db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number };
      if (recheck.n > 0) {
        const err = new Error("already set up") as Error & { statusCode: number };
        err.statusCode = 409;
        throw err;
      }
      app.db
        .prepare("INSERT INTO users (id, name, pin_hash, role, created_at) VALUES (?, ?, ?, 'admin', ?)")
        .run(id, body.adminName, pinHash, Date.now());
      app.db
        .prepare("UPDATE settings SET restaurant_name = ?, setup_complete = 1 WHERE id = 1")
        .run(body.restaurantName);
    });
    write();

    // A counter activated in the first step of setup registers the browser that set it up, so the admin lands straight in.
    const credential = req.headers["x-masalapos-device"];
    if (app.licensing.enabled) {
      const status = app.licensing.status(credential);
      if ((status.state === "active" || status.state === "grace") && status.registeredDevices === 0) {
        try { app.licensing.register(credential, "Main counter", body.adminName); app.licensing.announceChange(); }
        catch { /* The admin can still register it from Plan and devices. */ }
      }
    }

    const token = createSession(id, credential);
    return reply.status(201).send({ token, user: authedUser(app.db, { id, name: body.adminName, role: "admin" }) });
  });

  app.post("/api/login", async (req, reply) => {
    if (app.licensing.enabled && !deviceHash(req.headers["x-masalapos-device"])) return reply.status(400).send({ error: "A device credential is required" });
    const { pin } = LoginBody.parse(req.body);
    const ip = req.ip;

    // Throttle: refuse while this IP is in cooldown; otherwise count the attempt as a failure now, before the async PIN
    // checks, so parallel wrong PINs cannot all slip past this check. A right PIN clears it below.
    if (!throttle.beginPinAttempt(ip)) {
      return reply.status(429).send({ error: "too many attempts" });
    }

    const users = app.db
      .prepare("SELECT id, name, pin_hash, role FROM users WHERE is_active = 1")
      .all() as Array<{ id: string; name: string; pin_hash: string; role: RoleName }>;

    // PIN alone identifies the user (POS convention). Uniqueness across all
    // users is enforced at creation/PIN-change time — see users.ts pinInUse().
    for (const u of users) {
      if (await verifyPassword(pin, u.pin_hash)) {
        // Success: reset throttle
        throttle.clearPinFailures(ip);
        const token = createSession(u.id, req.headers["x-masalapos-device"]);
        return { token, user: authedUser(app.db, { id: u.id, name: u.name, role: u.role }) };
      }
    }

    // Failure: already counted by beginPinAttempt
    return reply.status(401).send({ error: "invalid pin" });
  });

  app.get("/api/me", { preHandler: requireAuth }, async (req) => ({ user: req.user }));

  app.post("/api/logout", { preHandler: requireAuth }, async (req, reply) => {
    const token = (req.headers.authorization ?? "").slice("Bearer ".length);
    app.db.prepare("DELETE FROM sessions WHERE token = ?").run(token);
    app.wsRevalidate();  // NEW: close this user's WS sockets
    return reply.status(204).send();
  });
}

declare module "fastify" {
  interface FastifyInstance {
    requireAuth: preHandlerHookHandler;
    requirePermission(slug: string): preHandlerHookHandler;
  }
  interface FastifyRequest {
    user: AuthedUser;
  }
}
