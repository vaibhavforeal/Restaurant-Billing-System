import { hashPassword, verifyPassword } from "@masalapos/core";
import { ADMIN_ONLY_PERMISSIONS, ADMIN_PIN_MESSAGE, PERMISSION_AREAS, PermissionOverridesSchema, UserCreate, UserUpdate, effectivePermissions, normaliseOverrides, roleDefaults, uuidv7, type RoleName } from "@masalapos/domain";
import { z } from "zod";
import { permissionOverrides } from "./auth.js";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { httpError } from "./http-error.js";

interface UserRow {
  id: string;
  name: string;
  username: string | null;
  role: RoleName;
  is_active: number;
  created_at: number;
  pin_hash: string;
  password_hash: string;
  max_discount_percent: number | null;
}

const toUser = (r: UserRow) => ({
  id: r.id,
  name: r.name,
  username: r.username ?? "",
  role: r.role,
  isActive: r.is_active === 1,
  createdAt: r.created_at,
  maxDiscountPercent: r.max_discount_percent,
});

const currentToken = (req: FastifyRequest) => (req.headers.authorization ?? "").slice("Bearer ".length);

export function registerUsers(app: FastifyInstance): void {
  const manage = app.requirePermission("users.manage");

  const getUser = (id: string) =>
    app.db.prepare("SELECT * FROM users WHERE id = ?").get(id) as UserRow | undefined;

  // An approval PIN tells the server which admin approved, so it must be unique among admins with a PIN — inactive included,
  // because reactivation cannot re-verify a PIN we only hold hashed. Salted hashes preclude a unique index; scan instead.
  // Checking each hash is async, so another request can save a PIN meanwhile: the write re-reads the admins in its transaction
  // and goes ahead only when every other PIN has been checked, otherwise it checks the new ones first.
  async function writeWithUniquePin<T>(pin: string, excludeId: string | undefined, write: (pinHash: string) => T): Promise<T> {
    const checked = new Map<string, string>(); // user id → the pin_hash already found not to match
    const unchecked = () => (app.db.prepare("SELECT id, pin_hash FROM users WHERE role = 'admin' AND pin_hash != ''").all() as Array<{ id: string; pin_hash: string }>)
      .filter((row) => row.id !== excludeId && checked.get(row.id) !== row.pin_hash);
    let pinHash: string | undefined;
    for (;;) {
      for (const row of unchecked()) {
        if (await verifyPassword(pin, row.pin_hash)) throw httpError(409, "Another admin uses this approval PIN");
        checked.set(row.id, row.pin_hash);
      }
      pinHash ??= await hashPassword(pin);
      const hash = pinHash;
      const done = app.db.transaction(() => (unchecked().length > 0 ? null : { result: write(hash) }))();
      if (done) return done.result;
    }
  }

  /** Usernames are unique whatever their case; the index enforces it and this turns its error into an answer. */
  function uniqueUsername<T>(write: () => T): T {
    try { return write(); }
    catch (err) {
      if (err instanceof Error && "code" in err && err.code === "SQLITE_CONSTRAINT_UNIQUE" && err.message.includes("username")) throw httpError(409, "Username already in use");
      throw err;
    }
  }

  app.get("/api/users", { preHandler: manage }, async () => {
    const rows = app.db.prepare("SELECT * FROM users ORDER BY created_at").all() as UserRow[];
    const changes = new Map((app.db.prepare("SELECT user_id, COUNT(*) AS n FROM user_permissions GROUP BY user_id").all() as Array<{ user_id: string; n: number }>).map((r) => [r.user_id, r.n]));
    return { users: rows.map((r) => ({ ...toUser(r), permissionChanges: r.role === "admin" ? 0 : changes.get(r.id) ?? 0 })) };
  });

  /** A person's permissions: their role's defaults, the admin's changes for them, and the result. */
  const permissionsJson = (row: UserRow) => {
    const overrides = permissionOverrides(app.db, row.id);
    return { role: row.role, areas: PERMISSION_AREAS, adminOnly: ADMIN_ONLY_PERMISSIONS, defaults: roleDefaults(row.role), overrides, effective: effectivePermissions(row.role, overrides) };
  };
  app.get("/api/users/:id/permissions", { preHandler: manage }, async (req) => {
    const row = getUser((req.params as { id: string }).id);
    if (!row) throw httpError(404, "user not found");
    return { permissions: permissionsJson(row) };
  });
  /** Replaces a person's changes. Admins always have everything; only real differences from the role are stored. */
  app.put("/api/users/:id/permissions", { preHandler: manage }, async (req) => {
    const row = getUser((req.params as { id: string }).id);
    if (!row) throw httpError(404, "user not found");
    if (row.role === "admin") throw httpError(409, "Admins always have every permission");
    const { overrides } = z.object({ overrides: PermissionOverridesSchema }).strict().parse(req.body);
    const changes = normaliseOverrides(row.role, overrides);
    const now = Date.now();
    app.db.transaction(() => {
      app.db.prepare("DELETE FROM user_permissions WHERE user_id = ?").run(row.id);
      const insert = app.db.prepare("INSERT INTO user_permissions (user_id, permission, allowed, updated_at, updated_by) VALUES (?, ?, ?, ?, ?)");
      for (const [permission, allowed] of Object.entries(changes)) insert.run(row.id, permission, allowed ? 1 : 0, now, req.user.id);
    })();
    // Screens of that person refresh what they can do without signing out, and their sockets get only what they may see.
    app.wsRevalidate();
    app.broadcast("user.changed", { userId: row.id });
    return { permissions: permissionsJson(row) };
  });

  app.post("/api/users", { preHandler: manage }, async (req, reply) => {
    const body = UserCreate.parse(req.body);
    const id = uuidv7();
    const passwordHash = await hashPassword(body.password);
    const insert = (pinHash: string) => uniqueUsername(() => app.db
      .prepare("INSERT INTO users (id, name, username, password_hash, pin_hash, role, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(id, body.name, body.username, passwordHash, pinHash, body.role, Date.now()));
    if (body.role === "admin" && body.pin) await writeWithUniquePin(body.pin, undefined, insert);
    else insert("");
    return reply.status(201).send({ user: toUser(getUser(id)!) });
  });

  app.patch("/api/users/:id", { preHandler: manage }, async (req) => {
    const { id } = req.params as { id: string };
    const body = UserUpdate.parse(req.body);
    const row = getUser(id);
    if (!row) throw httpError(404, "user not found");

    // Lockout guard: the last active admin can be neither deactivated nor demoted. Checked up front for a quick answer, and again
    // inside the write, because a PIN change awaits hashing and another admin's demotion may land in between.
    const wasActiveAdmin = row.role === "admin" && row.is_active === 1;
    const staysActiveAdmin = (body.role ?? row.role) === "admin" && (body.isActive ?? row.is_active === 1);
    const assertAnotherAdmin = () => {
      if (!wasActiveAdmin || staysActiveAdmin) return;
      const others = app.db
        .prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND is_active = 1 AND id != ?")
        .get(id) as { n: number };
      if (others.n === 0) throw httpError(409, "cannot remove the last admin");
    };
    assertAnotherAdmin();

    const roleChanged = body.role !== undefined && body.role !== row.role;
    const isAdmin = (body.role ?? row.role) === "admin";
    // Only admins approve, so only they hold a PIN; someone made an admin chooses theirs in the same change.
    if (body.pin && !isAdmin) throw httpError(400, "Only admins have an approval PIN");
    if (isAdmin && row.role !== "admin" && !body.pin) throw httpError(400, ADMIN_PIN_MESSAGE);
    const passwordHash = body.password ? await hashPassword(body.password) : row.password_hash;
    const update = app.db.transaction((pinHash: string) => {
      assertAnotherAdmin();
      uniqueUsername(() => app.db
        .prepare("UPDATE users SET name = ?, username = ?, password_hash = ?, role = ?, is_active = ?, pin_hash = ?, max_discount_percent = ? WHERE id = ?")
        .run(body.name ?? row.name, body.username ?? row.username, passwordHash, body.role ?? row.role, (body.isActive ?? row.is_active === 1) ? 1 : 0,
          isAdmin ? pinHash : "", body.maxDiscountPercent === undefined ? row.max_discount_percent : body.maxDiscountPercent, id));
      // A new password signs the person out everywhere else; whoever set it stays signed in on this device.
      if (body.password) app.db.prepare("DELETE FROM sessions WHERE user_id = ? AND token != ?").run(id, currentToken(req));
      // Per-person changes are differences from the old role; a new role starts from its own permissions, so nothing granted
      // (or taken away) for the old job carries over unnoticed.
      if (roleChanged) app.db.prepare("DELETE FROM user_permissions WHERE user_id = ?").run(id);
    });
    if (body.pin) await writeWithUniquePin(body.pin, id, update);
    else update(row.pin_hash);

    // Close WS sockets if user was deactivated; a new role changes what their sockets may receive.
    if ((row.is_active === 1 && body.isActive === false) || roleChanged || body.password) {
      app.wsRevalidate();
    }
    if (body.isActive === false || (body.role !== undefined && body.role !== "waiter")) app.broadcast("table.changed", {});
    if (roleChanged) app.broadcast("user.changed", { userId: id });

    return { user: toUser(getUser(id)!) };
  });
}
