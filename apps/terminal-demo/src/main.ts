/**
 * Phase 0 proof (PROJECT_PLAN §9): a terminal that boots, logs in, and syncs a
 * table offline → online, then takes a change back down from the cloud.
 *
 * The "cloud" here is an in-process PGlite (real PostgreSQL, compiled to WASM),
 * so the round trip crosses genuine dialect boundaries rather than a mock. What
 * it does not exercise is the network — that arrives with the sync engine.
 *
 *   npm run demo
 */
import { hashPassword } from "@forkflow/core";
import {
  CLOUD_TABLES,
  TERMINAL_TABLES,
  createAuthService,
  createDirectTransport,
  createRepository,
  createSyncAgent,
  menu_categories,
  openCloud,
  openTerminal,
  outbox,
  outlets,
  organizations,
  roles,
  user_outlet_access,
  users,
} from "@forkflow/db";
import { uuidv7 } from "@forkflow/sync";

const step = (n: number, text: string) => console.log(`\n${n}. ${text}`);
const ok = (text: string) => console.log(`   ✓ ${text}`);
const info = (text: string) => console.log(`     ${text}`);

async function main() {
  const orgId = uuidv7();
  const outletId = uuidv7();

  console.log("── ForkFlow · Phase 0 terminal ───────────────────────────────");

  // 1 ── boot
  step(1, "Boot");
  const cloud = await openCloud({ tables: CLOUD_TABLES });
  const db = await openTerminal({ url: ":memory:", tables: TERMINAL_TABLES });
  const repo = createRepository(db, { nodeId: "till-01", orgId });
  const agent = createSyncAgent({ db, transport: createDirectTransport(cloud), orgId });
  ok(`terminal SQLite ready (${TERMINAL_TABLES.length} tables) · cloud PostgreSQL ready (${CLOUD_TABLES.length} tables)`);

  // 2 ── provision this outlet
  step(2, "Provision outlet");
  await repo.write(organizations, { id: orgId, name: "Anna's Cafe" });
  await repo.write(outlets, { id: outletId, name: "Anna's Cafe — Koramangala", outlet_type: "cafe" });
  const roleId = await repo.write(roles, {
    name: "Cashier",
    permissions: ["order.create", "bill.settle", "discount.apply"],
    limits: { max_discount_percent: 10 },
  });
  const userId = await repo.write(users, {
    email: "asha@annascafe.test",
    name: "Asha",
    password_hash: await hashPassword("correct-horse"),
    is_active: true,
  });
  await repo.write(user_outlet_access, { user_id: userId, outlet_id: outletId, role_id: roleId });
  ok("organization, outlet, Cashier role and one user created locally");

  // 3 ── log in, with no cloud involved
  step(3, "Log in (no network required)");
  const auth = createAuthService(db, { orgId, outletId, repo });
  const login = await auth.login("asha@annascafe.test", "correct-horse");
  if (!login.ok) throw new Error(`login failed: ${login.reason}`);
  ok(`signed in as ${login.session.name} · role ${login.session.role.name}`);
  info(`permissions: ${login.session.role.permissions.join(", ")}`);

  // 4 ── work while offline
  step(4, "Service with the internet unplugged");
  for (const name of ["Beverages", "All-Day Breakfast", "Desserts"]) {
    await repo.write(menu_categories, { outlet_id: outletId, name });
  }
  const pending = await db.selectUnsynced(outbox, 100);
  ok(`${(await db.selectAll(menu_categories)).length} categories written locally`);
  info(`cloud still holds ${(await cloud.selectAll(menu_categories)).length} · outbox queued ${pending.length} changes`);

  // 5 ── reconnect
  step(5, "Internet returns");
  const pushed = await agent.push();
  ok(`pushed ${pushed.pushed} changes to PostgreSQL`);
  info(`cloud now holds ${(await cloud.selectAll(menu_categories)).length} categories`);
  info(`re-drain is a no-op: pushed ${(await agent.push()).pushed}`);

  // 6 ── head office edits the menu; it flows back down
  step(6, "Head office renames a category in the cloud");
  const headOffice = createRepository(cloud, { nodeId: "cloud", orgId, captureChanges: false });
  const [firstCategory] = await cloud.selectAll(menu_categories);
  await headOffice.write(menu_categories, { ...firstCategory, name: "Hot & Cold Beverages" });

  const pulled = await agent.pull();
  ok(`pulled ${pulled.applied} change(s) down to the terminal`);
  for (const category of await db.selectAll(menu_categories)) {
    info(`• ${category.name as string}`);
  }

  console.log("\n── Phase 0 criteria met: boots · logs in · syncs offline→online ──\n");

  await db.close();
  await cloud.close();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
