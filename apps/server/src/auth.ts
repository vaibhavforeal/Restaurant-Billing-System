import { hashPassword, verifyPassword, can } from "@forkflow/core";
import { LoginBody, SetupBody, roleFor, uuidv7, type RoleName, type Database } from "@forkflow/domain";
import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerHookHandler } from "fastify";
import { randomBytes } from "node:crypto";
import { deviceHash } from "./licensing.js";
import { createPinThrottle } from "./pin-throttle.js";

const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
export interface AuthedUser {
  id: string;
  name: string;
  role: RoleName;
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
  return { user: { id: row.user_id, name: row.name, role: row.role }, device: row.device };
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
    if (!session || !app.licensing.deviceAllowed(session.device, req.headers["x-forkflow-device"])) return null;
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
      if (!can(roleFor(user.role), slug)) {
        return reply.status(403).send({ error: "forbidden", permission: slug });
      }
      req.user = user;
      app.licensing.assertAccess(req);
    };
  });

  app.get("/api/needs-setup", async () => {
    // users-count is the canonical signal; settings.setup_complete is informational only
    const row = app.db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number };
    return { needsSetup: row.n === 0, ...(demo ? { demo: true } : {}) };
  });

  app.post("/api/setup", async (req, reply) => {
    if (app.licensing.enabled && !deviceHash(req.headers["x-forkflow-device"])) return reply.status(400).send({ error: "A device credential is required" });
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

    const token = createSession(id, req.headers["x-forkflow-device"]);
    return reply.status(201).send({ token, user: { id, name: body.adminName, role: "admin" } });
  });

  app.post("/api/login", async (req, reply) => {
    if (app.licensing.enabled && !deviceHash(req.headers["x-forkflow-device"])) return reply.status(400).send({ error: "A device credential is required" });
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
        const token = createSession(u.id, req.headers["x-forkflow-device"]);
        return { token, user: { id: u.id, name: u.name, role: u.role } };
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
