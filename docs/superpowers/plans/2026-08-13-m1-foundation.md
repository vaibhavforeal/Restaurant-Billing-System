# Milestone 1 — Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A pruned monorepo where a Fastify server owns a fully-migrated SQLite database with PIN auth + roles, a React login screen works from any browser, and an Electron shell boots the whole thing in one window.

**Architecture:** Local-only POS (spec: `docs/superpowers/specs/2026-08-13-desktop-pos-design.md`). One Node server (Fastify) is the single writer to SQLite (better-sqlite3, WAL); every client — including the Electron window — uses the same REST API on port 4100. This milestone builds the skeleton: schema for all tables up front, auth, one UI screen, the shell.

**Tech Stack:** TypeScript (strict, ESM, NodeNext — relative imports need `.js` suffix), npm workspaces, Fastify, better-sqlite3, zod, React + Vite, Electron, vitest.

## Global Constraints

- Node ESM everywhere: every `package.json` has `"type": "module"`; relative imports end in `.js` even in `.ts` files (NodeNext).
- TypeScript config extends `tsconfig.base.json` (strict, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess` — expect these to bite; don't loosen them).
- Money is INTEGER paise (never floats, never rupees). Timestamps are INTEGER Unix milliseconds written by application code (`Date.now()`), not SQL defaults.
- Server listens on `0.0.0.0:4100` (LAN clients are a spec requirement).
- Only the server process touches SQLite. WAL mode, foreign keys ON.
- Tests: vitest, files match `packages/*/src/**/*.test.ts` / `apps/*/src/**/*.test.ts`. Run with `npx vitest run <path>` for a single file, `npm test` for all.
- Workspace names: `@forkflow/core` (exists), `@forkflow/domain`, `@forkflow/server`, `@forkflow/ui`, `@forkflow/desktop`.
- Install deps into a workspace with `npm i <pkg> -w @forkflow/<name>` (run from repo root). Don't pin versions manually; accept what npm resolves.
- Windows dev machine, bash shell. Use forward slashes in commands; they work in Git Bash.
- Commit after every task (steps say when). Never use `git add -A` after Task 1 — stage named files.

---

### Task 1: Baseline commit of the pre-pivot codebase

The repo was `git init`-ed with only `docs/` committed. The old packages are untracked — commit everything **before** deleting anything, so the retired sync/db code stays recoverable from history.

**Files:**
- No file edits. Git only.

**Interfaces:**
- Consumes: nothing.
- Produces: a git history where the pre-pivot code exists; later tasks may delete freely.

- [ ] **Step 1: Verify .gitignore protects us**

Run: `cat .gitignore` — confirm it contains `node_modules/`, `*.db`, `dist/`. It does (checked 2026-08-13); if somehow not, stop and fix before `git add`.

- [ ] **Step 2: Commit the whole tree as baseline**

```bash
git add -A
git status   # sanity: no node_modules, no *.db staged
git commit -m "chore: baseline pre-pivot codebase (Phase 0 sync architecture, retired by 2026-08-13 spec)"
```

---

### Task 2: Prune retired packages; scaffold packages/domain with salvaged uuidv7

**Files:**
- Create: `packages/domain/package.json`, `packages/domain/src/index.ts`
- Create (copy from `packages/sync/src/`): `packages/domain/src/id.ts`, `packages/domain/src/id.test.ts`
- Delete: `packages/sync/`, `packages/db/`, `apps/terminal-demo/`
- Modify: `vitest.config.ts`, `tsconfig.json`, root `package.json`

**Interfaces:**
- Consumes: `packages/sync/src/id.ts` (`uuidv7(): string`, RFC 9562, monotonic).
- Produces: `import { uuidv7 } from "@forkflow/domain"` for every later task.

- [ ] **Step 1: Scaffold the domain package and salvage uuidv7**

```bash
mkdir -p packages/domain/src
cp packages/sync/src/id.ts packages/domain/src/id.ts
cp packages/sync/src/id.test.ts packages/domain/src/id.test.ts
```

Create `packages/domain/package.json`:

```json
{
  "name": "@forkflow/domain",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "description": "SQLite schema, migrations, and business logic for the local-only POS.",
  "exports": {
    ".": "./src/index.ts"
  }
}
```

Create `packages/domain/src/index.ts`:

```ts
export { uuidv7 } from "./id.js";
```

Check `packages/domain/src/id.test.ts`: if it imports from `"./id.js"` it needs no edit; if it imports `"@forkflow/sync"`, change to `"./id.js"`.

- [ ] **Step 2: Delete the retired workspaces**

```bash
rm -rf packages/sync packages/db apps/terminal-demo
```

- [ ] **Step 3: Update the three root configs**

`vitest.config.ts` — replace the alias block:

```ts
    alias: {
      "@forkflow/domain": pkg("domain"),
      "@forkflow/core": pkg("core"),
    },
```

Also delete the stale comment about PGlite/Postgres above `testTimeout` (keep the timeout).

`tsconfig.json` — replace the paths block:

```json
    "paths": {
      "@forkflow/domain": ["packages/domain/src/index.ts"],
      "@forkflow/core": ["packages/core/src/index.ts"]
    }
```

Root `package.json` — remove the `"demo"` script line.

- [ ] **Step 4: Reinstall workspaces and verify**

```bash
npm install
npm test
npm run typecheck
```

Expected: all remaining tests pass (core's password/rbac tests + domain's id test); typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor: retire sync/db/terminal-demo, scaffold @forkflow/domain with salvaged uuidv7"
```

(`git add -A` is allowed once more here because the deletions must be staged; verify `git status` shows only expected paths first.)

---

### Task 3: Domain — DB open helper + migration runner (TDD)

**Files:**
- Create: `packages/domain/src/db.ts`, `packages/domain/src/migrate.ts`
- Test: `packages/domain/src/migrate.test.ts`
- Modify: `packages/domain/src/index.ts`, `packages/domain/package.json` (deps)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `openDb(path: string): Database` — better-sqlite3 handle with WAL, FK ON, busy_timeout 5000, synchronous NORMAL.
  - `interface Migration { version: number; name: string; up(db: Database): void }`
  - `migrate(db: Database, migrations: Migration[]): void` — applies each pending migration in its own transaction, tracks via `PRAGMA user_version`.

- [ ] **Step 1: Install dependencies**

```bash
npm i better-sqlite3 -w @forkflow/domain
npm i -D @types/better-sqlite3 -w @forkflow/domain
```

- [ ] **Step 2: Write the failing test**

`packages/domain/src/migrate.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { openDb } from "./db.js";
import { migrate, type Migration } from "./migrate.js";

const m1: Migration = {
  version: 1,
  name: "create-a",
  up: (db) => db.exec("CREATE TABLE a (id INTEGER PRIMARY KEY)"),
};
const m2: Migration = {
  version: 2,
  name: "create-b",
  up: (db) => db.exec("CREATE TABLE b (id INTEGER PRIMARY KEY)"),
};

describe("openDb", () => {
  it("enables WAL-compatible mode and foreign keys", () => {
    const db = openDb(":memory:");
    // :memory: reports "memory" for journal_mode; foreign_keys must be 1
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
  });
});

describe("migrate", () => {
  it("applies pending migrations and records the version", () => {
    const db = openDb(":memory:");
    migrate(db, [m1, m2]);
    expect(db.pragma("user_version", { simple: true })).toBe(2);
    // both tables exist
    const names = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all()
      .map((r: any) => r.name);
    expect(names).toContain("a");
    expect(names).toContain("b");
  });

  it("is idempotent — re-running applies nothing", () => {
    const db = openDb(":memory:");
    migrate(db, [m1, m2]);
    migrate(db, [m1, m2]); // would throw "table a already exists" if re-applied
    expect(db.pragma("user_version", { simple: true })).toBe(2);
  });

  it("rolls back a failing migration and leaves version untouched", () => {
    const db = openDb(":memory:");
    const bad: Migration = {
      version: 1,
      name: "bad",
      up: (d) => {
        d.exec("CREATE TABLE good_table (id INTEGER PRIMARY KEY)");
        d.exec("THIS IS NOT SQL");
      },
    };
    expect(() => migrate(db, [bad])).toThrow();
    expect(db.pragma("user_version", { simple: true })).toBe(0);
    const names = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((r: any) => r.name);
    expect(names).not.toContain("good_table");
  });

  it("rejects out-of-order migration lists", () => {
    const db = openDb(":memory:");
    expect(() => migrate(db, [m2, m1])).toThrow(/order/i);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run packages/domain/src/migrate.test.ts`
Expected: FAIL — cannot resolve `./db.js` / `./migrate.js`.

- [ ] **Step 4: Implement db.ts and migrate.ts**

`packages/domain/src/db.ts`:

```ts
import DatabaseCtor from "better-sqlite3";
import type { Database } from "better-sqlite3";

export type { Database };

/**
 * Open (or create) the POS database. The server is the only process that
 * ever calls this — single writer is an architectural invariant.
 */
export function openDb(path: string): Database {
  const db = new DatabaseCtor(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  db.pragma("synchronous = NORMAL");
  return db;
}
```

`packages/domain/src/migrate.ts`:

```ts
import type { Database } from "better-sqlite3";

export interface Migration {
  version: number;
  name: string;
  up(db: Database): void;
}

/**
 * Apply pending migrations. Each runs in its own transaction; user_version
 * is bumped inside that same transaction so a crash can never record a
 * migration it did not finish.
 */
export function migrate(db: Database, migrations: Migration[]): void {
  for (let i = 1; i < migrations.length; i++) {
    const prev = migrations[i - 1]!;
    const cur = migrations[i]!;
    if (cur.version <= prev.version) {
      throw new Error(
        `migrations out of order: ${prev.name} (v${prev.version}) before ${cur.name} (v${cur.version})`,
      );
    }
  }

  for (const m of migrations) {
    const current = db.pragma("user_version", { simple: true }) as number;
    if (m.version <= current) continue;
    const run = db.transaction(() => {
      m.up(db);
      db.pragma(`user_version = ${m.version}`);
    });
    run();
  }
}
```

Append to `packages/domain/src/index.ts`:

```ts
export { openDb, type Database } from "./db.js";
export { migrate, type Migration } from "./migrate.js";
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run packages/domain/src/migrate.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/domain
git commit -m "feat(domain): openDb with safe pragmas + transactional migration runner"
```

---

### Task 4: Migration 001 — the full schema + seed

The spec (§3) fixes 16 domain tables. This migration creates all of them now — later milestones add behavior, not schema (recipes reuse `product_stock_links` by design). Implementation additions, documented here deliberately: `bill_taxes` (the spec's "per-rate CGST/SGST breakdown rows"), `sessions` (PIN auth), `sequences` (gapless bill numbers).

**Files:**
- Create: `packages/domain/src/migrations/001-initial.ts`, `packages/domain/src/migrations/index.ts`
- Test: `packages/domain/src/migrations/001-initial.test.ts`
- Modify: `packages/domain/src/index.ts`

**Interfaces:**
- Consumes: `Migration`, `openDb`, `migrate`, `uuidv7` (Tasks 2–3).
- Produces: `MIGRATIONS: Migration[]` (exported from `@forkflow/domain`); the full schema below — later tasks and milestones must match these exact table/column names.

- [ ] **Step 1: Write the failing test**

`packages/domain/src/migrations/001-initial.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { openDb } from "../db.js";
import { migrate } from "../migrate.js";
import { MIGRATIONS } from "./index.js";

function freshDb() {
  const db = openDb(":memory:");
  migrate(db, MIGRATIONS);
  return db;
}

describe("migration 001", () => {
  it("creates every table the spec names, plus implementation tables", () => {
    const db = freshDb();
    const names = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      .all()
      .map((r: any) => r.name)
      .sort();
    expect(names).toEqual(
      [
        "bill_taxes", "bills", "categories", "dining_tables", "kot_stations",
        "kots", "order_items", "orders", "payments", "printers", "product_stock_links",
        "products", "sequences", "sessions", "settings", "stock_items", "stock_moves",
        "users", "variants",
      ].sort(),
    );
  });

  it("seeds the settings singleton, a default Kitchen station, and the bill sequence", () => {
    const db = freshDb();
    const settings = db.prepare("SELECT * FROM settings WHERE id = 1").get() as any;
    expect(settings.setup_complete).toBe(0);
    const station = db.prepare("SELECT * FROM kot_stations").get() as any;
    expect(station.name).toBe("Kitchen");
    const seq = db.prepare("SELECT value FROM sequences WHERE name = 'bill_no'").get() as any;
    expect(seq.value).toBe(0);
  });

  it("enforces foreign keys", () => {
    const db = freshDb();
    expect(() =>
      db.prepare(
        "INSERT INTO products (id, category_id, name, price_paise, gst_rate, created_at) VALUES ('p1', 'no-such-category', 'Tea', 1000, 5, 0)",
      ).run(),
    ).toThrow(/FOREIGN KEY/);
  });

  it("rejects a second settings row", () => {
    const db = freshDb();
    expect(() => db.prepare("INSERT INTO settings (id) VALUES (2)").run()).toThrow();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/domain/src/migrations/001-initial.test.ts`
Expected: FAIL — cannot resolve `./index.js`.

- [ ] **Step 3: Write the migration**

`packages/domain/src/migrations/001-initial.ts`:

```ts
import type { Migration } from "../migrate.js";
import { uuidv7 } from "../id.js";

/**
 * The entire POS schema, up front (spec §3). Money is INTEGER paise;
 * timestamps are INTEGER Unix ms written by app code. Table status is
 * derived from orders — deliberately no status column on dining_tables.
 */
export const migration001: Migration = {
  version: 1,
  name: "initial-schema",
  up(db) {
    db.exec(`
      CREATE TABLE users (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        pin_hash    TEXT NOT NULL,
        role        TEXT NOT NULL CHECK (role IN ('admin','cashier','waiter','kitchen')),
        is_active   INTEGER NOT NULL DEFAULT 1,
        created_at  INTEGER NOT NULL
      );

      CREATE TABLE sessions (
        token       TEXT PRIMARY KEY,
        user_id     TEXT NOT NULL REFERENCES users(id),
        created_at  INTEGER NOT NULL,
        expires_at  INTEGER NOT NULL,
        device      TEXT
      );
      CREATE INDEX idx_sessions_expires ON sessions(expires_at);

      CREATE TABLE settings (
        id               INTEGER PRIMARY KEY CHECK (id = 1),
        restaurant_name  TEXT NOT NULL DEFAULT '',
        address          TEXT NOT NULL DEFAULT '',
        gstin            TEXT NOT NULL DEFAULT '',
        fssai            TEXT NOT NULL DEFAULT '',
        receipt_footer   TEXT NOT NULL DEFAULT '',
        setup_complete   INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE printers (
        id           TEXT PRIMARY KEY,
        name         TEXT NOT NULL,
        kind         TEXT NOT NULL CHECK (kind IN ('network','windows')),
        connection   TEXT NOT NULL,
        paper_width  INTEGER NOT NULL DEFAULT 80 CHECK (paper_width IN (58, 80)),
        is_active    INTEGER NOT NULL DEFAULT 1
      );

      CREATE TABLE kot_stations (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        printer_id  TEXT REFERENCES printers(id),
        is_active   INTEGER NOT NULL DEFAULT 1
      );

      CREATE TABLE categories (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        sort_order  INTEGER NOT NULL DEFAULT 0,
        is_active   INTEGER NOT NULL DEFAULT 1
      );

      CREATE TABLE products (
        id              TEXT PRIMARY KEY,
        category_id     TEXT NOT NULL REFERENCES categories(id),
        name            TEXT NOT NULL,
        price_paise     INTEGER NOT NULL CHECK (price_paise >= 0),
        gst_rate        REAL NOT NULL CHECK (gst_rate >= 0),
        is_veg          INTEGER NOT NULL DEFAULT 1,
        kot_station_id  TEXT REFERENCES kot_stations(id),
        is_active       INTEGER NOT NULL DEFAULT 1,
        created_at      INTEGER NOT NULL
      );

      CREATE TABLE variants (
        id           TEXT PRIMARY KEY,
        product_id   TEXT NOT NULL REFERENCES products(id),
        name         TEXT NOT NULL,
        price_paise  INTEGER NOT NULL CHECK (price_paise >= 0),
        is_active    INTEGER NOT NULL DEFAULT 1
      );

      CREATE TABLE dining_tables (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        area        TEXT,
        sort_order  INTEGER NOT NULL DEFAULT 0,
        is_active   INTEGER NOT NULL DEFAULT 1
      );

      CREATE TABLE orders (
        id          TEXT PRIMARY KEY,
        client_ref  TEXT NOT NULL UNIQUE,
        type        TEXT NOT NULL CHECK (type IN ('dine_in','parcel')),
        table_id    TEXT REFERENCES dining_tables(id),
        status      TEXT NOT NULL DEFAULT 'open'
                    CHECK (status IN ('open','billed','settled','cancelled')),
        opened_by   TEXT NOT NULL REFERENCES users(id),
        opened_at   INTEGER NOT NULL,
        closed_at   INTEGER
      );
      CREATE INDEX idx_orders_status ON orders(status);
      CREATE INDEX idx_orders_table ON orders(table_id);

      CREATE TABLE kots (
        id          TEXT PRIMARY KEY,
        order_id    TEXT NOT NULL REFERENCES orders(id),
        kot_no      INTEGER NOT NULL,
        station_id  TEXT NOT NULL REFERENCES kot_stations(id),
        created_at  INTEGER NOT NULL,
        created_by  TEXT NOT NULL REFERENCES users(id)
      );
      CREATE INDEX idx_kots_order ON kots(order_id);

      CREATE TABLE order_items (
        id                   TEXT PRIMARY KEY,
        order_id             TEXT NOT NULL REFERENCES orders(id),
        product_id           TEXT NOT NULL REFERENCES products(id),
        variant_id           TEXT REFERENCES variants(id),
        name_snapshot        TEXT NOT NULL,
        price_paise_snapshot INTEGER NOT NULL,
        gst_rate_snapshot    REAL NOT NULL,
        qty                  INTEGER NOT NULL CHECK (qty > 0),
        status               TEXT NOT NULL DEFAULT 'pending'
                             CHECK (status IN ('pending','sent','cancelled')),
        kot_id               TEXT REFERENCES kots(id),
        note                 TEXT,
        cancel_reason        TEXT,
        cancelled_by         TEXT REFERENCES users(id)
      );
      CREATE INDEX idx_order_items_order ON order_items(order_id);

      CREATE TABLE bills (
        id              TEXT PRIMARY KEY,
        bill_no         INTEGER NOT NULL UNIQUE,
        order_id        TEXT NOT NULL UNIQUE REFERENCES orders(id),
        subtotal_paise  INTEGER NOT NULL,
        discount_paise  INTEGER NOT NULL DEFAULT 0,
        discount_note   TEXT,
        cgst_paise      INTEGER NOT NULL,
        sgst_paise      INTEGER NOT NULL,
        rounding_paise  INTEGER NOT NULL DEFAULT 0,
        total_paise     INTEGER NOT NULL,
        status          TEXT NOT NULL DEFAULT 'unpaid'
                        CHECK (status IN ('unpaid','paid','void')),
        void_reason     TEXT,
        created_at      INTEGER NOT NULL,
        created_by      TEXT NOT NULL REFERENCES users(id)
      );

      CREATE TABLE bill_taxes (
        id             TEXT PRIMARY KEY,
        bill_id        TEXT NOT NULL REFERENCES bills(id),
        gst_rate       REAL NOT NULL,
        taxable_paise  INTEGER NOT NULL,
        cgst_paise     INTEGER NOT NULL,
        sgst_paise     INTEGER NOT NULL
      );
      CREATE INDEX idx_bill_taxes_bill ON bill_taxes(bill_id);

      CREATE TABLE payments (
        id           TEXT PRIMARY KEY,
        bill_id      TEXT NOT NULL REFERENCES bills(id),
        mode         TEXT NOT NULL CHECK (mode IN ('cash','upi','card')),
        amount_paise INTEGER NOT NULL CHECK (amount_paise > 0),
        ref_note     TEXT,
        created_at   INTEGER NOT NULL
      );
      CREATE INDEX idx_payments_bill ON payments(bill_id);

      CREATE TABLE stock_items (
        id                   TEXT PRIMARY KEY,
        name                 TEXT NOT NULL,
        unit                 TEXT NOT NULL CHECK (unit IN ('pcs','kg','g','L','ml')),
        qty                  REAL NOT NULL DEFAULT 0,
        low_stock_threshold  REAL,
        is_active            INTEGER NOT NULL DEFAULT 1
      );

      CREATE TABLE product_stock_links (
        id             TEXT PRIMARY KEY,
        product_id     TEXT NOT NULL REFERENCES products(id),
        stock_item_id  TEXT NOT NULL REFERENCES stock_items(id),
        qty_per_sale   REAL NOT NULL DEFAULT 1,
        UNIQUE (product_id, stock_item_id)
      );

      CREATE TABLE stock_moves (
        id             TEXT PRIMARY KEY,
        stock_item_id  TEXT NOT NULL REFERENCES stock_items(id),
        delta          REAL NOT NULL,
        reason         TEXT NOT NULL
                       CHECK (reason IN ('sale','purchase','adjustment','wastage','cancel_reversal')),
        ref            TEXT,
        note           TEXT,
        created_at     INTEGER NOT NULL,
        created_by     TEXT REFERENCES users(id)
      );
      CREATE INDEX idx_stock_moves_item ON stock_moves(stock_item_id);

      CREATE TABLE sequences (
        name   TEXT PRIMARY KEY,
        value  INTEGER NOT NULL
      );
    `);

    db.prepare("INSERT INTO settings (id) VALUES (1)").run();
    db.prepare("INSERT INTO kot_stations (id, name) VALUES (?, 'Kitchen')").run(uuidv7());
    db.prepare("INSERT INTO sequences (name, value) VALUES ('bill_no', 0)").run();
  },
};
```

`packages/domain/src/migrations/index.ts`:

```ts
import type { Migration } from "../migrate.js";
import { migration001 } from "./001-initial.js";

export const MIGRATIONS: Migration[] = [migration001];
```

Append to `packages/domain/src/index.ts`:

```ts
export { MIGRATIONS } from "./migrations/index.js";
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run packages/domain/src/migrations/001-initial.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/domain
git commit -m "feat(domain): migration 001 — full POS schema with seeds"
```

---

### Task 5: Domain — role definitions + auth request schemas

**Files:**
- Create: `packages/domain/src/roles.ts`, `packages/domain/src/auth-schemas.ts`
- Test: `packages/domain/src/roles.test.ts`
- Modify: `packages/domain/src/index.ts`, `packages/domain/package.json` (zod dep)

**Interfaces:**
- Consumes: `Role`, `can` from `@forkflow/core` (exists: `can(role, "orders.create")`, supports `"orders.*"` and `"*"`).
- Produces:
  - `type RoleName = "admin" | "cashier" | "waiter" | "kitchen"`
  - `roleFor(name: RoleName): Role`
  - `LoginBody` / `SetupBody` zod schemas (and inferred types `LoginInput`, `SetupInput`).

- [ ] **Step 1: Install zod**

```bash
npm i zod -w @forkflow/domain
```

- [ ] **Step 2: Write the failing test**

`packages/domain/src/roles.test.ts`:

```ts
import { can } from "@forkflow/core";
import { describe, expect, it } from "vitest";
import { roleFor } from "./roles.js";

describe("roleFor", () => {
  it("admin can do everything", () => {
    expect(can(roleFor("admin"), "users.manage")).toBe(true);
    expect(can(roleFor("admin"), "bills.void")).toBe(true);
  });

  it("waiter can take orders and send KOTs but cannot bill or manage", () => {
    const waiter = roleFor("waiter");
    expect(can(waiter, "orders.create")).toBe(true);
    expect(can(waiter, "kots.create")).toBe(true);
    expect(can(waiter, "catalog.read")).toBe(true);
    expect(can(waiter, "bills.create")).toBe(false);
    expect(can(waiter, "users.manage")).toBe(false);
  });

  it("cashier can bill and settle but not manage users or settings", () => {
    const cashier = roleFor("cashier");
    expect(can(cashier, "bills.create")).toBe(true);
    expect(can(cashier, "bills.settle")).toBe(true);
    expect(can(cashier, "orders.create")).toBe(true);
    expect(can(cashier, "users.manage")).toBe(false);
    expect(can(cashier, "settings.manage")).toBe(false);
  });

  it("kitchen can only read and update KOTs", () => {
    const kitchen = roleFor("kitchen");
    expect(can(kitchen, "kots.read")).toBe(true);
    expect(can(kitchen, "kots.update")).toBe(true);
    expect(can(kitchen, "orders.create")).toBe(false);
    expect(can(kitchen, "bills.create")).toBe(false);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run packages/domain/src/roles.test.ts`
Expected: FAIL — cannot resolve `./roles.js`.

- [ ] **Step 4: Implement roles and schemas**

`packages/domain/src/roles.ts`:

```ts
import type { Role } from "@forkflow/core";

export type RoleName = "admin" | "cashier" | "waiter" | "kitchen";

/**
 * Permission namespaces (fixed vocabulary for the whole app):
 * orders, kots, bills, tables, catalog, stock, users, settings, reports, printers.
 * Roles are code, not data — a restaurant picks a role per staff member and
 * that's the whole model (spec: fewer things to learn).
 */
const ROLES: Record<RoleName, Role> = {
  admin: { name: "admin", permissions: ["*"] },
  cashier: {
    name: "cashier",
    permissions: [
      "orders.*", "kots.*", "bills.*", "tables.read",
      "catalog.read", "stock.read", "reports.read",
    ],
    limits: { max_discount_percent: 10 },
  },
  waiter: {
    name: "waiter",
    permissions: ["orders.create", "orders.update", "orders.read", "kots.create", "kots.read", "tables.read", "catalog.read"],
  },
  kitchen: {
    name: "kitchen",
    permissions: ["kots.read", "kots.update"],
  },
};

export function roleFor(name: RoleName): Role {
  return ROLES[name];
}
```

`packages/domain/src/auth-schemas.ts`:

```ts
import { z } from "zod";

export const PIN = z.string().regex(/^\d{4,6}$/, "PIN must be 4-6 digits");

export const LoginBody = z.object({ pin: PIN });
export type LoginInput = z.infer<typeof LoginBody>;

export const SetupBody = z.object({
  restaurantName: z.string().trim().min(1),
  adminName: z.string().trim().min(1),
  pin: PIN,
});
export type SetupInput = z.infer<typeof SetupBody>;
```

Append to `packages/domain/src/index.ts`:

```ts
export { roleFor, type RoleName } from "./roles.js";
export { LoginBody, SetupBody, PIN, type LoginInput, type SetupInput } from "./auth-schemas.js";
```

- [ ] **Step 5: Run tests + typecheck, then commit**

```bash
npx vitest run packages/domain
npm run typecheck
git add packages/domain
git commit -m "feat(domain): role permission map + auth request schemas"
```

---

### Task 6: Server — buildServer skeleton with /api/health

**Files:**
- Create: `apps/server/package.json`, `apps/server/src/server.ts`, `apps/server/src/main.ts`
- Test: `apps/server/src/server.test.ts`

**Interfaces:**
- Consumes: `openDb`, `migrate`, `MIGRATIONS` from `@forkflow/domain`.
- Produces:
  - `buildServer(opts: { db: Database }): FastifyInstance` — routes registered, **not** listening; tests use `app.inject()`.
  - `GET /api/health` → `200 {"ok":true}`.
  - `main.ts` — real entrypoint: opens `$FORKFLOW_DATA_DIR/forkflow.db` (default `./data`), migrates, listens on `0.0.0.0:4100`, serves `apps/ui/dist` if present.

- [ ] **Step 1: Create the workspace and install deps**

`apps/server/package.json`:

```json
{
  "name": "@forkflow/server",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "description": "The POS server: single SQLite writer, REST + static hosting for LAN clients.",
  "exports": {
    ".": "./src/server.ts"
  },
  "dependencies": {
    "@forkflow/core": "*",
    "@forkflow/domain": "*"
  }
}
```

```bash
npm install
npm i fastify @fastify/static zod -w @forkflow/server
```

(No new tsconfig paths or vitest aliases are needed: server tests import `./server.js` relatively, and the `@forkflow/domain` / `@forkflow/core` aliases already exist from Task 2.)

- [ ] **Step 2: Write the failing test**

`apps/server/src/server.test.ts`:

```ts
import { MIGRATIONS, migrate, openDb } from "@forkflow/domain";
import { afterEach, describe, expect, it } from "vitest";
import { buildServer } from "./server.js";

export function testDb() {
  const db = openDb(":memory:");
  migrate(db, MIGRATIONS);
  return db;
}

let app: Awaited<ReturnType<typeof buildServer>>;
afterEach(async () => {
  await app?.close();
});

describe("GET /api/health", () => {
  it("returns ok", async () => {
    app = buildServer({ db: testDb() });
    const res = await app.inject({ method: "GET", url: "/api/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run apps/server/src/server.test.ts`
Expected: FAIL — cannot resolve `./server.js`.

- [ ] **Step 4: Implement server.ts and main.ts**

`apps/server/src/server.ts`:

```ts
import type { Database } from "@forkflow/domain";
import Fastify, { type FastifyInstance } from "fastify";
import { ZodError } from "zod";

export interface ServerOptions {
  db: Database;
}

export function buildServer(opts: ServerOptions): FastifyInstance {
  const app = Fastify({ logger: false });

  app.decorate("db", opts.db);

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ZodError) {
      return reply.status(400).send({ error: "validation", issues: err.issues });
    }
    app.log.error(err);
    const status = "statusCode" in err && typeof err.statusCode === "number" ? err.statusCode : 500;
    return reply.status(status).send({ error: err.message });
  });

  app.get("/api/health", async () => ({ ok: true }));

  return app;
}

declare module "fastify" {
  interface FastifyInstance {
    db: Database;
  }
}
```

`apps/server/src/main.ts`:

```ts
import { MIGRATIONS, migrate, openDb } from "@forkflow/domain";
import fastifyStatic from "@fastify/static";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildServer } from "./server.js";

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = resolve(process.env["FORKFLOW_DATA_DIR"] ?? "./data");
mkdirSync(dataDir, { recursive: true });

const db = openDb(join(dataDir, "forkflow.db"));
migrate(db, MIGRATIONS);

const app = buildServer({ db });

// Serve the built UI when it exists (production / packaged). In dev, Vite serves the UI.
const uiDist = resolve(here, "../../ui/dist");
if (existsSync(uiDist)) {
  await app.register(fastifyStatic, { root: uiDist, wildcard: false });
  app.setNotFoundHandler((req, reply) => {
    if (req.method === "GET" && !req.url.startsWith("/api/")) {
      return reply.sendFile("index.html");
    }
    return reply.status(404).send({ error: "not found" });
  });
}

const PORT = Number(process.env["FORKFLOW_PORT"] ?? 4100);
await app.listen({ host: "0.0.0.0", port: PORT });
console.log(`ForkFlow server on http://localhost:${PORT} (db: ${join(dataDir, "forkflow.db")})`);
```

- [ ] **Step 5: Run test + typecheck to verify**

```bash
npx vitest run apps/server/src/server.test.ts
npm run typecheck
```

Expected: PASS; typecheck clean.

- [ ] **Step 6: Smoke-run the real entrypoint**

```bash
npx tsx apps/server/src/main.ts &
sleep 2 && curl -s http://localhost:4100/api/health
kill %1
```

Expected output: `{"ok":true}`. A `data/forkflow.db` file appears (gitignored via `*.db`).

- [ ] **Step 7: Commit**

```bash
git add apps/server vitest.config.ts tsconfig.json package-lock.json
git commit -m "feat(server): Fastify skeleton — buildServer, /api/health, entrypoint with migrations and static hosting"
```

---

### Task 7: Server — PIN auth (setup, login, me, logout) + permission guard

**Files:**
- Create: `apps/server/src/auth.ts`
- Test: `apps/server/src/auth.test.ts`
- Modify: `apps/server/src/server.ts` (register plugin)

**Interfaces:**
- Consumes: `hashPassword`, `verifyPassword`, `can` (`@forkflow/core`); `uuidv7`, `roleFor`, `LoginBody`, `SetupBody`, `RoleName` (`@forkflow/domain`); `app.db`.
- Produces (later milestones depend on these exactly):
  - `GET /api/needs-setup` → `{ needsSetup: boolean }` (public)
  - `POST /api/setup` `{ restaurantName, adminName, pin }` → `201 { token, user }`; `409` if any user exists
  - `POST /api/login` `{ pin }` → `{ token, user: { id, name, role } }`; `401` on bad PIN
  - `GET /api/me` → `{ user }` (authed)
  - `POST /api/logout` → `204` (authed)
  - `app.requireAuth` — preHandler; sets `request.user = { id, name, role }`
  - `app.requirePermission(slug: string)` — preHandler factory; 401 unauthenticated, 403 unauthorized
  - Sessions live 24h; tokens are 64-hex-char `randomBytes(32)`.

- [ ] **Step 1: Write the failing test**

`apps/server/src/auth.test.ts`:

```ts
import { MIGRATIONS, migrate, openDb } from "@forkflow/domain";
import { afterEach, describe, expect, it } from "vitest";
import { buildServer } from "./server.js";

function freshApp() {
  const db = openDb(":memory:");
  migrate(db, MIGRATIONS);
  return buildServer({ db });
}

const SETUP = { restaurantName: "Cafe Test", adminName: "Asha", pin: "1234" };

let app: ReturnType<typeof freshApp>;
afterEach(async () => {
  await app?.close();
});

async function setup(a: typeof app) {
  const res = await a.inject({ method: "POST", url: "/api/setup", payload: SETUP });
  return res.json() as { token: string; user: { id: string; name: string; role: string } };
}

describe("first-run setup", () => {
  it("needs-setup flips after setup creates the admin", async () => {
    app = freshApp();
    expect((await app.inject({ method: "GET", url: "/api/needs-setup" })).json()).toEqual({ needsSetup: true });

    const res = await app.inject({ method: "POST", url: "/api/setup", payload: SETUP });
    expect(res.statusCode).toBe(201);
    expect(res.json().user.role).toBe("admin");

    expect((await app.inject({ method: "GET", url: "/api/needs-setup" })).json()).toEqual({ needsSetup: false });
  });

  it("rejects a second setup", async () => {
    app = freshApp();
    await setup(app);
    const again = await app.inject({ method: "POST", url: "/api/setup", payload: SETUP });
    expect(again.statusCode).toBe(409);
  });

  it("rejects a malformed PIN", async () => {
    app = freshApp();
    const res = await app.inject({ method: "POST", url: "/api/setup", payload: { ...SETUP, pin: "12" } });
    expect(res.statusCode).toBe(400);
  });
});

describe("login / me / logout", () => {
  it("full round trip", async () => {
    app = freshApp();
    await setup(app);

    const bad = await app.inject({ method: "POST", url: "/api/login", payload: { pin: "9999" } });
    expect(bad.statusCode).toBe(401);

    const good = await app.inject({ method: "POST", url: "/api/login", payload: { pin: "1234" } });
    expect(good.statusCode).toBe(200);
    const { token, user } = good.json();
    expect(user.name).toBe("Asha");

    const me = await app.inject({
      method: "GET", url: "/api/me",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json().user.id).toBe(user.id);

    const out = await app.inject({
      method: "POST", url: "/api/logout",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(out.statusCode).toBe(204);

    const meAfter = await app.inject({
      method: "GET", url: "/api/me",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(meAfter.statusCode).toBe(401);
  });

  it("rejects missing/garbage tokens", async () => {
    app = freshApp();
    expect((await app.inject({ method: "GET", url: "/api/me" })).statusCode).toBe(401);
    expect(
      (await app.inject({ method: "GET", url: "/api/me", headers: { authorization: "Bearer nope" } })).statusCode,
    ).toBe(401);
  });
});

describe("requirePermission", () => {
  it("admin passes, waiter is 403", async () => {
    app = freshApp();
    // a scratch admin-gated route, registered before ready()
    app.get("/api/_test-admin", { preHandler: app.requirePermission("users.manage") }, async () => ({ ok: true }));

    const admin = await setup(app);

    // create a waiter directly in the DB (user CRUD endpoints arrive in Milestone 2)
    const { hashPassword } = await import("@forkflow/core");
    const { uuidv7 } = await import("@forkflow/domain");
    app.db
      .prepare("INSERT INTO users (id, name, pin_hash, role, created_at) VALUES (?, 'Wren', ?, 'waiter', ?)")
      .run(uuidv7(), await hashPassword("5678"), Date.now());
    const waiter = (await app.inject({ method: "POST", url: "/api/login", payload: { pin: "5678" } })).json();

    const okRes = await app.inject({
      method: "GET", url: "/api/_test-admin",
      headers: { authorization: `Bearer ${admin.token}` },
    });
    expect(okRes.statusCode).toBe(200);

    const forbidden = await app.inject({
      method: "GET", url: "/api/_test-admin",
      headers: { authorization: `Bearer ${waiter.token}` },
    });
    expect(forbidden.statusCode).toBe(403);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run apps/server/src/auth.test.ts`
Expected: FAIL — `app.requirePermission is not a function` / 404s on auth routes.

- [ ] **Step 3: Implement the auth plugin**

`apps/server/src/auth.ts`:

```ts
import { hashPassword, verifyPassword, can } from "@forkflow/core";
import { LoginBody, SetupBody, roleFor, uuidv7, type RoleName } from "@forkflow/domain";
import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerHookHandler } from "fastify";
import { randomBytes } from "node:crypto";

const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

export interface AuthedUser {
  id: string;
  name: string;
  role: RoleName;
}

interface SessionRow {
  user_id: string;
  expires_at: number;
  name: string;
  role: RoleName;
  is_active: number;
}

export function registerAuth(app: FastifyInstance): void {
  const createSession = (userId: string): string => {
    const token = randomBytes(32).toString("hex");
    const now = Date.now();
    // opportunistic housekeeping: drop expired sessions on each new login
    app.db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(now);
    app.db
      .prepare("INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)")
      .run(token, userId, now, now + SESSION_TTL_MS);
    return token;
  };

  const userForToken = (header: string | undefined): AuthedUser | null => {
    if (!header?.startsWith("Bearer ")) return null;
    const token = header.slice("Bearer ".length);
    const row = app.db
      .prepare(
        `SELECT s.user_id, s.expires_at, u.name, u.role, u.is_active
         FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.token = ?`,
      )
      .get(token) as SessionRow | undefined;
    if (!row || row.expires_at < Date.now() || !row.is_active) return null;
    return { id: row.user_id, name: row.name, role: row.role };
  };

  const requireAuth: preHandlerHookHandler = async (req: FastifyRequest, reply: FastifyReply) => {
    const user = userForToken(req.headers.authorization);
    if (!user) return reply.status(401).send({ error: "unauthenticated" });
    req.user = user;
  };

  app.decorate("requireAuth", requireAuth);
  app.decorate("requirePermission", (slug: string): preHandlerHookHandler => {
    return async (req, reply) => {
      const user = userForToken(req.headers.authorization);
      if (!user) return reply.status(401).send({ error: "unauthenticated" });
      if (!can(roleFor(user.role), slug)) {
        return reply.status(403).send({ error: "forbidden", permission: slug });
      }
      req.user = user;
    };
  });

  app.get("/api/needs-setup", async () => {
    const row = app.db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number };
    return { needsSetup: row.n === 0 };
  });

  app.post("/api/setup", async (req, reply) => {
    const body = SetupBody.parse(req.body);
    const existing = app.db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number };
    if (existing.n > 0) return reply.status(409).send({ error: "already set up" });

    const id = uuidv7();
    const pinHash = await hashPassword(body.pin);
    const write = app.db.transaction(() => {
      app.db
        .prepare("INSERT INTO users (id, name, pin_hash, role, created_at) VALUES (?, ?, ?, 'admin', ?)")
        .run(id, body.adminName, pinHash, Date.now());
      app.db
        .prepare("UPDATE settings SET restaurant_name = ?, setup_complete = 1 WHERE id = 1")
        .run(body.restaurantName);
    });
    write();

    const token = createSession(id);
    return reply.status(201).send({ token, user: { id, name: body.adminName, role: "admin" } });
  });

  app.post("/api/login", async (req, reply) => {
    const { pin } = LoginBody.parse(req.body);
    const users = app.db
      .prepare("SELECT id, name, pin_hash, role FROM users WHERE is_active = 1")
      .all() as Array<{ id: string; name: string; pin_hash: string; role: RoleName }>;

    // PIN alone identifies the user (POS convention). PINs are enforced unique
    // among active users at creation time, so at most one row can match.
    for (const u of users) {
      if (await verifyPassword(pin, u.pin_hash)) {
        const token = createSession(u.id);
        return { token, user: { id: u.id, name: u.name, role: u.role } };
      }
    }
    return reply.status(401).send({ error: "invalid pin" });
  });

  app.get("/api/me", { preHandler: requireAuth }, async (req) => ({ user: req.user }));

  app.post("/api/logout", { preHandler: requireAuth }, async (req, reply) => {
    const token = (req.headers.authorization ?? "").slice("Bearer ".length);
    app.db.prepare("DELETE FROM sessions WHERE token = ?").run(token);
    return reply.status(204).send();
  });
}

declare module "fastify" {
  interface FastifyInstance {
    requireAuth: preHandlerHookHandler;
    requirePermission(slug: string): preHandlerHookHandler;
  }
  interface FastifyRequest {
    user: AuthedUser;
  }
}
```

Modify `apps/server/src/server.ts` — import and register inside `buildServer` after the error handler:

```ts
import { registerAuth } from "./auth.js";
// ... inside buildServer, after app.setErrorHandler(...):
  registerAuth(app);
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run apps/server`
Expected: PASS (health + all auth tests).

- [ ] **Step 5: Run the full suite + typecheck, commit**

```bash
npm test
npm run typecheck
git add apps/server
git commit -m "feat(server): PIN auth — setup/login/me/logout, session tokens, permission guard"
```

---

### Task 8: UI — Vite React app with setup/login/home screens

**Files:**
- Create: `apps/ui/package.json`, `apps/ui/tsconfig.json`, `apps/ui/vite.config.ts`, `apps/ui/index.html`, `apps/ui/src/main.tsx`, `apps/ui/src/App.tsx`, `apps/ui/src/api.ts`, `apps/ui/src/screens/Login.tsx`, `apps/ui/src/screens/Setup.tsx`, `apps/ui/src/screens/Home.tsx`
- Modify: root `tsconfig.json` (exclude apps/ui), root `package.json` (typecheck + dev scripts)

**Interfaces:**
- Consumes: the Task 7 API exactly (`/api/needs-setup`, `/api/setup`, `/api/login`, `/api/me`, `/api/logout`).
- Produces: `apps/ui/dist` (via `npm run build -w @forkflow/ui`) that `apps/server/src/main.ts` already serves; `api.ts` exports `apiFetch(path, init?)` and `session` helpers reused by every later screen.

- [ ] **Step 1: Scaffold the workspace**

`apps/ui/package.json`:

```json
{
  "name": "@forkflow/ui",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "description": "The POS web UI — served by the server to the Electron window and every LAN browser.",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "typecheck": "tsc --noEmit"
  }
}
```

```bash
npm install
npm i react react-dom -w @forkflow/ui
npm i -D vite @vitejs/plugin-react @types/react @types/react-dom -w @forkflow/ui
```

`apps/ui/tsconfig.json` (standalone — DOM lib and JSX, which the Node-flavored root config must not see):

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "composite": false,
    "declaration": false,
    "declarationMap": false,
    "noEmit": true,
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2023", "DOM", "DOM.Iterable"],
    "jsx": "react-jsx",
    "types": ["vite/client"]
  },
  "include": ["src", "vite.config.ts"]
}
```

`apps/ui/vite.config.ts`:

```ts
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: { "/api": "http://localhost:4100" },
  },
});
```

`apps/ui/index.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>ForkFlow POS</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

Root `tsconfig.json` — add (UI has its own config; the root one lacks DOM types):

```json
  "exclude": ["apps/ui"]
```

Root `package.json` scripts — replace `"typecheck"` and add dev helpers:

```json
    "typecheck": "tsc --noEmit && npm run typecheck -w @forkflow/ui",
    "dev:server": "tsx watch apps/server/src/main.ts",
    "dev:ui": "npm run dev -w @forkflow/ui"
```

- [ ] **Step 2: Implement the API helper and screens**

> **Import-style exception:** `apps/ui` uses Vite's `bundler` module resolution, so relative imports here are **extensionless** (`./api`, `./screens/Home`). The `.js`-suffix rule in Global Constraints applies only to the NodeNext packages (domain/server/desktop/core).

`apps/ui/src/api.ts`:

```ts
const TOKEN_KEY = "forkflow.token";

export const session = {
  get token(): string | null {
    return localStorage.getItem(TOKEN_KEY);
  },
  set(token: string) {
    localStorage.setItem(TOKEN_KEY, token);
  },
  clear() {
    localStorage.removeItem(TOKEN_KEY);
  },
};

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/** fetch with the session token attached; clears the session on a 401. */
export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  headers.set("content-type", "application/json");
  const token = session.token;
  if (token) headers.set("authorization", `Bearer ${token}`);

  const res = await fetch(path, { ...init, headers });
  if (res.status === 401) session.clear();
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new ApiError(res.status, body.error ?? res.statusText);
  }
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
}

export interface User {
  id: string;
  name: string;
  role: "admin" | "cashier" | "waiter" | "kitchen";
}
```

`apps/ui/src/screens/Login.tsx` — touch-first PIN pad:

```tsx
import { useState } from "react";
import { ApiError, apiFetch, session, type User } from "../api";

export function Login({ onLogin }: { onLogin: (user: User) => void }) {
  const [pin, setPin] = useState("");
  const [error, setError] = useState("");

  async function submit(candidate: string) {
    try {
      const { token, user } = await apiFetch<{ token: string; user: User }>("/api/login", {
        method: "POST",
        body: JSON.stringify({ pin: candidate }),
      });
      session.set(token);
      onLogin(user);
    } catch (e) {
      setError(e instanceof ApiError && e.status === 401 ? "Wrong PIN" : "Server unreachable");
      setPin("");
    }
  }

  function press(digit: string) {
    setError("");
    const next = pin + digit;
    setPin(next);
    if (next.length === 6) void submit(next);
  }

  return (
    <div style={{ maxWidth: 280, margin: "10vh auto", textAlign: "center", fontFamily: "system-ui" }}>
      <h1>ForkFlow</h1>
      <div style={{ fontSize: 32, letterSpacing: 8, minHeight: 44 }}>{"•".repeat(pin.length)}</div>
      <div style={{ color: "crimson", minHeight: 24 }}>{error}</div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8 }}>
        {["1", "2", "3", "4", "5", "6", "7", "8", "9", "⌫", "0", "OK"].map((key) => (
          <button
            key={key}
            style={{ padding: "18px 0", fontSize: 22 }}
            onClick={() => {
              if (key === "⌫") setPin((p) => p.slice(0, -1));
              else if (key === "OK") void submit(pin);
              else press(key);
            }}
          >
            {key}
          </button>
        ))}
      </div>
    </div>
  );
}
```

`apps/ui/src/screens/Setup.tsx`:

```tsx
import { useState, type FormEvent } from "react";
import { apiFetch, session, type User } from "../api";

export function Setup({ onDone }: { onDone: (user: User) => void }) {
  const [restaurantName, setRestaurantName] = useState("");
  const [adminName, setAdminName] = useState("");
  const [pin, setPin] = useState("");
  const [error, setError] = useState("");

  async function submit(e: FormEvent) {
    e.preventDefault();
    try {
      const { token, user } = await apiFetch<{ token: string; user: User }>("/api/setup", {
        method: "POST",
        body: JSON.stringify({ restaurantName, adminName, pin }),
      });
      session.set(token);
      onDone(user);
    } catch {
      setError("Setup failed — check the fields (PIN must be 4-6 digits)");
    }
  }

  return (
    <form onSubmit={submit} style={{ maxWidth: 320, margin: "10vh auto", display: "grid", gap: 12, fontFamily: "system-ui" }}>
      <h1>Set up ForkFlow</h1>
      <input placeholder="Restaurant name" value={restaurantName} onChange={(e) => setRestaurantName(e.target.value)} />
      <input placeholder="Your name (admin)" value={adminName} onChange={(e) => setAdminName(e.target.value)} />
      <input placeholder="Admin PIN (4-6 digits)" value={pin} inputMode="numeric" onChange={(e) => setPin(e.target.value)} />
      <button type="submit" style={{ padding: 12 }}>Start</button>
      <div style={{ color: "crimson" }}>{error}</div>
    </form>
  );
}
```

`apps/ui/src/screens/Home.tsx`:

```tsx
import { apiFetch, session, type User } from "../api";

export function Home({ user, onLogout }: { user: User; onLogout: () => void }) {
  async function logout() {
    try {
      await apiFetch<void>("/api/logout", { method: "POST" });
    } finally {
      session.clear();
      onLogout();
    }
  }

  return (
    <div style={{ maxWidth: 480, margin: "10vh auto", textAlign: "center", fontFamily: "system-ui" }}>
      <h1>ForkFlow</h1>
      <p>
        Signed in as <strong>{user.name}</strong> ({user.role})
      </p>
      <p>Milestone 1 foundation — modules arrive in Milestones 2-5.</p>
      <button onClick={() => void logout()} style={{ padding: 12 }}>Log out</button>
    </div>
  );
}
```

`apps/ui/src/App.tsx`:

```tsx
import { useEffect, useState } from "react";
import { apiFetch, session, type User } from "./api";
import { Home } from "./screens/Home";
import { Login } from "./screens/Login";
import { Setup } from "./screens/Setup";

type State =
  | { kind: "loading" }
  | { kind: "setup" }
  | { kind: "login" }
  | { kind: "home"; user: User };

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
            return setState({ kind: "home", user });
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
      return <Setup onDone={(user) => setState({ kind: "home", user })} />;
    case "login":
      return <Login onLogin={(user) => setState({ kind: "home", user })} />;
    case "home":
      return <Home user={state.user} onLogout={() => setState({ kind: "login" })} />;
  }
}
```

`apps/ui/src/main.tsx`:

```tsx
import { createRoot } from "react-dom/client";
import { App } from "./App";

createRoot(document.getElementById("root")!).render(<App />);
```

- [ ] **Step 3: Typecheck and build**

```bash
npm run typecheck
npm run build -w @forkflow/ui
```

Expected: both clean; `apps/ui/dist/index.html` exists.

- [ ] **Step 4: Verify the full loop manually**

```bash
npx tsx apps/server/src/main.ts
```

Open `http://localhost:4100` in a browser (delete `data/forkflow.db` first if a previous smoke test created users):
1. Setup screen appears → fill in name/admin/PIN → lands on Home.
2. Log out → PIN pad → wrong PIN shows "Wrong PIN" → right PIN lands on Home.
3. Refresh — still signed in (token survives reload).

Stop the server. Report what you saw in the task summary — this is the milestone's user-visible proof.

- [ ] **Step 5: Commit**

```bash
git add apps/ui tsconfig.json package.json package-lock.json
git commit -m "feat(ui): React SPA — first-run setup, PIN pad login, session handling"
```

---

### Task 9: Desktop — Electron shell that boots server + window

Dev-mode shell: it spawns the server with the system Node (`node --import tsx`), so better-sqlite3 keeps its normal Node ABI and no electron-rebuild is needed yet. Packaging (Milestone 6) will revisit this with `utilityProcess` + a rebuild step — that trade-off is deliberate and documented here.

**Files:**
- Create: `apps/desktop/package.json`, `apps/desktop/tsconfig.json`, `apps/desktop/src/main.ts`
- Modify: root `package.json` (dev:desktop script)

**Interfaces:**
- Consumes: the server entrypoint path `apps/server/src/main.ts` and `GET /api/health`.
- Produces: `npm run dev:desktop` — builds UI, compiles the shell, launches Electron: server starts, window opens on `http://localhost:4100`, server is relaunched if it dies (max 5 times, exponential backoff), child is killed on quit.

- [ ] **Step 1: Scaffold the workspace**

`apps/desktop/package.json`:

```json
{
  "name": "@forkflow/desktop",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "description": "Thin Electron shell: supervises the server process and opens the POS window.",
  "main": "dist/main.js",
  "scripts": {
    "build": "tsc -p .",
    "start": "electron ."
  }
}
```

```bash
npm install
npm i -D electron -w @forkflow/desktop
```

`apps/desktop/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "composite": false,
    "declaration": false,
    "declarationMap": false,
    "outDir": "dist",
    "types": ["node"]
  },
  "include": ["src"]
}
```

Root `package.json` — add script:

```json
    "dev:desktop": "npm run build -w @forkflow/ui && npm run build -w @forkflow/desktop && npm run start -w @forkflow/desktop"
```

- [ ] **Step 2: Implement the shell**

`apps/desktop/src/main.ts`:

```ts
import { spawn, type ChildProcess } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BrowserWindow, app } from "electron";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
const SERVER_URL = "http://localhost:4100";
const MAX_RESTARTS = 5;

let server: ChildProcess | null = null;
let restarts = 0;
let quitting = false;

function startServer(): void {
  // Dev shell: system Node + tsx keeps better-sqlite3 on the Node ABI.
  // Milestone 6 packaging replaces this with utilityProcess + electron-rebuild.
  server = spawn("node", ["--import", "tsx", "apps/server/src/main.ts"], {
    cwd: repoRoot,
    stdio: "inherit",
    shell: false,
  });
  server.on("exit", (code) => {
    if (quitting) return;
    if (restarts >= MAX_RESTARTS) {
      console.error(`server exited (code ${code}) too many times; giving up`);
      app.quit();
      return;
    }
    const delay = 500 * 2 ** restarts;
    restarts += 1;
    console.error(`server exited (code ${code}); restarting in ${delay}ms`);
    setTimeout(startServer, delay);
  });
}

async function waitForHealth(timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${SERVER_URL}/api/health`);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("server did not become healthy in time");
}

app.whenReady().then(async () => {
  startServer();
  await waitForHealth();
  const win = new BrowserWindow({ width: 1280, height: 800, autoHideMenuBar: true });
  await win.loadURL(SERVER_URL);
});

app.on("before-quit", () => {
  quitting = true;
  server?.kill();
});

app.on("window-all-closed", () => {
  app.quit();
});
```

- [ ] **Step 3: Typecheck and launch**

```bash
npm run typecheck
npm run dev:desktop
```

Expected: an Electron window opens showing the ForkFlow login (or setup) screen; closing the window exits Electron *and* the server process (verify: `curl -s http://localhost:4100/api/health` fails afterward).

- [ ] **Step 4: Commit**

```bash
git add apps/desktop package.json package-lock.json
git commit -m "feat(desktop): Electron shell — supervises server child, opens POS window"
```

---

### Task 10: Dev ergonomics, README, final verification

**Files:**
- Modify: root `package.json` (dev script), `README.md` (rewrite)

**Interfaces:**
- Consumes: everything above.
- Produces: `npm run dev` for daily development; a README that describes the *current* system (the old one documents the retired sync architecture).

- [ ] **Step 1: Add a combined dev script**

```bash
npm i -D concurrently
```

Root `package.json` scripts — add:

```json
    "dev": "concurrently -k -n server,ui npm:dev:server npm:dev:ui"
```

Verify: `npm run dev` starts both; `http://localhost:5173` (Vite, proxying /api) shows the login screen with hot reload. Ctrl-C kills both.

- [ ] **Step 2: Rewrite README.md**

Replace the entire file with:

```markdown
# ForkFlow

A local-only desktop POS for restaurants. One Windows PC runs everything —
an Electron shell, a Fastify server, and a SQLite database. Extra billing
counters, waiter phones, and the kitchen display are just browsers pointed
at the server's LAN address. No cloud.

Spec: [`docs/superpowers/specs/2026-08-13-desktop-pos-design.md`](./docs/superpowers/specs/2026-08-13-desktop-pos-design.md)

## Status — Milestone 1 (Foundation)

Schema, migrations, PIN auth with roles, a login/setup UI, and the Electron
shell. Modules (catalog, tables/KOT, billing, inventory) land in Milestones 2-5.

## Develop

```bash
npm install
npm test              # vitest across all workspaces
npm run typecheck
npm run dev           # server (:4100) + Vite UI (:5173) with hot reload
npm run dev:desktop   # the real thing: Electron window + server + built UI
```

The database lives in `./data/forkflow.db` (override with FORKFLOW_DATA_DIR).
Delete it to re-run first-time setup.

## Layout

```
packages/
  core/     PIN hashing (scrypt) · RBAC permission checks
  domain/   SQLite schema + migrations · roles · request schemas · uuidv7
apps/
  server/   Fastify: REST API · static UI hosting · the only SQLite writer
  ui/       React SPA served to the Electron window and LAN browsers
  desktop/  Thin Electron shell: supervises the server, opens the window
```
```

- [ ] **Step 3: Full verification pass**

```bash
npm test
npm run typecheck
npm run build -w @forkflow/ui
```

Expected: all green. Then `npm run dev:desktop` one last time — setup/login works in the window.

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json README.md
git commit -m "chore: dev scripts + README for the local-only POS foundation"
```

---

## Plan Self-Review Notes

- Spec coverage for Milestone 1 (spec §9.1): prune ✅ (Tasks 1-2), domain schema + migrations ✅ (Tasks 3-4), Fastify skeleton ✅ (Task 6), PIN auth + roles ✅ (Tasks 5, 7), Electron shell boots server + window ✅ (Task 9). UI login screen (Task 8) is the minimum needed to prove auth end-to-end.
- Out of scope here, by design: WebSockets, printing, LAN connect screen, packaging/installer, backups (Milestones 3-6). `main.ts` binds 0.0.0.0 so LAN access already works for whoever types the URL.
- PIN uniqueness across active users is asserted as a convention in Task 7's login comment; the enforcement lands with user CRUD in Milestone 2 (documented there — Milestone 1 has only the setup-created admin plus test-seeded users).
