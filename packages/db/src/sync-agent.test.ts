import { uuidv7 } from "@forkflow/sync";
import { expect, test } from "vitest";
import { openCloud, openTerminal } from "./client.js";
import { createRepository } from "./repository.js";
import { CLOUD_TABLES, TERMINAL_TABLES, menu_categories, outbox } from "./schema.js";
import { createSyncAgent } from "./sync-agent.js";
import { createDirectTransport } from "./transport-direct.js";

const orgId = uuidv7();
const outletId = uuidv7();

async function outletWithCloud(nodeId: string) {
  const cloud = await openCloud({ tables: CLOUD_TABLES });
  const db = await openTerminal({ url: ":memory:", tables: TERMINAL_TABLES });
  const repo = createRepository(db, { nodeId, orgId });
  const agent = createSyncAgent({ db, transport: createDirectTransport(cloud), orgId });
  return { cloud, db, repo, agent };
}

test("work done offline reaches the cloud once the link returns, exactly once", async () => {
  const { cloud, db, repo, agent } = await outletWithCloud("term-1");

  // ── network down ──
  const id = await repo.write(menu_categories, { outlet_id: outletId, name: "Beverages" });
  expect(await cloud.selectAll(menu_categories)).toStrictEqual([]);

  // ── network back ──
  expect(await agent.push()).toStrictEqual({ pushed: 1 });

  expect(await cloud.selectAll(menu_categories)).toMatchObject([
    { id, org_id: orgId, name: "Beverages", deleted_at: null },
  ]);
  expect((await db.selectAll(outbox)).every((entry) => entry.synced_at !== null)).toBe(true);

  // A second drain must not resend anything.
  expect(await agent.push()).toStrictEqual({ pushed: 0 });

  await db.close();
  await cloud.close();
});

test("timestamps survive the trip as instants, not strings", async () => {
  const { cloud, db, repo, agent } = await outletWithCloud("term-1");

  const id = await repo.write(menu_categories, { outlet_id: outletId, name: "Desserts" });
  await agent.push();

  const local = await db.findById(menu_categories, id);
  const remote = await cloud.findById(menu_categories, id);

  expect(remote?.created_at).toBeInstanceOf(Date);
  expect(remote?.created_at).toStrictEqual(local?.created_at);
  expect(remote?.is_active).toBe(true); // boolean, not 1

  await db.close();
  await cloud.close();
});
