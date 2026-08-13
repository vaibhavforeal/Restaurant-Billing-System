import { hashPassword, verifyPassword, can } from "@forkflow/core";
import { LoginBody, SetupBody, roleFor, uuidv7, type RoleName } from "@forkflow/domain";
import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerHookHandler } from "fastify";
import { randomBytes } from "node:crypto";

const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const THROTTLE_AFTER = 5;
const THROTTLE_START_MS = 2000;
const THROTTLE_MAX_MS = 60000;

interface ThrottleState {
  failures: number;
  cooldownUntil: number;
}

const loginThrottle = new Map<string, ThrottleState>();

export interface AuthedUser {
  id: string;
  name: string;
  role: RoleName;
}

interface SessionRow {
  user_id: string;
  expires_at: number;
  name: string;
  role: RoleName;
  is_active: number;
}

export function registerAuth(app: FastifyInstance): void {
  const createSession = (userId: string): string => {
    const token = randomBytes(32).toString("hex");
    const now = Date.now();
    // opportunistic housekeeping: drop expired sessions on each new login
    app.db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(now);
    app.db
      .prepare("INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)")
      .run(token, userId, now, now + SESSION_TTL_MS);
    return token;
  };

  const userForToken = (header: string | undefined): AuthedUser | null => {
    if (!header?.startsWith("Bearer ")) return null;
    const token = header.slice("Bearer ".length);
    const row = app.db
      .prepare(
        `SELECT s.user_id, s.expires_at, u.name, u.role, u.is_active
         FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.token = ?`,
      )
      .get(token) as SessionRow | undefined;
    if (!row || row.expires_at < Date.now() || !row.is_active) return null;
    return { id: row.user_id, name: row.name, role: row.role };
  };

  const requireAuth: preHandlerHookHandler = async (req: FastifyRequest, reply: FastifyReply) => {
    const user = userForToken(req.headers.authorization);
    if (!user) return reply.status(401).send({ error: "unauthenticated" });
    req.user = user;
  };

  app.decorate("requireAuth", requireAuth);
  app.decorate("requirePermission", (slug: string): preHandlerHookHandler => {
    return async (req, reply) => {
      const user = userForToken(req.headers.authorization);
      if (!user) return reply.status(401).send({ error: "unauthenticated" });
      if (!can(roleFor(user.role), slug)) {
        return reply.status(403).send({ error: "forbidden", permission: slug });
      }
      req.user = user;
    };
  });

  app.get("/api/needs-setup", async () => {
    // users-count is the canonical signal; settings.setup_complete is informational only
    const row = app.db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number };
    return { needsSetup: row.n === 0 };
  });

  app.post("/api/setup", async (req, reply) => {
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

    const token = createSession(id);
    return reply.status(201).send({ token, user: { id, name: body.adminName, role: "admin" } });
  });

  app.post("/api/login", async (req, reply) => {
    const { pin } = LoginBody.parse(req.body);
    const ip = req.ip;

    // Throttle: check if this IP is in cooldown
    const throttle = loginThrottle.get(ip);
    if (throttle && Date.now() < throttle.cooldownUntil) {
      return reply.status(429).send({ error: "too many attempts" });
    }

    const users = app.db
      .prepare("SELECT id, name, pin_hash, role FROM users WHERE is_active = 1")
      .all() as Array<{ id: string; name: string; pin_hash: string; role: RoleName }>;

    // PIN alone identifies the user (POS convention). Uniqueness will be enforced
    // when user creation lands (M2); until then the only users are setup-created admin + tests.
    for (const u of users) {
      if (await verifyPassword(pin, u.pin_hash)) {
        // Success: reset throttle
        loginThrottle.delete(ip);
        const token = createSession(u.id);
        return { token, user: { id: u.id, name: u.name, role: u.role } };
      }
    }

    // Failure: increment throttle counter
    const current = loginThrottle.get(ip) ?? { failures: 0, cooldownUntil: 0 };
    current.failures += 1;
    if (current.failures >= THROTTLE_AFTER) {
      const cooldownMs = Math.min(
        THROTTLE_START_MS * Math.pow(2, current.failures - THROTTLE_AFTER),
        THROTTLE_MAX_MS,
      );
      current.cooldownUntil = Date.now() + cooldownMs;
    }
    loginThrottle.set(ip, current);

    return reply.status(401).send({ error: "invalid pin" });
  });

  app.get("/api/me", { preHandler: requireAuth }, async (req) => ({ user: req.user }));

  app.post("/api/logout", { preHandler: requireAuth }, async (req, reply) => {
    const token = (req.headers.authorization ?? "").slice("Bearer ".length);
    app.db.prepare("DELETE FROM sessions WHERE token = ?").run(token);
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
