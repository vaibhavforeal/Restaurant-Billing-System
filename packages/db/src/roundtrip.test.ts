import { uuidv7 } from "@forkflow/sync";
import { expect, test } from "vitest";
import { openCloud, openTerminal } from "./client.js";
import { defineTable } from "./dialect.js";

const demo = defineTable("demo_rows", {
  id: { kind: "uuid", primaryKey: true },
  label: { kind: "text", notNull: true },
  amount_minor: { kind: "money", notNull: true },
  is_active: { kind: "boolean", notNull: true },
  created_at: { kind: "timestamp", notNull: true },
  payload: { kind: "json" },
});

test("one insert written through both dialects reads back identically", async () => {
  const terminal = await openTerminal({ url: ":memory:", tables: [demo] });
  const cloud = await openCloud({ tables: [demo] });

  const row = {
    id: uuidv7(),
    label: "Masala Chai",
    amount_minor: 4000, // ₹40.00 in paise
    is_active: true,
    created_at: new Date("2026-08-04T09:30:00.000Z"),
    payload: { station: "beverages" },
  };

  await terminal.insert(demo, row);
  await cloud.insert(demo, row);

  expect(await terminal.selectAll(demo)).toStrictEqual([row]);
  expect(await cloud.selectAll(demo)).toStrictEqual(await terminal.selectAll(demo));

  await terminal.close();
  await cloud.close();
});
