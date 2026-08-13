import { uuidv7 } from "@forkflow/sync";
import { expect, test } from "vitest";
import { openCloud, openTerminal, type DbHandle } from "./client.js";
import { createRepository } from "./repository.js";
import { CLOUD_TABLES, TERMINAL_TABLES, menu_categories } from "./schema.js";
import { createSyncAgent } from "./sync-agent.js";
import { createDirectTransport } from "./transport-direct.js";

const orgId = uuidv7();
const outletId = uuidv7();

/** A till whose clock we control, so "who wrote last" is not a race. */
async function till(nodeId: string, cloud: DbHandle, wallClock: number) {
  const db = await openTerminal({ url: ":memory:", tables: TERMINAL_TABLES });
  return {
    db,
    repo: createRepository(db, { nodeId, orgId, now: () => wallClock }),
    agent: createSyncAgent({ db, transport: createDirectTransport(cloud), orgId }),
  };
}

const nameOf = async (db: DbHandle, id: string) => (await db.findById(menu_categories, id))?.name;

test("two terminals editing one row while offline converge on the later edit", async () => {
  const cloud = await openCloud({ tables: CLOUD_TABLES });
  const one = await till("term-1", cloud, 1_000);
  const two = await till("term-2", cloud, 2_000);

  // Both tills start in agreement.
  const id = await one.repo.write(menu_categories, { outlet_id: outletId, name: "Beverages" });
  await one.agent.push();
  await two.agent.pull();
  expect(await nameOf(two.db, id)).toBe("Beverages");

  // ── the internet drops; both tills edit the same category ──
  await one.repo.write(menu_categories, { id, outlet_id: outletId, name: "Hot Drinks" });
  await two.repo.write(menu_categories, { id, outlet_id: outletId, name: "Cold Drinks" }); // later clock

  // ── the internet returns; the earlier edit reaches the cloud last ──
  await two.agent.push();
  await one.agent.push();
  await one.agent.pull();
  await two.agent.pull();

  // The later write wins everywhere — no split brain, and no dependence on
  // which till happened to reconnect first.
  expect(await nameOf(cloud, id)).toBe("Cold Drinks");
  expect(await nameOf(one.db, id)).toBe("Cold Drinks");
  expect(await nameOf(two.db, id)).toBe("Cold Drinks");

  await one.db.close();
  await two.db.close();
  await cloud.close();
});

test("a soft delete replicates rather than resurrecting the row", async () => {
  const cloud = await openCloud({ tables: CLOUD_TABLES });
  const one = await till("term-1", cloud, 1_000);
  const two = await till("term-2", cloud, 1_000);

  const id = await one.repo.write(menu_categories, { outlet_id: outletId, name: "Seasonal" });
  await one.agent.push();
  await two.agent.pull();

  await one.repo.remove(menu_categories, id);
  await one.agent.push();
  await two.agent.pull();

  expect((await two.db.findById(menu_categories, id))?.deleted_at).toBeInstanceOf(Date);

  await one.db.close();
  await two.db.close();
  await cloud.close();
});
