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

  // PIN uniqueness requires async verification of salted hashes. Keep all staff
  // mutations in one instance-local queue, without holding SQLite across awaits.
  let tail: Promise<void> = Promise.resolve();
  function serializeUserMutation<T>(work: () => Promise<T>): Promise<T> {
    const next = tail.then(work, work);
    tail = next.then(() => undefined, () => undefined);
    return next;
  }

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
    const user = await serializeUserMutation(async () => {
      app.assertPermission(req, "users.manage");
      if (await pinInUse(body.pin)) throw httpError(409, "PIN already in use");
      const pinHash = await hashPassword(body.pin);
      return app.db.transaction(() => {
        app.assertPermission(req, "users.manage");
        const id = uuidv7();
        app.db
          .prepare("INSERT INTO users (id, name, pin_hash, role, created_at) VALUES (?, ?, ?, ?, ?)")
          .run(id, body.name, pinHash, body.role, Date.now());
        return toUser(getUser(id)!);
      })();
    });
    return reply.status(201).send({ user });
  });

  app.patch("/api/users/:id", { preHandler: manage }, async (req) => {
    const { id } = req.params as { id: string };
    const body = UserUpdate.parse(req.body);
    return serializeUserMutation(async () => {
      app.assertPermission(req, "users.manage");
      if (!getUser(id)) throw httpError(404, "user not found");
      if (body.pin && (await pinInUse(body.pin, id))) throw httpError(409, "PIN already in use");
      const pinHash = body.pin ? await hashPassword(body.pin) : undefined;

      const result = app.db.transaction(() => {
        // Authority and target fields can change while password work is pending.
        // Keep the final checks and write synchronous in the same transaction.
        app.assertPermission(req, "users.manage");
        const row = getUser(id);
        if (!row) throw httpError(404, "user not found");
        const role = body.role ?? row.role;
        const isActive = body.isActive ?? row.is_active === 1;
        if (row.role === "admin" && row.is_active === 1 && (role !== "admin" || !isActive)) {
          const others = app.db
            .prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND is_active = 1 AND id != ?")
            .get(id) as { n: number };
          if (others.n === 0) throw httpError(409, "cannot remove the last admin");
        }

        app.db
          .prepare("UPDATE users SET name = ?, role = ?, is_active = ?, pin_hash = ? WHERE id = ?")
          .run(body.name ?? row.name, role, isActive ? 1 : 0, pinHash ?? row.pin_hash, id);
        return { user: toUser(getUser(id)!), deactivated: row.is_active === 1 && !isActive };
      })();

      if (result.deactivated) app.wsRevalidate();
      if (body.isActive === false || (body.role !== undefined && body.role !== "waiter")) app.broadcast("table.changed", {});
      return { user: result.user };
    });
  });
}
