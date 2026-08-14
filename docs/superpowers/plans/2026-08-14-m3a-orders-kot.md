# M3a Orders + KOT Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The core order flow of spec §9.3 — dining tables with derived status, dine-in/parcel orders with snapshot items, send-to-kitchen KOTs with per-day numbers, WebSocket live updates, and the kitchen display. (KOT *printing* is deliberately split out into the follow-up M3b plan; the kitchen display is the kitchen's view until then.)

**Architecture:** Migration 002 adds the two columns M3a needs (`kots.done_at`, `order_items.client_ref`). New server modules `tables.ts`, `orders.ts`, `kots.ts`, and a `ws.ts` WebSocket broadcast layer (`app.broadcast(event, data)`) registered right after auth. The UI gains a reconnecting WS client, a discriminated-union `Page` type, and three screens: Tables (tap-to-open orders + admin table management), OrderScreen (product grid + localStorage draft cart + punch/send/cancel), Kitchen (live KOT board with Done).

**Tech Stack:** Fastify 5 + `@fastify/websocket` ^11.3.0 + better-sqlite3 (server), zod 4 (validation in packages/domain), React 19 + Vite (UI), vitest with `app.inject`/`app.injectWS` against in-memory SQLite.

## Global Constraints

- Money is INTEGER **paise**; timestamps INTEGER Unix ms via `Date.now()`; ids `uuidv7()` from `@forkflow/domain`.
- DB snake_case → API camelCase; booleans real in JSON. No DELETE endpoints — `is_active` flags and status transitions only.
- **Table status is derived from orders, never stored** (spec §3): `open` order → `occupied`, `billed` order → `billed`, else `free`.
- **Item snapshots at punch time** (spec §3): `name_snapshot` (product name, or `Product (Variant)`), `price_paise_snapshot` (variant price if variant else product price), `gst_rate_snapshot` (product GST rate).
- **Idempotency:** `orders.client_ref` (UNIQUE, exists) makes order creation retry-safe; migration 002's `order_items.client_ref` (partial UNIQUE index) makes item punching retry-safe; send-to-kitchen is naturally idempotent (pending→sent transition leaves nothing to re-send).
- **Per-day gapless KOT numbers** via `nextSequence(db, "kot:" + localDateKey(Date.now()))` inside the send transaction (single writer, spec §3).
- WS events (exact names/payloads): `order.updated` `{order}`, `kot.created` `{kot}`, `kot.updated` `{kot}`, `table.changed` `{tableId}`. Clients refetch their screen on reconnect (spec §4) — missed broadcasts can never leave stale state.
- Permission slugs used: `tables.read`, `tables.manage`, `orders.create`, `orders.read`, `orders.update`, `orders.cancel_sent` (sent-item cancellation; matched by cashier's `orders.*` and admin's `*`, NOT held by waiter), `kots.create`, `kots.read`, `kots.update`. **roles.ts is not modified** — existing grants already produce the spec §4 role matrix.
- Import style: NodeNext workspaces (packages/*, apps/server) need `.js` suffixes on relative imports; apps/ui is extensionless (Vite). UI: inline styles, system-ui, no router/state libs.
- TDD per task: failing test → implement → pass → full `npm test` + `npm run typecheck` green → commit (conventional; body ends `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`).
- Baseline at branch start: 72 tests green, typecheck clean. Every task leaves the suite green.
- Sandbox notes for executors: `taskkill` denied → `powershell.exe -Command "Stop-Process -Id <pid> -Force"`; `rm -rf` denied → file-level `rm` + `rmdir`; check port :4100 before starting servers; if a subagent dies on timeout, check `git log` before re-dispatching.

---
### Task 1: Migration 002 + sequence/date helpers

**Files:**
- Create: `packages/domain/src/migrations/002-kot-done-and-item-refs.ts`
- Modify: `packages/domain/src/migrations/index.ts`
- Create: `packages/domain/src/sequences.ts`
- Create: `packages/domain/src/dates.ts`
- Modify: `packages/domain/src/index.ts`
- Test: `packages/domain/src/sequences.test.ts`

**Interfaces:**
- Consumes: `Migration` interface from `./migrate.js`; `Database` type from `./db.js`.
- Produces: `migration002` (used by MIGRATIONS array); `nextSequence(db: Database, name: string): number` (used by Tasks 7 for KOT numbering); `localDateKey(ms: number): string` (used by Task 7 for per-day KOT sequences). All exported from `@forkflow/domain`.

- [ ] **Step 1: Write the failing test**

`packages/domain/src/sequences.test.ts`:

```ts
import { afterEach, describe, expect, it } from "vitest";
import { migrate, MIGRATIONS, openDb, type Database } from "./index.js";
import { nextSequence } from "./sequences.js";
import { localDateKey } from "./dates.js";

let db: Database | undefined;
afterEach(() => {
  db?.close();
});

describe("migration 002", () => {
  it("adds done_at to kots and client_ref to order_items with unique index", () => {
    db = openDb(":memory:");
    migrate(db, MIGRATIONS);
    // test-only: dummy ids, FK targets don't exist
    db.pragma("foreign_keys = OFF");

    // Verify done_at column exists and is writable
    const kotId = "test-kot-id";
    db.prepare("INSERT INTO kots (id, order_id, kot_no, station_id, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?)")
      .run(kotId, "dummy-order", 1, "dummy-station", Date.now(), "dummy-user");
    
    const beforeDone = db.prepare("SELECT done_at FROM kots WHERE id = ?").get(kotId) as { done_at: number | null };
    expect(beforeDone.done_at).toBeNull();

    const now = Date.now();
    db.prepare("UPDATE kots SET done_at = ? WHERE id = ?").run(now, kotId);
    const afterDone = db.prepare("SELECT done_at FROM kots WHERE id = ?").get(kotId) as { done_at: number };
    expect(afterDone.done_at).toBe(now);

    // Verify client_ref column and unique index
    const itemId1 = "item-1";
    const itemId2 = "item-2";
    db.prepare(
      "INSERT INTO order_items (id, order_id, product_id, name_snapshot, price_paise_snapshot, gst_rate_snapshot, qty, client_ref) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(itemId1, "dummy-order", "dummy-product", "Test Item", 100, 5, 1, "ref-abc123");

    // Same client_ref should violate unique index
    expect(() => {
      db!.prepare(
        "INSERT INTO order_items (id, order_id, product_id, name_snapshot, price_paise_snapshot, gst_rate_snapshot, qty, client_ref) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
      ).run(itemId2, "dummy-order", "dummy-product", "Test Item 2", 200, 5, 1, "ref-abc123");
    }).toThrow();

    // NULL client_ref should be allowed (multiple NULLs don't violate partial unique index)
    db.prepare(
      "INSERT INTO order_items (id, order_id, product_id, name_snapshot, price_paise_snapshot, gst_rate_snapshot, qty, client_ref) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(itemId2, "dummy-order", "dummy-product", "Test Item 2", 200, 5, 1, null);
    
    const item2 = db.prepare("SELECT client_ref FROM order_items WHERE id = ?").get(itemId2) as { client_ref: string | null };
    expect(item2.client_ref).toBeNull();
  });
});

describe("nextSequence", () => {
  it("starts at 1, increments, and isolates by name", () => {
    db = openDb(":memory:");
    migrate(db, MIGRATIONS);

    expect(nextSequence(db, "test-seq")).toBe(1);
    expect(nextSequence(db, "test-seq")).toBe(2);
    expect(nextSequence(db, "test-seq")).toBe(3);

    // Different name starts at 1
    expect(nextSequence(db, "other-seq")).toBe(1);
    expect(nextSequence(db, "test-seq")).toBe(4);
  });

  it("works via UPDATE...RETURNING in a single statement", () => {
    db = openDb(":memory:");
    migrate(db, MIGRATIONS);

    // Pre-seed a sequence
    db.prepare("INSERT INTO sequences (name, value) VALUES (?, ?)").run("existing", 10);
    expect(nextSequence(db, "existing")).toBe(11);
  });
});

describe("localDateKey", () => {
  it("pads month and day to YYYY-MM-DD", () => {
    // 2026-01-05 (months are 0-indexed in JS Date, so month 0 = January)
    const jan5 = new Date(2026, 0, 5).getTime();
    expect(localDateKey(jan5)).toBe("2026-01-05");

    // 2026-12-31
    const dec31 = new Date(2026, 11, 31).getTime();
    expect(localDateKey(dec31)).toBe("2026-12-31");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/domain/src/sequences.test.ts`
Expected: FAIL — migration002 not in MIGRATIONS array, modules missing.

- [ ] **Step 3: Write migration 002**

`packages/domain/src/migrations/002-kot-done-and-item-refs.ts`:

```ts
import type { Migration } from "../migrate.js";

/** M3a: KOT done-state for the kitchen display; per-item client refs for idempotent punching. */
export const migration002: Migration = {
  version: 2,
  name: "kot-done-and-item-refs",
  up(db) {
    db.exec(`
      ALTER TABLE kots ADD COLUMN done_at INTEGER;
      ALTER TABLE order_items ADD COLUMN client_ref TEXT;
      CREATE UNIQUE INDEX idx_order_items_client_ref
        ON order_items(client_ref) WHERE client_ref IS NOT NULL;
    `);
  },
};
```

Update `packages/domain/src/migrations/index.ts`:

```ts
import type { Migration } from "../migrate.js";
import { migration001 } from "./001-initial.js";
import { migration002 } from "./002-kot-done-and-item-refs.js";

export const MIGRATIONS: Migration[] = [migration001, migration002];
```

- [ ] **Step 4: Write sequence and date helpers**

`packages/domain/src/sequences.ts`:

```ts
import type { Database } from "./db.js";

/** Next value of a named gapless sequence. MUST be called inside the caller's transaction (single writer makes it safe). Creates the row on first use. */
export function nextSequence(db: Database, name: string): number {
  const row = db.prepare("UPDATE sequences SET value = value + 1 WHERE name = ? RETURNING value").get(name) as
    | { value: number }
    | undefined;
  if (row) return row.value;
  db.prepare("INSERT INTO sequences (name, value) VALUES (?, 1)").run(name);
  return 1;
}
```

`packages/domain/src/dates.ts`:

```ts
/** Local-time YYYY-MM-DD key, used for per-day KOT number sequences. */
export function localDateKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
```

Append to `packages/domain/src/index.ts`:

```ts
export { nextSequence } from "./sequences.js";
export { localDateKey } from "./dates.js";
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run packages/domain/src/sequences.test.ts`
Expected: PASS (all tests). Then `npm run typecheck` — clean.

- [ ] **Step 6: Commit**

```bash
git add packages/domain/src/migrations/002-kot-done-and-item-refs.ts packages/domain/src/migrations/index.ts packages/domain/src/sequences.ts packages/domain/src/sequences.test.ts packages/domain/src/dates.ts packages/domain/src/index.ts
git commit -m "$(cat <<'EOF'
feat(domain): migration 002 + sequence/date helpers

Adds migration 002 for M3a orders+KOT milestone:
- kots.done_at column for kitchen completion tracking
- order_items.client_ref with partial unique index for idempotent item punching

Implements nextSequence() for gapless per-name counters (used for daily KOT
numbering) and localDateKey() for YYYY-MM-DD date keys.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Order/table zod schemas

**Files:**
- Create: `packages/domain/src/order-schemas.ts`
- Modify: `packages/domain/src/index.ts`
- Test: `packages/domain/src/order-schemas.test.ts`

**Interfaces:**
- Consumes: `z` from zod (already a dep); no other domain modules.
- Produces (used by Tasks 4–7): `TableCreate`, `TableUpdate`, `OrderCreate`, `OrderItemsAdd`, `OrderItemUpdate`, `ItemCancel` zod schemas + their TypeScript input types (`TableCreateInput`, etc.). Each schema validates and transforms API inputs; `.parse()` throws ZodError which the server's error handler maps to 400.

- [ ] **Step 1: Write the failing test**

`packages/domain/src/order-schemas.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  TableCreate, TableUpdate,
  OrderCreate, OrderItemsAdd, OrderItemUpdate, ItemCancel,
} from "./index.js";

describe("table schemas", () => {
  it("TableCreate defaults sortOrder to 0, area to null, and trims name", () => {
    expect(TableCreate.parse({ name: "  T1 " })).toEqual({ name: "T1", area: null, sortOrder: 0 });
  });

  it("TableCreate rejects empty names", () => {
    expect(() => TableCreate.parse({ name: "  " })).toThrow();
  });

  it("TableUpdate accepts partial fields including nullable area", () => {
    expect(TableUpdate.parse({ area: "Patio", sortOrder: 5 })).toEqual({ area: "Patio", sortOrder: 5 });
    expect(TableUpdate.parse({ area: null })).toEqual({ area: null });
  });
});

describe("order schemas", () => {
  it("OrderCreate requires clientRef 8-64 chars, defaults tableId to null", () => {
    const parcel = OrderCreate.parse({ clientRef: "abcd1234", type: "parcel" });
    expect(parcel).toEqual({ clientRef: "abcd1234", type: "parcel", tableId: null });

    expect(() => OrderCreate.parse({ clientRef: "short", type: "parcel" })).toThrow();
    expect(() => OrderCreate.parse({ clientRef: "x".repeat(65), type: "parcel" })).toThrow();
  });

  it("OrderCreate dine_in requires tableId, parcel must not have tableId", () => {
    expect(OrderCreate.parse({ clientRef: "ref12345", type: "dine_in", tableId: "table-1" }))
      .toEqual({ clientRef: "ref12345", type: "dine_in", tableId: "table-1" });

    // dine_in without tableId fails
    expect(() => OrderCreate.parse({ clientRef: "ref12345", type: "dine_in" })).toThrow(/dine_in requires tableId/);

    // parcel with tableId fails
    expect(() => OrderCreate.parse({ clientRef: "ref12345", type: "parcel", tableId: "table-1" }))
      .toThrow(/parcel cannot have a table/);
  });

  it("OrderItemsAdd requires at least one item with qty 1-99", () => {
    const valid = OrderItemsAdd.parse({
      items: [
        { productId: "p1", qty: 5 },
        { productId: "p2", variantId: "v1", qty: 99, note: "Extra spicy" },
      ],
    });
    expect(valid.items).toHaveLength(2);
    expect(valid.items[0]).toEqual({ productId: "p1", variantId: null, qty: 5 });
    expect(valid.items[1]?.note).toBe("Extra spicy");

    // Empty items array rejected
    expect(() => OrderItemsAdd.parse({ items: [] })).toThrow();

    // qty bounds
    expect(() => OrderItemsAdd.parse({ items: [{ productId: "p1", qty: 0 }] })).toThrow();
    expect(() => OrderItemsAdd.parse({ items: [{ productId: "p1", qty: 100 }] })).toThrow();
  });

  it("OrderItemsAdd clientRef length bounds and optional usage", () => {
    // clientRef optional, but when provided must be 8-64
    const withRef = OrderItemsAdd.parse({
      items: [{ clientRef: "item-ref-12345", productId: "p1", qty: 1 }],
    });
    expect(withRef.items[0]?.clientRef).toBe("item-ref-12345");

    expect(() =>
      OrderItemsAdd.parse({ items: [{ clientRef: "short", productId: "p1", qty: 1 }] })
    ).toThrow();
    expect(() =>
      OrderItemsAdd.parse({ items: [{ clientRef: "x".repeat(65), productId: "p1", qty: 1 }] })
    ).toThrow();
  });

  it("OrderItemUpdate accepts partial qty/note with nullable note", () => {
    expect(OrderItemUpdate.parse({ qty: 3 })).toEqual({ qty: 3 });
    expect(OrderItemUpdate.parse({ note: "Medium spice" })).toEqual({ note: "Medium spice" });
    expect(OrderItemUpdate.parse({ note: null })).toEqual({ note: null });

    // qty bounds
    expect(() => OrderItemUpdate.parse({ qty: 0 })).toThrow();
    expect(() => OrderItemUpdate.parse({ qty: 100 })).toThrow();
  });

  it("ItemCancel has optional reason with trimming and max 200 chars", () => {
    expect(ItemCancel.parse({})).toEqual({});
    expect(ItemCancel.parse({ reason: "  Customer changed mind " })).toEqual({ reason: "Customer changed mind" });
    expect(() => ItemCancel.parse({ reason: "x".repeat(201) })).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/domain/src/order-schemas.test.ts`
Expected: FAIL — schemas not exported yet.

- [ ] **Step 3: Write the schemas**

`packages/domain/src/order-schemas.ts`:

```ts
import { z } from "zod";

const Name = z.string().trim().min(1);
const ClientRef = z.string().min(8).max(64);

export const TableCreate = z.object({
  name: Name,
  area: z.string().trim().min(1).nullable().default(null),
  sortOrder: z.number().int().default(0),
});
export type TableCreateInput = z.infer<typeof TableCreate>;

export const TableUpdate = z.object({
  name: Name.optional(),
  area: z.string().trim().min(1).nullable().optional(),
  sortOrder: z.number().int().optional(),
  isActive: z.boolean().optional(),
});
export type TableUpdateInput = z.infer<typeof TableUpdate>;

export const OrderCreate = z
  .object({
    clientRef: ClientRef,
    type: z.enum(["dine_in", "parcel"]),
    tableId: z.string().min(1).nullable().default(null),
  })
  .superRefine((o, ctx) => {
    if (o.type === "dine_in" && !o.tableId) ctx.addIssue({ code: "custom", message: "dine_in requires tableId" });
    if (o.type === "parcel" && o.tableId) ctx.addIssue({ code: "custom", message: "parcel cannot have a table" });
  });
export type OrderCreateInput = z.infer<typeof OrderCreate>;

export const OrderItemsAdd = z.object({
  items: z
    .array(
      z.object({
        clientRef: ClientRef.optional(),
        productId: z.string().min(1),
        variantId: z.string().min(1).nullable().default(null),
        qty: z.number().int().min(1).max(99),
        note: z.string().trim().max(200).optional(),
      }),
    )
    .min(1),
});
export type OrderItemsAddInput = z.infer<typeof OrderItemsAdd>;

export const OrderItemUpdate = z.object({
  qty: z.number().int().min(1).max(99).optional(),
  note: z.string().trim().max(200).nullable().optional(),
});
export type OrderItemUpdateInput = z.infer<typeof OrderItemUpdate>;

export const ItemCancel = z.object({
  reason: z.string().trim().min(1).max(200).optional(),
});
export type ItemCancelInput = z.infer<typeof ItemCancel>;
```

Append to `packages/domain/src/index.ts`:

```ts
export {
  TableCreate, TableUpdate,
  OrderCreate, OrderItemsAdd, OrderItemUpdate, ItemCancel,
  type TableCreateInput, type TableUpdateInput,
  type OrderCreateInput, type OrderItemsAddInput, type OrderItemUpdateInput, type ItemCancelInput,
} from "./order-schemas.js";
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run packages/domain/src/order-schemas.test.ts`
Expected: PASS (all tests). Then `npm test` to verify all domain tests green. `npm run typecheck` — clean.

- [ ] **Step 5: Commit**

```bash
git add packages/domain/src/order-schemas.ts packages/domain/src/order-schemas.test.ts packages/domain/src/index.ts
git commit -m "$(cat <<'EOF'
feat(domain): order/table zod schemas

Validation schemas for M3a tables and orders APIs:
- TableCreate/Update for dining table management
- OrderCreate with dine_in/parcel type discriminator and tableId constraints
- OrderItemsAdd with per-item clientRef (optional, for idempotent retries)
- OrderItemUpdate for pending item qty/note changes
- ItemCancel with optional reason

All schemas include input type exports and enforce bounds (qty 1-99,
clientRef 8-64, note/reason max 200).

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```
### Task 3: WebSocket layer + auth token helper

**Files:**
- Modify: `apps/server/package.json` (add @fastify/websocket dependency)
- Modify: `apps/server/src/auth.ts` (extract sessionUser function for ws.ts reuse)
- Create: `apps/server/src/ws.ts`
- Modify: `apps/server/src/server.ts` (register ws before catalog/users/settings)
- Test: `apps/server/src/ws.test.ts`

**Interfaces:**
- Consumes: `Database` from `@forkflow/domain`; `AuthedUser` from `./auth.js`.
- Produces: `registerWs(app: FastifyInstance): void` (decorates `app.broadcast(event, data)`); `sessionUser(db: Database, token: string): AuthedUser | null` exported from auth.ts (shared lookup).
- Route: `GET /api/ws` (websocket upgrade, query param `?token=...`); missing/invalid token → close code 4401 "unauthenticated".

**Design rules:**
- `@fastify/websocket` provides both the plugin and the `app.injectWS(path)` test helper; it also types the `{websocket: true}` route option.
- WebSocket must register BEFORE orders/kots so `app.broadcast` exists when those modules call it.
- The session lookup in auth.ts is extracted into an exported `sessionUser(db, token)` function so ws.ts can reuse it without coupling to the full auth decorator stack.

- [ ] **Step 1: Add the @fastify/websocket dependency**

Edit `apps/server/package.json`:

```json
  "dependencies": {
    "@fastify/static": "^10.1.3",
    "@fastify/websocket": "^11.3.0",
    "@forkflow/core": "*",
    "@forkflow/domain": "*",
    "fastify": "^5.11.3",
    "zod": "^4.4.3"
  }
```

Then from the repo root:

```bash
npm install
```

- [ ] **Step 2: Write the failing test**

`apps/server/src/ws.test.ts`:

```ts
import { afterEach, describe, expect, it } from "vitest";
import { auth, freshApp, setupAdmin } from "./test-helpers.js";

let app: ReturnType<typeof freshApp>;
afterEach(async () => {
  await app?.close();
});

describe("WebSocket", () => {
  it("connects with a valid token and receives broadcasts", async () => {
    app = freshApp();
    await app.ready();
    const admin = await setupAdmin(app);

    const ws = await app.injectWS("/api/ws?token=" + admin.token);
    const messages: unknown[] = [];
    ws.on("message", (raw) => {
      messages.push(JSON.parse(raw.toString()));
    });

    try {
      app.broadcast("test.event", { x: 1 });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(messages).toHaveLength(1);
      expect(messages[0]).toEqual({ event: "test.event", data: { x: 1 } });
    } finally {
      ws.terminate();
    }
  });

  it("closes with code 4401 when the token is missing", async () => {
    app = freshApp();
    await app.ready();
    const ws = await app.injectWS("/api/ws");

    try {
      const result = await new Promise<{ code: number; reason: string }>((resolve) => {
        ws.on("close", (code, reason) => {
          resolve({ code, reason: reason.toString() });
        });
      });
      expect(result.code).toBe(4401);
      expect(result.reason).toBe("unauthenticated");
    } finally {
      ws.terminate();
    }
  });

  it("closes with code 4401 when the token is garbage", async () => {
    app = freshApp();
    await app.ready();
    const ws = await app.injectWS("/api/ws?token=garbage");

    try {
      const result = await new Promise<{ code: number; reason: string }>((resolve) => {
        ws.on("close", (code, reason) => {
          resolve({ code, reason: reason.toString() });
        });
      });
      expect(result.code).toBe(4401);
      expect(result.reason).toBe("unauthenticated");
    } finally {
      ws.terminate();
    }
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run apps/server/src/ws.test.ts`
Expected: FAIL — ws.ts doesn't exist, sessionUser not exported from auth.ts, app.broadcast not defined, app.injectWS not available.

- [ ] **Step 4: Refactor auth.ts to export sessionUser**

In `apps/server/src/auth.ts`, remove the pre-existing module-scope `SessionRow` interface (lines 22-28) since the inserted block redeclares it, and add the `sessionUser` export:

**Before**:
```ts
export function registerAuth(app: FastifyInstance): void {
  // Plugin-scoped: each server instance gets its own throttle state.
  const loginThrottle = new Map<string, ThrottleState>();
```

**After** — add SessionRow at module scope (after the ThrottleState interface, around line 14) and add the exported sessionUser function before registerAuth:

After line 20 (the `AuthedUser` interface), insert:

```ts
interface SessionRow {
  user_id: string;
  expires_at: number;
  name: string;
  role: RoleName;
  is_active: number;
}

export function sessionUser(db: Database, token: string): AuthedUser | null {
  const row = db
    .prepare(
      `SELECT s.user_id, s.expires_at, u.name, u.role, u.is_active
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token = ?`,
    )
    .get(token) as SessionRow | undefined;
  if (!row || row.expires_at < Date.now() || !row.is_active) return null;
  return { id: row.user_id, name: row.name, role: row.role };
}
```

Then replace the `userForToken` implementation (originally lines 45-57) with:

```ts
  const userForToken = (header: string | undefined): AuthedUser | null => {
    if (!header?.startsWith("Bearer ")) return null;
    const token = header.slice("Bearer ".length);
    return sessionUser(app.db, token);
  };
```

Add the `Database` import at the top of auth.ts (if not already present):

```ts
import type { Database } from "@forkflow/domain";
```

- [ ] **Step 5: Implement ws.ts**

`apps/server/src/ws.ts`:

```ts
import websocket from "@fastify/websocket";
import type { FastifyInstance } from "fastify";
import type { WebSocket } from "@fastify/websocket";
import { sessionUser } from "./auth.js";

export function registerWs(app: FastifyInstance): void {
  const clients = new Set<WebSocket>();
  app.decorate("broadcast", (event: string, data: unknown) => {
    const msg = JSON.stringify({ event, data });
    for (const ws of clients) {
      if (ws.readyState === ws.OPEN) ws.send(msg);
    }
  });
  app.register(websocket);
  app.register(async (scope) => {
    scope.get("/api/ws", { websocket: true }, (socket, req) => {
      const { token } = req.query as { token?: string };
      if (!token || !sessionUser(app.db, token)) {
        socket.close(4401, "unauthenticated");
        return;
      }
      clients.add(socket);
      socket.on("close", () => clients.delete(socket));
    });
  });
}

declare module "fastify" {
  interface FastifyInstance {
    broadcast(event: string, data: unknown): void;
  }
}
```

- [ ] **Step 6: Register ws in server.ts**

In `apps/server/src/server.ts`, import and register `registerWs` BEFORE `registerCatalog` (so `app.broadcast` exists when orders/kots load in future tasks):

Add the import after line 7:

```ts
import { registerWs } from "./ws.js";
```

Then modify the registration block (originally lines 47-50) to become:

```ts
  registerAuth(app);
  registerWs(app);
  registerCatalog(app);
  registerUsers(app);
  registerSettings(app);
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `npx vitest run apps/server/src/ws.test.ts` → PASS (all 3 tests).
Then the full suite: `npm test` → all green (72 baseline + new ws tests). `npm run typecheck` → clean.

- [ ] **Step 8: Commit**

```bash
git add apps/server/package.json apps/server/src/auth.ts apps/server/src/ws.ts apps/server/src/ws.test.ts apps/server/src/server.ts
git commit -m "$(cat <<'EOF'
feat(server): WebSocket layer with broadcast decorator and auth

- Add @fastify/websocket dependency
- Extract sessionUser from auth.ts for ws.ts reuse
- WebSocket route at /api/ws with token-based auth (close 4401 on bad token)
- Broadcast decorator for server-push events
- Register ws before catalog/users/settings so app.broadcast exists for future orders/kots

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Tables API

**Files:**
- Create: `apps/server/src/tables.ts`
- Modify: `apps/server/src/server.ts` (register tables)
- Test: `apps/server/src/tables.test.ts`

**Interfaces:**
- Consumes: `TableCreate`, `TableUpdate` from `@forkflow/domain`; `httpError` from `./http-error.js`; test helpers from `./test-helpers.js`.
- Produces: `registerTables(app: FastifyInstance): void`.
- Routes: `GET /api/tables` (gate `tables.read`) → `{tables: Table[]}` ordered `sort_order, name`; `POST /api/tables` (gate `tables.manage`) → 201 `{table}`; `PATCH /api/tables/:id` (gate `tables.manage`) → `{table}` / 404 / 409 `"table has an open order"` when deactivating a table with an open/billed order.
- Table shape: `{id, name, area: string|null, sortOrder, isActive, status: "free"|"occupied"|"billed", openOrderId: string|null}`.

**Design rules:**
- Table status is DERIVED (never stored): the table's latest order with `status IN ('open','billed')` determines occupancy — `"occupied"` when the order is `"open"`, `"billed"` when the order is `"billed"`, else `"free"`.
- `openOrderId` is the id of that order, or null when free.
- Deactivating a table while it has an open/billed order → 409 (you can't close a table with customers on it).
- Since the orders API doesn't exist yet at Task 4, the occupancy-derivation test seeds an order row via raw SQL (`app.db.prepare("INSERT INTO orders (...)")`) using the admin's user id.

- [ ] **Step 1: Write the failing test**

`apps/server/src/tables.test.ts`:

```ts
import { afterEach, describe, expect, it } from "vitest";
import { auth, createUser, freshApp, setupAdmin } from "./test-helpers.js";
import { uuidv7 } from "@forkflow/domain";

let app: ReturnType<typeof freshApp>;
afterEach(async () => {
  await app?.close();
});

async function addTable(adminToken: string, name: string, area: string | null = null, sortOrder = 0) {
  const res = await app.inject({
    method: "POST",
    url: "/api/tables",
    payload: { name, area, sortOrder },
    headers: auth(adminToken),
  });
  return res.json() as { table: { id: string; name: string; area: string | null; sortOrder: number; isActive: boolean } };
}

describe("tables", () => {
  it("creates and lists tables in sort order", async () => {
    app = freshApp();
    const admin = await setupAdmin(app);

    const res = await app.inject({
      method: "POST",
      url: "/api/tables",
      payload: { name: "T1", area: "Main", sortOrder: 0 },
      headers: auth(admin.token),
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().table).toMatchObject({ name: "T1", area: "Main", sortOrder: 0, isActive: true, status: "free", openOrderId: null });

    await addTable(admin.token, "T3", "Patio", 2);
    await addTable(admin.token, "T2", "Main", 1);

    const list = await app.inject({ method: "GET", url: "/api/tables", headers: auth(admin.token) });
    expect(list.statusCode).toBe(200);
    const tables = list.json().tables;
    expect(tables.map((t: { name: string }) => t.name)).toEqual(["T1", "T2", "T3"]);
    expect(tables.every((t: { status: string }) => t.status === "free")).toBe(true);
  });

  it("renames, changes area, reorders, and deactivates via PATCH; 404s on unknown id", async () => {
    app = freshApp();
    const admin = await setupAdmin(app);
    const { table } = await addTable(admin.token, "T1", "Main");

    const patched = await app.inject({
      method: "PATCH",
      url: `/api/tables/${table.id}`,
      payload: { name: "Table One", area: "Patio", sortOrder: 5, isActive: false },
      headers: auth(admin.token),
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().table).toMatchObject({ name: "Table One", area: "Patio", sortOrder: 5, isActive: false });

    const missing = await app.inject({
      method: "PATCH",
      url: "/api/tables/nope",
      payload: { name: "X" },
      headers: auth(admin.token),
    });
    expect(missing.statusCode).toBe(404);
  });

  it("derives occupied/billed status from the latest open/billed order", async () => {
    app = freshApp();
    const admin = await setupAdmin(app);
    const { table } = await addTable(admin.token, "T1");

    // Seed an open order directly in the database (orders API doesn't exist yet)
    const orderId = uuidv7();
    app.db
      .prepare(
        "INSERT INTO orders (id, client_ref, type, table_id, status, opened_by, opened_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(orderId, "test-ref-1", "dine_in", table.id, "open", admin.user.id, Date.now());

    const occupied = await app.inject({ method: "GET", url: "/api/tables", headers: auth(admin.token) });
    expect(occupied.json().tables[0]).toMatchObject({ id: table.id, status: "occupied", openOrderId: orderId });

    // Update the order to billed
    app.db.prepare("UPDATE orders SET status = ? WHERE id = ?").run("billed", orderId);
    const billed = await app.inject({ method: "GET", url: "/api/tables", headers: auth(admin.token) });
    expect(billed.json().tables[0]).toMatchObject({ status: "billed", openOrderId: orderId });

    // Close the order (settled)
    app.db.prepare("UPDATE orders SET status = ?, closed_at = ? WHERE id = ?").run("settled", Date.now(), orderId);
    const free = await app.inject({ method: "GET", url: "/api/tables", headers: auth(admin.token) });
    expect(free.json().tables[0]).toMatchObject({ status: "free", openOrderId: null });
  });

  it("refuses to deactivate a table with an open order (409)", async () => {
    app = freshApp();
    const admin = await setupAdmin(app);
    const { table } = await addTable(admin.token, "T1");

    // Seed an open order
    app.db
      .prepare(
        "INSERT INTO orders (id, client_ref, type, table_id, status, opened_by, opened_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(uuidv7(), "test-ref-2", "dine_in", table.id, "open", admin.user.id, Date.now());

    const deactivate = await app.inject({
      method: "PATCH",
      url: `/api/tables/${table.id}`,
      payload: { isActive: false },
      headers: auth(admin.token),
    });
    expect(deactivate.statusCode).toBe(409);
    expect(deactivate.json().error).toBe("table has an open order");
  });

  it("read is open to waiters, write is not; anonymous is 401", async () => {
    app = freshApp();
    const admin = await setupAdmin(app);
    const waiter = await createUser(app, admin.token, { name: "Wren", pin: "5678", role: "waiter" });

    expect((await app.inject({ method: "GET", url: "/api/tables", headers: auth(waiter.token) })).statusCode).toBe(200);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/tables",
          payload: { name: "X" },
          headers: auth(waiter.token),
        })
      ).statusCode,
    ).toBe(403);
    expect((await app.inject({ method: "GET", url: "/api/tables" })).statusCode).toBe(401);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/server/src/tables.test.ts`
Expected: FAIL — routes don't exist (404s where tests expect 200/201).

- [ ] **Step 3: Implement tables.ts**

`apps/server/src/tables.ts`:

```ts
import { TableCreate, TableUpdate, uuidv7 } from "@forkflow/domain";
import type { FastifyInstance } from "fastify";
import { httpError } from "./http-error.js";

interface TableRow {
  id: string;
  name: string;
  area: string | null;
  sort_order: number;
  is_active: number;
}

type OrderStatus = "open" | "billed" | "settled" | "cancelled";
type TableStatus = "free" | "occupied" | "billed";

export function registerTables(app: FastifyInstance): void {
  const read = app.requirePermission("tables.read");
  const manage = app.requirePermission("tables.manage");

  const getTable = (id: string) =>
    app.db.prepare("SELECT * FROM dining_tables WHERE id = ?").get(id) as TableRow | undefined;

  // Derive status from the latest open/billed order (never stored)
  const deriveStatus = (tableId: string): { status: TableStatus; openOrderId: string | null } => {
    const order = app.db
      .prepare(
        `SELECT id, status FROM orders
         WHERE table_id = ? AND status IN ('open', 'billed')
         ORDER BY opened_at DESC
         LIMIT 1`,
      )
      .get(tableId) as { id: string; status: OrderStatus } | undefined;

    if (!order) return { status: "free", openOrderId: null };
    return {
      status: order.status === "open" ? "occupied" : "billed",
      openOrderId: order.id,
    };
  };

  const toTable = (r: TableRow) => {
    const { status, openOrderId } = deriveStatus(r.id);
    return {
      id: r.id,
      name: r.name,
      area: r.area,
      sortOrder: r.sort_order,
      isActive: r.is_active === 1,
      status,
      openOrderId,
    };
  };

  app.get("/api/tables", { preHandler: read }, async () => {
    const rows = app.db.prepare("SELECT * FROM dining_tables ORDER BY sort_order, name").all() as TableRow[];
    return { tables: rows.map(toTable) };
  });

  app.post("/api/tables", { preHandler: manage }, async (req, reply) => {
    const body = TableCreate.parse(req.body);
    const id = uuidv7();
    app.db
      .prepare("INSERT INTO dining_tables (id, name, area, sort_order) VALUES (?, ?, ?, ?)")
      .run(id, body.name, body.area, body.sortOrder);
    return reply.status(201).send({ table: toTable(getTable(id)!) });
  });

  app.patch("/api/tables/:id", { preHandler: manage }, async (req) => {
    const { id } = req.params as { id: string };
    const body = TableUpdate.parse(req.body);
    const row = getTable(id);
    if (!row) throw httpError(404, "table not found");

    // Check if deactivating a table with an open/billed order
    if (body.isActive === false) {
      const { status } = deriveStatus(id);
      if (status === "occupied" || status === "billed") {
        throw httpError(409, "table has an open order");
      }
    }

    app.db
      .prepare("UPDATE dining_tables SET name = ?, area = ?, sort_order = ?, is_active = ? WHERE id = ?")
      .run(
        body.name ?? row.name,
        body.area === undefined ? row.area : body.area,
        body.sortOrder ?? row.sort_order,
        (body.isActive ?? row.is_active === 1) ? 1 : 0,
        id,
      );
    return { table: toTable(getTable(id)!) };
  });
}
```

- [ ] **Step 4: Register tables in server.ts**

In `apps/server/src/server.ts`, import and register `registerTables`:

Add the import after line 7:

```ts
import { registerTables } from "./tables.js";
```

Then modify the registration block to add `registerTables(app);`:

```ts
  registerAuth(app);
  registerWs(app);
  registerCatalog(app);
  registerUsers(app);
  registerSettings(app);
  registerTables(app);
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run apps/server/src/tables.test.ts` → PASS (all 5 tests).
Then the full suite: `npm test` → all green (72 baseline + ws + tables). `npm run typecheck` → clean.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/tables.ts apps/server/src/tables.test.ts apps/server/src/server.ts
git commit -m "$(cat <<'EOF'
feat(server): tables API with derived occupancy status

- GET/POST/PATCH for dining tables
- Status derived from latest open/billed order (occupied/billed/free)
- Refuse to deactivate a table with an open order (409)
- Permission gates: tables.read for GET, tables.manage for POST/PATCH

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```
### Task 5: Orders API: create/get/list

**Files:**
- Create: `apps/server/src/orders.ts`
- Modify: `apps/server/src/server.ts` (register the module)
- Test: `apps/server/src/orders.test.ts`

**Interfaces:**
- Consumes: `OrderCreate` from `@forkflow/domain`; `httpError` from `./http-error.js`; test helpers from `./test-helpers.js`.
- Produces: `registerOrders(app: FastifyInstance): void` — Task 6 **extends this same file** with item operations.
- Routes: `POST /api/orders` (gate `orders.create`) → 201 `{order}` / 200 idempotent; dine_in checks: 400 `unknown table` / 409 `table is not active` / 409 `table occupied`; broadcasts `order.updated` + `table.changed` (if dine_in). `GET /api/orders` (gate `orders.read`) → `{orders: Order[]}` (open only). `GET /api/orders/:id` (gate `orders.read`) → `{order}` / 404.

- [ ] **Step 1: Write the failing test**

`apps/server/src/orders.test.ts`:

```ts
import { afterEach, describe, expect, it } from "vitest";
import { auth, createUser, freshApp, setupAdmin } from "./test-helpers.js";

let app: ReturnType<typeof freshApp>;
afterEach(async () => {
  await app?.close();
});

async function fixtures(app: ReturnType<typeof freshApp>, adminToken: string) {
  const catRes = await app.inject({
    method: "POST", url: "/api/categories",
    payload: { name: "Mains" }, headers: auth(adminToken),
  });
  const categoryId = catRes.json().category.id;

  const stationsRes = await app.inject({ method: "GET", url: "/api/kot-stations", headers: auth(adminToken) });
  const kitchenStation = stationsRes.json().stations[0];

  const dalRes = await app.inject({
    method: "POST", url: "/api/products",
    payload: { categoryId, name: "Dal", pricePaise: 12000, gstRate: 5 },
    headers: auth(adminToken),
  });
  const dalId = dalRes.json().product.id;

  const biryaniRes = await app.inject({
    method: "POST", url: "/api/products",
    payload: {
      categoryId, name: "Biryani", pricePaise: 30000, gstRate: 5,
      kotStationId: kitchenStation.id, variants: [{ name: "Half", pricePaise: 18000 }],
    },
    headers: auth(adminToken),
  });
  const biryaniProduct = biryaniRes.json().product;

  return {
    categoryId,
    kitchenStationId: kitchenStation.id,
    dalId,
    biryaniId: biryaniProduct.id,
    biryaniHalfVariantId: biryaniProduct.variants[0].id,
  };
}

describe("orders: create/get/list", () => {
  it("creates a parcel order idempotently by clientRef", async () => {
    app = freshApp();
    const admin = await setupAdmin(app);

    const clientRef = "order-c1";
    const res1 = await app.inject({
      method: "POST", url: "/api/orders",
      payload: { clientRef, type: "parcel", tableId: null },
      headers: auth(admin.token),
    });
    expect(res1.statusCode).toBe(201);
    const order1 = res1.json().order;
    expect(order1).toMatchObject({ clientRef, type: "parcel", tableId: null, status: "open", openedBy: admin.user.id });
    expect(order1.items).toEqual([]);
    expect(order1.kots).toEqual([]);

    const res2 = await app.inject({
      method: "POST", url: "/api/orders",
      payload: { clientRef, type: "dine_in", tableId: "different" },
      headers: auth(admin.token),
    });
    expect(res2.statusCode).toBe(200);
    expect(res2.json().order.id).toBe(order1.id);
    expect(res2.json().order.type).toBe("parcel");
  });

  it("creates a dine_in order after table checks", async () => {
    app = freshApp();
    const admin = await setupAdmin(app);

    const unknownTable = await app.inject({
      method: "POST", url: "/api/orders",
      payload: { clientRef: "order-c2", type: "dine_in", tableId: "nope" },
      headers: auth(admin.token),
    });
    expect(unknownTable.statusCode).toBe(400);
    expect(unknownTable.json().error).toBe("unknown table");

    const tableRes = await app.inject({
      method: "POST", url: "/api/tables",
      payload: { name: "T1", area: "Main" },
      headers: auth(admin.token),
    });
    const tableId = tableRes.json().table.id;

    const inactiveTable = await app.inject({
      method: "PATCH", url: `/api/tables/${tableId}`,
      payload: { isActive: false },
      headers: auth(admin.token),
    });
    expect(inactiveTable.statusCode).toBe(200);

    const inactive = await app.inject({
      method: "POST", url: "/api/orders",
      payload: { clientRef: "order-c3", type: "dine_in", tableId },
      headers: auth(admin.token),
    });
    expect(inactive.statusCode).toBe(409);
    expect(inactive.json().error).toBe("table is not active");

    await app.inject({
      method: "PATCH", url: `/api/tables/${tableId}`,
      payload: { isActive: true },
      headers: auth(admin.token),
    });

    const order1 = await app.inject({
      method: "POST", url: "/api/orders",
      payload: { clientRef: "order-c4", type: "dine_in", tableId },
      headers: auth(admin.token),
    });
    expect(order1.statusCode).toBe(201);
    expect(order1.json().order.tableId).toBe(tableId);

    const occupied = await app.inject({
      method: "POST", url: "/api/orders",
      payload: { clientRef: "order-c5", type: "dine_in", tableId },
      headers: auth(admin.token),
    });
    expect(occupied.statusCode).toBe(409);
    expect(occupied.json().error).toBe("table occupied");
  });

  it("GET /api/orders lists only open orders", async () => {
    app = freshApp();
    const admin = await setupAdmin(app);

    await app.inject({
      method: "POST", url: "/api/orders",
      payload: { clientRef: "order-c6", type: "parcel" },
      headers: auth(admin.token),
    });

    const list = await app.inject({ method: "GET", url: "/api/orders", headers: auth(admin.token) });
    expect(list.statusCode).toBe(200);
    expect(list.json().orders).toHaveLength(1);

    app.db.prepare("UPDATE orders SET status = 'cancelled' WHERE client_ref = 'order-c6'").run();

    const listAfter = await app.inject({ method: "GET", url: "/api/orders", headers: auth(admin.token) });
    expect(listAfter.json().orders).toHaveLength(0);
  });

  it("GET /api/orders/:id returns 404 for unknown id", async () => {
    app = freshApp();
    const admin = await setupAdmin(app);

    const res = await app.inject({ method: "GET", url: "/api/orders/nope", headers: auth(admin.token) });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("order not found");
  });

  it("kitchen role cannot create orders", async () => {
    app = freshApp();
    const admin = await setupAdmin(app);
    const kitchen = await createUser(app, admin.token, { name: "Chef", pin: "5678", role: "kitchen" });

    const res = await app.inject({
      method: "POST", url: "/api/orders",
      payload: { clientRef: "order-c7", type: "parcel" },
      headers: auth(kitchen.token),
    });
    expect(res.statusCode).toBe(403);
  });

  it("anonymous requests are 401", async () => {
    app = freshApp();
    await setupAdmin(app);

    expect((await app.inject({ method: "POST", url: "/api/orders", payload: { clientRef: "x", type: "parcel" } })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/api/orders" })).statusCode).toBe(401);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/server/src/orders.test.ts`
Expected: FAIL — routes don't exist (404s where tests expect 201/200).

- [ ] **Step 3: Implement the routes**

`apps/server/src/orders.ts`:

```ts
import { OrderCreate, uuidv7 } from "@forkflow/domain";
import type { FastifyInstance } from "fastify";
import { httpError } from "./http-error.js";

interface OrderRow {
  id: string;
  client_ref: string;
  type: "dine_in" | "parcel";
  table_id: string | null;
  status: "open" | "billed" | "settled" | "cancelled";
  opened_by: string;
  opened_at: number;
  closed_at: number | null;
}

interface OrderItemRow {
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

interface KotRow {
  id: string;
  kot_no: number;
  station_id: string;
  order_id: string;
  created_at: number;
  done_at: number | null;
}

const toOrderItem = (r: OrderItemRow) => ({
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
});

const toKot = (r: KotRow) => ({
  id: r.id,
  kotNo: r.kot_no,
  stationId: r.station_id,
  orderId: r.order_id,
  createdAt: r.created_at,
  doneAt: r.done_at,
});

const toOrder = (r: OrderRow, items: OrderItemRow[], kots: KotRow[]) => ({
  id: r.id,
  clientRef: r.client_ref,
  type: r.type,
  tableId: r.table_id,
  status: r.status,
  openedBy: r.opened_by,
  openedAt: r.opened_at,
  closedAt: r.closed_at,
  items: items.map(toOrderItem),
  kots: kots.map(toKot),
});

export function registerOrders(app: FastifyInstance): void {
  const create = app.requirePermission("orders.create");
  const read = app.requirePermission("orders.read");

  const getOrder = (id: string) =>
    app.db.prepare("SELECT * FROM orders WHERE id = ?").get(id) as OrderRow | undefined;

  function orderWithDetails(id: string) {
    const order = getOrder(id);
    if (!order) return null;
    const items = app.db
      .prepare("SELECT * FROM order_items WHERE order_id = ? ORDER BY id")
      .all(id) as OrderItemRow[];
    const kots = app.db
      .prepare("SELECT * FROM kots WHERE order_id = ? ORDER BY created_at")
      .all(id) as KotRow[];
    return toOrder(order, items, kots);
  }

  app.post("/api/orders", { preHandler: create }, async (req, reply) => {
    const body = OrderCreate.parse(req.body);
    const existing = app.db.prepare("SELECT id FROM orders WHERE client_ref = ?").get(body.clientRef) as { id: string } | undefined;
    if (existing) {
      return reply.status(200).send({ order: orderWithDetails(existing.id) });
    }

    if (body.type === "dine_in") {
      const table = app.db
        .prepare("SELECT id, is_active FROM dining_tables WHERE id = ?")
        .get(body.tableId!) as { id: string; is_active: number } | undefined;
      if (!table) throw httpError(400, "unknown table");
      if (table.is_active !== 1) throw httpError(409, "table is not active");

      const openOrder = app.db
        .prepare("SELECT id FROM orders WHERE table_id = ? AND status IN ('open', 'billed')")
        .get(body.tableId!) as { id: string } | undefined;
      if (openOrder) throw httpError(409, "table occupied");
    }

    const id = uuidv7();
    app.db
      .prepare("INSERT INTO orders (id, client_ref, type, table_id, opened_by, opened_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(id, body.clientRef, body.type, body.tableId, req.user.id, Date.now());

    const order = orderWithDetails(id)!;
    app.broadcast("order.updated", { order });
    if (body.type === "dine_in") {
      app.broadcast("table.changed", { tableId: body.tableId! });
    }

    return reply.status(201).send({ order });
  });

  app.get("/api/orders", { preHandler: read }, async () => {
    const rows = app.db
      .prepare("SELECT * FROM orders WHERE status = 'open' ORDER BY opened_at")
      .all() as OrderRow[];
    const orders = rows.map((r) => orderWithDetails(r.id)!);
    return { orders };
  });

  app.get("/api/orders/:id", { preHandler: read }, async (req) => {
    const { id } = req.params as { id: string };
    const order = orderWithDetails(id);
    if (!order) throw httpError(404, "order not found");
    return { order };
  });
}
```

In `apps/server/src/server.ts`, import and register after `registerTables(app);`:

```ts
import { registerOrders } from "./orders.js";
```

```ts
  registerAuth(app);
  registerWs(app);
  registerCatalog(app);
  registerUsers(app);
  registerSettings(app);
  registerTables(app);
  registerOrders(app);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run apps/server/src/orders.test.ts` → PASS. Then the full suite: `npm test` → all green (72 + new). `npm run typecheck` → clean.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/orders.ts apps/server/src/orders.test.ts apps/server/src/server.ts
git commit -m "$(cat <<'EOF'
feat(server): orders API create/get/list

Implements order creation with idempotent clientRef, dine_in table
validation (unknown/inactive/occupied checks), parcel orders, list
(open only), and get by id. Broadcasts order.updated and table.changed
on creation.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Orders API: items punch/update/cancel + order cancel

**Files:**
- Modify: `apps/server/src/orders.ts` (extend from Task 5)
- Test: `apps/server/src/orders.test.ts` (append new describe blocks)

**Interfaces:**
- Consumes: `OrderItemsAdd`, `OrderItemUpdate`, `ItemCancel` from `@forkflow/domain`; `can`, `roleFor` from `@forkflow/core` + `@forkflow/domain`; everything Task 5 built.
- Produces routes (all under `registerOrders` in orders.ts):
  - `POST /api/orders/:id/items` (gate `orders.update`) → 200 `{order}`; 404 / 409 `order is not open`; 400 reference checks (`unknown product` / `product is not active` / `unknown variant` / `variant is not active` / `variant does not belong to product`); snapshots `name_snapshot` (variant: `${product.name} (${variant.name})` else product.name), `price_paise_snapshot` (variant ? variant.price_paise : product.price_paise), `gst_rate_snapshot`; clientRef dedup; broadcast `order.updated`.
  - `PATCH /api/order-items/:id` (gate `orders.update`) → 200 `{order}`; 404 / 409 `item is not pending`; broadcast `order.updated`.
  - `POST /api/order-items/:id/cancel` (gate `orders.update`) → 200 `{order}`; 404 / 409 `item already cancelled`; pending: free; sent: check `can(roleFor(req.user.role), "orders.cancel_sent")` else 403 `{error:"forbidden", permission:"orders.cancel_sent"}`, reason required else 400 `reason required`; sets `status='cancelled'`, `cancel_reason`, `cancelled_by`; broadcasts `order.updated` + `kot.updated` (if sent).
  - `POST /api/orders/:id/cancel` (gate `orders.update`) → 200 `{order}`; 404 / 409 `order is not open` / 409 `cancel sent items first`; sets `status='cancelled'`, `closed_at`; broadcasts `order.updated` + `table.changed` (if tableId).

- [ ] **Step 1: Write the failing tests**

Append to `apps/server/src/orders.test.ts`:

```ts
describe("orders: items punch/update/cancel", () => {
  it("punches items with snapshots and variant name composition", async () => {
    app = freshApp();
    const admin = await setupAdmin(app);
    const { dalId, biryaniId, biryaniHalfVariantId } = await fixtures(app, admin.token);

    const orderRes = await app.inject({
      method: "POST", url: "/api/orders",
      payload: { clientRef: "order-punch", type: "parcel" },
      headers: auth(admin.token),
    });
    const orderId = orderRes.json().order.id;

    const punchRes = await app.inject({
      method: "POST", url: `/api/orders/${orderId}/items`,
      payload: {
        items: [
          { productId: dalId, variantId: null, qty: 2 },
          { productId: biryaniId, variantId: biryaniHalfVariantId, qty: 1, note: "Extra spicy" },
        ],
      },
      headers: auth(admin.token),
    });
    expect(punchRes.statusCode).toBe(200);
    const items = punchRes.json().order.items;
    expect(items).toHaveLength(2);

    expect(items[0]).toMatchObject({
      name: "Dal",
      pricePaise: 12000,
      gstRate: 5,
      qty: 2,
      status: "pending",
      note: null,
    });

    expect(items[1]).toMatchObject({
      name: "Biryani (Half)",
      pricePaise: 18000,
      gstRate: 5,
      qty: 1,
      note: "Extra spicy",
      status: "pending",
    });
  });

  it("skips items with duplicate clientRef on retry", async () => {
    app = freshApp();
    const admin = await setupAdmin(app);
    const { dalId } = await fixtures(app, admin.token);

    const orderRes = await app.inject({
      method: "POST", url: "/api/orders",
      payload: { clientRef: "order-retry", type: "parcel" },
      headers: auth(admin.token),
    });
    const orderId = orderRes.json().order.id;

    const itemClientRef = "item-abc";
    const punch1 = await app.inject({
      method: "POST", url: `/api/orders/${orderId}/items`,
      payload: { items: [{ clientRef: itemClientRef, productId: dalId, qty: 1 }] },
      headers: auth(admin.token),
    });
    expect(punch1.json().order.items).toHaveLength(1);

    const punch2 = await app.inject({
      method: "POST", url: `/api/orders/${orderId}/items`,
      payload: { items: [{ clientRef: itemClientRef, productId: dalId, qty: 5 }] },
      headers: auth(admin.token),
    });
    expect(punch2.json().order.items).toHaveLength(1);
    expect(punch2.json().order.items[0].qty).toBe(1);
  });

  it("reference checks: unknown/inactive product, unknown/inactive/wrong variant", async () => {
    app = freshApp();
    const admin = await setupAdmin(app);
    const { dalId, biryaniId, biryaniHalfVariantId } = await fixtures(app, admin.token);

    const orderRes = await app.inject({
      method: "POST", url: "/api/orders",
      payload: { clientRef: "order-refs", type: "parcel" },
      headers: auth(admin.token),
    });
    const orderId = orderRes.json().order.id;

    const unknownProduct = await app.inject({
      method: "POST", url: `/api/orders/${orderId}/items`,
      payload: { items: [{ productId: "nope", qty: 1 }] },
      headers: auth(admin.token),
    });
    expect(unknownProduct.statusCode).toBe(400);
    expect(unknownProduct.json().error).toBe("unknown product");

    await app.inject({
      method: "PATCH", url: `/api/products/${dalId}`,
      payload: { isActive: false },
      headers: auth(admin.token),
    });

    const inactiveProduct = await app.inject({
      method: "POST", url: `/api/orders/${orderId}/items`,
      payload: { items: [{ productId: dalId, qty: 1 }] },
      headers: auth(admin.token),
    });
    expect(inactiveProduct.statusCode).toBe(400);
    expect(inactiveProduct.json().error).toBe("product is not active");

    const unknownVariant = await app.inject({
      method: "POST", url: `/api/orders/${orderId}/items`,
      payload: { items: [{ productId: biryaniId, variantId: "nope", qty: 1 }] },
      headers: auth(admin.token),
    });
    expect(unknownVariant.statusCode).toBe(400);
    expect(unknownVariant.json().error).toBe("unknown variant");

    await app.inject({
      method: "PATCH", url: `/api/variants/${biryaniHalfVariantId}`,
      payload: { isActive: false },
      headers: auth(admin.token),
    });

    const inactiveVariant = await app.inject({
      method: "POST", url: `/api/orders/${orderId}/items`,
      payload: { items: [{ productId: biryaniId, variantId: biryaniHalfVariantId, qty: 1 }] },
      headers: auth(admin.token),
    });
    expect(inactiveVariant.statusCode).toBe(400);
    expect(inactiveVariant.json().error).toBe("variant is not active");

    await app.inject({
      method: "PATCH", url: `/api/variants/${biryaniHalfVariantId}`,
      payload: { isActive: true },
      headers: auth(admin.token),
    });

    const wrongVariant = await app.inject({
      method: "POST", url: `/api/orders/${orderId}/items`,
      payload: { items: [{ productId: dalId, variantId: biryaniHalfVariantId, qty: 1 }] },
      headers: auth(admin.token),
    });
    expect(wrongVariant.statusCode).toBe(400);
    expect(wrongVariant.json().error).toBe("variant does not belong to product");
  });

  it("updates qty and note for pending items, 409 for sent items", async () => {
    app = freshApp();
    const admin = await setupAdmin(app);
    const { dalId } = await fixtures(app, admin.token);

    const orderRes = await app.inject({
      method: "POST", url: "/api/orders",
      payload: { clientRef: "order-update", type: "parcel" },
      headers: auth(admin.token),
    });
    const orderId = orderRes.json().order.id;

    const punchRes = await app.inject({
      method: "POST", url: `/api/orders/${orderId}/items`,
      payload: { items: [{ productId: dalId, qty: 1 }] },
      headers: auth(admin.token),
    });
    const itemId = punchRes.json().order.items[0].id;

    const updateRes = await app.inject({
      method: "PATCH", url: `/api/order-items/${itemId}`,
      payload: { qty: 3, note: "Less salt" },
      headers: auth(admin.token),
    });
    expect(updateRes.statusCode).toBe(200);
    const updated = updateRes.json().order.items.find((i: { id: string }) => i.id === itemId);
    expect(updated).toMatchObject({ qty: 3, note: "Less salt" });

    app.db.prepare("UPDATE order_items SET status = 'sent' WHERE id = ?").run(itemId);

    const sentUpdate = await app.inject({
      method: "PATCH", url: `/api/order-items/${itemId}`,
      payload: { qty: 5 },
      headers: auth(admin.token),
    });
    expect(sentUpdate.statusCode).toBe(409);
    expect(sentUpdate.json().error).toBe("item is not pending");
  });

  it("cancels pending items freely, sent items with permission and reason", async () => {
    app = freshApp();
    const admin = await setupAdmin(app);
    const waiter = await createUser(app, admin.token, { name: "Wren", pin: "5678", role: "waiter" });
    const cashier = await createUser(app, admin.token, { name: "Ravi", pin: "4321", role: "cashier" });
    const { dalId, biryaniId } = await fixtures(app, admin.token);

    const orderRes = await app.inject({
      method: "POST", url: "/api/orders",
      payload: { clientRef: "order-cancel", type: "parcel" },
      headers: auth(admin.token),
    });
    const orderId = orderRes.json().order.id;

    const punchRes = await app.inject({
      method: "POST", url: `/api/orders/${orderId}/items`,
      payload: {
        items: [
          { productId: dalId, qty: 1 },
          { productId: biryaniId, qty: 1 },
        ],
      },
      headers: auth(admin.token),
    });
    const items = punchRes.json().order.items;
    const pendingItemId = items[0].id;
    const sentItemId = items[1].id;

    const pendingCancel = await app.inject({
      method: "POST", url: `/api/order-items/${pendingItemId}/cancel`,
      payload: {},
      headers: auth(admin.token),
    });
    expect(pendingCancel.statusCode).toBe(200);
    expect(pendingCancel.json().order.items.find((i: { id: string }) => i.id === pendingItemId).status).toBe("cancelled");

    app.db.prepare("UPDATE order_items SET status = 'sent' WHERE id = ?").run(sentItemId);

    const waiterSentCancel = await app.inject({
      method: "POST", url: `/api/order-items/${sentItemId}/cancel`,
      payload: { reason: "Customer changed mind" },
      headers: auth(waiter.token),
    });
    expect(waiterSentCancel.statusCode).toBe(403);
    expect(waiterSentCancel.json()).toMatchObject({ error: "forbidden", permission: "orders.cancel_sent" });

    const cashierNoReason = await app.inject({
      method: "POST", url: `/api/order-items/${sentItemId}/cancel`,
      payload: {},
      headers: auth(cashier.token),
    });
    expect(cashierNoReason.statusCode).toBe(400);
    expect(cashierNoReason.json().error).toBe("reason required");

    const cashierWithReason = await app.inject({
      method: "POST", url: `/api/order-items/${sentItemId}/cancel`,
      payload: { reason: "Customer changed mind" },
      headers: auth(cashier.token),
    });
    expect(cashierWithReason.statusCode).toBe(200);
    const cancelled = cashierWithReason.json().order.items.find((i: { id: string }) => i.id === sentItemId);
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.cancelReason).toBe("Customer changed mind");
    const row = app.db.prepare("SELECT cancelled_by FROM order_items WHERE id = ?").get(sentItemId) as { cancelled_by: string };
    expect(row.cancelled_by).toBe(cashier.id);
  });

  it("404s on unknown item", async () => {
    app = freshApp();
    const admin = await setupAdmin(app);

    expect((await app.inject({
      method: "PATCH", url: "/api/order-items/nope",
      payload: { qty: 1 },
      headers: auth(admin.token),
    })).statusCode).toBe(404);

    expect((await app.inject({
      method: "POST", url: "/api/order-items/nope/cancel",
      payload: {},
      headers: auth(admin.token),
    })).statusCode).toBe(404);
  });

  it("broadcasts order.updated via WS on item mutations", async () => {
    app = freshApp();
    const admin = await setupAdmin(app);
    const { dalId } = await fixtures(app, admin.token);

    await app.ready();
    const ws = await app.injectWS("/api/ws?token=" + admin.token);
    const messages: unknown[] = [];
    ws.on("message", (data) => messages.push(JSON.parse(data.toString())));

    try {
      const orderRes = await app.inject({
        method: "POST", url: "/api/orders",
        payload: { clientRef: "order-ws", type: "parcel" },
        headers: auth(admin.token),
      });
      const orderId = orderRes.json().order.id;

      messages.length = 0;

      await app.inject({
        method: "POST", url: `/api/orders/${orderId}/items`,
        payload: { items: [{ productId: dalId, qty: 1 }] },
        headers: auth(admin.token),
      });

      await new Promise((r) => setTimeout(r, 50));
      expect(messages).toEqual([{ event: "order.updated", data: { order: expect.objectContaining({ id: orderId }) } }]);
    } finally {
      ws.terminate();
    }
  });
});

describe("orders: order cancel", () => {
  it("blocks cancel if sent items exist, allows after cancelling them", async () => {
    app = freshApp();
    const admin = await setupAdmin(app);
    const { dalId } = await fixtures(app, admin.token);

    const orderRes = await app.inject({
      method: "POST", url: "/api/orders",
      payload: { clientRef: "order-cancel-2", type: "parcel" },
      headers: auth(admin.token),
    });
    const orderId = orderRes.json().order.id;

    const punchRes = await app.inject({
      method: "POST", url: `/api/orders/${orderId}/items`,
      payload: { items: [{ productId: dalId, qty: 1 }] },
      headers: auth(admin.token),
    });
    const itemId = punchRes.json().order.items[0].id;

    app.db.prepare("UPDATE order_items SET status = 'sent' WHERE id = ?").run(itemId);

    const blockedCancel = await app.inject({
      method: "POST", url: `/api/orders/${orderId}/cancel`,
      headers: auth(admin.token),
    });
    expect(blockedCancel.statusCode).toBe(409);
    expect(blockedCancel.json().error).toBe("cancel sent items first");

    await app.inject({
      method: "POST", url: `/api/order-items/${itemId}/cancel`,
      payload: { reason: "Mistake" },
      headers: auth(admin.token),
    });

    const allowedCancel = await app.inject({
      method: "POST", url: `/api/orders/${orderId}/cancel`,
      headers: auth(admin.token),
    });
    expect(allowedCancel.statusCode).toBe(200);
    expect(allowedCancel.json().order.status).toBe("cancelled");
    expect(allowedCancel.json().order.closedAt).toBeGreaterThan(0);
  });

  it("409s if order is not open", async () => {
    app = freshApp();
    const admin = await setupAdmin(app);

    const orderRes = await app.inject({
      method: "POST", url: "/api/orders",
      payload: { clientRef: "order-not-open", type: "parcel" },
      headers: auth(admin.token),
    });
    const orderId = orderRes.json().order.id;

    app.db.prepare("UPDATE orders SET status = 'billed' WHERE id = ?").run(orderId);

    const res = await app.inject({
      method: "POST", url: `/api/orders/${orderId}/cancel`,
      headers: auth(admin.token),
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("order is not open");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run apps/server/src/orders.test.ts`
Expected: Task 5's describe block PASS, the new blocks FAIL (routes missing).

- [ ] **Step 3: Implement**

Extend `apps/server/src/orders.ts`. Replace the existing `import { OrderCreate, uuidv7 } from "@forkflow/domain";` line with:

```ts
import { OrderCreate, OrderItemsAdd, OrderItemUpdate, ItemCancel, uuidv7, roleFor } from "@forkflow/domain";
import { can } from "@forkflow/core";
```

Add inside `registerOrders`, after the GET /:id route:

```ts
  const update = app.requirePermission("orders.update");

  app.post("/api/orders/:id/items", { preHandler: update }, async (req) => {
    const { id } = req.params as { id: string };
    const body = OrderItemsAdd.parse(req.body);
    const order = getOrder(id);
    if (!order) throw httpError(404, "order not found");
    if (order.status !== "open") throw httpError(409, "order is not open");

    const existingRefs = new Set(
      (app.db.prepare("SELECT client_ref FROM order_items WHERE client_ref IS NOT NULL").all() as Array<{ client_ref: string }>).map((r) => r.client_ref),
    );

    interface ProductRow {
      id: string;
      name: string;
      price_paise: number;
      gst_rate: number;
      is_active: number;
    }
    interface VariantRow {
      id: string;
      product_id: string;
      name: string;
      price_paise: number;
      is_active: number;
    }

    const itemsToInsert: Array<{
      clientRef: string | null;
      productId: string;
      variantId: string | null;
      name: string;
      pricePaise: number;
      gstRate: number;
      qty: number;
      note: string | undefined;
    }> = [];

    for (const item of body.items) {
      if (item.clientRef && existingRefs.has(item.clientRef)) continue;

      const product = app.db.prepare("SELECT * FROM products WHERE id = ?").get(item.productId) as ProductRow | undefined;
      if (!product) throw httpError(400, "unknown product");
      if (product.is_active !== 1) throw httpError(400, "product is not active");

      let variant: VariantRow | undefined;
      if (item.variantId) {
        variant = app.db.prepare("SELECT * FROM variants WHERE id = ?").get(item.variantId) as VariantRow | undefined;
        if (!variant) throw httpError(400, "unknown variant");
        if (variant.is_active !== 1) throw httpError(400, "variant is not active");
        if (variant.product_id !== item.productId) throw httpError(400, "variant does not belong to product");
      }

      const name = variant ? `${product.name} (${variant.name})` : product.name;
      const pricePaise = variant ? variant.price_paise : product.price_paise;

      itemsToInsert.push({
        clientRef: item.clientRef ?? null,
        productId: item.productId,
        variantId: item.variantId,
        name,
        pricePaise,
        gstRate: product.gst_rate,
        qty: item.qty,
        note: item.note,
      });
    }

    if (itemsToInsert.length > 0) {
      const write = app.db.transaction(() => {
        for (const item of itemsToInsert) {
          app.db
            .prepare(
              "INSERT INTO order_items (id, order_id, client_ref, product_id, variant_id, name_snapshot, price_paise_snapshot, gst_rate_snapshot, qty, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            )
            .run(
              uuidv7(),
              id,
              item.clientRef,
              item.productId,
              item.variantId,
              item.name,
              item.pricePaise,
              item.gstRate,
              item.qty,
              item.note ?? null,
            );
        }
      });
      write();
    }

    const result = orderWithDetails(id)!;
    app.broadcast("order.updated", { order: result });
    return { order: result };
  });

  app.patch("/api/order-items/:id", { preHandler: update }, async (req) => {
    const { id } = req.params as { id: string };
    const body = OrderItemUpdate.parse(req.body);
    const item = app.db.prepare("SELECT * FROM order_items WHERE id = ?").get(id) as OrderItemRow | undefined;
    if (!item) throw httpError(404, "item not found");
    if (item.status !== "pending") throw httpError(409, "item is not pending");

    const qty = body.qty ?? item.qty;
    const note = body.note === undefined ? item.note : body.note;

    app.db.prepare("UPDATE order_items SET qty = ?, note = ? WHERE id = ?").run(qty, note, id);

    const result = orderWithDetails(item.order_id)!;
    app.broadcast("order.updated", { order: result });
    return { order: result };
  });

  app.post("/api/order-items/:id/cancel", { preHandler: update }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = ItemCancel.parse(req.body);
    const item = app.db.prepare("SELECT * FROM order_items WHERE id = ?").get(id) as OrderItemRow | undefined;
    if (!item) throw httpError(404, "item not found");
    if (item.status === "cancelled") throw httpError(409, "item already cancelled");

    if (item.status === "sent") {
      if (!can(roleFor(req.user.role), "orders.cancel_sent")) {
        return reply.status(403).send({ error: "forbidden", permission: "orders.cancel_sent" });
      }
      if (!body.reason) throw httpError(400, "reason required");
    }

    app.db
      .prepare("UPDATE order_items SET status = 'cancelled', cancel_reason = ?, cancelled_by = ? WHERE id = ?")
      .run(body.reason ?? null, req.user.id, id);

    const result = orderWithDetails(item.order_id)!;
    app.broadcast("order.updated", { order: result });
    if (item.status === "sent" && item.kot_id) {
      const kot = app.db.prepare("SELECT * FROM kots WHERE id = ?").get(item.kot_id) as KotRow;
      const kotItems = app.db
        .prepare("SELECT * FROM order_items WHERE kot_id = ? ORDER BY id")
        .all(item.kot_id) as OrderItemRow[];
      const order = getOrder(kot.order_id)!;
      const tableName = order.table_id
        ? (app.db.prepare("SELECT name FROM dining_tables WHERE id = ?").get(order.table_id) as { name: string } | undefined)?.name ?? null
        : null;
      app.broadcast("kot.updated", {
        kot: {
          ...toKot(kot),
          orderType: order.type,
          tableName,
          items: kotItems.map((i) => ({ id: i.id, name: i.name_snapshot, qty: i.qty, note: i.note, status: i.status })),
        },
      });
    }
    return { order: result };
  });

  app.post("/api/orders/:id/cancel", { preHandler: update }, async (req) => {
    const { id } = req.params as { id: string };
    const order = getOrder(id);
    if (!order) throw httpError(404, "order not found");
    if (order.status !== "open") throw httpError(409, "order is not open");

    const sentItem = app.db
      .prepare("SELECT id FROM order_items WHERE order_id = ? AND status = 'sent' LIMIT 1")
      .get(id) as { id: string } | undefined;
    if (sentItem) throw httpError(409, "cancel sent items first");

    app.db.prepare("UPDATE orders SET status = 'cancelled', closed_at = ? WHERE id = ?").run(Date.now(), id);

    const result = orderWithDetails(id)!;
    app.broadcast("order.updated", { order: result });
    if (order.table_id) {
      app.broadcast("table.changed", { tableId: order.table_id });
    }
    return { order: result };
  });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run apps/server/src/orders.test.ts` → PASS. Then the full suite: `npm test` → all green (72 + new). `npm run typecheck` → clean.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/orders.ts apps/server/src/orders.test.ts
git commit -m "$(cat <<'EOF'
feat(server): orders items punch/update/cancel + order cancel

Implements item punching with snapshot capture (variant name composition,
variant price), clientRef idempotency, reference validation, qty/note
updates on pending items, cancel with permission gate for sent items
(waiter 403, cashier needs reason), order cancel (blocks if sent items
exist). Broadcasts order.updated and kot.updated (on sent item cancel).

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Send-to-kitchen + KOT board + done

**Files:**
- Create: `apps/server/src/kots.ts`
- Modify: `apps/server/src/server.ts` (register the module)
- Test: `apps/server/src/kots.test.ts`

**Interfaces:**
- Consumes: `nextSequence`, `localDateKey` from `@forkflow/domain`; everything from orders.ts.
- Produces: `registerKots(app: FastifyInstance): void`.
- Routes:
  - `POST /api/orders/:id/send` (gate `kots.create`) → 200 `{order, kots: KotWithContext[]}`; 404 / 409 `order is not open` / 409 `nothing to send`; groups pending items by station (non-null `kot_station_id` from CURRENT products row), per station: `kot_no = nextSequence(db, "kot:" + localDateKey(Date.now()))` INSIDE transaction, INSERT kots, UPDATE items SET status='sent', kot_id; broadcasts `kot.created` (per KOT) + `order.updated` + `table.changed` (if dine_in).
  - `GET /api/kots` (gate `kots.read`) → `{kots: KotWithContext[]}` where `done_at IS NULL`, ordered `created_at`; `tableName` joined via orders→dining_tables (null for parcel).
  - `POST /api/kots/:id/done` (gate `kots.update`) → 200 `{kot: Kot}`; 404; already done → 200 idempotent; sets `done_at=Date.now()`; broadcast `kot.updated`.

- [ ] **Step 1: Write the failing test**

`apps/server/src/kots.test.ts`:

```ts
import { afterEach, describe, expect, it } from "vitest";
import { auth, createUser, freshApp, setupAdmin } from "./test-helpers.js";
import { uuidv7 } from "@forkflow/domain";

let app: ReturnType<typeof freshApp>;
afterEach(async () => {
  await app?.close();
});

async function fixtures(app: ReturnType<typeof freshApp>, adminToken: string) {
  const catRes = await app.inject({
    method: "POST", url: "/api/categories",
    payload: { name: "Mains" }, headers: auth(adminToken),
  });
  const categoryId = catRes.json().category.id;

  const stationsRes = await app.inject({ method: "GET", url: "/api/kot-stations", headers: auth(adminToken) });
  const kitchenStation = stationsRes.json().stations[0];

  const station2Id = uuidv7();
  app.db.prepare("INSERT INTO kot_stations (id, name, is_active) VALUES (?, 'Grill', 1)").run(station2Id);

  const dalRes = await app.inject({
    method: "POST", url: "/api/products",
    payload: { categoryId, name: "Dal", pricePaise: 12000, gstRate: 5 },
    headers: auth(adminToken),
  });
  const dalId = dalRes.json().product.id;

  const biryaniRes = await app.inject({
    method: "POST", url: "/api/products",
    payload: {
      categoryId, name: "Biryani", pricePaise: 30000, gstRate: 5,
      kotStationId: kitchenStation.id, variants: [{ name: "Half", pricePaise: 18000 }],
    },
    headers: auth(adminToken),
  });
  const biryaniProduct = biryaniRes.json().product;

  const kebabRes = await app.inject({
    method: "POST", url: "/api/products",
    payload: { categoryId, name: "Kebab", pricePaise: 20000, gstRate: 5, kotStationId: station2Id },
    headers: auth(adminToken),
  });
  const kebabId = kebabRes.json().product.id;

  return {
    categoryId,
    kitchenStationId: kitchenStation.id,
    grillStationId: station2Id,
    dalId,
    biryaniId: biryaniProduct.id,
    biryaniHalfVariantId: biryaniProduct.variants[0].id,
    kebabId,
  };
}

describe("kots: send-to-kitchen", () => {
  it("groups items by station and assigns per-day KOT numbers", async () => {
    app = freshApp();
    const admin = await setupAdmin(app);
    const { biryaniId, biryaniHalfVariantId, kebabId } = await fixtures(app, admin.token);

    const orderRes = await app.inject({
      method: "POST", url: "/api/orders",
      payload: { clientRef: "order-send", type: "parcel" },
      headers: auth(admin.token),
    });
    const orderId = orderRes.json().order.id;

    await app.inject({
      method: "POST", url: `/api/orders/${orderId}/items`,
      payload: {
        items: [
          { productId: biryaniId, variantId: biryaniHalfVariantId, qty: 1 },
          { productId: kebabId, qty: 2 },
        ],
      },
      headers: auth(admin.token),
    });

    const sendRes = await app.inject({
      method: "POST", url: `/api/orders/${orderId}/send`,
      headers: auth(admin.token),
    });
    expect(sendRes.statusCode).toBe(200);
    const { order, kots } = sendRes.json();

    expect(kots).toHaveLength(2);
    expect(kots[0].kotNo).toBe(1);
    expect(kots[1].kotNo).toBe(2);
    expect(order.items.every((i: { status: string }) => i.status === "sent")).toBe(true);

    const orderRes2 = await app.inject({
      method: "POST", url: "/api/orders",
      payload: { clientRef: "order-send-2", type: "parcel" },
      headers: auth(admin.token),
    });
    const orderId2 = orderRes2.json().order.id;

    await app.inject({
      method: "POST", url: `/api/orders/${orderId2}/items`,
      payload: { items: [{ productId: biryaniId, qty: 1 }] },
      headers: auth(admin.token),
    });

    const send2Res = await app.inject({
      method: "POST", url: `/api/orders/${orderId2}/send`,
      headers: auth(admin.token),
    });
    expect(send2Res.json().kots[0].kotNo).toBe(3);
  });

  it("items with no station stay pending", async () => {
    app = freshApp();
    const admin = await setupAdmin(app);
    const { dalId, biryaniId } = await fixtures(app, admin.token);

    const orderRes = await app.inject({
      method: "POST", url: "/api/orders",
      payload: { clientRef: "order-no-station", type: "parcel" },
      headers: auth(admin.token),
    });
    const orderId = orderRes.json().order.id;

    await app.inject({
      method: "POST", url: `/api/orders/${orderId}/items`,
      payload: {
        items: [
          { productId: dalId, qty: 1 },
          { productId: biryaniId, qty: 1 },
        ],
      },
      headers: auth(admin.token),
    });

    const sendRes = await app.inject({
      method: "POST", url: `/api/orders/${orderId}/send`,
      headers: auth(admin.token),
    });
    expect(sendRes.statusCode).toBe(200);
    const { order, kots } = sendRes.json();

    expect(kots).toHaveLength(1);
    const dalItem = order.items.find((i: { name: string }) => i.name === "Dal");
    const biryaniItem = order.items.find((i: { name: string }) => i.name === "Biryani");
    expect(dalItem.status).toBe("pending");
    expect(biryaniItem.status).toBe("sent");
  });

  it("409 when nothing to send (no items or all no-station)", async () => {
    app = freshApp();
    const admin = await setupAdmin(app);
    const { dalId } = await fixtures(app, admin.token);

    const orderRes = await app.inject({
      method: "POST", url: "/api/orders",
      payload: { clientRef: "order-empty", type: "parcel" },
      headers: auth(admin.token),
    });
    const orderId = orderRes.json().order.id;

    const emptyRes = await app.inject({
      method: "POST", url: `/api/orders/${orderId}/send`,
      headers: auth(admin.token),
    });
    expect(emptyRes.statusCode).toBe(409);
    expect(emptyRes.json().error).toBe("nothing to send");

    await app.inject({
      method: "POST", url: `/api/orders/${orderId}/items`,
      payload: { items: [{ productId: dalId, qty: 1 }] },
      headers: auth(admin.token),
    });

    const allNoStation = await app.inject({
      method: "POST", url: `/api/orders/${orderId}/send`,
      headers: auth(admin.token),
    });
    expect(allNoStation.statusCode).toBe(409);
    expect(allNoStation.json().error).toBe("nothing to send");
  });

  it("broadcasts kot.created for each KOT", async () => {
    app = freshApp();
    const admin = await setupAdmin(app);
    const { biryaniId, kebabId } = await fixtures(app, admin.token);

    await app.ready();
    const ws = await app.injectWS("/api/ws?token=" + admin.token);
    const messages: unknown[] = [];
    ws.on("message", (data) => messages.push(JSON.parse(data.toString())));

    try {
      const orderRes = await app.inject({
        method: "POST", url: "/api/orders",
        payload: { clientRef: "order-bc", type: "parcel" },
        headers: auth(admin.token),
      });
      const orderId = orderRes.json().order.id;

      await app.inject({
        method: "POST", url: `/api/orders/${orderId}/items`,
        payload: {
          items: [
            { productId: biryaniId, qty: 1 },
            { productId: kebabId, qty: 1 },
          ],
        },
        headers: auth(admin.token),
      });

      messages.length = 0;

      await app.inject({
        method: "POST", url: `/api/orders/${orderId}/send`,
        headers: auth(admin.token),
      });

      await new Promise((r) => setTimeout(r, 50));

      const kotCreated = messages.filter(
        (m): m is { event: string; data: { kot: { orderType: string; tableName: string | null } } } =>
          (m as { event?: string }).event === "kot.created",
      );
      expect(kotCreated).toHaveLength(2);
      expect(kotCreated[0]!.data.kot).toMatchObject({ orderType: "parcel", tableName: null });
    } finally {
      ws.terminate();
    }
  });
});

describe("kots: board and done", () => {
  it("GET /api/kots shows only not-done with tableName join", async () => {
    app = freshApp();
    const admin = await setupAdmin(app);
    const { biryaniId } = await fixtures(app, admin.token);

    const tableRes = await app.inject({
      method: "POST", url: "/api/tables",
      payload: { name: "T1" },
      headers: auth(admin.token),
    });
    const tableId = tableRes.json().table.id;

    const dineInRes = await app.inject({
      method: "POST", url: "/api/orders",
      payload: { clientRef: "order-dinein", type: "dine_in", tableId },
      headers: auth(admin.token),
    });
    const dineInId = dineInRes.json().order.id;

    await app.inject({
      method: "POST", url: `/api/orders/${dineInId}/items`,
      payload: { items: [{ productId: biryaniId, qty: 1 }] },
      headers: auth(admin.token),
    });

    const parcelRes = await app.inject({
      method: "POST", url: "/api/orders",
      payload: { clientRef: "order-parcel", type: "parcel" },
      headers: auth(admin.token),
    });
    const parcelId = parcelRes.json().order.id;

    await app.inject({
      method: "POST", url: `/api/orders/${parcelId}/items`,
      payload: { items: [{ productId: biryaniId, qty: 1 }] },
      headers: auth(admin.token),
    });

    const sendDineIn = await app.inject({
      method: "POST", url: `/api/orders/${dineInId}/send`,
      headers: auth(admin.token),
    });
    const sendParcel = await app.inject({
      method: "POST", url: `/api/orders/${parcelId}/send`,
      headers: auth(admin.token),
    });

    const kotDineInId = sendDineIn.json().kots[0].id;
    const kotParcelId = sendParcel.json().kots[0].id;

    const list = await app.inject({ method: "GET", url: "/api/kots", headers: auth(admin.token) });
    expect(list.statusCode).toBe(200);
    const kots = list.json().kots;
    expect(kots).toHaveLength(2);

    const dineInKot = kots.find((k: { id: string }) => k.id === kotDineInId);
    const parcelKot = kots.find((k: { id: string }) => k.id === kotParcelId);

    expect(dineInKot.tableName).toBe("T1");
    expect(parcelKot.tableName).toBeNull();

    app.db.prepare("UPDATE kots SET done_at = ? WHERE id = ?").run(Date.now(), kotDineInId);

    const listAfterDone = await app.inject({ method: "GET", url: "/api/kots", headers: auth(admin.token) });
    expect(listAfterDone.json().kots).toHaveLength(1);
    expect(listAfterDone.json().kots[0].id).toBe(kotParcelId);
  });

  it("POST /api/kots/:id/done is idempotent and broadcasts kot.updated", async () => {
    app = freshApp();
    const admin = await setupAdmin(app);
    const { biryaniId } = await fixtures(app, admin.token);

    const orderRes = await app.inject({
      method: "POST", url: "/api/orders",
      payload: { clientRef: "order-done", type: "parcel" },
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
    const kotId = sendRes.json().kots[0].id;

    const doneRes = await app.inject({
      method: "POST", url: `/api/kots/${kotId}/done`,
      headers: auth(admin.token),
    });
    expect(doneRes.statusCode).toBe(200);
    expect(doneRes.json().kot.doneAt).toBeGreaterThan(0);

    const done2Res = await app.inject({
      method: "POST", url: `/api/kots/${kotId}/done`,
      headers: auth(admin.token),
    });
    expect(done2Res.statusCode).toBe(200);
    expect(done2Res.json().kot.doneAt).toBe(doneRes.json().kot.doneAt);
  });

  it("kitchen role can read and done, waiter cannot done", async () => {
    app = freshApp();
    const admin = await setupAdmin(app);
    const waiter = await createUser(app, admin.token, { name: "Wren", pin: "5678", role: "waiter" });
    const kitchen = await createUser(app, admin.token, { name: "Chef", pin: "4321", role: "kitchen" });
    const { biryaniId } = await fixtures(app, admin.token);

    const orderRes = await app.inject({
      method: "POST", url: "/api/orders",
      payload: { clientRef: "order-perm", type: "parcel" },
      headers: auth(admin.token),
    });
    const orderId = orderRes.json().order.id;

    await app.inject({
      method: "POST", url: `/api/orders/${orderId}/items`,
      payload: { items: [{ productId: biryaniId, qty: 1 }] },
      headers: auth(admin.token),
    });

    const waiterSend = await app.inject({
      method: "POST", url: `/api/orders/${orderId}/send`,
      headers: auth(waiter.token),
    });
    expect(waiterSend.statusCode).toBe(200);
    const kotId = waiterSend.json().kots[0].id;

    expect((await app.inject({ method: "GET", url: "/api/kots", headers: auth(kitchen.token) })).statusCode).toBe(200);

    const kitchenDone = await app.inject({
      method: "POST", url: `/api/kots/${kotId}/done`,
      headers: auth(kitchen.token),
    });
    expect(kitchenDone.statusCode).toBe(200);

    const orderRes2 = await app.inject({
      method: "POST", url: "/api/orders",
      payload: { clientRef: "order-waiter-done", type: "parcel" },
      headers: auth(admin.token),
    });
    const orderId2 = orderRes2.json().order.id;

    await app.inject({
      method: "POST", url: `/api/orders/${orderId2}/items`,
      payload: { items: [{ productId: biryaniId, qty: 1 }] },
      headers: auth(admin.token),
    });

    const sendRes2 = await app.inject({
      method: "POST", url: `/api/orders/${orderId2}/send`,
      headers: auth(admin.token),
    });
    const kotId2 = sendRes2.json().kots[0].id;

    const waiterDone = await app.inject({
      method: "POST", url: `/api/kots/${kotId2}/done`,
      headers: auth(waiter.token),
    });
    expect(waiterDone.statusCode).toBe(403);
  });

  it("404s on unknown kot", async () => {
    app = freshApp();
    const admin = await setupAdmin(app);

    const res = await app.inject({
      method: "POST", url: "/api/kots/nope/done",
      headers: auth(admin.token),
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("kot not found");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/server/src/kots.test.ts`
Expected: FAIL — routes don't exist.

- [ ] **Step 3: Implement**

`apps/server/src/kots.ts`:

```ts
import { nextSequence, localDateKey, uuidv7 } from "@forkflow/domain";
import type { FastifyInstance } from "fastify";
import { httpError } from "./http-error.js";

interface OrderRow {
  id: string;
  client_ref: string;
  type: "dine_in" | "parcel";
  table_id: string | null;
  status: string;
  opened_by: string;
  opened_at: number;
  closed_at: number | null;
}

interface OrderItemRow {
  id: string;
  client_ref: string | null;
  order_id: string;
  product_id: string;
  variant_id: string | null;
  kot_id: string | null;
  name_snapshot: string;
  price_paise_snapshot: number;
  gst_rate_snapshot: number;
  qty: number;
  status: "pending" | "sent" | "cancelled";
  note: string | null;
  cancel_reason: string | null;
}

interface KotRow {
  id: string;
  kot_no: number;
  station_id: string;
  order_id: string;
  created_at: number;
  done_at: number | null;
}

const toKot = (r: KotRow) => ({
  id: r.id,
  kotNo: r.kot_no,
  stationId: r.station_id,
  orderId: r.order_id,
  createdAt: r.created_at,
  doneAt: r.done_at,
});

function toKotWithContext(
  kot: KotRow,
  order: OrderRow,
  tableName: string | null,
  items: OrderItemRow[],
) {
  return {
    ...toKot(kot),
    orderType: order.type,
    tableName,
    items: items.map((i) => ({ id: i.id, name: i.name_snapshot, qty: i.qty, note: i.note, status: i.status })),
  };
}

export function registerKots(app: FastifyInstance): void {
  const create = app.requirePermission("kots.create");
  const read = app.requirePermission("kots.read");
  const update = app.requirePermission("kots.update");

  app.post("/api/orders/:id/send", { preHandler: create }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const order = app.db.prepare("SELECT * FROM orders WHERE id = ?").get(id) as OrderRow | undefined;
    if (!order) throw httpError(404, "order not found");
    if (order.status !== "open") throw httpError(409, "order is not open");

    interface PendingItem {
      id: string;
      product_id: string;
      station_id: string | null;
    }
    const pendingItems = app.db
      .prepare(
        `SELECT oi.id, oi.product_id, p.kot_station_id AS station_id
         FROM order_items oi
         JOIN products p ON p.id = oi.product_id
         WHERE oi.order_id = ? AND oi.status = 'pending'
         ORDER BY oi.id`,
      )
      .all(id) as PendingItem[];

    const byStation = new Map<string, string[]>();
    for (const item of pendingItems) {
      if (item.station_id) {
        const list = byStation.get(item.station_id) ?? [];
        list.push(item.id);
        byStation.set(item.station_id, list);
      }
    }

    if (byStation.size === 0) throw httpError(409, "nothing to send");

    const createdKots: Array<{ id: string; stationId: string }> = [];

    const write = app.db.transaction(() => {
      const now = Date.now();
      const dateKey = localDateKey(now);
      for (const [stationId, itemIds] of byStation.entries()) {
        const kotNo = nextSequence(app.db, "kot:" + dateKey);
        const kotId = uuidv7();
        app.db
          .prepare("INSERT INTO kots (id, order_id, kot_no, station_id, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?)")
          .run(kotId, id, kotNo, stationId, now, req.user.id);

        for (const itemId of itemIds) {
          app.db.prepare("UPDATE order_items SET status = 'sent', kot_id = ? WHERE id = ?").run(kotId, itemId);
        }

        createdKots.push({ id: kotId, stationId });
      }
    });
    write();

    const orderResult = app.db.prepare("SELECT * FROM orders WHERE id = ?").get(id) as OrderRow;
    const allItems = app.db
      .prepare("SELECT * FROM order_items WHERE order_id = ? ORDER BY id")
      .all(id) as OrderItemRow[];
    const allKots = app.db
      .prepare("SELECT * FROM kots WHERE order_id = ? ORDER BY created_at")
      .all(id) as KotRow[];

    const tableName = orderResult.table_id
      ? (app.db.prepare("SELECT name FROM dining_tables WHERE id = ?").get(orderResult.table_id) as { name: string } | undefined)?.name ?? null
      : null;

    const kotsWithContext = createdKots.map((ck) => {
      const kotRow = allKots.find((k) => k.id === ck.id)!;
      const kotItems = allItems.filter((i) => i.kot_id === ck.id);
      return toKotWithContext(kotRow, orderResult, tableName, kotItems);
    });

    for (const kot of kotsWithContext) {
      app.broadcast("kot.created", { kot });
    }

    const toOrderItem = (i: OrderItemRow) => ({
      id: i.id,
      clientRef: i.client_ref,
      productId: i.product_id,
      variantId: i.variant_id,
      name: i.name_snapshot,
      pricePaise: i.price_paise_snapshot,
      gstRate: i.gst_rate_snapshot,
      qty: i.qty,
      status: i.status,
      note: i.note,
      cancelReason: i.cancel_reason,
      kotId: i.kot_id,
    });

    const orderFull = {
      id: orderResult.id,
      clientRef: orderResult.client_ref,
      type: orderResult.type,
      tableId: orderResult.table_id,
      status: orderResult.status,
      openedBy: orderResult.opened_by,
      openedAt: orderResult.opened_at,
      closedAt: orderResult.closed_at,
      items: allItems.map(toOrderItem),
      kots: allKots.map(toKot),
    };

    app.broadcast("order.updated", { order: orderFull });
    if (orderResult.type === "dine_in") {
      app.broadcast("table.changed", { tableId: orderResult.table_id! });
    }

    return reply.status(200).send({ order: orderFull, kots: kotsWithContext });
  });

  app.get("/api/kots", { preHandler: read }, async () => {
    const rows = app.db
      .prepare("SELECT * FROM kots WHERE done_at IS NULL ORDER BY created_at")
      .all() as KotRow[];

    const kots = rows.map((kot) => {
      const order = app.db.prepare("SELECT * FROM orders WHERE id = ?").get(kot.order_id) as OrderRow;
      const tableName = order.table_id
        ? (app.db.prepare("SELECT name FROM dining_tables WHERE id = ?").get(order.table_id) as { name: string } | undefined)?.name ?? null
        : null;
      const items = app.db
        .prepare("SELECT * FROM order_items WHERE kot_id = ? ORDER BY id")
        .all(kot.id) as OrderItemRow[];
      return toKotWithContext(kot, order, tableName, items);
    });

    return { kots };
  });

  app.post("/api/kots/:id/done", { preHandler: update }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const kot = app.db.prepare("SELECT * FROM kots WHERE id = ?").get(id) as KotRow | undefined;
    if (!kot) throw httpError(404, "kot not found");

    if (kot.done_at) {
      return reply.status(200).send({ kot: toKot(kot) });
    }

    const now = Date.now();
    app.db.prepare("UPDATE kots SET done_at = ? WHERE id = ?").run(now, id);

    const updated = app.db.prepare("SELECT * FROM kots WHERE id = ?").get(id) as KotRow;
    const order = app.db.prepare("SELECT * FROM orders WHERE id = ?").get(updated.order_id) as OrderRow;
    const tableName = order.table_id
      ? (app.db.prepare("SELECT name FROM dining_tables WHERE id = ?").get(order.table_id) as { name: string } | undefined)?.name ?? null
      : null;
    const items = app.db
      .prepare("SELECT * FROM order_items WHERE kot_id = ? ORDER BY id")
      .all(id) as OrderItemRow[];

    app.broadcast("kot.updated", { kot: toKotWithContext(updated, order, tableName, items) });

    return reply.status(200).send({ kot: toKot(updated) });
  });
}
```

In `apps/server/src/server.ts`, import and register after `registerOrders(app);`:

```ts
import { registerKots } from "./kots.js";
```

```ts
  registerAuth(app);
  registerWs(app);
  registerCatalog(app);
  registerUsers(app);
  registerSettings(app);
  registerTables(app);
  registerOrders(app);
  registerKots(app);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run apps/server/src/kots.test.ts` → PASS. Then the full suite: `npm test` → all green (72 + new). `npm run typecheck` → clean.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/kots.ts apps/server/src/kots.test.ts apps/server/src/server.ts
git commit -m "$(cat <<'EOF'
feat(server): KOT send/board/done with station grouping

Implements send-to-kitchen grouping pending items by station, per-day
KOT numbering with nextSequence inside transaction, GET /api/kots
(not-done only with tableName join), idempotent done, permission gates
(kitchen can read/done but not send). Broadcasts kot.created (per KOT),
order.updated, table.changed, and kot.updated.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```
### Task 8: UI shell — ws client, Page union, NavBar/App/Home rework

**Files:**
- Create: `apps/ui/src/ws.ts`
- Modify: `apps/ui/vite.config.ts` (proxy `ws: true`)
- Modify: `apps/ui/src/types.ts` (add TableInfo, OrderItem, Order, Kot, KotWithContext)
- Modify: `apps/ui/src/NavBar.tsx` (Page union + role→tab matrix)
- Modify: `apps/ui/src/App.tsx` (page state = Page object, placeholders for tables/order/kitchen)
- Modify: `apps/ui/src/screens/Home.tsx` (tiles per role)

**Interfaces:**
- Consumes: `session` from `./api`; existing `User` type; existing screen components (Catalog, Users, Settings).
- Produces:
  - `ws.ts`: `connectWs(handlers: WsHandlers): () => void` — auto-reconnecting WebSocket client with backoff 1s doubling to 10s cap, onStatus transitions, dispose flag.
  - `types.ts`: `TableInfo`, `OrderItem`, `Order`, `Kot`, `KotWithContext` — exact camelCase shapes per contracts.
  - `NavBar.tsx`: `Page` union type (discriminated: `{name:"home"}`, `{name:"tables"}`, `{name:"order"; orderId:string}`, `{name:"kitchen"}`, `{name:"catalog"}`, `{name:"users"}`, `{name:"settings"}`); tabs per role matrix; "order" page highlights tables tab.
  - `App.tsx`: page state as Page object; initial page kitchen-role → kitchen, else home; placeholders `<p>` for tables/order/kitchen slots.
  - `Home.tsx`: tiles per role (non-kitchen: Tables; admin/cashier: +Kitchen; admin: +Catalog/Users/Settings).

- [ ] **Step 1: Implement ws.ts**

`apps/ui/src/ws.ts`:

```ts
import { session } from "./api";

export interface WsHandlers {
  onEvent: (event: string, data: unknown) => void;
  onStatus: (connected: boolean) => void;
}

/** Auto-reconnecting WebSocket client. Backoff 1s..10s. Returns a dispose function. */
export function connectWs(handlers: WsHandlers): () => void {
  let ws: WebSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let backoffMs = 1000;
  let disposed = false;

  function connect() {
    if (disposed) return;
    const protocol = location.protocol === "https:" ? "wss" : "ws";
    const url = `${protocol}://${location.host}/api/ws?token=${session.token ?? ""}`;
    ws = new WebSocket(url);

    ws.onopen = () => {
      backoffMs = 1000;
      handlers.onStatus(true);
    };

    ws.onmessage = (e) => {
      try {
        const { event, data } = JSON.parse(e.data);
        handlers.onEvent(event, data);
      } catch {
        // ignore malformed messages
      }
    };

    ws.onclose = () => {
      if (disposed) return;
      handlers.onStatus(false);
      reconnectTimer = setTimeout(() => {
        backoffMs = Math.min(backoffMs * 2, 10000);
        connect();
      }, backoffMs);
    };

    ws.onerror = () => {
      ws?.close();
    };
  }

  connect();

  return () => {
    disposed = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    ws?.close();
  };
}
```

- [ ] **Step 2: Update vite.config.ts**

In `apps/ui/vite.config.ts`, replace the proxy line:

```ts
  server: {
    proxy: { "/api": { target: "http://localhost:4100", ws: true } },
  },
```

- [ ] **Step 3: Add types to types.ts**

Append to `apps/ui/src/types.ts`:

```ts
export interface TableInfo {
  id: string;
  name: string;
  area: string | null;
  sortOrder: number;
  isActive: boolean;
  status: "free" | "occupied" | "billed";
  openOrderId: string | null;
}

export interface OrderItem {
  id: string;
  clientRef: string | null;
  productId: string;
  variantId: string | null;
  name: string;
  pricePaise: number;
  gstRate: number;
  qty: number;
  status: "pending" | "sent" | "cancelled";
  note: string | null;
  cancelReason: string | null;
  kotId: string | null;
}

export interface Order {
  id: string;
  clientRef: string;
  type: "dine_in" | "parcel";
  tableId: string | null;
  status: "open" | "billed" | "settled" | "cancelled";
  openedBy: string;
  openedAt: number;
  closedAt: number | null;
  items: OrderItem[];
  kots: Kot[];
}

export interface Kot {
  id: string;
  kotNo: number;
  stationId: string;
  orderId: string;
  createdAt: number;
  doneAt: number | null;
}

export interface KotWithContext {
  id: string;
  kotNo: number;
  stationId: string;
  orderId: string;
  createdAt: number;
  doneAt: number | null;
  orderType: "dine_in" | "parcel";
  tableName: string | null;
  items: Array<{
    id: string;
    name: string;
    qty: number;
    note: string | null;
    status: "pending" | "sent" | "cancelled";
  }>;
}
```

- [ ] **Step 4: Rewrite NavBar.tsx**

Replace `apps/ui/src/NavBar.tsx` with:

```tsx
import { apiFetch, session, type User } from "./api";

export type Page =
  | { name: "home" }
  | { name: "tables" }
  | { name: "order"; orderId: string }
  | { name: "kitchen" }
  | { name: "catalog" }
  | { name: "users" }
  | { name: "settings" };

export function NavBar({
  user,
  page,
  onNavigate,
  onLogout,
}: {
  user: User;
  page: Page;
  onNavigate: (page: Page) => void;
  onLogout: () => void;
}) {
  async function logout() {
    try {
      await apiFetch<void>("/api/logout", { method: "POST" });
    } catch {
      // ignore error - local session is cleared regardless
    } finally {
      session.clear();
      onLogout();
    }
  }

  // Role→tab matrix per contracts
  const tabs: Array<{ page: Page; label: string }> =
    user.role === "admin"
      ? [
          { page: { name: "home" }, label: "home" },
          { page: { name: "tables" }, label: "tables" },
          { page: { name: "kitchen" }, label: "kitchen" },
          { page: { name: "catalog" }, label: "catalog" },
          { page: { name: "users" }, label: "users" },
          { page: { name: "settings" }, label: "settings" },
        ]
      : user.role === "cashier"
        ? [
            { page: { name: "home" }, label: "home" },
            { page: { name: "tables" }, label: "tables" },
            { page: { name: "kitchen" }, label: "kitchen" },
          ]
        : user.role === "waiter"
          ? [
              { page: { name: "home" }, label: "home" },
              { page: { name: "tables" }, label: "tables" },
            ]
          : [{ page: { name: "kitchen" }, label: "kitchen" }]; // kitchen role

  // "order" page highlights tables tab
  const activeTab = page.name === "order" ? "tables" : page.name;

  return (
    <nav style={{ display: "flex", gap: 8, alignItems: "center", padding: 8, borderBottom: "1px solid #ddd", fontFamily: "system-ui" }}>
      <strong style={{ marginRight: 8 }}>ForkFlow</strong>
      {tabs.map((t) => (
        <button
          key={t.label}
          onClick={() => onNavigate(t.page)}
          disabled={activeTab === t.label}
          style={{ padding: "6px 12px", textTransform: "capitalize" }}
        >
          {t.label}
        </button>
      ))}
      <span style={{ marginLeft: "auto" }}>{user.name}</span>
      <button onClick={() => void logout()} style={{ padding: "6px 12px" }}>
        Log out
      </button>
    </nav>
  );
}
```

- [ ] **Step 5: Rewrite App.tsx**

Replace `apps/ui/src/App.tsx` with:

```tsx
import { useEffect, useState } from "react";
import { apiFetch, session, type User } from "./api";
import { NavBar, type Page } from "./NavBar";
import { Catalog } from "./screens/Catalog";
import { Home } from "./screens/Home";
import { Login } from "./screens/Login";
import { Settings } from "./screens/Settings";
import { Setup } from "./screens/Setup";
import { Users } from "./screens/Users";

type State =
  | { kind: "loading" }
  | { kind: "setup" }
  | { kind: "login" }
  | { kind: "in"; user: User; page: Page };

export function App() {
  const [state, setState] = useState<State>({ kind: "loading" });

  useEffect(() => {
    void (async () => {
      try {
        const { needsSetup } = await apiFetch<{ needsSetup: boolean }>("/api/needs-setup");
        if (needsSetup) return setState({ kind: "setup" });
        if (session.token) {
          try {
            const { user } = await apiFetch<{ user: User }>("/api/me");
            const initialPage: Page = user.role === "kitchen" ? { name: "kitchen" } : { name: "home" };
            return setState({ kind: "in", user, page: initialPage });
          } catch {
            /* token expired — fall through to login */
          }
        }
        setState({ kind: "login" });
      } catch {
        setState({ kind: "login" }); // server down: login screen will show "Server unreachable"
      }
    })();
  }, []);

  switch (state.kind) {
    case "loading":
      return null;
    case "setup":
      return <Setup onDone={(user) => setState({ kind: "in", user, page: { name: "home" } })} />;
    case "login":
      return <Login onLogin={(user) => setState({ kind: "in", user, page: user.role === "kitchen" ? { name: "kitchen" } : { name: "home" } })} />;
    case "in": {
      const { user, page } = state;
      const go = (next: Page) => setState({ kind: "in", user, page: next });
      const onOpenOrder = (orderId: string) => setState({ kind: "in", user, page: { name: "order", orderId } });
      const onBack = () => setState({ kind: "in", user, page: { name: "tables" } });
      return (
        <div>
          <NavBar user={user} page={page} onNavigate={go} onLogout={() => setState({ kind: "login" })} />
          {page.name === "home" && <Home user={user} onNavigate={go} />}
          {page.name === "tables" && <p style={{ fontFamily: "system-ui", padding: 16 }}>Tables screen (Task 9)</p>}
          {page.name === "order" && <p style={{ fontFamily: "system-ui", padding: 16 }}>Order screen (Task 10)</p>}
          {page.name === "kitchen" && <p style={{ fontFamily: "system-ui", padding: 16 }}>Kitchen display (Task 11)</p>}
          {page.name === "catalog" && <Catalog />}
          {page.name === "users" && <Users />}
          {page.name === "settings" && <Settings />}
        </div>
      );
    }
  }
}
```

- [ ] **Step 6: Rewrite Home.tsx**

Replace `apps/ui/src/screens/Home.tsx` with:

```tsx
import type { Page } from "../NavBar";
import type { User } from "../api";

const tile = { padding: 20, fontSize: 18 } as const;

export function Home({ user, onNavigate }: { user: User; onNavigate: (page: Page) => void }) {
  // Non-kitchen roles see Tables tile
  const showTables = user.role !== "kitchen";
  // Admin/cashier see Kitchen tile
  const showKitchen = user.role === "admin" || user.role === "cashier";
  // Admin sees catalog/users/settings tiles
  const isAdmin = user.role === "admin";

  return (
    <div style={{ maxWidth: 480, margin: "8vh auto", textAlign: "center", fontFamily: "system-ui" }}>
      <p>
        Signed in as <strong>{user.name}</strong> ({user.role})
      </p>
      <div style={{ display: "grid", gap: 12 }}>
        {showTables && (
          <button style={tile} onClick={() => onNavigate({ name: "tables" })}>
            Tables
          </button>
        )}
        {showKitchen && (
          <button style={tile} onClick={() => onNavigate({ name: "kitchen" })}>
            Kitchen
          </button>
        )}
        {isAdmin && (
          <>
            <button style={tile} onClick={() => onNavigate({ name: "catalog" })}>
              Catalog
            </button>
            <button style={tile} onClick={() => onNavigate({ name: "users" })}>
              Users
            </button>
            <button style={tile} onClick={() => onNavigate({ name: "settings" })}>
              Settings
            </button>
          </>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 7: Verify**

Run: `npm run typecheck` → clean. Run: `npm run build -w @forkflow/ui` → builds. Run: `npm test` → green (all baseline + M2 tests still pass).

- [ ] **Step 8: Commit**

```bash
git add apps/ui/src/ws.ts apps/ui/vite.config.ts apps/ui/src/types.ts apps/ui/src/NavBar.tsx apps/ui/src/App.tsx apps/ui/src/screens/Home.tsx
git commit -m "$(cat <<'EOF'
feat(ui): ws client, Page union, role-based navigation

WebSocket auto-reconnect (1s..10s backoff), Page discriminated union,
NavBar tabs per role matrix, initial page kitchen→kitchen, Home tiles
per role. Placeholders for tables/order/kitchen screens.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: UI Tables screen

**Files:**
- Create: `apps/ui/src/screens/Tables.tsx`
- Modify: `apps/ui/src/App.tsx` (replace tables placeholder, wire onOpenOrder)

**Interfaces:**
- Consumes: `apiFetch`, `ApiError`, `User` from `../api`; `connectWs` from `../ws`; `TableInfo`, `Order` from `../types`.
- Produces: `Tables({ user, onOpenOrder })` component. Loads `/api/tables` + `/api/orders`; WS reload on `table.changed`/`order.updated`; grouped by `area ?? "Main"`; tap free table → POST create dine-in order → `onOpenOrder(order.id)`; tap occupied → `onOpenOrder(openOrderId)`; "New parcel" button + open-parcel list; admin-only "Manage tables" toggle (add name+area, rename ✎, sortOrder ▲▼ swap like Catalog categories, deactivate ⏸ — deactivate 409 surfaces error).

- [ ] **Step 1: Implement Tables.tsx**

`apps/ui/src/screens/Tables.tsx`:

```tsx
import { useEffect, useState } from "react";
import { ApiError, apiFetch, type User } from "../api";
import type { Order, TableInfo } from "../types";
import { connectWs } from "../ws";

export function Tables({ user, onOpenOrder }: { user: User; onOpenOrder: (orderId: string) => void }) {
  const [tables, setTables] = useState<TableInfo[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [managing, setManaging] = useState(false);
  const [newTable, setNewTable] = useState({ name: "", area: "" });
  const [error, setError] = useState("");

  async function reload() {
    const [t, o] = await Promise.all([
      apiFetch<{ tables: TableInfo[] }>("/api/tables"),
      apiFetch<{ orders: Order[] }>("/api/orders"),
    ]);
    setTables(t.tables);
    setOrders(o.orders);
  }

  useEffect(() => {
    reload().catch(() => setError("Failed to load tables"));
    const dispose = connectWs({
      onEvent: (event) => {
        if (event === "table.changed" || event === "order.updated") void reload();
      },
      onStatus: (connected) => { if (connected) void reload(); },
    });
    return dispose;
  }, []);

  async function run(action: () => Promise<unknown>) {
    setError("");
    try {
      await action();
      await reload();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Request failed");
    }
  }

  function addTable() {
    const name = newTable.name.trim();
    if (!name) return;
    const maxSort = Math.max(0, ...tables.map((t) => t.sortOrder));
    void run(async () => {
      await apiFetch("/api/tables", {
        method: "POST",
        body: JSON.stringify({ name, area: newTable.area.trim() || null, sortOrder: maxSort + 1 }),
      });
      setNewTable({ name: "", area: "" });
    });
  }

  function patchTable(id: string, patch: Partial<Pick<TableInfo, "name" | "area" | "sortOrder" | "isActive">>) {
    void run(() => apiFetch(`/api/tables/${id}`, { method: "PATCH", body: JSON.stringify(patch) }));
  }

  function move(table: TableInfo, dir: -1 | 1) {
    const i = tables.findIndex((t) => t.id === table.id);
    const neighbor = tables[i + dir];
    if (!neighbor) return;
    void run(async () => {
      await apiFetch(`/api/tables/${table.id}`, { method: "PATCH", body: JSON.stringify({ sortOrder: neighbor.sortOrder }) });
      await apiFetch(`/api/tables/${neighbor.id}`, { method: "PATCH", body: JSON.stringify({ sortOrder: table.sortOrder }) });
    });
  }

  function rename(table: TableInfo) {
    const name = window.prompt("Table name", table.name)?.trim();
    if (name && name !== table.name) patchTable(table.id, { name });
  }

  function openTable(table: TableInfo) {
    if (table.status === "occupied" || table.status === "billed") {
      onOpenOrder(table.openOrderId!);
    } else {
      void run(async () => {
        const { order } = await apiFetch<{ order: Order }>("/api/orders", {
          method: "POST",
          body: JSON.stringify({ clientRef: crypto.randomUUID(), type: "dine_in", tableId: table.id }),
        });
        onOpenOrder(order.id);
      });
    }
  }

  function newParcel() {
    void run(async () => {
      const { order } = await apiFetch<{ order: Order }>("/api/orders", {
        method: "POST",
        body: JSON.stringify({ clientRef: crypto.randomUUID(), type: "parcel", tableId: null }),
      });
      onOpenOrder(order.id);
    });
  }

  const grouped = new Map<string, TableInfo[]>();
  for (const t of tables) {
    const area = t.area ?? "Main";
    const list = grouped.get(area) ?? [];
    list.push(t);
    grouped.set(area, list);
  }

  const openParcels = orders.filter((o) => o.type === "parcel");

  const isAdmin = user.role === "admin";

  return (
    <div style={{ padding: 16, fontFamily: "system-ui" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <h2>Tables</h2>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={newParcel} style={{ padding: "8px 16px", fontWeight: 700 }}>
            New parcel
          </button>
          {isAdmin && (
            <button onClick={() => setManaging(!managing)} style={{ padding: "8px 16px" }}>
              {managing ? "Done managing" : "Manage tables"}
            </button>
          )}
        </div>
      </div>

      <div style={{ color: "crimson", minHeight: 20 }}>{error}</div>

      {managing && isAdmin && (
        <div style={{ marginBottom: 24, padding: 16, border: "1px solid #ddd", borderRadius: 4 }}>
          <h3>Add table</h3>
          <div style={{ display: "flex", gap: 8 }}>
            <input placeholder="Table name" value={newTable.name} onChange={(e) => setNewTable({ ...newTable, name: e.target.value })} />
            <input placeholder="Area (optional)" value={newTable.area} onChange={(e) => setNewTable({ ...newTable, area: e.target.value })} />
            <button onClick={addTable}>Add</button>
          </div>
          <h3 style={{ marginTop: 16 }}>All tables</h3>
          <ul style={{ listStyle: "none", padding: 0 }}>
            {tables.map((t) => (
              <li key={t.id} style={{ display: "flex", gap: 4, alignItems: "center", padding: "4px 0", opacity: t.isActive ? 1 : 0.45 }}>
                <span style={{ flex: 1 }}>
                  {t.name} {t.area && `(${t.area})`}
                </span>
                <button onClick={() => move(t, -1)} title="Move up">
                  ▲
                </button>
                <button onClick={() => move(t, 1)} title="Move down">
                  ▼
                </button>
                <button onClick={() => rename(t)} title="Rename">
                  ✎
                </button>
                <button onClick={() => patchTable(t.id, { isActive: !t.isActive })} title={t.isActive ? "Deactivate" : "Activate"}>
                  {t.isActive ? "⏸" : "▶"}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {!managing && (
        <>
          {Array.from(grouped.entries()).map(([area, list]) => (
            <div key={area} style={{ marginBottom: 24 }}>
              <h3>{area}</h3>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(120px, 1fr))", gap: 12 }}>
                {list
                  .filter((t) => t.isActive)
                  .map((t) => (
                    <button
                      key={t.id}
                      onClick={() => openTable(t)}
                      style={{
                        padding: 16,
                        fontSize: 16,
                        fontWeight: 700,
                        backgroundColor: t.status === "free" ? "#e0f7e0" : t.status === "occupied" ? "#ffe0b2" : "#ffcccc",
                        border: "1px solid #ccc",
                        borderRadius: 4,
                      }}
                    >
                      {t.name}
                      <div style={{ fontSize: 12, fontWeight: 400, marginTop: 4, textTransform: "capitalize" }}>{t.status}</div>
                    </button>
                  ))}
              </div>
            </div>
          ))}

          {openParcels.length > 0 && (
            <div>
              <h3>Open parcels</h3>
              <ul style={{ listStyle: "none", padding: 0 }}>
                {openParcels.map((o) => (
                  <li key={o.id} style={{ padding: "8px 0", borderBottom: "1px solid #eee" }}>
                    <button onClick={() => onOpenOrder(o.id)} style={{ fontSize: 16, padding: 8 }}>
                      Parcel {o.clientRef.slice(0, 8)}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Wire into App**

In `apps/ui/src/App.tsx`, add the import:

```tsx
import { Tables } from "./screens/Tables";
```

Replace the tables placeholder line:

```tsx
          {page.name === "tables" && <Tables user={user} onOpenOrder={onOpenOrder} />}
```

- [ ] **Step 3: Verify**

Run: `npm run typecheck` → clean. Run: `npm run build -w @forkflow/ui` → builds. Run: `npm test` → green.

- [ ] **Step 4: Commit**

```bash
git add apps/ui/src/screens/Tables.tsx apps/ui/src/App.tsx
git commit -m "$(cat <<'EOF'
feat(ui): tables screen with admin manage-toggle

Grouped by area, tap free→create dine-in order, tap occupied→open,
new parcel button, open-parcel list, admin manage mode with add/
rename/reorder (▲▼ swap)/deactivate (409 surfaced), WS reload on
table.changed/order.updated.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 10: UI Order screen

**Files:**
- Create: `apps/ui/src/screens/OrderScreen.tsx`
- Modify: `apps/ui/src/App.tsx` (replace order placeholder, wire onBack)

**Interfaces:**
- Consumes: `apiFetch`, `ApiError`, `User` from `../api`; `connectWs` from `../ws`; `paiseToRupees` from `../money`; `Category`, `Product`, `Order`, `OrderItem` from `../types`.
- Produces: `OrderScreen({ user, orderId, onBack })` component. Loads order + categories + products; WS reload on `order.updated` (matching id) / `table.changed`; draft cart in `localStorage["forkflow.draft." + orderId]` (JSON array of `{clientRef, productId, variantId, name, pricePaise, qty, note}`; clientRef = `crypto.randomUUID()` at add time so punch retries dedupe); product grid by category tab (active products in active categories; product with active variants → inline variant buttons); cart ops qty +/-, note via `window.prompt`, remove; **Punch** → POST items then clear draft; punched list with status chips; cancel: pending → `confirm()` then POST cancel; sent → visible only when `user.role === "admin" || user.role === "cashier"`, `window.prompt` reason (required); **Send to kitchen** → POST send, surface 409 messages; **Cancel order** → visible only when no sent items, `confirm()` then POST; totals footer = sum over non-cancelled items of pricePaise*qty (display only, `paiseToRupees`).

- [ ] **Step 1: Implement OrderScreen.tsx**

`apps/ui/src/screens/OrderScreen.tsx`:

```tsx
import { useEffect, useState } from "react";
import { ApiError, apiFetch, type User } from "../api";
import { paiseToRupees } from "../money";
import type { Category, Order, OrderItem, Product } from "../types";
import { connectWs } from "../ws";

interface DraftItem {
  clientRef: string;
  productId: string;
  variantId: string | null;
  name: string;
  pricePaise: number;
  qty: number;
  note: string;
}

export function OrderScreen({ user, orderId, onBack }: { user: User; orderId: string; onBack: () => void }) {
  const [order, setOrder] = useState<Order | null>(null);
  const [categories, setCategories] = useState<Category[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [selectedCat, setSelectedCat] = useState<string | null>(null);
  const [draft, setDraft] = useState<DraftItem[]>([]);
  const [error, setError] = useState("");

  const draftKey = `forkflow.draft.${orderId}`;

  async function reload() {
    const [o, c, p] = await Promise.all([
      apiFetch<{ order: Order }>(`/api/orders/${orderId}`),
      apiFetch<{ categories: Category[] }>("/api/categories"),
      apiFetch<{ products: Product[] }>("/api/products"),
    ]);
    setOrder(o.order);
    setCategories(c.categories.filter((cat) => cat.isActive));
    setProducts(p.products.filter((prod) => prod.isActive));
    setSelectedCat((cur) => cur ?? c.categories.filter((x) => x.isActive)[0]?.id ?? null);
  }

  useEffect(() => {
    reload().catch(() => setError("Failed to load order"));
    const stored = localStorage.getItem(draftKey);
    if (stored) {
      try {
        setDraft(JSON.parse(stored));
      } catch {
        // ignore corrupted draft
      }
    }
    const dispose = connectWs({
      onEvent: (event, data) => {
        if (event === "order.updated" && (data as { order: Order }).order.id === orderId) void reload();
        if (event === "table.changed") void reload();
      },
      onStatus: (connected) => { if (connected) void reload(); },
    });
    return dispose;
  }, [orderId, draftKey]);

  useEffect(() => {
    localStorage.setItem(draftKey, JSON.stringify(draft));
  }, [draft, draftKey]);

  async function run(action: () => Promise<unknown>) {
    setError("");
    try {
      await action();
      await reload();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Request failed");
    }
  }

  function addToDraft(productId: string, variantId: string | null, name: string, pricePaise: number) {
    setDraft((d) => [...d, { clientRef: crypto.randomUUID(), productId, variantId, name, pricePaise, qty: 1, note: "" }]);
  }

  function updateDraft(clientRef: string, update: Partial<Pick<DraftItem, "qty" | "note">>) {
    setDraft((d) => d.map((item) => (item.clientRef === clientRef ? { ...item, ...update } : item)));
  }

  function removeDraft(clientRef: string) {
    setDraft((d) => d.filter((item) => item.clientRef !== clientRef));
  }

  function punch() {
    if (draft.length === 0) return;
    void run(async () => {
      const items = draft.map((d) => ({
        clientRef: d.clientRef,
        productId: d.productId,
        variantId: d.variantId,
        qty: d.qty,
        note: d.note || undefined,
      }));
      await apiFetch(`/api/orders/${orderId}/items`, { method: "POST", body: JSON.stringify({ items }) });
      setDraft([]);
      localStorage.removeItem(draftKey);
    });
  }

  function cancelItem(item: OrderItem) {
    if (item.status === "pending") {
      if (!window.confirm(`Cancel ${item.name}?`)) return;
      void run(() => apiFetch(`/api/order-items/${item.id}/cancel`, { method: "POST", body: JSON.stringify({}) }));
    } else if (item.status === "sent") {
      if (user.role !== "admin" && user.role !== "cashier") return;
      const reason = window.prompt(`Cancel ${item.name}?\nReason (required):`);
      if (!reason?.trim()) return;
      void run(() => apiFetch(`/api/order-items/${item.id}/cancel`, { method: "POST", body: JSON.stringify({ reason: reason.trim() }) }));
    }
  }

  function sendToKitchen() {
    void run(() => apiFetch(`/api/orders/${orderId}/send`, { method: "POST" }));
  }

  function cancelOrder() {
    if (!window.confirm("Cancel this entire order?")) return;
    void run(async () => {
      await apiFetch(`/api/orders/${orderId}/cancel`, { method: "POST" });
      onBack();
    });
  }

  function addNote(clientRef: string) {
    const note = window.prompt("Add note (e.g. less spicy):") ?? "";
    updateDraft(clientRef, { note });
  }

  if (!order) return <p style={{ fontFamily: "system-ui", padding: 16 }}>Loading order...</p>;

  const activeProducts = products.filter((p) => p.categoryId === selectedCat);
  const hasSentItems = order.items.some((i) => i.status === "sent");
  const canCancelOrder = order.status === "open" && !hasSentItems;

  const total = order.items.filter((i) => i.status !== "cancelled").reduce((sum, i) => sum + i.pricePaise * i.qty, 0);

  return (
    <div style={{ fontFamily: "system-ui", padding: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <h2>
          {order.type === "dine_in" ? `Table order` : "Parcel"} — {order.status}
        </h2>
        <button onClick={onBack} style={{ padding: "8px 16px" }}>
          ← Back
        </button>
      </div>

      <div style={{ color: "crimson", minHeight: 20 }}>{error}</div>

      {order.status === "open" && (
        <>
          <div style={{ marginBottom: 16 }}>
            <h3>Products</h3>
            <div style={{ display: "flex", gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
              {categories.map((c) => (
                <button key={c.id} onClick={() => setSelectedCat(c.id)} disabled={c.id === selectedCat} style={{ padding: 6 }}>
                  {c.name}
                </button>
              ))}
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))", gap: 12 }}>
              {activeProducts.map((p) => {
                const activeVariants = p.variants.filter((v) => v.isActive);
                if (activeVariants.length > 0) {
                  return (
                    <div key={p.id} style={{ border: "1px solid #ddd", borderRadius: 4, padding: 8 }}>
                      <div style={{ fontWeight: 700, marginBottom: 4 }}>{p.name}</div>
                      {activeVariants.map((v) => (
                        <button
                          key={v.id}
                          onClick={() => addToDraft(p.id, v.id, `${p.name} (${v.name})`, v.pricePaise)}
                          style={{ display: "block", width: "100%", marginBottom: 4, padding: 6, fontSize: 12 }}
                        >
                          {v.name} — ₹{paiseToRupees(v.pricePaise)}
                        </button>
                      ))}
                    </div>
                  );
                } else {
                  return (
                    <button
                      key={p.id}
                      onClick={() => addToDraft(p.id, null, p.name, p.pricePaise)}
                      style={{ padding: 12, fontSize: 14, border: "1px solid #ddd", borderRadius: 4 }}
                    >
                      <div style={{ fontWeight: 700 }}>{p.name}</div>
                      <div style={{ fontSize: 12 }}>₹{paiseToRupees(p.pricePaise)}</div>
                    </button>
                  );
                }
              })}
            </div>
          </div>

          <div style={{ marginBottom: 16 }}>
            <h3>Cart ({draft.length} items)</h3>
            {draft.length === 0 && <p style={{ color: "#777" }}>Add items from products above.</p>}
            {draft.map((d) => (
              <div key={d.clientRef} style={{ display: "flex", gap: 8, alignItems: "center", padding: "8px 0", borderBottom: "1px solid #eee" }}>
                <span style={{ flex: 1 }}>
                  {d.name}
                  {d.note && <span style={{ fontSize: 12, color: "#555" }}> ({d.note})</span>}
                </span>
                <button onClick={() => updateDraft(d.clientRef, { qty: Math.max(1, d.qty - 1) })}>−</button>
                <span>{d.qty}</span>
                <button onClick={() => updateDraft(d.clientRef, { qty: d.qty + 1 })}>+</button>
                <button onClick={() => addNote(d.clientRef)}>Note</button>
                <button onClick={() => removeDraft(d.clientRef)}>✕</button>
              </div>
            ))}
            {draft.length > 0 && (
              <button onClick={punch} style={{ marginTop: 8, padding: "10px 24px", fontWeight: 700 }}>
                Punch
              </button>
            )}
          </div>
        </>
      )}

      <div style={{ marginBottom: 16 }}>
        <h3>Punched items</h3>
        {order.items.length === 0 && <p style={{ color: "#777" }}>No items yet.</p>}
        {order.items.map((item) => (
          <div
            key={item.id}
            style={{
              display: "flex",
              gap: 8,
              alignItems: "center",
              padding: "8px 0",
              borderBottom: "1px solid #eee",
              opacity: item.status === "cancelled" ? 0.45 : 1,
            }}
          >
            <span style={{ flex: 1 }}>
              {item.qty} × {item.name}
              {item.note && <span style={{ fontSize: 12, color: "#555" }}> ({item.note})</span>}
              {item.cancelReason && <span style={{ fontSize: 12, color: "crimson" }}> [Cancelled: {item.cancelReason}]</span>}
            </span>
            <span
              style={{
                fontSize: 12,
                padding: "2px 6px",
                borderRadius: 4,
                backgroundColor: item.status === "pending" ? "#fff3cd" : item.status === "sent" ? "#d1ecf1" : "#f8d7da",
              }}
            >
              {item.status}
            </span>
            {item.status !== "cancelled" && (
              <button onClick={() => cancelItem(item)} disabled={item.status === "sent" && user.role !== "admin" && user.role !== "cashier"}>
                Cancel
              </button>
            )}
          </div>
        ))}
      </div>

      <div style={{ marginBottom: 16, padding: 16, backgroundColor: "#f9f9f9", borderRadius: 4 }}>
        <div style={{ fontSize: 18, fontWeight: 700 }}>Total: ₹{paiseToRupees(total)}</div>
        <div style={{ fontSize: 12, color: "#555" }}>(display only; excluding tax)</div>
      </div>

      {order.status === "open" && (
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={sendToKitchen} style={{ padding: "10px 24px", fontWeight: 700 }}>
            Send to kitchen
          </button>
          {canCancelOrder && (
            <button onClick={cancelOrder} style={{ padding: "10px 24px", backgroundColor: "#f8d7da" }}>
              Cancel order
            </button>
          )}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Wire into App**

In `apps/ui/src/App.tsx`, add the import:

```tsx
import { OrderScreen } from "./screens/OrderScreen";
```

Replace the order placeholder line:

```tsx
          {page.name === "order" && <OrderScreen user={user} orderId={page.orderId} onBack={onBack} />}
```

- [ ] **Step 3: Verify**

Run: `npm run typecheck` → clean. Run: `npm run build -w @forkflow/ui` → builds. Run: `npm test` → green.

- [ ] **Step 4: Commit**

```bash
git add apps/ui/src/screens/OrderScreen.tsx apps/ui/src/App.tsx
git commit -m "$(cat <<'EOF'
feat(ui): order screen with localStorage draft + punch/send/cancel

Category tabs, product grid with variant buttons, draft cart (qty +/-,
note via prompt, remove), punch → POST items + clear draft, punched
list with status chips, cancel (pending: confirm; sent: admin/cashier
+ reason prompt), send-to-kitchen (409 surfaced), cancel-order (when
no sent items), totals footer (pricePaise*qty via paiseToRupees), WS
reload on order.updated/table.changed.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 11: UI Kitchen display

**Files:**
- Create: `apps/ui/src/screens/Kitchen.tsx`
- Modify: `apps/ui/src/App.tsx` (replace kitchen placeholder)

**Interfaces:**
- Consumes: `apiFetch` from `../api`; `connectWs` from `../ws`; `KotWithContext` from `../types`.
- Produces: `Kitchen()` component (no props). Loads `/api/kots`; WS reload on `kot.created`/`kot.updated`/`order.updated`; "reconnecting…" banner from onStatus(false); ticket card: `KOT #n`, table name or "Parcel", age in minutes (interval re-render 30s), items `qty × name` + note, cancelled items line-through; **Done** button → POST done.

- [ ] **Step 1: Implement Kitchen.tsx**

`apps/ui/src/screens/Kitchen.tsx`:

```tsx
import { useEffect, useState } from "react";
import { apiFetch } from "../api";
import type { KotWithContext } from "../types";
import { connectWs } from "../ws";

export function Kitchen() {
  const [kots, setKots] = useState<KotWithContext[]>([]);
  const [connected, setConnected] = useState(true);
  const [, setTick] = useState(0); // force re-render for age updates

  async function reload() {
    const { kots } = await apiFetch<{ kots: KotWithContext[] }>("/api/kots");
    setKots(kots);
  }

  useEffect(() => {
    void reload();
    const dispose = connectWs({
      onEvent: (event) => {
        if (event === "kot.created" || event === "kot.updated" || event === "order.updated") void reload();
      },
      onStatus: (c) => { setConnected(c); if (c) void reload(); },
    });
    const ageInterval = setInterval(() => setTick((t) => t + 1), 30000);
    return () => {
      dispose();
      clearInterval(ageInterval);
    };
  }, []);

  async function markDone(id: string) {
    try {
      await apiFetch(`/api/kots/${id}/done`, { method: "POST" });
      await reload();
    } catch {
      void reload();
    }
  }

  function age(createdAt: number): string {
    const mins = Math.floor((Date.now() - createdAt) / 60000);
    return mins === 0 ? "just now" : `${mins} min`;
  }

  return (
    <div style={{ fontFamily: "system-ui", padding: 16 }}>
      {!connected && (
        <div style={{ padding: 12, backgroundColor: "#fff3cd", borderRadius: 4, marginBottom: 16 }}>
          Reconnecting…
        </div>
      )}
      <h2>Kitchen Display</h2>
      {kots.length === 0 && <p style={{ color: "#777" }}>No active KOTs.</p>}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))", gap: 16 }}>
        {kots.map((kot) => (
          <div key={kot.id} style={{ border: "2px solid #333", borderRadius: 8, padding: 16, backgroundColor: "#fffbf0" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
              <div style={{ fontSize: 20, fontWeight: 700 }}>KOT #{kot.kotNo}</div>
              <div style={{ fontSize: 14, color: "#555" }}>{age(kot.createdAt)}</div>
            </div>
            <div style={{ fontSize: 14, marginBottom: 8 }}>{kot.tableName ?? "Parcel"}</div>
            <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
              {kot.items.map((item) => (
                <li
                  key={item.id}
                  style={{
                    padding: "4px 0",
                    textDecoration: item.status === "cancelled" ? "line-through" : "none",
                    opacity: item.status === "cancelled" ? 0.5 : 1,
                  }}
                >
                  {item.qty} × {item.name}
                  {item.note && <div style={{ fontSize: 12, color: "#555", fontStyle: "italic" }}>({item.note})</div>}
                </li>
              ))}
            </ul>
            <button onClick={() => void markDone(kot.id)} style={{ marginTop: 12, padding: "10px 24px", fontWeight: 700, width: "100%" }}>
              Done
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Wire into App**

In `apps/ui/src/App.tsx`, add the import:

```tsx
import { Kitchen } from "./screens/Kitchen";
```

Replace the kitchen placeholder line:

```tsx
          {page.name === "kitchen" && <Kitchen />}
```

- [ ] **Step 3: Verify**

Run: `npm run typecheck` → clean. Run: `npm run build -w @forkflow/ui` → builds. Run: `npm test` → green (all baseline + M2 + new M3a tests pass).

- [ ] **Step 4: Commit**

```bash
git add apps/ui/src/screens/Kitchen.tsx apps/ui/src/App.tsx
git commit -m "$(cat <<'EOF'
feat(ui): kitchen display with ticket cards and live updates

Active KOTs grid, ticket cards (KOT #n, table/parcel, age in minutes,
items qty × name + note, cancelled line-through), Done button → POST
done, WS reload on kot.created/kot.updated/order.updated, reconnecting
banner from onStatus(false), 30s age re-render interval.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```
---

### Task 12: Whole-milestone verification

**Files:** none created — this task proves the milestone. It is run by the controller session (it has the Playwright browser), not by an implementer subagent.

- [ ] **Step 1: Full suite + typecheck + build**

```bash
npm test            # all green (72 baseline + this plan's new domain/server tests)
npm run typecheck   # clean
npm run build -w @forkflow/ui
```

- [ ] **Step 2: Scripted API round trip against the production serving path**

Run the real server on a scratch data dir (NEVER the real `./data`):

```bash
FORKFLOW_DATA_DIR=./data-m3a-check npx tsx apps/server/src/main.ts &
```

With `TOKEN` from `POST /api/setup`, exercise: `POST /api/tables` → `POST /api/orders` (dine_in, clientRef; repeat same clientRef → same order id back) → `POST /api/orders/:id/items` (one stationed product w/ variant, one no-station product; repeat same body → item count unchanged) → `POST /api/orders/:id/send` (expect 1 KOT, kotNo 1) → `GET /api/kots` (ticket present, tableName set) → `POST /api/kots/:id/done` → `GET /api/kots` (empty) → `GET /api/tables` (status occupied). Then kill the server (port-check + PowerShell Stop-Process — the tsx wrapper leaves a node child) and delete `data-m3a-check/` (file-level rm + rmdir).

- [ ] **Step 3: Real-browser click-through (controller/human — inject/curl is NOT browser-equivalent)**

`FORKFLOW_DATA_DIR=<scratch>` server + built UI on :4100, then in a real browser: setup → Tables → admin "Manage tables" add two tables with areas → tap a free table → OrderScreen: punch a variant product and a no-station product (draft survives a reload before punching) → Send to kitchen → Kitchen page: ticket appears (WS live), items listed, mark Done → back to Tables (occupied) → cancel-sent flow as admin (reason prompt; waiter must not see the button) → cancel remaining pending items → cancel order → table free again → New parcel order round trip → create a waiter user (Users screen), log in as waiter: sees home+tables tabs only; kitchen-role user lands directly on the Kitchen board.

- [ ] **Step 4: Finish the branch**

Use superpowers:finishing-a-development-branch (merge to main after green suite on the merged result, push per project convention).
