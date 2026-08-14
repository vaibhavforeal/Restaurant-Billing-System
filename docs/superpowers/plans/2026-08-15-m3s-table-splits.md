# M3s Table Splits Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A dine-in table can be split into two or more customer groups — each split is an independent order (own punches, KOTs, cancel flows, and later its own bill) with an auto-assigned letter (A, B, C…), while never-split tables look and behave exactly as today.

**Architecture:** Migration 003 adds `orders.split_label` (backfilled 'A' for dine-in, NULL for parcels); a domain helper picks the first unused letter among a table's open/billed orders inside the create transaction. A prerequisite pure refactor extracts the duplicated order/KOT serializers into `apps/server/src/mappers.ts` so `splitLabel` (and a new `tableName`) land in exactly one place. Tables derive status from ALL active orders and expose `activeOrders` for the tap-picker; the UI adds a splits picker on Tables, a `+ Split` button and labelled header on OrderScreen, and a `T1 · B` context line on Kitchen. The browser gate script moves into `tools/e2e/` and grows a split scenario.

**Tech Stack:** Fastify + better-sqlite3 (single-writer, sync transactions), zod, vitest, React (Vite), Python Playwright for the browser gate.

**Spec:** `docs/superpowers/specs/2026-08-15-table-splits-design.md` (approved 2026-08-15). Binding contracts used during plan-writing: `.e2e-scratch/m3s-plan/contracts.md` (disposable scratch).

---
# M3s Table Splits — Server Tasks (1–4)

## Global Constraints

- **Branch:** `m3s-table-splits`, branch-in-place (NO worktree — Electron/better-sqlite3 npm install cost).
- **Import style:** `.js` suffixes in `packages/*` and `apps/server` (NodeNext); extensionless in `apps/ui` (Vite).
- **noUncheckedIndexedAccess:** Test array access with `[0]!` or `?.`.
- **Error handler:** server.ts passes ONLY `{error: message}` from thrown errors. 403s needing extra fields use `reply.status(403).send(...)` directly.
- **WS vocabulary FROZEN:** `order.updated` `kot.created` `kot.updated` `table.changed`. No new events.
- **UI uuid:** NEVER `crypto.randomUUID` — use `uuid()` from `apps/ui/src/uuid.ts`.
- **WS tests:** `(m as { event?: string })` type-guard pattern.
- **Server test fixtures:** `apps/server/src/test-helpers.ts` → `freshApp`, `setupAdmin`, `auth`, `createUser`. Do NOT touch `auth.test.ts`.
- **packages/core roles.ts:** NOT modified.
- **FK reality for domain tests:** `orders.opened_by` → users row required; `orders.table_id` → dining_tables row required. Insert those first (raw SQL fine).
- **Baseline:** 120 tests green at commit `b863f15`. Every task ends with full suite green.
- **Sandbox notes:** `taskkill` denied → `powershell.exe -Command "Stop-Process -Id <pid> -Force"`; `rm -rf` denied → file-level `rm` + `rmdir`; check port :4100 before starting servers.

---

## Task 1: Shared mappers extraction (PURE refactor)

**Files:**
- Create: `apps/server/src/mappers.ts`
- Create: `apps/server/src/mappers.test.ts`
- Modify: `apps/server/src/orders.ts` (lines 6-78: delete duplicated interfaces/serializers; import from mappers; lines 87-96, 292-311: replace inline fetch+map with `loadOrderJson`)
- Modify: `apps/server/src/kots.ts` (lines 5-62: delete duplicated interfaces/serializers; import from mappers; lines 144-170: replace inline fetch+map with `loadOrderJson`)
- Test: No test file changes required; full suite proves refactor correctness

**Interfaces:**
- Consumes: `Database` from `@forkflow/domain`
- Produces: `OrderRow`, `OrderItemRow`, `KotRow` interfaces; `orderItemJson`, `kotJson`, `kotWithContextJson`, `loadOrderJson` functions exported from `apps/server/src/mappers.ts`

**Proof of correctness:** This is a PURE refactor — zero behavior change. Proof: all 120 existing tests pass UNCHANGED (no test file edits). A smoke test in mappers.test.ts validates `loadOrderJson` null-case.

### Steps

- [ ] **Step 1: Write the smoke test**

`apps/server/src/mappers.test.ts`:

```ts
import { afterEach, describe, expect, it } from "vitest";
import { freshApp, setupAdmin } from "./test-helpers.js";
import { loadOrderJson } from "./mappers.js";

let app: ReturnType<typeof freshApp>;
afterEach(async () => {
  await app?.close();
});

describe("mappers", () => {
  it("loadOrderJson returns null for unknown order id", async () => {
    app = freshApp();
    await setupAdmin(app);
    expect(loadOrderJson(app.db, "nonexistent-id")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/server/src/mappers.test.ts`

Expected: FAIL — module not found.

- [ ] **Step 3: Write mappers.ts**

`apps/server/src/mappers.ts`:

```ts
import type { Database } from "@forkflow/domain";

export interface OrderRow {
  id: string;
  client_ref: string;
  type: "dine_in" | "parcel";
  table_id: string | null;
  status: "open" | "billed" | "settled" | "cancelled";
  opened_by: string;
  opened_at: number;
  closed_at: number | null;
}

export interface OrderItemRow {
  id: string;
  order_id: string;
  client_ref: string | null;
  product_id: string;
  variant_id: string | null;
  name_snapshot: string;
  price_paise_snapshot: number;
  gst_rate_snapshot: number;
  qty: number;
  status: "pending" | "sent" | "cancelled";
  note: string | null;
  cancel_reason: string | null;
  kot_id: string | null;
  cancelled_by: string | null;
}

export interface KotRow {
  id: string;
  kot_no: number;
  station_id: string;
  order_id: string;
  created_at: number;
  done_at: number | null;
}

export function orderItemJson(r: OrderItemRow) {
  return {
    id: r.id,
    clientRef: r.client_ref,
    productId: r.product_id,
    variantId: r.variant_id,
    name: r.name_snapshot,
    pricePaise: r.price_paise_snapshot,
    gstRate: r.gst_rate_snapshot,
    qty: r.qty,
    status: r.status,
    note: r.note,
    cancelReason: r.cancel_reason,
    kotId: r.kot_id,
  };
}

export function kotJson(r: KotRow) {
  return {
    id: r.id,
    kotNo: r.kot_no,
    stationId: r.station_id,
    orderId: r.order_id,
    createdAt: r.created_at,
    doneAt: r.done_at,
  };
}

export function kotWithContextJson(
  kot: KotRow,
  order: OrderRow,
  tableName: string | null,
  items: OrderItemRow[],
) {
  return {
    ...kotJson(kot),
    orderType: order.type,
    tableName,
    items: items.map((i) => ({ id: i.id, name: i.name_snapshot, qty: i.qty, note: i.note, status: i.status })),
  };
}

export function loadOrderJson(db: Database, orderId: string) {
  const order = db.prepare("SELECT * FROM orders WHERE id = ?").get(orderId) as OrderRow | undefined;
  if (!order) return null;

  const items = db
    .prepare("SELECT * FROM order_items WHERE order_id = ? ORDER BY id")
    .all(orderId) as OrderItemRow[];

  const kots = db
    .prepare("SELECT * FROM kots WHERE order_id = ? ORDER BY created_at")
    .all(orderId) as KotRow[];

  return {
    id: order.id,
    clientRef: order.client_ref,
    type: order.type,
    tableId: order.table_id,
    status: order.status,
    openedBy: order.opened_by,
    openedAt: order.opened_at,
    closedAt: order.closed_at,
    items: items.map(orderItemJson),
    kots: kots.map(kotJson),
  };
}
```

- [ ] **Step 4: Refactor orders.ts**

Delete lines 6-78 (the `OrderRow`, `OrderItemRow`, `KotRow` interfaces and `toOrderItem`, `toKot`, `toOrder` functions).

Add import at top (after line 4):

```ts
import { OrderCreate, OrderItemsAdd, OrderItemUpdate, ItemCancel, uuidv7, roleFor } from "@forkflow/domain";
import { can } from "@forkflow/core";
import type { FastifyInstance } from "fastify";
import { httpError } from "./http-error.js";
import { loadOrderJson, orderItemJson, kotJson, kotWithContextJson, type OrderRow, type OrderItemRow, type KotRow } from "./mappers.js";
```

Replace the `orderWithDetails` function (originally lines 87-97) with:

```ts
  function orderWithDetails(id: string) {
    return loadOrderJson(app.db, id);
  }
```

In the sent-item-cancel `kot.updated` broadcast site (originally lines 292-311), replace orders.ts:292-311 with:

```ts
    const result = orderWithDetails(item.order_id)!;
    app.broadcast("order.updated", { order: result });
    if (item.status === "sent" && item.kot_id) {
      const kot = app.db.prepare("SELECT * FROM kots WHERE id = ?").get(item.kot_id) as KotRow;
      const kotItems = app.db
        .prepare("SELECT * FROM order_items WHERE kot_id = ? ORDER BY id")
        .all(item.kot_id) as OrderItemRow[];
      const order = app.db.prepare("SELECT * FROM orders WHERE id = ?").get(kot.order_id) as OrderRow;
      const tableName = order.table_id
        ? (app.db.prepare("SELECT name FROM dining_tables WHERE id = ?").get(order.table_id) as { name: string } | undefined)?.name ?? null
        : null;
      app.broadcast("kot.updated", { kot: kotWithContextJson(kot, order, tableName, kotItems) });
    }
```

- [ ] **Step 5: Refactor kots.ts**

Delete lines 5-62 (the duplicated interfaces and serializers).

Add import at top (after line 3):

```ts
import { nextSequence, localDateKey, uuidv7 } from "@forkflow/domain";
import type { FastifyInstance } from "fastify";
import { httpError } from "./http-error.js";
import { loadOrderJson, kotJson, kotWithContextJson, type OrderRow, type OrderItemRow, type KotRow } from "./mappers.js";
```

In the send route, replace the `orderFull` inline construction (originally lines 144-170) with:

```ts
    const orderFull = loadOrderJson(app.db, id)!;
```

Rename all call sites to use the imported mappers:
- Line 137 (`kotsWithContext` in the send-route): change `toKotWithContext(...)` to `kotWithContextJson(...)`
- Line 221 (board route): change `toKotWithContext(...)` to `kotWithContextJson(...)`
- Line 232 (done-route first response): change `toKot(...)` to `kotJson(...)`
- Line 247 (done broadcast): change `toKotWithContext(...)` to `kotWithContextJson(...)`
- Line 249 (done-route second response): change `toKot(...)` to `kotJson(...)`

- [ ] **Step 6: Run the smoke test**

Run: `npx vitest run apps/server/src/mappers.test.ts`

Expected: PASS.

- [ ] **Step 7: Run full suite to prove refactor correctness**

Run: `npx vitest run`

Expected: 121 passing (120 baseline + 1 new smoke test), 0 failed. No test files were modified except the new mappers.test.ts.

Then: `npm run typecheck`

Expected: clean.

- [ ] **Step 8: Commit**

```bash
git add apps/server/src/mappers.ts apps/server/src/mappers.test.ts apps/server/src/orders.ts apps/server/src/kots.ts
git commit -m "$(cat <<'EOF'
refactor(server): extract shared mappers for order/KOT serialization

Moves duplicated OrderRow/OrderItemRow/KotRow interfaces and serialization
functions from orders.ts and kots.ts into a shared mappers.ts module:
- orderItemJson, kotJson, kotWithContextJson for consistent shape
- loadOrderJson: single-source order fetch with items+kots (replaces
  orders.ts orderWithDetails + kots.ts inline orderFull construction +
  orders.ts sent-cancel kot.updated site hand-built fetch)

Unifies kots.ts OrderRow.status from string to union type for type safety.

PURE refactor: zero behavior change, proven by all 120 existing tests
passing UNCHANGED (no test file edits except new smoke test).

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Migration 003 + nextSplitLabel domain helper

**Files:**
- Create: `packages/domain/src/migrations/003-order-split-label.ts`
- Create: `packages/domain/src/migrations/003-order-split-label.test.ts`
- Modify: `packages/domain/src/migrations/index.ts` (add migration003 to MIGRATIONS array)
- Create: `packages/domain/src/split-labels.ts`
- Create: `packages/domain/src/split-labels.test.ts`
- Modify: `packages/domain/src/index.ts` (export nextSplitLabel)

**Interfaces:**
- Consumes: `Migration` from `./migrate.js`; `Database` from `./db.js`
- Produces: `migration003` (registered in MIGRATIONS); `nextSplitLabel(db: Database, tableId: string): string | null` (exported from `@forkflow/domain`)

### Steps

- [ ] **Step 1: Write the migration backfill test**

`packages/domain/src/migrations/003-order-split-label.test.ts`:

```ts
import { afterEach, describe, expect, it } from "vitest";
import { migrate, MIGRATIONS, openDb, type Database } from "../index.js";
import { uuidv7 } from "../id.js";

let db: Database | undefined;
afterEach(() => {
  db?.close();
});

describe("migration 003", () => {
  it("adds split_label column and backfills dine_in orders with 'A', leaves parcels NULL", () => {
    db = openDb(":memory:");
    // Migrate to version 2 first
    migrate(db, MIGRATIONS.slice(0, 2));

    // Insert FK targets (users + dining_tables required by orders)
    const userId = uuidv7();
    const tableId = uuidv7();
    db.prepare("INSERT INTO users (id, name, pin_hash, role, created_at) VALUES (?, 'Admin', 'dummy', 'admin', 0)").run(userId);
    db.prepare("INSERT INTO dining_tables (id, name, sort_order) VALUES (?, 'T1', 0)").run(tableId);

    // Insert one dine_in and one parcel order
    const dineInId = uuidv7();
    const parcelId = uuidv7();
    db.prepare(
      "INSERT INTO orders (id, client_ref, type, table_id, opened_by, opened_at) VALUES (?, 'ref-dine', 'dine_in', ?, ?, ?)"
    ).run(dineInId, tableId, userId, Date.now());
    db.prepare(
      "INSERT INTO orders (id, client_ref, type, table_id, opened_by, opened_at) VALUES (?, 'ref-parcel', 'parcel', NULL, ?, ?)"
    ).run(parcelId, userId, Date.now());

    // Apply migration 003
    migrate(db, MIGRATIONS);

    // Verify backfill
    const dineIn = db.prepare("SELECT split_label FROM orders WHERE id = ?").get(dineInId) as { split_label: string | null };
    expect(dineIn.split_label).toBe("A");

    const parcel = db.prepare("SELECT split_label FROM orders WHERE id = ?").get(parcelId) as { split_label: string | null };
    expect(parcel.split_label).toBeNull();
  });
});
```

- [ ] **Step 2: Write split-labels tests**

`packages/domain/src/split-labels.test.ts`:

```ts
import { afterEach, describe, expect, it } from "vitest";
import { migrate, MIGRATIONS, openDb, type Database, uuidv7 } from "./index.js";
import { nextSplitLabel } from "./split-labels.js";

let db: Database | undefined;
afterEach(() => {
  db?.close();
});

describe("nextSplitLabel", () => {
  it("returns 'A' for an empty table", () => {
    db = openDb(":memory:");
    migrate(db, MIGRATIONS);
    const tableId = uuidv7();
    db.prepare("INSERT INTO dining_tables (id, name, sort_order) VALUES (?, 'T1', 0)").run(tableId);
    expect(nextSplitLabel(db, tableId)).toBe("A");
  });

  it("returns 'B' when 'A' is open", () => {
    db = openDb(":memory:");
    migrate(db, MIGRATIONS);
    const userId = uuidv7();
    const tableId = uuidv7();
    db.prepare("INSERT INTO users (id, name, pin_hash, role, created_at) VALUES (?, 'Admin', 'dummy', 'admin', 0)").run(userId);
    db.prepare("INSERT INTO dining_tables (id, name, sort_order) VALUES (?, 'T1', 0)").run(tableId);

    const orderA = uuidv7();
    db.prepare(
      "INSERT INTO orders (id, client_ref, type, table_id, split_label, status, opened_by, opened_at) VALUES (?, 'ref-a', 'dine_in', ?, 'A', 'open', ?, ?)"
    ).run(orderA, tableId, userId, Date.now());

    expect(nextSplitLabel(db, tableId)).toBe("B");
  });

  it("returns 'B' when 'A' is billed", () => {
    db = openDb(":memory:");
    migrate(db, MIGRATIONS);
    const userId = uuidv7();
    const tableId = uuidv7();
    db.prepare("INSERT INTO users (id, name, pin_hash, role, created_at) VALUES (?, 'Admin', 'dummy', 'admin', 0)").run(userId);
    db.prepare("INSERT INTO dining_tables (id, name, sort_order) VALUES (?, 'T1', 0)").run(tableId);

    const orderA = uuidv7();
    db.prepare(
      "INSERT INTO orders (id, client_ref, type, table_id, split_label, status, opened_by, opened_at) VALUES (?, 'ref-a', 'dine_in', ?, 'A', 'billed', ?, ?)"
    ).run(orderA, tableId, userId, Date.now());

    expect(nextSplitLabel(db, tableId)).toBe("B");
  });

  it("reuses 'A' when 'A' is settled", () => {
    db = openDb(":memory:");
    migrate(db, MIGRATIONS);
    const userId = uuidv7();
    const tableId = uuidv7();
    db.prepare("INSERT INTO users (id, name, pin_hash, role, created_at) VALUES (?, 'Admin', 'dummy', 'admin', 0)").run(userId);
    db.prepare("INSERT INTO dining_tables (id, name, sort_order) VALUES (?, 'T1', 0)").run(tableId);

    const orderA = uuidv7();
    db.prepare(
      "INSERT INTO orders (id, client_ref, type, table_id, split_label, status, opened_by, opened_at, closed_at) VALUES (?, 'ref-a', 'dine_in', ?, 'A', 'settled', ?, ?, ?)"
    ).run(orderA, tableId, userId, Date.now(), Date.now());

    expect(nextSplitLabel(db, tableId)).toBe("A");
  });

  it("reuses 'A' when 'A' is cancelled", () => {
    db = openDb(":memory:");
    migrate(db, MIGRATIONS);
    const userId = uuidv7();
    const tableId = uuidv7();
    db.prepare("INSERT INTO users (id, name, pin_hash, role, created_at) VALUES (?, 'Admin', 'dummy', 'admin', 0)").run(userId);
    db.prepare("INSERT INTO dining_tables (id, name, sort_order) VALUES (?, 'T1', 0)").run(tableId);

    const orderA = uuidv7();
    db.prepare(
      "INSERT INTO orders (id, client_ref, type, table_id, split_label, status, opened_by, opened_at, closed_at) VALUES (?, 'ref-a', 'dine_in', ?, 'A', 'cancelled', ?, ?, ?)"
    ).run(orderA, tableId, userId, Date.now(), Date.now());

    expect(nextSplitLabel(db, tableId)).toBe("A");
  });

  it("fills gaps (A and C active -> returns 'B')", () => {
    db = openDb(":memory:");
    migrate(db, MIGRATIONS);
    const userId = uuidv7();
    const tableId = uuidv7();
    db.prepare("INSERT INTO users (id, name, pin_hash, role, created_at) VALUES (?, 'Admin', 'dummy', 'admin', 0)").run(userId);
    db.prepare("INSERT INTO dining_tables (id, name, sort_order) VALUES (?, 'T1', 0)").run(tableId);

    const orderA = uuidv7();
    const orderC = uuidv7();
    db.prepare(
      "INSERT INTO orders (id, client_ref, type, table_id, split_label, status, opened_by, opened_at) VALUES (?, 'ref-a', 'dine_in', ?, 'A', 'open', ?, ?)"
    ).run(orderA, tableId, userId, Date.now());
    db.prepare(
      "INSERT INTO orders (id, client_ref, type, table_id, split_label, status, opened_by, opened_at) VALUES (?, 'ref-c', 'dine_in', ?, 'C', 'open', ?, ?)"
    ).run(orderC, tableId, userId, Date.now());

    expect(nextSplitLabel(db, tableId)).toBe("B");
  });

  it("returns null when all 26 letters are used", () => {
    db = openDb(":memory:");
    migrate(db, MIGRATIONS);
    const userId = uuidv7();
    const tableId = uuidv7();
    db.prepare("INSERT INTO users (id, name, pin_hash, role, created_at) VALUES (?, 'Admin', 'dummy', 'admin', 0)").run(userId);
    db.prepare("INSERT INTO dining_tables (id, name, sort_order) VALUES (?, 'T1', 0)").run(tableId);

    // Insert 26 open orders with labels A-Z
    const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    for (let i = 0; i < 26; i++) {
      const orderId = uuidv7();
      db.prepare(
        "INSERT INTO orders (id, client_ref, type, table_id, split_label, status, opened_by, opened_at) VALUES (?, ?, 'dine_in', ?, ?, 'open', ?, ?)"
      ).run(orderId, `ref-${letters[i]}`, tableId, letters[i], userId, Date.now());
    }

    expect(nextSplitLabel(db, tableId)).toBeNull();
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run packages/domain/src/migrations/003-order-split-label.test.ts packages/domain/src/split-labels.test.ts`

Expected: FAIL — migration003 not in MIGRATIONS, split-labels.ts missing.

- [ ] **Step 4: Write migration 003**

`packages/domain/src/migrations/003-order-split-label.ts`:

```ts
import type { Migration } from "../migrate.js";

/** M3s: per-split labels on dine-in orders (A, B, C…). Parcels stay NULL. */
export const migration003: Migration = {
  version: 3,
  name: "order-split-label",
  up(db) {
    db.exec(`
      ALTER TABLE orders ADD COLUMN split_label TEXT;
      UPDATE orders SET split_label = 'A' WHERE type = 'dine_in';
    `);
  },
};
```

Update `packages/domain/src/migrations/index.ts`:

```ts
import type { Migration } from "../migrate.js";
import { migration001 } from "./001-initial.js";
import { migration002 } from "./002-kot-done-and-item-refs.js";
import { migration003 } from "./003-order-split-label.js";

export const MIGRATIONS: Migration[] = [migration001, migration002, migration003];
```

- [ ] **Step 5: Write split-labels helper**

`packages/domain/src/split-labels.ts`:

```ts
import type { Database } from "./db.js";

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/**
 * Returns the next unused split label (A-Z) for the given table.
 * Considers orders with status 'open' or 'billed'.
 * Returns null if all 26 letters are taken.
 * Caller holds any transaction.
 */
export function nextSplitLabel(db: Database, tableId: string): string | null {
  const used = db
    .prepare(
      `SELECT split_label FROM orders
       WHERE table_id = ? AND status IN ('open', 'billed') AND split_label IS NOT NULL`
    )
    .all(tableId) as Array<{ split_label: string }>;

  const usedSet = new Set(used.map((r) => r.split_label));

  for (let i = 0; i < 26; i++) {
    const letter = LETTERS[i]!;
    if (!usedSet.has(letter)) return letter;
  }

  return null;
}
```

Append to `packages/domain/src/index.ts`:

```ts
export { nextSplitLabel } from "./split-labels.js";
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run packages/domain/src/migrations/003-order-split-label.test.ts packages/domain/src/split-labels.test.ts`

Expected: PASS (8 tests total). Then the full domain suite: `npx vitest run packages/domain/src`

Expected: all green. Then: `npm run typecheck`

Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add packages/domain/src/migrations/003-order-split-label.ts packages/domain/src/migrations/003-order-split-label.test.ts packages/domain/src/migrations/index.ts packages/domain/src/split-labels.ts packages/domain/src/split-labels.test.ts packages/domain/src/index.ts
git commit -m "$(cat <<'EOF'
feat(domain): migration 003 + nextSplitLabel for table splits

Adds migration 003 for M3s table splits milestone:
- orders.split_label column (TEXT, NULL for parcels)
- Backfills existing dine_in orders with 'A'

Implements nextSplitLabel(db, tableId) domain helper:
- Returns first unused letter A-Z for orders with status 'open' or 'billed'
- Fills gaps (if A and C are used, returns B)
- Returns null when all 26 letters are taken
- Caller holds any transaction (single-writer makes it safe)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Order create assigns labels; order/KOT JSON gain splitLabel + tableName

**Files:**
- Modify: `apps/server/src/mappers.ts` (OrderRow gains split_label; orderJson + loadOrderJson gain splitLabel + tableName LEFT JOIN; kotWithContextJson output gains splitLabel)
- Modify: `apps/server/src/orders.ts` (line 113-116: DELETE occupied-409 block; replace with label-picking transaction + 26-cap check; INSERT gains split_label column)
- Modify: `apps/server/src/orders.test.ts` (line 126: rewrite "table occupied" → "second create on same table → 201, splitLabel B"; add 8 new tests)
- Modify: `apps/server/src/kots.test.ts` (add 2 new tests: board + send payloads carry splitLabel)
- Test: full suite runs green

**Interfaces:**
- Consumes: `nextSplitLabel` from `@forkflow/domain`; `OrderRow` gains `split_label: string | null`
- Produces: Order JSON shape gains `splitLabel: string | null` and `tableName: string | null`; KOT context JSON gains `splitLabel: string | null`

### Steps

- [ ] **Step 1: Update mappers.ts OrderRow interface and serialization**

In `apps/server/src/mappers.ts`, modify the `OrderRow` interface (after line 2):

```ts
export interface OrderRow {
  id: string;
  client_ref: string;
  type: "dine_in" | "parcel";
  table_id: string | null;
  split_label: string | null;
  status: "open" | "billed" | "settled" | "cancelled";
  opened_by: string;
  opened_at: number;
  closed_at: number | null;
}
```

Replace the `loadOrderJson` function (originally line 70 onwards) with:

```ts
export function loadOrderJson(db: Database, orderId: string) {
  const row = db
    .prepare(
      `SELECT o.*, dt.name AS table_name
       FROM orders o
       LEFT JOIN dining_tables dt ON dt.id = o.table_id
       WHERE o.id = ?`
    )
    .get(orderId) as (OrderRow & { table_name: string | null }) | undefined;

  if (!row) return null;

  const items = db
    .prepare("SELECT * FROM order_items WHERE order_id = ? ORDER BY id")
    .all(orderId) as OrderItemRow[];

  const kots = db
    .prepare("SELECT * FROM kots WHERE order_id = ? ORDER BY created_at")
    .all(orderId) as KotRow[];

  return {
    id: row.id,
    clientRef: row.client_ref,
    type: row.type,
    tableId: row.table_id,
    splitLabel: row.split_label,
    tableName: row.table_name,
    status: row.status,
    openedBy: row.opened_by,
    openedAt: row.opened_at,
    closedAt: row.closed_at,
    items: items.map(orderItemJson),
    kots: kots.map(kotJson),
  };
}
```

Modify the `kotWithContextJson` function to add `splitLabel` (originally line 63):

```ts
export function kotWithContextJson(
  kot: KotRow,
  order: OrderRow,
  tableName: string | null,
  items: OrderItemRow[],
) {
  return {
    ...kotJson(kot),
    orderType: order.type,
    tableName,
    splitLabel: order.split_label,
    items: items.map((i) => ({ id: i.id, name: i.name_snapshot, qty: i.qty, note: i.note, status: i.status })),
  };
}
```

- [ ] **Step 2: Update orders.ts to pick labels and remove occupied-409**

In `apps/server/src/orders.ts`, add the import for `nextSplitLabel` (top of file, after line 1):

```ts
import { OrderCreate, OrderItemsAdd, OrderItemUpdate, ItemCancel, uuidv7, roleFor, nextSplitLabel } from "@forkflow/domain";
```

Replace the dine_in occupied check (originally lines 113-116) with the new label-picking transaction. The full `if (body.type === "dine_in")` block (lines 106-117) becomes:

```ts
    if (body.type === "dine_in") {
      const table = app.db
        .prepare("SELECT id, is_active FROM dining_tables WHERE id = ?")
        .get(body.tableId!) as { id: string; is_active: number } | undefined;
      if (!table) throw httpError(400, "unknown table");
      if (table.is_active !== 1) throw httpError(409, "table is not active");

      // No longer checking for occupied — splits allowed
    }
```

Replace the INSERT statement (originally lines 119-122) to include split_label:

```ts
    const id = uuidv7();
    const now = Date.now();

    if (body.type === "dine_in") {
      const write = app.db.transaction(() => {
        const label = nextSplitLabel(app.db, body.tableId!);
        if (label === null) throw httpError(409, "table has too many open splits");

        app.db
          .prepare("INSERT INTO orders (id, client_ref, type, table_id, split_label, opened_by, opened_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
          .run(id, body.clientRef, body.type, body.tableId, label, req.user.id, now);
      });
      write();
    } else {
      // Parcel: split_label is NULL
      app.db
        .prepare("INSERT INTO orders (id, client_ref, type, table_id, split_label, opened_by, opened_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(id, body.clientRef, body.type, body.tableId, null, req.user.id, now);
    }
```

- [ ] **Step 3: Rewrite the "table occupied" test in orders.test.ts**

In `apps/server/src/orders.test.ts`, find the test "creates a dine_in order after table checks" (originally line 72). Replace orders.test.ts:112-127 (from `const order1 = ...` through the occupied expectations) with:

```ts
    const order1 = await app.inject({
      method: "POST", url: "/api/orders",
      payload: { clientRef: "order-c4", type: "dine_in", tableId },
      headers: auth(admin.token),
    });
    expect(order1.statusCode).toBe(201);
    expect(order1.json().order.tableId).toBe(tableId);
    expect(order1.json().order.splitLabel).toBe("A");

    // Second create on same table -> 201 with splitLabel "B"
    const order2 = await app.inject({
      method: "POST", url: "/api/orders",
      payload: { clientRef: "order-c5", type: "dine_in", tableId },
      headers: auth(admin.token),
    });
    expect(order2.statusCode).toBe(201);
    expect(order2.json().order.splitLabel).toBe("B");
```

- [ ] **Step 4: Add new tests to orders.test.ts**

Append the following tests to the `orders: create/get/list` describe block in `apps/server/src/orders.test.ts` (before the closing brace of the describe):

```ts
  it("assigns split labels A, B, C in sequence for dine_in orders", async () => {
    app = freshApp();
    const admin = await setupAdmin(app);

    const tableRes = await app.inject({
      method: "POST", url: "/api/tables",
      payload: { name: "T1" },
      headers: auth(admin.token),
    });
    const tableId = tableRes.json().table.id;

    const orderA = await app.inject({
      method: "POST", url: "/api/orders",
      payload: { clientRef: "split-aa", type: "dine_in", tableId },
      headers: auth(admin.token),
    });
    expect(orderA.json().order.splitLabel).toBe("A");

    const orderB = await app.inject({
      method: "POST", url: "/api/orders",
      payload: { clientRef: "split-bb", type: "dine_in", tableId },
      headers: auth(admin.token),
    });
    expect(orderB.json().order.splitLabel).toBe("B");

    const orderC = await app.inject({
      method: "POST", url: "/api/orders",
      payload: { clientRef: "split-cc", type: "dine_in", tableId },
      headers: auth(admin.token),
    });
    expect(orderC.json().order.splitLabel).toBe("C");
  });

  it("reuses split labels after order cancellation", async () => {
    app = freshApp();
    const admin = await setupAdmin(app);

    const tableRes = await app.inject({
      method: "POST", url: "/api/tables",
      payload: { name: "T1" },
      headers: auth(admin.token),
    });
    const tableId = tableRes.json().table.id;

    const orderA = await app.inject({
      method: "POST", url: "/api/orders",
      payload: { clientRef: "split-aa", type: "dine_in", tableId },
      headers: auth(admin.token),
    });
    const orderAId = orderA.json().order.id;
    expect(orderA.json().order.splitLabel).toBe("A");

    // Cancel order A
    await app.inject({
      method: "POST", url: `/api/orders/${orderAId}/cancel`,
      headers: auth(admin.token),
    });

    // Next order should reuse 'A'
    const orderA2 = await app.inject({
      method: "POST", url: "/api/orders",
      payload: { clientRef: "split-aa2", type: "dine_in", tableId },
      headers: auth(admin.token),
    });
    expect(orderA2.json().order.splitLabel).toBe("A");
  });

  it("billed orders hold their letter (no reuse until settled)", async () => {
    app = freshApp();
    const admin = await setupAdmin(app);

    const tableRes = await app.inject({
      method: "POST", url: "/api/tables",
      payload: { name: "T1" },
      headers: auth(admin.token),
    });
    const tableId = tableRes.json().table.id;

    const orderA = await app.inject({
      method: "POST", url: "/api/orders",
      payload: { clientRef: "split-aa", type: "dine_in", tableId },
      headers: auth(admin.token),
    });
    const orderAId = orderA.json().order.id;
    expect(orderA.json().order.splitLabel).toBe("A");

    // Mark as billed via raw SQL (no billing API yet)
    app.db.prepare("UPDATE orders SET status = 'billed' WHERE id = ?").run(orderAId);

    // Next order should be 'B' (A is still held)
    const orderB = await app.inject({
      method: "POST", url: "/api/orders",
      payload: { clientRef: "split-bb", type: "dine_in", tableId },
      headers: auth(admin.token),
    });
    expect(orderB.json().order.splitLabel).toBe("B");
  });

  it("parcel orders have null splitLabel", async () => {
    app = freshApp();
    const admin = await setupAdmin(app);

    const orderRes = await app.inject({
      method: "POST", url: "/api/orders",
      payload: { clientRef: "parcel-1", type: "parcel" },
      headers: auth(admin.token),
    });
    expect(orderRes.json().order.splitLabel).toBeNull();
  });

  it("clientRef replay on occupied table returns existing order without consuming a letter", async () => {
    app = freshApp();
    const admin = await setupAdmin(app);

    const tableRes = await app.inject({
      method: "POST", url: "/api/tables",
      payload: { name: "T1" },
      headers: auth(admin.token),
    });
    const tableId = tableRes.json().table.id;

    const order1 = await app.inject({
      method: "POST", url: "/api/orders",
      payload: { clientRef: "replay-ref", type: "dine_in", tableId },
      headers: auth(admin.token),
    });
    expect(order1.statusCode).toBe(201);
    expect(order1.json().order.splitLabel).toBe("A");

    // Replay same clientRef -> 200, same order
    const order2 = await app.inject({
      method: "POST", url: "/api/orders",
      payload: { clientRef: "replay-ref", type: "dine_in", tableId },
      headers: auth(admin.token),
    });
    expect(order2.statusCode).toBe(200);
    expect(order2.json().order.id).toBe(order1.json().order.id);
    expect(order2.json().order.splitLabel).toBe("A");

    // Next new order should be 'B' (replay didn't consume a letter)
    const order3 = await app.inject({
      method: "POST", url: "/api/orders",
      payload: { clientRef: "new-ref-1", type: "dine_in", tableId },
      headers: auth(admin.token),
    });
    expect(order3.json().order.splitLabel).toBe("B");
  });

  it("order JSON includes tableName for dine_in orders", async () => {
    app = freshApp();
    const admin = await setupAdmin(app);

    const tableRes = await app.inject({
      method: "POST", url: "/api/tables",
      payload: { name: "T1", area: "Patio" },
      headers: auth(admin.token),
    });
    const tableId = tableRes.json().table.id;

    const orderRes = await app.inject({
      method: "POST", url: "/api/orders",
      payload: { clientRef: "order-with-table", type: "dine_in", tableId },
      headers: auth(admin.token),
    });
    expect(orderRes.json().order.tableName).toBe("T1");
  });

  it("26-split cap returns 409 error", async () => {
    app = freshApp();
    const admin = await setupAdmin(app);

    const tableRes = await app.inject({
      method: "POST", url: "/api/tables",
      payload: { name: "T1" },
      headers: auth(admin.token),
    });
    const tableId = tableRes.json().table.id;

    // Create 26 splits
    const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    for (let i = 0; i < 26; i++) {
      const res = await app.inject({
        method: "POST", url: "/api/orders",
        payload: { clientRef: `split-cap-${letters[i]}`, type: "dine_in", tableId },
        headers: auth(admin.token),
      });
      expect(res.statusCode).toBe(201);
    }

    // 27th split should fail
    const overflow = await app.inject({
      method: "POST", url: "/api/orders",
      payload: { clientRef: "split-overflow", type: "dine_in", tableId },
      headers: auth(admin.token),
    });
    expect(overflow.statusCode).toBe(409);
    expect(overflow.json().error).toBe("table has too many open splits");
  });

  it("parcel order JSON has null tableName", async () => {
    app = freshApp();
    const admin = await setupAdmin(app);

    const orderRes = await app.inject({
      method: "POST", url: "/api/orders",
      payload: { clientRef: "parcel-1", type: "parcel" },
      headers: auth(admin.token),
    });
    expect(orderRes.json().order.tableName).toBeNull();
  });
```

- [ ] **Step 5: Add kots.test.ts tests for splitLabel in board + send**

Append to `apps/server/src/kots.test.ts` (after the last test, before the closing brace):

```ts
  it("KOT board payload includes splitLabel from order", async () => {
    app = freshApp();
    const admin = await setupAdmin(app);
    const { biryaniId } = await fixtures(app, admin.token);

    const tableRes = await app.inject({
      method: "POST", url: "/api/tables",
      payload: { name: "T1" },
      headers: auth(admin.token),
    });
    const tableId = tableRes.json().table.id;

    const orderRes = await app.inject({
      method: "POST", url: "/api/orders",
      payload: { clientRef: "order-for-kot", type: "dine_in", tableId },
      headers: auth(admin.token),
    });
    const orderId = orderRes.json().order.id;

    await app.inject({
      method: "POST", url: `/api/orders/${orderId}/items`,
      payload: { items: [{ productId: biryaniId, qty: 1 }] },
      headers: auth(admin.token),
    });

    await app.inject({
      method: "POST", url: `/api/orders/${orderId}/send`,
      headers: auth(admin.token),
    });

    const boardRes = await app.inject({
      method: "GET", url: "/api/kots",
      headers: auth(admin.token),
    });
    expect(boardRes.statusCode).toBe(200);
    const kots = boardRes.json().kots;
    expect(kots[0]!.splitLabel).toBe("A");
  });

  it("send response KOT context includes splitLabel", async () => {
    app = freshApp();
    const admin = await setupAdmin(app);
    const { biryaniId } = await fixtures(app, admin.token);

    const tableRes = await app.inject({
      method: "POST", url: "/api/tables",
      payload: { name: "T2" },
      headers: auth(admin.token),
    });
    const tableId = tableRes.json().table.id;

    const orderRes = await app.inject({
      method: "POST", url: "/api/orders",
      payload: { clientRef: "order-send-split", type: "dine_in", tableId },
      headers: auth(admin.token),
    });
    const orderId = orderRes.json().order.id;

    await app.inject({
      method: "POST", url: `/api/orders/${orderId}/items`,
      payload: { items: [{ productId: biryaniId, qty: 1 }] },
      headers: auth(admin.token),
    });

    const sendRes = await app.inject({
      method: "POST", url: `/api/orders/${orderId}/send`,
      headers: auth(admin.token),
    });
    expect(sendRes.statusCode).toBe(200);
    const { kots } = sendRes.json();
    expect(kots[0]!.splitLabel).toBe("A");
  });
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run apps/server/src/orders.test.ts`

Expected: PASS (25 tests total: 17 existing + 8 new).

Run: `npx vitest run apps/server/src/kots.test.ts`

Expected: PASS (includes 2 new splitLabel tests).

Then full suite: `npm test`

Expected: 139 passing (120 baseline + 1 mappers + 8 domain/migration + 8 orders + 2 kots). `npm run typecheck` → clean.

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/mappers.ts apps/server/src/orders.ts apps/server/src/orders.test.ts apps/server/src/kots.test.ts
git commit -m "$(cat <<'EOF'
feat(orders): assign split labels on dine_in create; add splitLabel + tableName to JSON

- OrderRow gains split_label column
- Order JSON (all routes) gains splitLabel and tableName (LEFT JOIN dining_tables)
- KOT context JSON gains splitLabel (board + send + broadcasts)
- POST /api/orders dine_in: DELETE occupied-409 check, replace with label-picking
  transaction using nextSplitLabel; INSERT adds split_label column (parcels get NULL)
- 409 "table has too many open splits" when all 26 letters are used
- clientRef replay returns existing order without consuming a letter

Tests:
- Rewrite "table occupied" → "second create on same table → 201, splitLabel B"
- Add 8 tests: A/B/C sequence, letter reuse after cancel, billed holds letter,
  parcel null, replay-no-letter, tableName in JSON, 26-cap 409, parcel tableName null
- Add 2 kots.test.ts tests: board + send payloads carry splitLabel

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Tables API — activeOrders + status derivation rewrite

**Files:**
- Modify: `apps/server/src/tables.ts` (replace `deriveStatus` with `deriveTableState`; `toTable` removes `openOrderId`, adds `activeOrders`; deactivate guard unchanged)
- Modify: `apps/server/src/tables.test.ts` (lines 32, 81, 86, 91: replace `openOrderId` matchers with `activeOrders`; add 4 new tests)
- Test: full suite runs green

**Interfaces:**
- Consumes: Nothing new
- Produces: `GET /api/tables` JSON shape: table objects now have `activeOrders: Array<{ id: string; splitLabel: string | null; status: "open" | "billed" }>` instead of `openOrderId`

### Steps

- [ ] **Step 1: Rewrite deriveStatus to deriveTableState in tables.ts**

In `apps/server/src/tables.ts`, replace the `deriveStatus` function (originally lines 24-39) with:

```ts
  function deriveTableState(tableId: string): {
    status: TableStatus;
    activeOrders: Array<{ id: string; splitLabel: string | null; status: "open" | "billed" }>;
  } {
    const orders = app.db
      .prepare(
        `SELECT id, split_label, status FROM orders
         WHERE table_id = ? AND status IN ('open', 'billed')
         ORDER BY split_label`
      )
      .all(tableId) as Array<{ id: string; split_label: string | null; status: "open" | "billed" }>;

    if (orders.length === 0) {
      return { status: "free", activeOrders: [] };
    }

    const hasOpen = orders.some((o) => o.status === "open");
    const status = hasOpen ? "occupied" : "billed";

    return {
      status,
      activeOrders: orders.map((o) => ({ id: o.id, splitLabel: o.split_label, status: o.status })),
    };
  }
```

Replace the `toTable` function (originally lines 41-52) with:

```ts
  const toTable = (r: TableRow) => {
    const { status, activeOrders } = deriveTableState(r.id);
    return {
      id: r.id,
      name: r.name,
      area: r.area,
      sortOrder: r.sort_order,
      isActive: r.is_active === 1,
      status,
      activeOrders,
    };
  };
```

The deactivate guard in the PATCH route (originally lines 75-79) stays unchanged semantically but now uses the new function:

```ts
    if (body.isActive === false) {
      const { status } = deriveTableState(id);
      if (status === "occupied" || status === "billed") {
        throw httpError(409, "table has an open order");
      }
    }
```

- [ ] **Step 2: Rewrite tables.test.ts to use activeOrders**

In `apps/server/src/tables.test.ts`, replace line 32 (originally `status: "free", openOrderId: null`) with:

```ts
    expect(res.json().table).toMatchObject({ name: "T1", area: "Main", sortOrder: 0, isActive: true, status: "free", activeOrders: [] });
```

Replace lines 80-91 (the "derives occupied/billed status" test assertions) with:

```ts
    const occupied = await app.inject({ method: "GET", url: "/api/tables", headers: auth(admin.token) });
    expect(occupied.json().tables[0]).toMatchObject({
      id: table.id,
      status: "occupied",
      activeOrders: [{ id: orderId, splitLabel: "A", status: "open" }],
    });

    // Update the order to billed
    app.db.prepare("UPDATE orders SET status = ? WHERE id = ?").run("billed", orderId);
    const billed = await app.inject({ method: "GET", url: "/api/tables", headers: auth(admin.token) });
    expect(billed.json().tables[0]).toMatchObject({
      status: "billed",
      activeOrders: [{ id: orderId, splitLabel: "A", status: "billed" }],
    });

    // Close the order (settled)
    app.db.prepare("UPDATE orders SET status = ?, closed_at = ? WHERE id = ?").run("settled", Date.now(), orderId);
    const free = await app.inject({ method: "GET", url: "/api/tables", headers: auth(admin.token) });
    expect(free.json().tables[0]).toMatchObject({ status: "free", activeOrders: [] });
```

- [ ] **Step 3: Add new tables.test.ts tests for multi-split scenarios**

Append the following tests to the `tables` describe block (before the closing brace):

```ts
  it("derives occupied status when table has multiple open orders", async () => {
    app = freshApp();
    const admin = await setupAdmin(app);
    const { table } = await addTable(admin.token, "T1");

    const order1Id = uuidv7();
    const order2Id = uuidv7();
    app.db
      .prepare(
        "INSERT INTO orders (id, client_ref, type, table_id, split_label, status, opened_by, opened_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
      )
      .run(order1Id, "ref-1", "dine_in", table.id, "A", "open", admin.user.id, Date.now());
    app.db
      .prepare(
        "INSERT INTO orders (id, client_ref, type, table_id, split_label, status, opened_by, opened_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
      )
      .run(order2Id, "ref-2", "dine_in", table.id, "B", "open", admin.user.id, Date.now());

    const res = await app.inject({ method: "GET", url: "/api/tables", headers: auth(admin.token) });
    expect(res.json().tables[0]).toMatchObject({
      status: "occupied",
      activeOrders: [
        { id: order1Id, splitLabel: "A", status: "open" },
        { id: order2Id, splitLabel: "B", status: "open" },
      ],
    });
  });

  it("derives occupied status when table has one open and one billed order", async () => {
    app = freshApp();
    const admin = await setupAdmin(app);
    const { table } = await addTable(admin.token, "T1");

    const order1Id = uuidv7();
    const order2Id = uuidv7();
    app.db
      .prepare(
        "INSERT INTO orders (id, client_ref, type, table_id, split_label, status, opened_by, opened_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
      )
      .run(order1Id, "ref-1", "dine_in", table.id, "A", "open", admin.user.id, Date.now());
    app.db
      .prepare(
        "INSERT INTO orders (id, client_ref, type, table_id, split_label, status, opened_by, opened_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
      )
      .run(order2Id, "ref-2", "dine_in", table.id, "B", "billed", admin.user.id, Date.now());

    const res = await app.inject({ method: "GET", url: "/api/tables", headers: auth(admin.token) });
    expect(res.json().tables[0]).toMatchObject({
      status: "occupied",
      activeOrders: [
        { id: order1Id, splitLabel: "A", status: "open" },
        { id: order2Id, splitLabel: "B", status: "billed" },
      ],
    });
  });

  it("derives billed status when table has only billed orders", async () => {
    app = freshApp();
    const admin = await setupAdmin(app);
    const { table } = await addTable(admin.token, "T1");

    const order1Id = uuidv7();
    app.db
      .prepare(
        "INSERT INTO orders (id, client_ref, type, table_id, split_label, status, opened_by, opened_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
      )
      .run(order1Id, "ref-1", "dine_in", table.id, "A", "billed", admin.user.id, Date.now());

    const res = await app.inject({ method: "GET", url: "/api/tables", headers: auth(admin.token) });
    expect(res.json().tables[0]).toMatchObject({
      status: "billed",
      activeOrders: [{ id: order1Id, splitLabel: "A", status: "billed" }],
    });
  });

  it("derives free status when all orders are settled or cancelled (activeOrders empty)", async () => {
    app = freshApp();
    const admin = await setupAdmin(app);
    const { table } = await addTable(admin.token, "T1");

    const order1Id = uuidv7();
    const order2Id = uuidv7();
    app.db
      .prepare(
        "INSERT INTO orders (id, client_ref, type, table_id, split_label, status, opened_by, opened_at, closed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
      )
      .run(order1Id, "ref-1", "dine_in", table.id, "A", "settled", admin.user.id, Date.now(), Date.now());
    app.db
      .prepare(
        "INSERT INTO orders (id, client_ref, type, table_id, split_label, status, opened_by, opened_at, closed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
      )
      .run(order2Id, "ref-2", "dine_in", table.id, "B", "cancelled", admin.user.id, Date.now(), Date.now());

    const res = await app.inject({ method: "GET", url: "/api/tables", headers: auth(admin.token) });
    expect(res.json().tables[0]).toMatchObject({ status: "free", activeOrders: [] });
  });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run apps/server/src/tables.test.ts`

Expected: PASS (9 tests: 5 existing + 4 new).

Then full suite: `npm test`

Expected: 143 passing (139 from Task 3 + 4 new tables tests). `npm run typecheck` → clean.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/tables.ts apps/server/src/tables.test.ts
git commit -m "$(cat <<'EOF'
feat(tables): activeOrders array + status derivation rewrite

- Replace deriveStatus with deriveTableState returning
  {status, activeOrders: Array<{id, splitLabel, status}>}
- Query orders WHERE status IN ('open','billed') ORDER BY split_label
- Status: any open → 'occupied', else any billed → 'billed', else 'free'
- toTable output: REMOVE openOrderId, ADD activeOrders
- Deactivate guard: unchanged semantics (409 when status !== 'free')

Tests:
- Rewrite 4 existing test matchers (openOrderId → activeOrders)
- Add 4 new tests: open+open → occupied with 2 activeOrders sorted A,B;
  open+billed → occupied; billed-only → billed; all settled → free, activeOrders []

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

# UI Implementation (Tasks 5–7)

Branch: `m3s-table-splits` (branch-in-place, NO worktree).

## Global Constraints

- Import style: extensionless in `apps/ui` (Vite).
- Root tsconfig has `noUncheckedIndexedAccess`: index into arrays with `[0]!` or `?.`.
- UI: NEVER `crypto.randomUUID` — use `uuid()` from `apps/ui/src/uuid.ts`.
- All mutating buttons need in-flight guards (reuse Punch/Send pattern from OrderScreen.tsx).
- Screens refetch on WS reconnect via `onStatus(true)`.
- WS event vocabulary FROZEN: `order.updated` `kot.created` `kot.updated` `table.changed`. No new events.
- Baseline: 120 tests green at `b863f15`. Every task ends with full suite green.
- UI verification: `npm run typecheck` (includes `tsc --noEmit && npm run typecheck -w @forkflow/ui`) + `npx vitest run` full suite.
- Exact UI strings are contractual (see each task).

---

## Task 5: UI types + Tables screen (tap logic, picker, splits suffix)

**Files:**
- **Modify:** `apps/ui/src/types.ts` (lines 48-56 for `TableInfo`, lines 73-84 for `Order`)
- **Modify:** `apps/ui/src/screens/Tables.tsx` (lines 77-95 tap handler; new picker component state + render; line 199 status line)
- **Test:** `npm run typecheck` + `npx vitest run` (full suite green) + manual smoke (see steps)

**Interfaces:**

*Consumes (from Task 4):*
```ts
// GET /api/tables response, each table includes:
{
  id: string;
  name: string;
  area: string | null;
  sortOrder: number;
  isActive: boolean;
  status: "free" | "occupied" | "billed";
  activeOrders: Array<{ id: string; splitLabel: string | null; status: "open" | "billed" }>;
}
```

*Produces:*
```ts
// Updated TableInfo type in apps/ui/src/types.ts
export interface TableInfo {
  id: string;
  name: string;
  area: string | null;
  sortOrder: number;
  isActive: boolean;
  status: "free" | "occupied" | "billed";
  activeOrders: Array<{ id: string; splitLabel: string | null; status: "open" | "billed" }>;
}

// Order type gains splitLabel and tableName (from Task 3 order JSON)
export interface Order {
  id: string;
  clientRef: string;
  type: "dine_in" | "parcel";
  tableId: string | null;
  splitLabel: string | null;
  tableName: string | null;
  status: "open" | "billed" | "settled" | "cancelled";
  openedBy: string;
  openedAt: number;
  closedAt: number | null;
  items: OrderItem[];
  kots: Kot[];
}
```

**Steps:**

- [ ] **Step 1: Update TableInfo type in apps/ui/src/types.ts**

Replace lines 48-56 (the entire `TableInfo` interface):

```ts
export interface TableInfo {
  id: string;
  name: string;
  area: string | null;
  sortOrder: number;
  isActive: boolean;
  status: "free" | "occupied" | "billed";
  activeOrders: Array<{ id: string; splitLabel: string | null; status: "open" | "billed" }>;
}
```

- [ ] **Step 2: Update Order type to include splitLabel and tableName**

Replace lines 73-84 (the entire `Order` interface):

```ts
export interface Order {
  id: string;
  clientRef: string;
  type: "dine_in" | "parcel";
  tableId: string | null;
  splitLabel: string | null;
  tableName: string | null;
  status: "open" | "billed" | "settled" | "cancelled";
  openedBy: string;
  openedAt: number;
  closedAt: number | null;
  items: OrderItem[];
  kots: Kot[];
}
```

- [ ] **Step 3: Run typecheck to verify type changes**

```bash
npm run typecheck
```

Expected: Typecheck fails on Tables.tsx line 79 (`table.openOrderId` does not exist). OrderScreen.tsx does not error yet (it doesn't reference the new fields yet; Task 6 will add them).

- [ ] **Step 4: Add picker state to Tables.tsx**

After line 13 (after the `creating` state):

```ts
  const [pickerTableId, setPickerTableId] = useState<string | null>(null);
```

- [ ] **Step 5: Replace openTable tap handler (lines 77-95) with new split-aware logic**

Replace the entire `openTable` function (lines 77-95):

```ts
  function openTable(table: TableInfo) {
    if (table.activeOrders.length === 0) {
      // Free table: create split A
      if (creating) return;
      setCreating(true);
      void run(async () => {
        try {
          const { order } = await apiFetch<{ order: Order }>("/api/orders", {
            method: "POST",
            body: JSON.stringify({ clientRef: uuid(), type: "dine_in", tableId: table.id }),
          });
          onOpenOrder(order.id);
        } finally {
          setCreating(false);
        }
      });
    } else if (table.activeOrders.length === 1) {
      // Fast path: one split, open directly
      onOpenOrder(table.activeOrders[0]!.id);
    } else {
      // Multiple splits: show picker
      setPickerTableId(table.id);
    }
  }
```

- [ ] **Step 6: Add createSplitOnTable helper for the picker's "New split" button**

After the `openTable` function (before `newParcel`):

```ts
  function createSplitOnTable(tableId: string) {
    if (creating) return;
    setCreating(true);
    void run(async () => {
      try {
        const { order } = await apiFetch<{ order: Order }>("/api/orders", {
          method: "POST",
          body: JSON.stringify({ clientRef: uuid(), type: "dine_in", tableId }),
        });
        setPickerTableId(null); // close picker
        onOpenOrder(order.id);
      } finally {
        setCreating(false);
      }
    });
  }
```

- [ ] **Step 7: Update table card status line to show splits suffix (line 199)**

Replace line 199 (the status div inside the table button):

```ts
                      <div style={{ fontSize: 12, fontWeight: 400, marginTop: 4, textTransform: "capitalize" }}>
                        {t.status}{t.activeOrders.length >= 2 ? ` · ${t.activeOrders.length} splits` : ""}
                      </div>
```

- [ ] **Step 8: Add picker panel render inside each area block (after the table grid)**

Find the closing `</div>` of the grid (around line 203). Replace Tables.tsx lines 202-203 with:

```tsx
              </div>
              {/* Picker panel */}
              {(() => {
                if (pickerTableId === null) return null;
                const table = list.find((t) => t.id === pickerTableId);
                if (!table) return null;
                return (
                  <div
                    style={{
                      marginTop: 16,
                      padding: 16,
                      border: "2px solid #333",
                      borderRadius: 8,
                      backgroundColor: "#fffbf0",
                    }}
                  >
                    <h4 style={{ marginTop: 0, marginBottom: 12 }}>
                      {table.name} — splits
                    </h4>
                    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                      {table.activeOrders.map((o) => (
                        <button
                          key={o.id}
                          onClick={() => {
                            setPickerTableId(null);
                            onOpenOrder(o.id);
                          }}
                          style={{ padding: "12px 16px", fontSize: 16, textAlign: "left" }}
                        >
                          Split {o.splitLabel ?? "?"}
                          {o.status === "billed" ? " (billed)" : ""}
                        </button>
                      ))}
                      <button
                        onClick={() => createSplitOnTable(table.id)}
                        disabled={creating}
                        style={{ padding: "12px 16px", fontSize: 16, fontWeight: 700 }}
                      >
                        New split
                      </button>
                      <button
                        onClick={() => setPickerTableId(null)}
                        style={{ padding: "12px 16px", fontSize: 16 }}
                      >
                        Close
                      </button>
                    </div>
                  </div>
                );
              })()}
            </div>
```

- [ ] **Step 9: Add useEffect to clear stale picker when splits drop below 2**

After the `createSplitOnTable` function (before the `newParcel` function or the render return), add:

```ts
  // Clear picker if the target table's splits drop below 2 (e.g., remote settle/cancel)
  useEffect(() => {
    if (pickerTableId === null) return;
    const table = tables.find((t) => t.id === pickerTableId);
    if (!table || table.activeOrders.length < 2) {
      setPickerTableId(null);
    }
  }, [tables, pickerTableId]);
```

- [ ] **Step 10: Run typecheck again**

```bash
npm run typecheck
```

Expected: typecheck clean (OrderScreen.tsx never referenced the changed fields, so it does not error). If any Tables.tsx errors remain, fix them before proceeding.

- [ ] **Step 11: Run full vitest suite**

```bash
npx vitest run
```

Expected: All 143 tests pass (from Task 4). No new tests in this task (UI components have no test harness).

- [ ] **Step 12: Manual smoke test — verify picker behavior**

Build the UI production bundle first:
```bash
npm run build -w @forkflow/ui
```

Start the dev server (or use a scratch server):
```bash
FORKFLOW_DATA_DIR=<scratch> npx tsx apps/server/src/main.ts
```

In a browser:
1. Log in as admin, create a table T1 (if not already present).
2. Tap T1 (free) → order screen opens directly (split A created).
3. Navigate back to Tables. T1 should show status `occupied` (no splits suffix yet, only 1 active).
4. Tap T1 again → should open the split A order directly (fast path, no picker).
5. From the order screen, you should see the header still says "Table order — open" (Task 6 will change this to show split label).
6. Navigate back. From Tables, tap "New parcel" to create a second order.
7. Open the parcel order, punch/send an item, then back to Tables.
8. Create a NEW order on T1: POST /api/orders via curl/fetch (or implement the "+ Split" button in Task 6, but for now, use the admin endpoint directly OR wait for Task 6). Actually, the picker has a "New split" button — we can test it once T1 has 2 splits. But we can't easily get 2 splits on T1 yet without the "+ Split" button from Task 6. So this smoke test will be limited to the free/occupied fast path. Task 7's e2e gate will verify the full picker workflow after Task 6 is complete.

Smoke verification for Task 5:
- Free table tap → creates order, fast path works.
- Occupied table with 1 split → fast path opens it directly, no picker.
- Table status line shows `occupied` (no splits suffix for single split, as per spec: suffix only when `>= 2`).

Note: Full picker smoke test (2+ splits) requires Task 6's "+ Split" button to be functional, so we'll verify that in Task 7's gate script.

- [ ] **Step 13: Commit Task 5 changes**

```bash
git add apps/ui/src/types.ts apps/ui/src/screens/Tables.tsx
git commit -m "$(cat <<'EOF'
feat(ui): table splits — types + Tables tap logic + picker

- TableInfo: remove openOrderId, add activeOrders array
- Order: add splitLabel and tableName fields (from Task 3)
- Tables tap handler: 0 splits -> create, 1 -> fast open, 2+ -> picker
- Picker: inline panel with "Split {label}" buttons, billed suffix, "New
  split" and "Close" actions; useEffect clears stale picker when splits < 2
- Status line: append " · {n} splits" when activeOrders.length >= 2

Contractual UI strings: "New split", "Close", "Split {label}", " (billed)",
" · {n} splits" (U+00B7 middle dot).

Verification: typecheck + full suite green (143 tests). Picker behavior
verified in Task 7 gate.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 14: Verify commit + suite green**

```bash
git log -1 --stat
npm run typecheck
npx vitest run
```

Expected: Commit shows the two modified files; typecheck clean; 143 tests pass.

---

## Task 6: OrderScreen header + "+ Split" button; Kitchen context line

**Files:**
- **Modify:** `apps/ui/src/types.ts` (line 95-111 for `KotWithContext` type)
- **Modify:** `apps/ui/src/screens/OrderScreen.tsx` (add onOpenOrder prop; lines 147-149 header; new "+ Split" button immediately after the closing `</h2>`, before the Back button)
- **Modify:** `apps/ui/src/App.tsx` (line 61: pass onOpenOrder prop and add key={page.orderId})
- **Modify:** `apps/ui/src/screens/Kitchen.tsx` (line 61 context line)
- **Test:** `npm run typecheck` + `npx vitest run` + manual smoke (see steps)

**Interfaces:**

*Consumes (from Task 3):*
```ts
// Order JSON includes (from Task 5 + Task 3):
{
  id: string;
  clientRef: string;
  type: "dine_in" | "parcel";
  tableId: string | null;
  splitLabel: string | null;
  tableName: string | null;
  status: "open" | "billed" | "settled" | "cancelled";
  // ... items, kots
}

// KOT context JSON (kot board, send response, broadcasts) includes:
{
  id: string;
  kotNo: number;
  stationId: string;
  orderId: string;
  createdAt: number;
  doneAt: number | null;
  orderType: "dine_in" | "parcel";
  tableName: string | null;
  splitLabel: string | null;  // NEW from Task 3
  items: Array<{ ... }>;
}
```

*Produces:*
```ts
// Updated KotWithContext type in apps/ui/src/types.ts
export interface KotWithContext {
  id: string;
  kotNo: number;
  stationId: string;
  orderId: string;
  createdAt: number;
  doneAt: number | null;
  orderType: "dine_in" | "parcel";
  tableName: string | null;
  splitLabel: string | null;
  items: Array<{
    id: string;
    name: string;
    qty: number;
    note: string | null;
    status: "pending" | "sent" | "cancelled";
  }>;
}
```

**Steps:**

- [ ] **Step 1: Update KotWithContext type in apps/ui/src/types.ts**

Replace lines 95-111 (the entire `KotWithContext` interface):

```ts
export interface KotWithContext {
  id: string;
  kotNo: number;
  stationId: string;
  orderId: string;
  createdAt: number;
  doneAt: number | null;
  orderType: "dine_in" | "parcel";
  tableName: string | null;
  splitLabel: string | null;
  items: Array<{
    id: string;
    name: string;
    qty: number;
    note: string | null;
    status: "pending" | "sent" | "cancelled";
  }>;
}
```

- [ ] **Step 2: Run typecheck**

```bash
npm run typecheck
```

Expected: Typecheck passes clean. OrderScreen.tsx doesn't reference the new fields yet (we add them in the next steps); Kitchen.tsx similarly doesn't use `kot.splitLabel` yet.

- [ ] **Step 3: Update OrderScreen signature to add onOpenOrder prop**

In `apps/ui/src/screens/OrderScreen.tsx`, replace line 18:

```tsx
export function OrderScreen({ user, orderId, onBack, onOpenOrder }: { user: User; orderId: string; onBack: () => void; onOpenOrder: (orderId: string) => void }) {
```

- [ ] **Step 4: Update OrderScreen header (lines 147-149)**

Replace lines 147-149 (the entire h2 block inside the header div):

```tsx
        <h2>
          {order.type === "dine_in"
            ? `${order.tableName ?? "Table"} · ${order.splitLabel ?? "A"} — ${order.status}`
            : `Parcel — ${order.status}`}
        </h2>
```

Contractual strings: em-dash `—` (U+2014), middle dot `·` (U+00B7).

- [ ] **Step 5: Update App.tsx to pass onOpenOrder prop and add key**

In `apps/ui/src/App.tsx`, replace line 61 — KEEP the `{page.name === "order" && …}` wrapper (it narrows the `Page` union; dropping it renders OrderScreen on every page AND fails typecheck on `page.orderId`):

```tsx
          {page.name === "order" && <OrderScreen key={page.orderId} user={user} orderId={page.orderId} onBack={onBack} onOpenOrder={onOpenOrder} />}
```

(The `key={page.orderId}` ensures OrderScreen remounts when switching splits, resetting draft state to prevent cart bleed.)

- [ ] **Step 6: Add "+ Split" button after the header h2**

Immediately after the closing `</h2>` (before the Back button; do not rely on pre-edit line numbers — Step 4 shifted them), insert:

```tsx
        {order.type === "dine_in" && order.status === "open" && (
          <button
            onClick={() => {
              if (pending) return;
              setPending(true);
              void run(async () => {
                try {
                  const { order: newOrder } = await apiFetch<{ order: Order }>("/api/orders", {
                    method: "POST",
                    body: JSON.stringify({ clientRef: uuid(), type: "dine_in", tableId: order.tableId }),
                  });
                  onOpenOrder(newOrder.id);
                } finally {
                  setPending(false);
                }
              });
            }}
            disabled={pending}
            style={{ padding: "8px 16px", fontWeight: 700 }}
          >
            + Split
          </button>
        )}
```

So the full header block (lines 146-152) becomes:

```tsx
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <h2>
          {order.type === "dine_in"
            ? `${order.tableName ?? "Table"} · ${order.splitLabel ?? "A"} — ${order.status}`
            : `Parcel — ${order.status}`}
        </h2>
        {order.type === "dine_in" && order.status === "open" && (
          <button
            onClick={() => {
              if (pending) return;
              setPending(true);
              void run(async () => {
                try {
                  const { order: newOrder } = await apiFetch<{ order: Order }>("/api/orders", {
                    method: "POST",
                    body: JSON.stringify({ clientRef: uuid(), type: "dine_in", tableId: order.tableId }),
                  });
                  onOpenOrder(newOrder.id);
                } finally {
                  setPending(false);
                }
              });
            }}
            disabled={pending}
            style={{ padding: "8px 16px", fontWeight: 700 }}
          >
            + Split
          </button>
        )}
        <button onClick={onBack} style={{ padding: "8px 16px" }}>
          ← Back
        </button>
      </div>
```

Contractual string: `+ Split` (exact, including the plus and space).

- [ ] **Step 7: Update Kitchen context line (line 61)**

Replace line 61 (the context div inside the KOT card):

```tsx
            <div style={{ fontSize: 14, marginBottom: 8 }}>
              {kot.orderType === "parcel"
                ? "Parcel"
                : kot.splitLabel && kot.splitLabel !== "A"
                  ? `${kot.tableName ?? "Table"} · ${kot.splitLabel}`
                  : kot.tableName ?? "Table"}
            </div>
```

Contractual strings: middle dot `·` (U+00B7). Context line logic:
- Parcel: "Parcel"
- Dine-in split A: just table name (e.g., "T1")
- Dine-in other splits: table name + dot + label (e.g., "T1 · B")

- [ ] **Step 8: Run typecheck**

```bash
npm run typecheck
```

Expected: All type errors resolved. OrderScreen.tsx, App.tsx, and Kitchen.tsx should now type-check cleanly.

- [ ] **Step 9: Run full vitest suite**

```bash
npx vitest run
```

Expected: All 143 tests pass (from Task 4).

- [ ] **Step 10: Manual smoke test — verify OrderScreen header + "+ Split" button**

Build the UI bundle first (the server serves `apps/ui/dist` — without a rebuild the smoke runs against the Task 5-era bundle and the new header/button are absent), then start the server (scratch DB):
```bash
npm run build -w @forkflow/ui
FORKFLOW_DATA_DIR="<scratch>" npx tsx apps/server/src/main.ts
```

In a browser:
1. Log in as admin, create table T1 (if not already present).
2. Tap T1 → order screen opens. Header should show: `T1 · A — open` (not "Table order — open").
3. The "+ Split" button should be visible next to the Back button.
4. Click "+ Split" → navigates to a new order screen. Header should show: `T1 · B — open`.
5. Navigate back to Tables. T1 card should now show `occupied · 2 splits` (status line from Task 5).
6. Tap T1 → picker should appear with buttons: `Split A`, `Split B`, `New split`, `Close`.
7. Click `Split A` → opens split A order screen, header shows `T1 · A — open`, and you see the original items (if any).
8. Back to Tables. Tap T1, click `Split B` → opens split B, header `T1 · B — open`.
9. From split B, punch an item, send to kitchen.
10. Navigate to Kitchen page. You should see a KOT card. The context line should show `T1 · B` (not just "T1").
11. Go back to Tables, create a parcel. Open it, punch/send an item. Kitchen should show the parcel KOT with context line `Parcel`.
12. Go back to T1 split A (via picker). Punch and send an item. Kitchen should now show a KOT with context line `T1` (split A, so no suffix as per spec).

Smoke verification:
- OrderScreen header format correct for dine-in (with split label) and parcel.
- "+ Split" button visible and functional (creates new split, navigates correctly).
- Kitchen context line shows split label only when ≠ 'A', shows "Parcel" for parcels, shows plain table name for split A.

- [ ] **Step 11: Commit Task 6 changes**

```bash
git add apps/ui/src/types.ts apps/ui/src/screens/OrderScreen.tsx apps/ui/src/App.tsx apps/ui/src/screens/Kitchen.tsx
git commit -m "$(cat <<'EOF'
feat(ui): order/kitchen splits UI — headers + context

- KotWithContext type: add splitLabel field (from Task 3 kot JSON)
- OrderScreen: add onOpenOrder prop; header shows "Table · Label — status"
  for dine_in (parcel unchanged); "+ Split" button visible when dine_in + open,
  creates next split on same table with in-flight guard, navigates to new order
- App.tsx: pass onOpenOrder to OrderScreen and add key={page.orderId} to
  remount on split change (prevents draft cart bleed across splits)
- Kitchen context line: parcel -> "Parcel"; dine_in split A -> table name
  only; other splits -> "Table · Label"

Contractual strings: "+ Split", em-dash U+2014, middle dot U+00B7.

Verification: typecheck + 143 tests green + manual smoke (2-split picker,
kitchen context, draft isolation).

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 12: Verify commit + suite green**

```bash
git log -1 --stat
npm run typecheck
npx vitest run
```

Expected: Commit shows the four modified files (types.ts, OrderScreen.tsx, App.tsx, Kitchen.tsx); typecheck clean; 143 tests pass.

---

## Task 7: e2e gate script → tools/e2e/ + split scenario

**Files:**
- **Create:** `tools/e2e/gate.py` (from `.e2e-scratch/m3a_e2e.py` with modifications)
- **Create:** `tools/e2e/README.md`
- **Test:** Run gate against scratch server (see steps for exact commands)

**Interfaces:**

*Consumes (from Tasks 5 & 6):*
- OrderScreen "+ Split" button (creates next split on same table)
- Tables picker (tap multi-split table shows picker with split buttons)
- Kitchen context line (shows split label for non-A splits)
- Order header (shows split label)

*Produces:*
- `tools/e2e/gate.py`: parameterized e2e script with split scenario appended
- `tools/e2e/README.md`: how to run the gate

**Steps:**

- [ ] **Step 1: Create tools/e2e/ directory**

```bash
mkdir -p tools/e2e
```

- [ ] **Step 2: Create tools/e2e/gate.py from .e2e-scratch/m3a_e2e.py with modifications**

Create `tools/e2e/gate.py` with the following content (full file):

```python
# ForkFlow e2e gate — click-through acceptance test for M3a (orders/KOT) + M3s (splits).
# Run: python tools/e2e/gate.py
# Requires: Python 3.10+, playwright, chromium installed.
# Assumes: FRESH scratch DB (KOT numbers are per-day sequences).
import os
import re
import sys
import traceback

from playwright.sync_api import sync_playwright, expect

BASE = os.environ.get("GATE_BASE", "http://localhost:4100")
GATE_LAN = os.environ.get("GATE_LAN")  # Optional; skip LAN block if unset

expect.set_options(timeout=10_000)

step_n = 0


def step(msg):
    global step_n
    step_n += 1
    print(f"[{step_n:02d}] {msg}", flush=True)


def nav(page, tab):
    page.locator("nav").get_by_role("button", name=tab, exact=True).click()


def pin_pad(page, pin):
    for d in pin:
        page.get_by_role("button", name=d, exact=True).click()


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        ctx_a = browser.new_context()
        page1 = ctx_a.new_page()
        pages = {"admin-main": page1}

        # dialog answer queue for page1 (sent-cancel reason prompt)
        answers = []

        def on_dialog(d):
            if answers:
                a = answers.pop(0)
                if a is None:
                    d.dismiss()
                else:
                    d.accept(a)
            else:
                d.accept()

        page1.on("dialog", on_dialog)

        try:
            step("Setup: first-run admin on scratch DB")
            page1.goto(BASE)
            expect(page1.get_by_role("heading", name="Set up ForkFlow")).to_be_visible()
            page1.get_by_placeholder("Restaurant name").fill("Testaurant")
            page1.get_by_placeholder("Your name (admin)").fill("Admin")
            page1.get_by_placeholder("Admin PIN (4-6 digits)").fill("111111")
            page1.get_by_role("button", name="Start").click()
            expect(page1.get_by_text("Signed in as")).to_be_visible()

            step("Catalog: category Mains")
            nav(page1, "catalog")
            page1.get_by_placeholder("New category").fill("Mains")
            page1.get_by_role("button", name="Add", exact=True).click()
            expect(page1.get_by_role("button", name="Mains")).to_be_visible()

            step("Catalog: product Biryani (station Kitchen, variants Half/Full)")
            page1.get_by_role("button", name="New product").click()
            page1.get_by_placeholder("Product name").fill("Biryani")
            page1.get_by_placeholder("Price").first.fill("100")
            station_sel = page1.locator("select").filter(
                has=page1.locator("option", has_text="No KOT station")
            )
            station_sel.select_option(label="Kitchen")
            page1.get_by_placeholder("Variant name (e.g. Half)").fill("Half")
            page1.get_by_placeholder("Price").last.fill("60")
            page1.get_by_role("button", name="Add", exact=True).click()
            expect(page1.get_by_text(re.compile(r"Half — ₹60\.00"))).to_be_visible()
            page1.get_by_placeholder("Variant name (e.g. Half)").fill("Full")
            page1.get_by_placeholder("Price").last.fill("100")
            page1.get_by_role("button", name="Add", exact=True).click()
            expect(page1.get_by_text(re.compile(r"Full — ₹100\.00"))).to_be_visible()
            page1.get_by_role("button", name="Save", exact=True).click()
            expect(
                page1.get_by_text(re.compile(r"(Half, Full|Full, Half)"))
            ).to_be_visible()

            step("Catalog: stationless product Water Bottle")
            page1.get_by_role("button", name="New product").click()
            page1.get_by_placeholder("Product name").fill("Water Bottle")
            page1.get_by_placeholder("Price").first.fill("20")
            # station left at default "No KOT station" -> stationless
            page1.get_by_role("button", name="Save", exact=True).click()
            expect(page1.get_by_text("Water Bottle")).to_be_visible()

            step("Users: create waiter Wally (PIN 222222)")
            nav(page1, "users")
            page1.get_by_placeholder("Name", exact=True).fill("Wally")
            page1.get_by_placeholder("PIN (4-6 digits)", exact=True).fill("222222")
            page1.get_by_role("button", name="Add", exact=True).click()
            expect(page1.get_by_text("Wally")).to_be_visible()

            step("Tables: admin creates T1 via Manage tables")
            nav(page1, "tables")
            page1.get_by_role("button", name="Manage tables").click()
            page1.get_by_placeholder("Table name").fill("T1")
            page1.get_by_role("button", name="Add", exact=True).click()
            expect(page1.get_by_text("T1")).to_be_visible()
            page1.get_by_role("button", name="Done managing").click()
            t1 = page1.get_by_role("button").filter(has_text="T1")
            expect(t1).to_contain_text("free")

            step("Dine-in: tap T1 -> order opens")
            t1.click()
            expect(page1.get_by_text(re.compile(r"T1 · A — open"))).to_be_visible()

            step("Punch prep: add Biryani(Half) + stationless Water Bottle to draft")
            page1.get_by_role("button", name=re.compile(r"Half — ₹60\.00")).click()
            page1.get_by_role("button", name="Water Bottle").click()
            expect(page1.get_by_text("Cart (2 items)")).to_be_visible()

            step("Draft survives reload (localStorage)")
            page1.reload()
            expect(page1.get_by_text("Signed in as")).to_be_visible()
            nav(page1, "tables")
            t1 = page1.get_by_role("button").filter(has_text="T1")
            expect(t1).to_contain_text("occupied")
            t1.click()
            expect(page1.get_by_text("Cart (2 items)")).to_be_visible()

            step("Punch -> both items pending")
            page1.get_by_role("button", name="Punch", exact=True).click()
            expect(page1.get_by_text("pending", exact=True)).to_have_count(2)

            step("Open Kitchen board in second page (same admin session)")
            page_k = ctx_a.new_page()
            pages["kitchen"] = page_k
            page_k.goto(BASE)
            nav(page_k, "kitchen")
            expect(page_k.get_by_text("No active KOTs.")).to_be_visible()

            step("Send to kitchen -> Biryani sent, Water stays pending")
            page1.get_by_role("button", name="Send to kitchen").click()
            expect(page1.get_by_text("sent", exact=True)).to_have_count(1)
            expect(page1.get_by_text("pending", exact=True)).to_have_count(1)

            step("Kitchen board updates LIVE (no reload): KOT #1, no stationless item")
            expect(page_k.get_by_text("KOT #1")).to_be_visible()
            # Kitchen context for split A: just table name, no suffix
            expect(page_k.get_by_text("T1", exact=True)).to_be_visible()
            expect(page_k.get_by_text("Biryani (Half)")).to_be_visible()
            expect(page_k.get_by_text("Water")).to_have_count(0)

            step("Kitchen: mark KOT #1 done")
            page_k.get_by_role("button", name="Done", exact=True).click()
            expect(page_k.get_by_text("No active KOTs.")).to_be_visible()

            step("Waiter login (fresh context, PIN pad)")
            ctx_w = browser.new_context()
            page_w = ctx_w.new_page()
            pages["waiter"] = page_w
            page_w.goto(BASE)
            pin_pad(page_w, "222222")
            expect(page_w.get_by_text("Signed in as")).to_be_visible()
            expect(page_w.get_by_text("(waiter)")).to_be_visible()

            step("Waiter nav shows only home+tables")
            wnav = page_w.locator("nav")
            expect(wnav.get_by_role("button", name="tables", exact=True)).to_be_visible()
            for absent in ("kitchen", "catalog", "users", "settings"):
                expect(wnav.get_by_role("button", name=absent, exact=True)).to_have_count(0)

            step("Waiter sees NO Cancel on sent item (only on pending)")
            nav(page_w, "tables")
            page_w.get_by_role("button").filter(has_text="T1").click()
            expect(page_w.get_by_text("Punched items")).to_be_visible()
            expect(page_w.get_by_text("sent", exact=True)).to_be_visible()
            expect(
                page_w.get_by_role("button", name="Cancel", exact=True)
            ).to_have_count(1)

            step("Admin cancels SENT Biryani with required reason")
            expect(
                page1.get_by_role("button", name="Cancel", exact=True)
            ).to_have_count(2)
            answers.append("wrong item")
            biryani_row = page1.locator("div").filter(
                has_text=re.compile(r"Biryani \(Half\)")
            ).last
            biryani_row.get_by_role("button", name="Cancel", exact=True).click()
            expect(page1.get_by_text("[Cancelled: wrong item]")).to_be_visible()
            expect(page1.get_by_text("cancelled", exact=True)).to_be_visible()

            step("Waiter's open order screen shows the cancellation LIVE")
            expect(page_w.get_by_text("[Cancelled: wrong item]")).to_be_visible()

            step("Parcel round trip: create -> punch -> send")
            page1.get_by_role("button", name="← Back").click()
            page1.get_by_role("button", name="New parcel").click()
            expect(page1.get_by_text("Parcel — open")).to_be_visible()
            page1.get_by_role("button", name=re.compile(r"Full — ₹100\.00")).click()
            expect(page1.get_by_text("Cart (1 items)")).to_be_visible()
            page1.get_by_role("button", name="Punch", exact=True).click()
            expect(page1.get_by_text("pending", exact=True)).to_be_visible()
            page1.get_by_role("button", name="Send to kitchen").click()
            expect(page1.get_by_text("sent", exact=True)).to_be_visible()

            step("Kitchen gets parcel KOT #2 live, marks done")
            expect(page_k.get_by_text("KOT #2")).to_be_visible()
            expect(page_k.get_by_text("Parcel", exact=True)).to_be_visible()
            page_k.get_by_role("button", name="Done", exact=True).click()
            expect(page_k.get_by_text("No active KOTs.")).to_be_visible()

            step("Tables shows Open parcels + T1 still occupied")
            page1.get_by_role("button", name="← Back").click()
            expect(page1.get_by_text("Open parcels")).to_be_visible()
            expect(
                page1.get_by_role("button").filter(
                    has_text=re.compile(r"Parcel [0-9a-f]{8}")
                )
            ).to_be_visible()
            expect(page1.get_by_role("button").filter(has_text="T1")).to_contain_text(
                "occupied"
            )

            if GATE_LAN:
                step("LAN origin: login + order-create path (uuid fallback)")
                ctx_l = browser.new_context()
                page_l = ctx_l.new_page()
                pages["lan"] = page_l
                page_l.goto(GATE_LAN)
                rand_type = page_l.evaluate("typeof crypto.randomUUID")
                print(f"     typeof crypto.randomUUID on LAN origin = {rand_type}", flush=True)
                assert rand_type == "undefined", (
                    "LAN origin unexpectedly has crypto.randomUUID - test would not "
                    "exercise the uuid.ts fallback"
                )
                pin_pad(page_l, "111111")
                expect(page_l.get_by_text("Signed in as")).to_be_visible()
                nav(page_l, "tables")
                page_l.get_by_role("button", name="New parcel").click()
                expect(page_l.get_by_text("Parcel — open")).to_be_visible()
                page_l.get_by_role("button", name=re.compile(r"Half — ₹60\.00")).click()
                page_l.get_by_role("button", name="Punch", exact=True).click()
                expect(page_l.get_by_text("pending", exact=True)).to_be_visible()
                page_l.get_by_role("button", name="Send to kitchen").click()
                expect(page_l.get_by_text("sent", exact=True)).to_be_visible()

                step("Kitchen receives LAN-origin KOT #3 live, marks done")
                expect(page_k.get_by_text("KOT #3")).to_be_visible()
                page_k.get_by_role("button", name="Done", exact=True).click()
                expect(page_k.get_by_text("No active KOTs.")).to_be_visible()
            else:
                print("[SKIP] LAN origin test (GATE_LAN not set)", flush=True)

            # M3s split scenario starts here
            step("Split scenario: back to T1 order screen (split A)")
            page1.get_by_role("button").filter(has_text="T1").click()
            expect(page1.get_by_text(re.compile(r"T1 · A — open"))).to_be_visible()

            step("Click + Split button -> navigates to new split B order")
            page1.get_by_role("button", name="+ Split", exact=True).click()
            expect(page1.get_by_text(re.compile(r"T1 · B — open"))).to_be_visible()

            step("Punch Full Biryani on split B")
            page1.get_by_role("button", name=re.compile(r"Full — ₹100\.00")).click()
            expect(page1.get_by_text("Cart (1 items)")).to_be_visible()
            page1.get_by_role("button", name="Punch", exact=True).click()
            expect(page1.get_by_text("pending", exact=True)).to_be_visible()

            step("Send split B to kitchen")
            page1.get_by_role("button", name="Send to kitchen").click()
            expect(page1.get_by_text("sent", exact=True)).to_be_visible()

            step("Kitchen shows KOT with context 'T1 · B' (split B suffix)")
            # KOT number depends on whether the LAN block ran (#4 with LAN, #3 without).
            expected_kot_b = "KOT #4" if GATE_LAN else "KOT #3"
            expect(page_k.get_by_text(expected_kot_b)).to_be_visible()
            # Context line for split B should be "T1 · B" (middle dot U+00B7)
            expect(page_k.get_by_text(re.compile(r"T1 · B"))).to_be_visible()
            # Verify Full Biryani is listed
            expect(page_k.get_by_text("Biryani (Full)")).to_be_visible()

            step("Kitchen: mark split B KOT done")
            page_k.get_by_role("button", name="Done", exact=True).click()
            expect(page_k.get_by_text("No active KOTs.")).to_be_visible()

            step("Back to Tables: T1 card shows 'occupied · 2 splits'")
            page1.get_by_role("button", name="← Back").click()
            t1 = page1.get_by_role("button").filter(has_text="T1")
            expect(t1).to_contain_text("occupied · 2 splits")

            step("Tap T1 -> picker shows 'Split A', 'Split B', 'New split', 'Close'")
            t1.click()
            # Picker should be visible with these buttons
            expect(page1.get_by_role("button", name="Split A", exact=True)).to_be_visible()
            expect(page1.get_by_role("button", name="Split B", exact=True)).to_be_visible()
            expect(page1.get_by_role("button", name="New split", exact=True)).to_be_visible()
            expect(page1.get_by_role("button", name="Close", exact=True)).to_be_visible()

            step("Click 'Split A' in picker -> opens split A order")
            page1.get_by_role("button", name="Split A", exact=True).click()
            expect(page1.get_by_text(re.compile(r"T1 · A — open"))).to_be_visible()
            # Verify split A's items are still present (Water Bottle pending)
            expect(page1.get_by_text("1 × Water Bottle")).to_be_visible()
            expect(page1.get_by_text("pending", exact=True)).to_be_visible()

            step("Screenshot final state for review")
            page1.screenshot(path="gate-final-split-a.png", full_page=True)
            page_k.screenshot(path="gate-final-kitchen.png", full_page=True)
            print("Screenshots: gate-final-split-a.png, gate-final-kitchen.png", flush=True)

            print("\nALL STEPS PASSED (including M3s splits)", flush=True)
        except Exception:
            traceback.print_exc()
            for name, pg in pages.items():
                try:
                    pg.screenshot(path=f"gate-fail-{name}.png", full_page=True)
                    print(f"screenshot: gate-fail-{name}.png", flush=True)
                except Exception:
                    pass
            sys.exit(1)
        finally:
            browser.close()


if __name__ == "__main__":
    main()
```

- [ ] **Step 3: Create tools/e2e/README.md**

Create `tools/e2e/README.md` with the following content:

```markdown
# ForkFlow E2E Gate

Browser-based acceptance test for M3a (orders/KOT) and M3s (table splits).

## Prerequisites

- Python 3.10 or later
- Playwright with Chromium installed:
  ```bash
  pip install playwright
  playwright install chromium
  ```

## Running the gate

1. **Build the UI production bundle** (the server serves the production build):
   ```bash
   npm run build -w @forkflow/ui
   ```

2. **Start the ForkFlow server with a fresh scratch database**:
   ```bash
   FORKFLOW_DATA_DIR=<path-to-scratch-dir> npx tsx apps/server/src/main.ts
   ```

   Example (Git Bash on Windows):
   ```bash
   FORKFLOW_DATA_DIR="D:/scratch/forkflow-gate" npx tsx apps/server/src/main.ts
   ```

   The server will initialize a fresh DB on first run. To re-run the gate from scratch, delete the scratch directory and restart the server.

3. **Run the gate script** (from the repo root):
   ```bash
   python tools/e2e/gate.py
   ```

   The script connects to `http://localhost:4100` by default. Override with `GATE_BASE`:
   ```bash
   GATE_BASE=http://localhost:3000 python tools/e2e/gate.py
   ```

4. **Optional: LAN origin test** (verifies uuid fallback on insecure origins):
   ```bash
   GATE_LAN=http://192.168.x.x:4100 python tools/e2e/gate.py
   ```

   If `GATE_LAN` is not set, the LAN test is skipped (printed as `[SKIP]`).

## Notes

- **KOT numbers in assertions** are per-day sequences starting at 1. The gate assumes a **fresh scratch DB** (all KOTs start from 1). If you run the gate against a DB that has already issued KOTs today, the assertions will fail.

- **Screenshots**: On success, the gate saves `gate-final-split-a.png` and `gate-final-kitchen.png` to the current directory. On failure, it saves `gate-fail-<page-name>.png` for each open page.

- **Server logs**: The gate runs in headless mode. To debug a failing step, check the server logs (stdout from the `tsx` command) for API errors or WS events.

## Killing the server

The server does not daemonize. To stop it:
- Ctrl+C in the terminal where it's running, OR
- On Windows: `taskkill /F /IM node.exe` (kills all Node processes — use with care)
- On Unix: `pkill -f "tsx apps/server/src/main.ts"` or `lsof -ti:4100 | xargs kill`
```

- [ ] **Step 4: Run typecheck (no TypeScript in gate.py, but verify the repo is clean)**

```bash
npm run typecheck
```

Expected: All type checks pass (Tasks 5 & 6 changes are committed and clean).

- [ ] **Step 5: Build the UI production bundle**

The server serves the production build from `apps/ui/dist`, so we must build it before running the gate:

```bash
npm run build -w @forkflow/ui
```

Expected: Build succeeds, output in `apps/ui/dist`.

- [ ] **Step 6: Start the ForkFlow server with a fresh scratch DB**

In a separate terminal (Git Bash on Windows):

```bash
FORKFLOW_DATA_DIR="D:/scratch/forkflow-gate" npx tsx apps/server/src/main.ts
```

(Adjust the path to a scratch directory. Delete it between runs to reset the DB. Use forward slashes and quotes on Windows.)

Expected: Server starts on `http://localhost:4100`, logs show DB initialization and "Server running on...".

- [ ] **Step 7: Run the gate script**

From the repo root:

```bash
python tools/e2e/gate.py
```

Expected: All steps pass, ending with "ALL STEPS PASSED (including M3s splits)". Screenshots `gate-final-split-a.png` and `gate-final-kitchen.png` are saved to the current directory (repo root).

Key assertions in the split scenario:
- `T1 · A — open` header before split creation.
- `+ Split` button visible and functional.
- `T1 · B — open` header after split creation.
- Kitchen KOT context shows `T1 · B` for split B (not split A or plain table name).
- Tables card shows `occupied · 2 splits` when 2 active orders exist.
- Picker appears with `Split A`, `Split B`, `New split`, `Close` buttons.
- Clicking `Split A` in picker opens the correct order with its items intact.

If any step fails, the gate will print a traceback and save `gate-fail-<page-name>.png` screenshots.

- [ ] **Step 8: Stop the server**

In the terminal where the server is running, press Ctrl+C.

On Windows:
```bash
taskkill /F /IM node.exe
```

(Use with care — kills all Node processes.)

- [ ] **Step 9: Verify screenshots (manual spot-check)**

Open `gate-final-split-a.png` and `gate-final-kitchen.png`. Visually confirm:
- Split A order screen header shows `T1 · A — open`.
- Water Bottle (pending) is visible in the punched items list.
- Kitchen screen shows "No active KOTs" (all KOTs marked done).

- [ ] **Step 10: Commit Task 7 changes**

```bash
git add tools/e2e/gate.py tools/e2e/README.md
git commit -m "$(cat <<'EOF'
test(e2e): add gate script for M3a+M3s acceptance

- tools/e2e/gate.py: from m3a_e2e.py with GATE_BASE/GATE_LAN env params,
  screenshots to CWD, split scenario appended
- Split scenario: "+ Split" -> T1 · B header, punch/send Full Biryani,
  kitchen context "T1 · B", Tables shows "occupied · 2 splits", picker with
  Split A/B buttons, click Split A -> correct order with items intact
- tools/e2e/README.md: how to run (build UI, fresh scratch server, python
  gate.py), KOT-number assumptions, screenshot/log notes

Gate assertions: split labels in headers, kitchen context suffix (only for
non-A splits), picker behavior, 2-split status line.

Verification: gate.py green against scratch server (all steps pass).

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 11: Verify commit + final suite green**

```bash
git log -1 --stat
npm run typecheck
npx vitest run
```

Expected: Commit shows the two new files in `tools/e2e/`; typecheck clean; 143 tests pass.

- [ ] **Step 12: Re-run the gate one more time to confirm green**

(Optional but recommended for a final sanity check.)

Delete the scratch directory (sandbox-compliant delete):
```bash
rm -r "D:/scratch/forkflow-gate"
```

(If directory is not empty, delete files first: `rm "D:/scratch/forkflow-gate"/*` then `rmdir "D:/scratch/forkflow-gate"`.)

Restart the server:
```bash
FORKFLOW_DATA_DIR="D:/scratch/forkflow-gate" npx tsx apps/server/src/main.ts
```

Re-run the gate:
```bash
python tools/e2e/gate.py
```

Expected: All steps pass again. If the gate is green, Task 7 is complete.

---

Plan reviewed adversarially (18 findings applied + 3 re-verification findings applied). Verdict after fixes: executable as-is.
