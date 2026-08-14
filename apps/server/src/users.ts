import { hashPassword, verifyPassword } from "@forkflow/core";
import { UserCreate, UserUpdate, uuidv7, type RoleName } from "@forkflow/domain";
import type { FastifyInstance } from "fastify";
import { httpError } from "./http-error.js";

interface UserRow {
  id: string;
  name: string;
  role: RoleName;
  is_active: number;
  created_at: number;
  pin_hash: string;
}

const toUser = (r: UserRow) => ({
  id: r.id,
  name: r.name,
  role: r.role,
  isActive: r.is_active === 1,
  createdAt: r.created_at,
});

export function registerUsers(app: FastifyInstance): void {
  const manage = app.requirePermission("users.manage");

  const getUser = (id: string) =>
    app.db.prepare("SELECT * FROM users WHERE id = ?").get(id) as UserRow | undefined;

  // PIN alone identifies a user at login, so a PIN must be unique across ALL
  // users — inactive included, because reactivation cannot re-verify a PIN we
  // only hold hashed. Salted hashes preclude a unique index; scan instead.
  async function pinInUse(pin: string, excludeId?: string): Promise<boolean> {
    const rows = app.db.prepare("SELECT id, pin_hash FROM users").all() as Array<{ id: string; pin_hash: string }>;
    for (const row of rows) {
      if (row.id === excludeId) continue;
      if (await verifyPassword(pin, row.pin_hash)) return true;
    }
    return false;
  }

  app.get("/api/users", { preHandler: manage }, async () => {
    const rows = app.db.prepare("SELECT * FROM users ORDER BY created_at").all() as UserRow[];
    return { users: rows.map(toUser) };
  });

  app.post("/api/users", { preHandler: manage }, async (req, reply) => {
    const body = UserCreate.parse(req.body);
    if (await pinInUse(body.pin)) throw httpError(409, "PIN already in use");
    const id = uuidv7();
    app.db
      .prepare("INSERT INTO users (id, name, pin_hash, role, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(id, body.name, await hashPassword(body.pin), body.role, Date.now());
    return reply.status(201).send({ user: toUser(getUser(id)!) });
  });

  app.patch("/api/users/:id", { preHandler: manage }, async (req) => {
    const { id } = req.params as { id: string };
    const body = UserUpdate.parse(req.body);
    const row = getUser(id);
    if (!row) throw httpError(404, "user not found");

    // Lockout guard: the last active admin can be neither deactivated nor demoted.
    const wasActiveAdmin = row.role === "admin" && row.is_active === 1;
    const staysActiveAdmin = (body.role ?? row.role) === "admin" && (body.isActive ?? row.is_active === 1);
    if (wasActiveAdmin && !staysActiveAdmin) {
      const others = app.db
        .prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND is_active = 1 AND id != ?")
        .get(id) as { n: number };
      if (others.n === 0) throw httpError(409, "cannot remove the last admin");
    }

    if (body.pin && (await pinInUse(body.pin, id))) throw httpError(409, "PIN already in use");
    const pinHash = body.pin ? await hashPassword(body.pin) : row.pin_hash;

    app.db
      .prepare("UPDATE users SET name = ?, role = ?, is_active = ?, pin_hash = ? WHERE id = ?")
      .run(body.name ?? row.name, body.role ?? row.role, (body.isActive ?? row.is_active === 1) ? 1 : 0, pinHash, id);
    return { user: toUser(getUser(id)!) };
  });
}
