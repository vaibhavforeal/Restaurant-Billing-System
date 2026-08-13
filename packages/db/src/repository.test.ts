import { uuidv7 } from "@forkflow/sync";
import { expect, test } from "vitest";
import { openCloud, openTerminal } from "./client.js";
import { createRepository } from "./repository.js";
import { CLOUD_TABLES, TERMINAL_TABLES, menu_categories, outbox } from "./schema.js";

const orgId = uuidv7();
const outletId = uuidv7();

async function terminalRepo(nodeId: string) {
  const db = await openTerminal({ url: ":memory:", tables: TERMINAL_TABLES });
  return { db, repo: createRepository(db, { nodeId, orgId }) };
}

test("an offline write lands in the local table and queues exactly one change", async () => {
  const { db, repo } = await terminalRepo("term-1");

  const id = await repo.write(menu_categories, { outlet_id: outletId, name: "Beverages" });

  const rows = await db.selectAll(menu_categories);
  expect(rows).toMatchObject([{ id, org_id: orgId, name: "Beverages", deleted_at: null }]);
  expect(rows[0]?.hlc).toMatch(/^[0-9a-f]{12}-[0-9a-f]{4}-term-1$/);

  expect(await db.selectAll(outbox)).toMatchObject([
    { entity: "menu_categories", entity_id: id, op: "upsert", synced_at: null },
  ]);

  await db.close();
});

test("editing a row replaces it in place and queues a second change", async () => {
  const { db, repo } = await terminalRepo("term-1");

  const id = await repo.write(menu_categories, { outlet_id: outletId, name: "Beverages" });
  await repo.write(menu_categories, { id, outlet_id: outletId, name: "Hot Beverages" });

  expect(await db.selectAll(menu_categories)).toMatchObject([{ id, name: "Hot Beverages" }]);
  expect(await db.selectAll(outbox)).toHaveLength(2);

  await db.close();
});

test("head office can edit in the cloud, which keeps no outbox of its own", async () => {
  const cloud = await openCloud({ tables: CLOUD_TABLES });
  const repo = createRepository(cloud, { nodeId: "cloud", orgId, captureChanges: false });

  const id = await repo.write(menu_categories, { outlet_id: outletId, name: "Bakery" });

  // The row still carries an HLC, which is what terminals pull against.
  expect(await cloud.findById(menu_categories, id)).toMatchObject({
    name: "Bakery",
    hlc: expect.stringMatching(/-cloud$/),
  });

  await cloud.close();
});
