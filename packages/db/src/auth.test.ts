import { hashPassword } from "@forkflow/core";
import { uuidv7 } from "@forkflow/sync";
import { expect, test } from "vitest";
import { createAuthService } from "./auth.js";
import { openTerminal } from "./client.js";
import { createRepository } from "./repository.js";
import { TERMINAL_TABLES, audit_log, roles, user_outlet_access, users } from "./schema.js";

const orgId = uuidv7();
const outletId = uuidv7();

async function terminalWithStaff() {
  const db = await openTerminal({ url: ":memory:", tables: TERMINAL_TABLES });
  const repo = createRepository(db, { nodeId: "term-1", orgId });

  const roleId = await repo.write(roles, {
    name: "Cashier",
    permissions: ["order.create", "bill.settle"],
    limits: { max_discount_percent: 10 },
  });
  const userId = await repo.write(users, {
    email: "asha@outlet.test",
    name: "Asha",
    password_hash: await hashPassword("correct-horse"),
    is_active: true,
  });
  await repo.write(user_outlet_access, { user_id: userId, outlet_id: outletId, role_id: roleId });

  return { db, repo, userId, auth: createAuthService(db, { orgId, outletId, repo }) };
}

test("a cashier signs in on a terminal with no network and gets their permissions", async () => {
  const { db, auth, userId } = await terminalWithStaff();

  const result = await auth.login("asha@outlet.test", "correct-horse");

  expect(result).toMatchObject({
    ok: true,
    session: { userId, name: "Asha", outletId, role: { name: "Cashier" } },
  });
  expect(result.ok && result.session.role.permissions).toStrictEqual(["order.create", "bill.settle"]);

  await db.close();
});

test("a wrong password is refused and the attempt is recorded", async () => {
  const { db, auth } = await terminalWithStaff();

  const result = await auth.login("asha@outlet.test", "wrong");

  expect(result).toStrictEqual({ ok: false, reason: "invalid_credentials" });
  expect(await db.selectAll(audit_log)).toMatchObject([{ action: "user.login_failed" }]);

  await db.close();
});

test("an unknown email is refused with the same reason as a wrong password", async () => {
  const { db, auth } = await terminalWithStaff();

  // Identical response, so the login screen cannot be used to enumerate staff.
  expect(await auth.login("nobody@outlet.test", "correct-horse")).toStrictEqual({
    ok: false,
    reason: "invalid_credentials",
  });

  await db.close();
});

test("a deactivated user cannot sign in even with the right password", async () => {
  const { db, auth, repo, userId } = await terminalWithStaff();
  const existing = await db.findById(users, userId);
  await repo.write(users, { ...existing, is_active: false });

  expect(await auth.login("asha@outlet.test", "correct-horse")).toStrictEqual({
    ok: false,
    reason: "inactive_user",
  });

  await db.close();
});

test("a successful sign-in is written to the audit log", async () => {
  const { db, auth, userId } = await terminalWithStaff();

  await auth.login("asha@outlet.test", "correct-horse");

  expect(await db.selectAll(audit_log)).toMatchObject([
    { action: "user.login", user_id: userId, outlet_id: outletId },
  ]);

  await db.close();
});
