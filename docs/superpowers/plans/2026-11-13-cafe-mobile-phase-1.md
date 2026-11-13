# MasalaPOS Cafe Phase 1: Offline Billing Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task, inline, in one session. Do not use subagent-driven-development (see `CLAUDE.md`: tasks here build on each other). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A phone running MasalaPOS Cafe makes, takes payment for, prints and reports GST bills with no account and no internet.

**Architecture:** Bill arithmetic and receipt bytes come from the Windows POS's existing TypeScript, made safe to run on a phone. A new package, `packages/cafe-data`, owns the phone's SQLite schema and the bill flow behind a small synchronous `SqlDriver` interface, so it is tested in Node. A new Expo React Native app, `apps/cafe-android`, supplies the screens, an `expo-sqlite` driver and a small Kotlin printer module.

**Tech Stack:** TypeScript, zod 4, vitest 4, better-sqlite3 (tests only), Expo (current SDK, 58 when this was written) with Expo Router, expo-sqlite, expo-crypto, expo-dev-client, react-native-svg, Kotlin (Expo Modules API), Gradle with JDK 17+.

**Spec:** `docs/superpowers/specs/2026-11-13-cafe-mobile-design.md`. Read it first; this plan covers its "Phase 1 in detail" section only.

## Global Constraints

- Work only in the worktree `E:\Softwares\masalapos-cafe` on branch `feat/cafe-mobile`. Never edit the main checkout at `E:\Softwares\Restaurant Billing Software`.
- This session runs on Opus 5.5 and executes the plan inline. Do not switch models mid-session.
- Money is integer paise. Times are epoch milliseconds.
- Code the phone can reach never imports the `@masalapos/domain` root, `db.ts`, `better-sqlite3`, or any `node:` module. `tools/phone-safe-imports.test.ts` (Task 1) enforces this.
- The Windows POS must not change behaviour: its whole test suite passes after every task, and receipts for its bills print the same bytes as before.
- Application id `app.masalapos.cafe`, name `MasalaPOS Cafe`, Android only, English only, phone and tablet layouts, 58 mm and 80 mm paper.
- Touch targets are at least 48 dp.
- Install Expo packages with `npx expo install <name>` so versions match the SDK. Before using an Expo API, check the current docs (context7 library `/expo/expo`).
- This machine has no Android emulator. Steps marked **DEVICE** need a real phone over USB. If `adb devices` shows none, finish the rest of the task, list the pending check in the pickup note (Task 13), and tell the user.
- All code, wording and artwork in the app is our own. Nothing is copied from any other product.
- A test shown as a name with a comment is written in full, with exactly the assertions the comment states.
- Commit at the end of each task with the repo's style (`feat(cafe): ...`, `refactor(server): ...`). Do not push or open a PR unless the user asks.
- In Git Bash, prefix commands that pass `/path` arguments to node scripts with `MSYS_NO_PATHCONV=1`.

## Review Focus

Failure modes the spec implies but does not spell out. Each is pinned by a test in the task named.

1. **Paid is tapped twice.** One bill is created, not two. `createBill` takes a caller-made id and returns the existing bill for a repeat (Task 6).
2. **The app dies or a write fails halfway through saving a bill.** No partial bill, no consumed invoice number or token (Task 6).
3. **An item in the cart is deleted or marked unavailable before payment.** `createBill` refuses and names the line; the cart shows which one (Tasks 6 and 11).
4. **A discount equal to the whole bill.** A zero-total bill saves with no payments and prints (Task 6).
5. **Item names the printer cannot print** (Hindi, emoji). The slip still prints, with `?` for those characters, and the menu editor warns before saving (Tasks 3 and 10).

## File Structure

```
packages/domain/src/id.ts                  modify: random bytes from Web Crypto
packages/domain/package.json               modify: export ./id ./bill-print ./printer-schemas ./settings-schemas
packages/domain/src/billing.ts             modify: ReceiptSnapshot.token
tools/phone-safe-imports.test.ts           create: transitive import guard
packages/print/                            create: pure print code moved from apps/server/src/print
  src/index.ts bytes.ts escpos.ts profile.ts templates.ts upi.ts receipt.ts
  src/restaurant-receipt-style.ts render-bytes.ts  (+ the moved *.test.ts files)
apps/server/src/print/to-buffer.ts         create: Uint8Array -> Buffer at the server boundary
packages/cafe-data/                        create
  src/index.ts driver.ts migrate.ts migrations/index.ts migrations/001-initial.ts
  src/sequences.ts time.ts cafe.ts menu.ts bills.ts reports.ts printers.ts events.ts
  src/testing/sqlite-driver.ts             better-sqlite3 adapter, tests only
apps/cafe-android/                         create: Expo app
  app.json package.json tsconfig.json metro.config.js
  modules/printer/                         local Expo module (Kotlin)
  src/polyfills.ts money.ts
  src/db/expo-driver.ts src/db/provider.tsx
  src/theme/tokens.ts src/ui/*             shared components
  src/cart/cart-store.ts src/payment/tender.ts src/menu/printable.ts src/security/pin.ts
  src/print/print-queue.ts printer.ts day-summary-slip.ts test-slip.ts
  src/app/                                 Expo Router screens
tools/build-cafe-android.mjs               create
docs/operations/cafe-app.md                create
```

---

### Task 1: Workspace, phone-safe ids and the import guard

**Files:**
- Modify: `packages/domain/src/id.ts`, `packages/domain/package.json`
- Create: `tools/phone-safe-imports.test.ts`

**Interfaces:**
- Produces: subpath imports `@masalapos/domain/id` (`uuidv7`), `/bill-print`, `/printer-schemas`, `/settings-schemas`; the exported array `PHONE_ENTRIES` in the guard test, which later tasks extend.

- [ ] **Step 1: Install and record the baseline**

Run `npm ci` in the worktree, then `npm test` and `npm run typecheck`. Write down any failures that exist before your changes; "passes" in later steps means "no new failures".

- [ ] **Step 2: Write the guard test** at `tools/phone-safe-imports.test.ts`

```ts
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { workspaceExports } from "./workspace-exports.mjs";

const root = resolve(__dirname, "..");
/** Everything the phone bundle starts from. Later tasks append to this list. */
export const PHONE_ENTRIES: string[] = [
  "@masalapos/domain/id", "@masalapos/domain/billing", "@masalapos/domain/gst", "@masalapos/domain/round-off",
  "@masalapos/domain/invoice-numbers", "@masalapos/domain/receipt-styles", "@masalapos/domain/bill-print",
  "@masalapos/domain/printer-schemas", "@masalapos/domain/settings-schemas",
];
const DENIED = /^(node:.*|better-sqlite3|fs|path|crypto|os|net|http|https|child_process|worker_threads)$/;
const FROM = /^[ \t]*(?:import|export)\s+(type\s+)?[^;'"]*?from\s+["']([^"']+)["']/gm;
const BARE = /^[ \t]*import\s+["']([^"']+)["']/gm;

function workspaceFile(spec: string): string | undefined {
  const name = spec.split("/")[1]!;
  return existsSync(join(root, "packages", name)) ? workspaceExports(root, name)[spec] : undefined;
}
function relativeFile(from: string, spec: string): string | undefined {
  const base = join(dirname(from), spec.replace(/\.js$/, ""));
  return [`${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")].find((p) => existsSync(p));
}
/** Walks value imports from the entries and returns "file -> import" for every denied or unresolvable one. */
export function phoneOffenders(entries: string[]): string[] {
  const offenders: string[] = [];
  const seen = new Set<string>();
  const queue = entries.map((e) => (e.startsWith("@masalapos/") ? workspaceFile(e) ?? e : resolve(root, e)));
  while (queue.length) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    if (!existsSync(file)) { offenders.push(`${file} -> not found`); continue; }
    const text = readFileSync(file, "utf8");
    const specs = [...text.matchAll(FROM)].filter((m) => !m[1]).map((m) => m[2]!).concat([...text.matchAll(BARE)].map((m) => m[1]!));
    for (const spec of specs) {
      const where = `${file.slice(root.length + 1).replaceAll("\\", "/")} -> ${spec}`;
      if (DENIED.test(spec) || /(^|\/)db\.js$/.test(spec)) offenders.push(where);
      else if (spec.startsWith(".")) { const next = relativeFile(file, spec); next ? queue.push(next) : offenders.push(`${where} (unresolved)`); }
      else if (spec.startsWith("@masalapos/")) { const next = workspaceFile(spec); next ? queue.push(next) : offenders.push(`${where} (not exported)`); }
    }
  }
  return offenders.sort();
}

describe("code the phone can reach", () => {
  it("imports no Node built-ins, no better-sqlite3 and no db.ts", () => {
    expect(phoneOffenders(PHONE_ENTRIES)).toEqual([]);
  });
});
```

- [ ] **Step 3: Run it and confirm it fails**

Run: `npx vitest run tools/phone-safe-imports.test.ts`
Expected: FAIL listing `packages/domain/src/id.ts -> node:crypto` and "not exported" for `id`, `bill-print`, `printer-schemas`, `settings-schemas`.

- [ ] **Step 4: Fix `id.ts` and the exports map**

In `id.ts`, replace the `node:crypto` import: `randomTail()` fills `new Uint8Array(10)` with `globalThis.crypto.getRandomValues` and folds the bytes into a `bigint` with shifts, then masks with `RAND_MAX` as today. Add to `packages/domain/package.json` exports: `"./id": "./src/id.ts"`, `"./bill-print": "./src/bill-print.ts"`, `"./printer-schemas": "./src/printer-schemas.ts"`, `"./settings-schemas": "./src/settings-schemas.ts"`.

- [ ] **Step 5: Verify**

Run: `npx vitest run tools/phone-safe-imports.test.ts packages/domain/src/id.test.ts` then `npm run typecheck`.
Expected: PASS. If the guard names another file in the chain, fix it the same way (a `node:` import becomes a platform-neutral one; a value import of `db.ts` becomes `import type`).

- [ ] **Step 6: Commit** `refactor(domain): ids from Web Crypto and a guard for code the phone can reach`

---

### Task 2: `packages/print`, the shared receipt and slip builders

**Files:**
- Create: `packages/print/package.json`, `packages/print/src/index.ts`, `packages/print/src/bytes.ts`, `apps/server/src/print/to-buffer.ts`
- Move with `git mv` from `apps/server/src/print/` to `packages/print/src/`: `escpos.ts`, `profile.ts`, `templates.ts`, `upi.ts`, `receipt.ts`, `restaurant-receipt-style.ts`, `render-bytes.ts` and the tests `escpos.test.ts`, `templates.test.ts`, `upi.test.ts`, `receipt.test.ts`, `render-bytes.test.ts`
- Stay in `apps/server/src/print/`: `best-effort.ts`, `bill-preview.ts`, `credit-note.ts`, `discovery.ts`, `queue.ts`, `receipt-style.ts`, `sinks.ts`, `station-slip.ts`, `target.ts` and their tests
- Modify: every importer of the moved files (find with `grep -rnE "print/(escpos|profile|templates|upi|receipt|restaurant-receipt-style|render-bytes)" apps tools packages --include=*.ts --include=*.mjs`), `apps/server/package.json`, `vitest.config.ts`, `tools/build-desktop.mjs`, `tools/phone-safe-imports.test.ts`

**Interfaces:**
- Produces, all from `@masalapos/print`:
  - `class EscPos` (unchanged methods; `raster(widthBytes, height, data: Uint8Array)`; `bytes(): Uint8Array`), `CHARS_PER_LINE`
  - `concatBytes(chunks: readonly Uint8Array[]): Uint8Array`
  - `DEFAULT_PROFILE`, `readProfile(json?: string): PrintProfileInput`, `finishSlip(pos: EscPos, profile: PrintProfileInput): Uint8Array`
  - `receiptSlip(bill: Bill, paperWidth: 58 | 80, profile?: PrintProfileInput): Uint8Array`, `receiptHtml(bill: Bill): string`
  - `kotSlip`, `cancelSlip`, `editSlip`, `tableChangeSlip` (same parameters, returning `Uint8Array`), `contextLine`
  - `slipWriter`, `money`, `dateTime`, `clean`, `escape`, `buyerLines`, `chargeLabel`
  - `upiPaymentUri(p: { upiId: string; payeeName: string; amountPaise: number; ref: string; note: string }): string | null`, `billUpiPayment(bill)`, `upiQrSvg(uri): string`, `upiQrRaster(uri, paperWidth): { widthBytes: number; height: number; data: Uint8Array }`
  - `renderBytes(bytes: Uint8Array): string`
- Produces for the server: `toBuffer(bytes: Uint8Array): Buffer` in `apps/server/src/print/to-buffer.ts`.

`receiptHtml` moves too, although the spec first said it would stay: `receipt.ts` shares a dozen private helpers between the slip and the HTML, and the phone can use the HTML later for sharing a bill. Step 7 updates the spec.

- [ ] **Step 1: Create the package and move the files**

`packages/print/package.json`: name `@masalapos/print`, `"private": true`, `"type": "module"`, `"exports": { ".": "./src/index.ts" }`, dependencies `@masalapos/domain: "*"` and `qrcode` at the version in `apps/server/package.json`. `index.ts` re-exports everything listed under Interfaces. Add `"@masalapos/print": "*"` to `apps/server/package.json`. Run `npm install` at the root to link it.

- [ ] **Step 2: Write the new tests** in `packages/print/src/escpos.test.ts` and `upi.test.ts`

```ts
it("returns plain bytes, not a Node Buffer", () => {
  const out = new EscPos().init().line("Hi").bytes();
  expect(out).toBeInstanceOf(Uint8Array);
  expect(Buffer.isBuffer(out)).toBe(false);
  expect([...out]).toEqual([0x1b, 0x40, 0x48, 0x69, 0x0a]);
});
it("builds a UPI payment link for an amount", () => {
  expect(upiPaymentUri({ upiId: "cafe@upi", payeeName: "Chai Point", amountPaise: 12050, ref: "abc123", note: "Bill MPA/26-27/0001" }))
    .toBe("upi://pay?pa=cafe%40upi&pn=Chai%20Point&am=120.50&cu=INR&tr=abc123&tn=Bill%20MPA%2F26-27%2F0001");
  expect(upiPaymentUri({ upiId: "", payeeName: "x", amountPaise: 100, ref: "a", note: "n" })).toBeNull();
  expect(upiPaymentUri({ upiId: "cafe@upi", payeeName: "x", amountPaise: 0, ref: "a", note: "n" })).toBeNull();
});
```

- [ ] **Step 3: Make the moved code phone-safe**

- Replace every `Buffer` with `Uint8Array`: `Buffer.from([...])` becomes `Uint8Array.from([...])`, `Buffer.alloc(n)` becomes `new Uint8Array(n)`, `Buffer.concat` becomes `concatBytes`.
- Replace imports of the `@masalapos/domain` root in non-test files with subpaths: `Bill`, `chargeLabel` and other billing types from `/billing`; `billChargesGst` from `/gst`; `billShowOf`, `billTextLines` from `/bill-print`; `resolveReceiptStyle` from `/receipt-styles`; `PrintProfile`, `PrintProfileInput` from `/printer-schemas`; `UpiId` from `/settings-schemas`. Tests may keep importing the root.
- `billUpiPayment` keeps its behaviour and calls the new `upiPaymentUri` for the link.

- [ ] **Step 4: Rewire the server**

Server files import the moved names from `@masalapos/print`. Wherever a slip's bytes enter the print queue, a sink or a database write, wrap them with `toBuffer(...)`; `npm run typecheck` lists every such place, because a `Uint8Array` is not assignable to `Buffer`. In `vitest.config.ts` add `{ find: "@masalapos/print", replacement: pkg("print") }`. In `tools/build-desktop.mjs` change the workspace filter to `/^@masalapos\/(domain|core|print)(\/[a-z0-9-]+)?$/` and add `delete deps["@masalapos/print"]` beside the two existing deletes. Append `"packages/print/src/index.ts"` to `PHONE_ENTRIES`.

- [ ] **Step 5: Verify**

Run: `npm test`, `npm run typecheck`, `npm run build:desktop`.
Expected: all pass. The moved receipt and template tests pass with no change to their expected text, which proves Windows POS receipts are unchanged.

- [ ] **Step 6: Run the guard**

Run: `npx vitest run tools/phone-safe-imports.test.ts`.
Expected: PASS with `packages/print/src/index.ts` among the entries. The guard does not look inside third-party packages, so whether `qrcode` runs on the phone is proved on a real device in Task 8 Step 9.

- [ ] **Step 7: Update the spec and commit**

In the spec's "Shared-code preparation" item 2, say that all pure print files including `receiptHtml` move and that `receipt-style.ts` (used by credit notes) stays. Commit: `refactor(server): receipt and slip builders move to packages/print and return plain bytes`

---

### Task 3: A token number on the receipt

**Files:**
- Modify: `packages/domain/src/billing.ts` (`ReceiptSnapshot`), `packages/print/src/receipt.ts`
- Test: `packages/print/src/receipt.test.ts`

**Interfaces:**
- Produces: `ReceiptSnapshot.token?: number` ("The cafe app's order token; absent on Windows POS bills.").

- [ ] **Step 1: Write the failing tests** using the file's existing bill fixture

```ts
it("prints the token in large type when the bill has one", () => {
  const text = renderBytes(receiptSlip({ ...bill, receipt: { ...bill.receipt, token: 27 } }, 58));
  expect(text).toContain("TOKEN 27");
  expect(text.indexOf("TOKEN 27")).toBeLessThan(text.indexOf("Date:"));
});
it("prints a bill without a token exactly as before", () => {
  expect(renderBytes(receiptSlip(bill, 58))).not.toContain("TOKEN");
});
it("prints ? for characters a thermal printer cannot show", () => {
  const odd = { ...bill, receipt: { ...bill.receipt, items: [{ name: "चाय ☕ Tea", pricePaise: 2000, qty: 1, gstRate: 5 }] } };
  const out = receiptSlip(odd, 58);
  expect(renderBytes(out)).toContain("??? ? Tea"); // three Devanagari code units, a space, the cup, a space, then Tea
});
```

- [ ] **Step 2: Run and confirm the first test fails**

Run: `npx vitest run packages/print/src/receipt.test.ts`

- [ ] **Step 3: Implement**

Add the field. In `receiptSlip`, directly before the `Date:` line, when `r.token !== undefined`: centre, bold, `size(2, 2)`, print `TOKEN <n>`, then restore normal size, weight and left alignment.

- [ ] **Step 4: Verify** with `npm test` (the whole suite, since the type is shared) and `npm run typecheck`.

- [ ] **Step 5: Commit** `feat(print): an order token on the receipt`

---

### Task 4: `packages/cafe-data` foundation: driver, migrations, sequences

**Files:**
- Create: `packages/cafe-data/package.json`, `src/index.ts`, `src/driver.ts`, `src/migrate.ts`, `src/migrations/index.ts`, `src/migrations/001-initial.ts`, `src/sequences.ts`, `src/time.ts`, `src/events.ts`, `src/testing/sqlite-driver.ts`
- Test: `src/migrate.test.ts`, `src/sequences.test.ts`, `src/time.test.ts`
- Modify: `vitest.config.ts` (alias `@masalapos/cafe-data`), `tools/phone-safe-imports.test.ts` (append `"packages/cafe-data/src/index.ts"`)

**Interfaces:**
- Produces:

```ts
// driver.ts
export interface SqlDriver {
  run(sql: string, params?: readonly unknown[]): void;
  get<T>(sql: string, params?: readonly unknown[]): T | undefined;
  all<T>(sql: string, params?: readonly unknown[]): T[];
  /** Not re-entrant: a transaction inside a transaction throws. */
  transaction<T>(fn: () => T): T;
}
// migrate.ts
export interface Migration { version: number; up(db: SqlDriver): void }
export function migrate(db: SqlDriver, migrations?: readonly Migration[]): number; // returns the version reached
// sequences.ts — call inside the caller's transaction
export function nextSequence(db: SqlDriver, name: string): number;
// time.ts
export function businessDate(ms: number, tzOffsetMinutes: number): string;              // "2026-11-13"
export function cafeFinancialYear(ms: number, tzOffsetMinutes: number): { key: string; short: string }; // { key: "2026-27", short: "26-27" }
// events.ts
export function onDataChanged(fn: () => void): () => void;
export function dataChanged(): void;
// testing/sqlite-driver.ts (not exported from index.ts)
export function sqliteDriver(db: import("better-sqlite3").Database): SqlDriver;
export function memoryCafeDb(): SqlDriver; // ":memory:", foreign keys on, migrated
```

`tzOffsetMinutes` is minutes east of UTC (India is 330). `cafeFinancialYear` returns the same shape as the domain's `financialYear` but takes the offset as an argument instead of reading the machine's time zone, so tests do not depend on where they run.

- [ ] **Step 1: Create the package**

`package.json`: name `@masalapos/cafe-data`, private, `"type": "module"`, `"exports": { ".": "./src/index.ts" }`, dependencies `@masalapos/domain: "*"` and `zod` at the domain's version, devDependencies `better-sqlite3` and `@types/better-sqlite3` at the domain's versions. Run `npm install` at the root.

- [ ] **Step 2: Write the failing tests**

```ts
// migrate.test.ts
it("creates every table from an empty database and records the version", () => {
  const db = memoryCafeDb();
  const names = db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").map((r) => r.name);
  expect(names).toEqual(["bill_lines", "bill_voids", "bills", "cafe", "categories", "device", "item_variants", "items", "payments", "printers", "sequences"]);
  expect(db.get<{ user_version: number }>("PRAGMA user_version")!.user_version).toBe(1);
});
it("applies only newer migrations and keeps existing rows", () => {
  const db = memoryCafeDb();
  db.run("INSERT INTO sequences (name, value) VALUES ('x', 7)");
  const two: Migration = { version: 2, up: (d) => d.run("ALTER TABLE sequences ADD COLUMN note TEXT") };
  expect(migrate(db, [...MIGRATIONS, two])).toBe(2);
  expect(db.get<{ value: number }>("SELECT value FROM sequences WHERE name = 'x'")!.value).toBe(7);
});
it("rolls back a failing migration and leaves the version alone", () => {
  const db = memoryCafeDb();
  const bad: Migration = { version: 2, up: (d) => { d.run("CREATE TABLE t (a)"); d.run("NOT SQL"); } };
  expect(() => migrate(db, [...MIGRATIONS, bad])).toThrow();
  expect(db.get("SELECT name FROM sqlite_master WHERE name = 't'")).toBeUndefined();
  expect(db.get<{ user_version: number }>("PRAGMA user_version")!.user_version).toBe(1);
});
it("refuses a database made by a newer app", () => {
  const db = memoryCafeDb();
  db.run("PRAGMA user_version = 99");
  expect(() => migrate(db)).toThrow(/newer version/);
});
it("refuses a transaction inside a transaction", () => {
  const db = memoryCafeDb();
  expect(() => db.transaction(() => db.transaction(() => 1))).toThrow(/nested/);
});
// sequences.test.ts
it("counts from 1 per name", () => {
  const db = memoryCafeDb();
  expect(db.transaction(() => [nextSequence(db, "a"), nextSequence(db, "a"), nextSequence(db, "b")])).toEqual([1, 2, 1]);
});
// time.test.ts
it("puts a bill in the device's calendar day", () => {
  const justAfterMidnightIst = Date.UTC(2026, 10, 12, 18, 31); // 13 Nov 00:01 IST
  expect(businessDate(justAfterMidnightIst, 330)).toBe("2026-11-13");
  expect(businessDate(justAfterMidnightIst, 0)).toBe("2026-11-12");
});
it("starts the financial year on 1 April in the device's time zone", () => {
  expect(cafeFinancialYear(Date.UTC(2027, 2, 31, 18, 29), 330)).toEqual({ key: "2026-27", short: "26-27" }); // 31 Mar 23:59 IST
  expect(cafeFinancialYear(Date.UTC(2027, 2, 31, 18, 30), 330)).toEqual({ key: "2027-28", short: "27-28" }); // 1 Apr 00:00 IST
});
```

- [ ] **Step 3: Run and confirm they fail** with `npx vitest run packages/cafe-data`

- [ ] **Step 4: Implement**

- `sqliteDriver` runs `BEGIN` / `COMMIT` / `ROLLBACK` itself with a flag, and throws `Error("nested transaction")` on re-entry, to match `expo-sqlite`, whose synchronous transaction cannot nest.
- `migrate` reads `PRAGMA user_version`, throws `Error("This data was made by a newer version of MasalaPOS Cafe")` if it is above the highest known version, and runs each newer migration plus `PRAGMA user_version = <n>` in its own transaction.
- `nextSequence`: `INSERT INTO sequences (name, value) VALUES (?, 1) ON CONFLICT(name) DO UPDATE SET value = value + 1`, then select the value.
- `001-initial.ts` runs exactly this schema:

```sql
CREATE TABLE cafe (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, address TEXT NOT NULL DEFAULT '', phone TEXT NOT NULL DEFAULT '',
  gstin TEXT NOT NULL DEFAULT '', fssai TEXT NOT NULL DEFAULT '',
  gst_mode TEXT NOT NULL CHECK (gst_mode IN ('included','exclusive','none')),
  default_gst_rate INTEGER NOT NULL CHECK (default_gst_rate IN (0,5,12,18,28)),
  round_off TEXT NOT NULL CHECK (round_off IN ('rupee','half','off')),
  invoice_prefix TEXT NOT NULL DEFAULT '', receipt_header TEXT NOT NULL DEFAULT '', receipt_footer TEXT NOT NULL DEFAULT '',
  receipt_style TEXT NOT NULL DEFAULT 'classic', upi_id TEXT NOT NULL DEFAULT '', owner_pin_hash TEXT,
  updated_at INTEGER NOT NULL, deleted_at INTEGER);
CREATE TABLE device (id TEXT PRIMARY KEY, name TEXT NOT NULL, series_letter TEXT NOT NULL CHECK (length(series_letter) = 1));
CREATE TABLE categories (id TEXT PRIMARY KEY, name TEXT NOT NULL, sort INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER);
CREATE TABLE items (
  id TEXT PRIMARY KEY, category_id TEXT NOT NULL REFERENCES categories(id), name TEXT NOT NULL,
  price_paise INTEGER NOT NULL CHECK (price_paise >= 0), gst_rate INTEGER CHECK (gst_rate IN (0,5,12,18,28)),
  available INTEGER NOT NULL DEFAULT 1, sort INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER);
CREATE TABLE item_variants (
  id TEXT PRIMARY KEY, item_id TEXT NOT NULL REFERENCES items(id), name TEXT NOT NULL,
  price_paise INTEGER NOT NULL CHECK (price_paise >= 0), sort INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER);
CREATE TABLE bills (
  id TEXT PRIMARY KEY, device_id TEXT NOT NULL, bill_no INTEGER NOT NULL, invoice_no TEXT NOT NULL UNIQUE,
  token INTEGER NOT NULL, business_date TEXT NOT NULL, created_at INTEGER NOT NULL,
  discount_paise INTEGER NOT NULL, discount_note TEXT, total_paise INTEGER NOT NULL,
  totals_json TEXT NOT NULL, receipt_json TEXT NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER);
CREATE INDEX bills_by_date ON bills (business_date, created_at);
CREATE TABLE bill_lines (
  id TEXT PRIMARY KEY, bill_id TEXT NOT NULL REFERENCES bills(id), item_id TEXT, variant_id TEXT, name TEXT NOT NULL,
  price_paise INTEGER NOT NULL, qty INTEGER NOT NULL CHECK (qty >= 1), gst_rate INTEGER NOT NULL,
  offer_discount_paise INTEGER NOT NULL DEFAULT 0, sort INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER);
CREATE INDEX bill_lines_by_bill ON bill_lines (bill_id);
CREATE TABLE payments (
  id TEXT PRIMARY KEY, bill_id TEXT NOT NULL REFERENCES bills(id), mode TEXT NOT NULL CHECK (mode IN ('cash','upi','card')),
  amount_paise INTEGER NOT NULL CHECK (amount_paise > 0), ref_note TEXT, created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL, deleted_at INTEGER);
CREATE INDEX payments_by_bill ON payments (bill_id);
CREATE TABLE bill_voids (
  id TEXT PRIMARY KEY, bill_id TEXT NOT NULL UNIQUE REFERENCES bills(id), credit_note_no TEXT NOT NULL UNIQUE,
  reason TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER);
CREATE TABLE sequences (name TEXT PRIMARY KEY, value INTEGER NOT NULL);
CREATE TABLE printers (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, transport TEXT NOT NULL CHECK (transport IN ('bluetooth','network')),
  address TEXT NOT NULL, paper_width INTEGER NOT NULL CHECK (paper_width IN (58,80)),
  role TEXT NOT NULL CHECK (role IN ('receipt','kitchen')), profile_json TEXT NOT NULL);
```

`bills.total_paise` is one column more than the spec's table, so reports can sum in SQL. Add it to the spec's table in this task's commit.

- [ ] **Step 5: Verify** with `npx vitest run packages/cafe-data tools/phone-safe-imports.test.ts` and `npm run typecheck`.

- [ ] **Step 6: Commit** `feat(cafe): the phone's data layer starts: driver, schema, sequences`

---

### Task 5: Cafe settings and the menu

**Files:**
- Create: `packages/cafe-data/src/cafe.ts`, `src/menu.ts`
- Test: `src/cafe.test.ts`, `src/menu.test.ts`

**Interfaces:**
- Consumes: `SqlDriver`, `memoryCafeDb`, `dataChanged`; `uuidv7` from `@masalapos/domain/id`; `GST_MODES` from `/gst`; `ROUND_OFF_MODES` from `/round-off`; `RECEIPT_STYLES` from `/receipt-styles`; `OptionalGstin` and `UpiId` through `/settings-schemas`.
- Produces:

```ts
// cafe.ts
export const CafeSettingsInput: z.ZodType<CafeSettings>; // name 1..60; address, receiptHeader, receiptFooter <= 200; phone <= 20;
                                                          // invoicePrefix: 0..3 of A-Z 0-9, upper-cased, not "CN"
export interface CafeSettings {
  name: string; address: string; phone: string; gstin: string; fssai: string;
  gstMode: "included" | "exclusive" | "none"; defaultGstRate: 0 | 5 | 12 | 18 | 28; roundOff: "rupee" | "half" | "off";
  invoicePrefix: string; receiptHeader: string; receiptFooter: string; receiptStyle: ReceiptStyle; upiId: string;
}
export interface Device { id: string; name: string; seriesLetter: string }
export function getCafe(db: SqlDriver): CafeSettings | null;
export function saveCafe(db: SqlDriver, input: unknown, now: number): CafeSettings; // first save also creates the device: name "Counter 1", letter "A"
export function getDevice(db: SqlDriver): Device | null;
export function ownerPinHash(db: SqlDriver): string | null;
export function setOwnerPinHash(db: SqlDriver, hash: string | null, now: number): void;
// menu.ts
export class MenuError extends Error { constructor(readonly code: "duplicate_name" | "category_not_empty" | "not_found" | "invalid", message: string) }
export interface Category { id: string; name: string; sort: number }
export interface Variant { id: string; itemId: string; name: string; pricePaise: number; sort: number }
export interface Item { id: string; categoryId: string; name: string; pricePaise: number; gstRate: number | null; available: boolean; sort: number; variants: Variant[] }
export interface ItemInput { id?: string; categoryId: string; name: string; pricePaise: number; gstRate: number | null; variants: Array<{ id?: string; name: string; pricePaise: number }> }
export function listMenu(db: SqlDriver): { categories: Category[]; items: Item[] };
export function saveCategory(db: SqlDriver, input: { id?: string; name: string }, now: number): Category;
export function deleteCategory(db: SqlDriver, id: string, now: number): void;
export function saveItem(db: SqlDriver, input: ItemInput, now: number): Item;
export function setItemAvailable(db: SqlDriver, id: string, available: boolean, now: number): void;
export function deleteItem(db: SqlDriver, id: string, now: number): void;
export function moveInList(db: SqlDriver, table: "categories" | "items", id: string, direction: "up" | "down", now: number): void;
export function seedSampleMenu(db: SqlDriver, now: number): void;
```

Rules the tests pin: names are trimmed, 1 to 60 characters; a price is 0 to 10,000,000 paise; a category name is unique among live categories, ignoring case; deletes are soft (`deleted_at`); `saveItem` soft-deletes variants missing from the input; new rows go last (`sort` = max + 1); every write sets `updated_at = now` and calls `dataChanged()`; every public function that writes opens one transaction.

- [ ] **Step 1: Write the failing tests**

```ts
// cafe.test.ts
const base = { name: " Chai Point ", address: "", phone: "", gstin: "", fssai: "", gstMode: "included", defaultGstRate: 5, roundOff: "rupee",
  invoicePrefix: "cp", receiptHeader: "", receiptFooter: "", receiptStyle: "classic", upiId: "" };
it("saves the cafe, trims and upper-cases, and creates the device once", () => {
  const db = memoryCafeDb();
  expect(getCafe(db)).toBeNull();
  expect(saveCafe(db, base, 1000)).toMatchObject({ name: "Chai Point", invoicePrefix: "CP" });
  const device = getDevice(db)!;
  expect(device).toMatchObject({ name: "Counter 1", seriesLetter: "A" });
  saveCafe(db, { ...base, name: "Chai Point 2" }, 2000);
  expect(getDevice(db)!.id).toBe(device.id);
  expect(getCafe(db)!.name).toBe("Chai Point 2");
});
it.each([["ABCD"], ["CN"], ["a-b"]])("rejects the invoice prefix %s", (invoicePrefix) => {
  expect(() => saveCafe(memoryCafeDb(), { ...base, invoicePrefix }, 1)).toThrow();
});
it("keeps the owner PIN hash apart from the settings", () => {
  const db = memoryCafeDb(); saveCafe(db, base, 1);
  setOwnerPinHash(db, "h1", 2); saveCafe(db, { ...base, name: "New" }, 3);
  expect(ownerPinHash(db)).toBe("h1");
});
// menu.test.ts
it("lists categories and items in order, with variants", () => {
  const db = memoryCafeDb();
  const tea = saveCategory(db, { name: "Tea" }, 1), snacks = saveCategory(db, { name: "Snacks" }, 2);
  const chai = saveItem(db, { categoryId: tea.id, name: "Masala Chai", pricePaise: 2000, gstRate: null, variants: [{ name: "Small", pricePaise: 1500 }, { name: "Large", pricePaise: 2500 }] }, 3);
  saveItem(db, { categoryId: snacks.id, name: "Samosa", pricePaise: 1800, gstRate: 5, variants: [] }, 4);
  const menu = listMenu(db);
  expect(menu.categories.map((c) => c.name)).toEqual(["Tea", "Snacks"]);
  expect(menu.items.map((i) => i.name)).toEqual(["Masala Chai", "Samosa"]);
  expect(menu.items[0]!.variants.map((v) => [v.name, v.pricePaise])).toEqual([["Small", 1500], ["Large", 2500]]);
  expect(chai.available).toBe(true);
});
it("replaces an item's variants and soft-deletes the ones left out", () => { /* save with [Small, Large], save again with [Small(id)], expect 1 live variant and deleted_at set on Large */ });
it("rejects a duplicate category name whatever its case", () => { /* "Tea" then " tea " -> MenuError code "duplicate_name" */ });
it("will not delete a category that still has items", () => { /* MenuError code "category_not_empty"; after deleteItem it succeeds */ });
it("hides deleted items and keeps unavailable ones", () => { /* setItemAvailable(false) stays listed with available false; deleteItem removes it from listMenu */ });
it("moves a category up and down and stops at the ends", () => { /* [A,B,C]: move C up -> [A,C,B]; move A up -> unchanged */ });
it("rejects an empty name and a price above one lakh rupees", () => { /* MenuError code "invalid" for name "  " and pricePaise 10_000_001 */ });
it("seeds a small sample menu only into an empty menu", () => { /* 3 categories, 8 items; a second call adds nothing */ });
```

Write each outlined test in full, with the assertions its comment states.

- [ ] **Step 2: Run and confirm they fail** with `npx vitest run packages/cafe-data`

- [ ] **Step 3: Implement `cafe.ts` and `menu.ts`** to the interfaces and rules above. The sample menu is our own: categories Hot Drinks, Cold Drinks, Snacks; items Tea ₹15, Coffee ₹20, Masala Chai ₹20, Cold Coffee ₹60, Lemon Soda ₹40, Samosa ₹18, Veg Sandwich ₹50, Bun Maska ₹30; all at the cafe's default GST rate.

- [ ] **Step 4: Verify** with `npx vitest run packages/cafe-data` and `npm run typecheck`.

- [ ] **Step 5: Commit** `feat(cafe): cafe settings and the menu on the phone`

---

### Task 6: Making a bill

**Files:**
- Create: `packages/cafe-data/src/bills.ts`
- Test: `packages/cafe-data/src/bills.test.ts`

**Interfaces:**
- Consumes: Task 4 and 5 exports; `calculateBill`, `Bill`, `BillTotals`, `ReceiptSnapshot` from `@masalapos/domain/billing`; `effectiveGstRate` from `/gst`; `formatInvoiceNo`, `INVOICE_COUNTER_MAX` from `/invoice-numbers`; `DEFAULT_BILL_SHOW` from `/bill-print`.
- Produces:

```ts
export type BillErrorCode = "no_cafe" | "empty" | "invalid_line" | "item_unavailable" | "discount_too_large"
  | "payments_mismatch" | "counter_exhausted" | "not_found" | "already_void";
export class BillError extends Error { constructor(readonly code: BillErrorCode, message: string, readonly lineIndex?: number) }
export interface CartLine { itemId: string | null; variantId: string | null; qty: number; custom?: { name: string; pricePaise: number; gstRate: number | null } }
export interface PaymentInput { mode: "cash" | "upi" | "card"; amountPaise: number; refNote: string | null }
export interface CreateBillInput { id: string; lines: CartLine[]; discountPaise: number; discountNote: string | null;
  payments: PaymentInput[]; now: number; tzOffsetMinutes: number }
export interface CafeBill extends Bill { token: number; businessDate: string;
  voided: { creditNoteNo: string; reason: string; at: number } | null }
export function previewBill(db: SqlDriver, input: Pick<CreateBillInput, "lines" | "discountPaise">): BillTotals;
export function createBill(db: SqlDriver, input: CreateBillInput): CafeBill;
export function getBill(db: SqlDriver, id: string): CafeBill | null;
export function listBills(db: SqlDriver, businessDate: string, search?: string): CafeBill[]; // newest first
export function lastBillAt(db: SqlDriver): number | null;
```

Decisions:
- A menu line (`itemId` set) takes its name, price and GST rate from the database at billing time. With a `variantId` the price is the variant's and the name is `"<item> (<variant>)"`. An item that has variants needs a `variantId`. A deleted or unavailable item, or a deleted variant, is `item_unavailable` with that line's index.
- A custom line (`itemId` null) needs `custom`. Its name is trimmed, defaults to `"Item"` when blank, and is at most 60 characters. A null rate means the cafe's default.
- `qty` is an integer from 1 to 999. Anything else is `invalid_line`.
- Totals come from `calculateBill(lines, discountPaise, cafe.gstMode, cafe.roundOff)`. A discount above the subtotal is `discount_too_large`.
- Payments must add up to the total exactly. A zero total takes no payments. Otherwise `payments_mismatch`.
- The invoice number is `formatInvoiceNo(cafe.invoicePrefix + device.seriesLetter, fy.short, n)` with `n = nextSequence(db, "invoice:<prefix><letter>:<fy.key>")`. When `n` would exceed `INVOICE_COUNTER_MAX` the error is `counter_exhausted` and nothing is written. The token is `nextSequence(db, "token:<businessDate>")`.
- The returned `Bill` has `orderId` equal to its own id, `status: "paid"`, `refundState: "none"`, `creditNotes: []`, `refundedQty: {}`. Its `receipt` is frozen from the cafe at that moment: `orderType: "parcel"`, `orderTypeKind: "takeaway"`, `tableName: null`, `splitLabel: null`, `token`, `billShow: DEFAULT_BILL_SHOW`, plus name, address, phone, gstin, fssai, header, footer, style, `upiId` when set, and the lines.
- A second `createBill` with an id that already exists returns the stored bill and writes nothing.
- Everything happens in one `db.transaction`. `listBills`' `search` matches an exact token number or any part of the invoice number, ignoring case.

- [ ] **Step 1: Write the failing tests.** Use a helper `setup()` that returns a migrated database with the Task 5 `base` cafe (`gstMode: "included"`, rate 5, prefix `CP`), a category, `chai` (₹20, variants Small ₹15 / Large ₹25) and `samosa` (₹18, GST 5). `T0 = Date.UTC(2026, 10, 13, 6, 0)` (11:30 IST), offset 330.

```ts
it("makes a paid bill with a number, a token and a frozen receipt", () => {
  const bill = createBill(db, { id: "b1", lines: [{ itemId: samosa.id, variantId: null, qty: 2 }], discountPaise: 0, discountNote: null,
    payments: [{ mode: "cash", amountPaise: 3600, refNote: null }], now: T0, tzOffsetMinutes: 330 });
  expect(bill).toMatchObject({ id: "b1", status: "paid", invoiceNo: "CPA/26-27/0001", billNo: 1, token: 1, businessDate: "2026-11-13", totalPaise: 3600, voided: null });
  expect(bill.receipt).toMatchObject({ restaurantName: "Chai Point", orderType: "parcel", orderTypeKind: "takeaway", token: 1,
    items: [{ name: "Samosa", pricePaise: 1800, qty: 2, gstRate: 5 }] });
  expect(bill.totalPaise).toBe(calculateBill([{ pricePaise: 1800, qty: 2, gstRate: 5 }], 0, "included", "rupee").totalPaise);
  expect(getBill(db, "b1")).toEqual(bill);
});
it("prices a variant and names the line after it", () => { /* Large chai x1 -> name "Masala Chai (Large)", pricePaise 2500 */ });
it("refuses an item with variants when none is chosen", () => { /* BillError invalid_line, lineIndex 0 */ });
it("bills a custom line with no menu item, defaulting its name and rate", () => { /* custom { name: " ", pricePaise: 4000, gstRate: null } -> "Item", gstRate 5; stored item_id null */ });
it("mixes custom and menu lines in one bill", () => { /* two lines, totals equal calculateBill of both */ });
it("adds GST on top in exclusive mode and none in no-GST mode", () => { /* change cafe gstMode; compare with calculateBill */ });
it("takes a split payment that adds up", () => { /* cash 2000 + upi 1600 on a 3600 bill; payments stored in order */ });
it.each([[3500], [3700]])("refuses payments of %i paise on a 3600 bill", (amountPaise) => { /* payments_mismatch; no bill row; next bill still gets number 1 and token 1 */ });
it("saves a bill discounted to zero with no payments", () => { /* discountPaise 3600, payments [] -> totalPaise 0, status paid */ });
it("refuses a discount above the subtotal", () => { /* discount_too_large */ });
it("refuses an empty cart and a quantity of zero or 1000", () => { /* empty; invalid_line */ });
it("refuses a line whose item was deleted or made unavailable, and says which", () => { /* line 1 unavailable -> code item_unavailable, lineIndex 1; nothing written */ });
it("returns the same bill for a repeated id and makes no second one", () => { /* call twice with id "b1"; equal results; COUNT(*) bills = 1; next new bill is 0002 */ });
it("writes nothing when a payment row cannot be stored", () => { /* payments [{ mode: "cheque" as never, amountPaise: 3600 }] -> throws; bills, bill_lines, payments, sequences all empty */ });
it("restarts tokens each day and keeps invoice numbers running", () => { /* T0 and T0 + 24h: tokens 1 and 1; invoice 0001 and 0002 */ });
it("starts a new invoice series in a new financial year", () => { /* 31 Mar 2027 23:59 IST -> CPA/26-27/....; 1 Apr 2027 00:00 IST -> CPA/27-28/0001 */ });
it("refuses to pass the yearly invoice limit", () => { /* set the sequence to 99999, expect counter_exhausted and the sequence unchanged */ });
it("keeps an old bill's receipt when the cafe or the item changes later", () => { /* rename cafe, change samosa price; getBill(b1).receipt unchanged */ });
it("lists a day's bills newest first and finds them by token or invoice number", () => { /* 3 bills; search "2" -> token 2; search "cpa/26-27/0003" -> that bill; other date -> [] */ });
it("previews the same totals it will bill", () => { /* previewBill equals createBill totals */ });
```

Write each outlined test in full, with the assertions its comment states.

- [ ] **Step 2: Run and confirm they fail** with `npx vitest run packages/cafe-data/src/bills.test.ts`

- [ ] **Step 3: Implement `bills.ts`** to the interfaces and decisions above. Resolve all lines and compute totals before taking any sequence number, so a refused bill never consumes one.

- [ ] **Step 4: Verify** with `npx vitest run packages/cafe-data` and `npm run typecheck`.

- [ ] **Step 5: Commit** `feat(cafe): making a bill on the phone`

---

### Task 7: Voids and the day report

**Files:**
- Modify: `packages/cafe-data/src/bills.ts` (`voidBill`, and `getBill`/`listBills` now fill `voided` and `status`)
- Create: `packages/cafe-data/src/reports.ts`
- Test: `src/void.test.ts`, `src/reports.test.ts`

**Interfaces:**
- Consumes: Task 6; `formatCreditNoteNo` from `@masalapos/domain/invoice-numbers`; `TaxLine` from `/billing`.
- Produces:

```ts
export function voidBill(db: SqlDriver, input: { billId: string; reason: string; now: number; tzOffsetMinutes: number }): CafeBill;
export interface DaySummary {
  date: string; billCount: number; voidCount: number;
  grossPaise: number;      // sum of subtotals of live bills
  discountPaise: number; roundingPaise: number;
  netPaise: number;        // sum of totals of live bills
  taxes: TaxLine[];        // merged by rate, ascending
  byMode: { cash: number; upi: number; card: number };
  items: Array<{ name: string; qty: number; amountPaise: number }>; // by amount, largest first, then name
  voids: Array<{ invoiceNo: string; token: number; totalPaise: number; reason: string }>;
}
export function daySummary(db: SqlDriver, businessDate: string): DaySummary;
```

Decisions: a void reason is trimmed and must be 1 to 120 characters; otherwise the error code is `invalid_reason`, which this task adds to `BillErrorCode`. The credit-note number is `formatCreditNoteNo(fy.short, nextSequence(db, "cn:<fy.key>"))` using the void's own time. A voided bill has `status: "void"` and its `voided` field set. A voided bill counts under the day it was billed, in `voids` only: it adds nothing to sales, tax, modes or items. Item lines group by name, so custom lines with the same name add together.

- [ ] **Step 1: Write the failing tests**

```ts
// void.test.ts
it("voids a bill with a credit note number and a reason", () => {
  const voided = voidBill(db, { billId: "b1", reason: " wrong order ", now: T0 + 60_000, tzOffsetMinutes: 330 });
  expect(voided).toMatchObject({ status: "void", voided: { creditNoteNo: "CN/26-27/001", reason: "wrong order", at: T0 + 60_000 } });
  expect(getBill(db, "b1")!.status).toBe("void");
  expect(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM bills")!.n).toBe(1); // the bill row itself is untouched
});
it("refuses a second void, an unknown bill and an empty reason", () => { /* already_void, not_found, invalid_reason */ });
it("prints VOID on the receipt of a voided bill", () => {
  expect(renderBytes(receiptSlip(voidBill(db, { billId: "b1", reason: "x", now: T0, tzOffsetMinutes: 330 }), 58))).toContain("VOID");
});
// reports.test.ts — three bills on 13 Nov: b1 samosa x2 cash 3600; b2 Large chai + custom "Cookie" ₹40, discount ₹5, split cash 4000 + upi 2000; b3 samosa x1 card 1800, then voided
it("sums the day without the voided bill", () => {
  const s = daySummary(db, "2026-11-13");
  expect(s).toMatchObject({ date: "2026-11-13", billCount: 2, voidCount: 1, grossPaise: 3600 + 6500, discountPaise: 500, netPaise: 3600 + 6000,
    byMode: { cash: 7600, upi: 2000, card: 0 } });
  expect(s.items).toEqual([{ name: "Cookie", qty: 1, amountPaise: 4000 }, { name: "Samosa", qty: 2, amountPaise: 3600 }, { name: "Masala Chai (Large)", qty: 1, amountPaise: 2500 }]);
  expect(s.voids).toEqual([{ invoiceNo: "CPA/26-27/0003", token: 3, totalPaise: 1800, reason: "x" }]);
  expect(s.taxes.reduce((n, t) => n + t.taxablePaise + t.cgstPaise + t.sgstPaise, 0)).toBe(s.netPaise - s.roundingPaise);
});
it("returns zeros for a day with no bills", () => { /* billCount 0, items [], byMode all 0 */ });
```

- [ ] **Step 2: Run and confirm they fail.** **Step 3: Implement.** **Step 4: Verify** with `npx vitest run packages/cafe-data` and `npm run typecheck`.

- [ ] **Step 5: Commit** `feat(cafe): voids and the day report`

---

### Task 8: The app shell on a real phone

**Files:**
- Create: `apps/cafe-android/` (`package.json`, `app.json`, `tsconfig.json`, `metro.config.js`, `src/polyfills.ts`, `src/db/expo-driver.ts`, `src/db/provider.tsx`, `src/theme/tokens.ts`, `src/ui/`, `src/security/pin.ts`, `src/app/_layout.tsx`, `src/app/first-run.tsx`, `src/app/(tabs)/_layout.tsx`, `bill.tsx`, `bills.tsx`, `reports.tsx`, `menu.tsx`, `more.tsx`, `src/app/self-check.tsx`), `tools/build-cafe-android.mjs`
- Modify: root `package.json` (scripts), root `tsconfig.json` (exclude), `.gitignore`, `tools/phone-safe-imports.test.ts`
- Test: `apps/cafe-android/src/db/expo-driver.test.ts`

**Interfaces:**
- Consumes: `@masalapos/cafe-data` (`SqlDriver`, `migrate`, `getCafe`, `saveCafe`, `setOwnerPinHash`, `seedSampleMenu`, `onDataChanged`).
- Produces:

```ts
// src/db/expo-driver.ts
export interface SyncSqlite { runSync(sql: string, params: unknown[]): unknown; getFirstSync<T>(sql: string, params: unknown[]): T | null;
  getAllSync<T>(sql: string, params: unknown[]): T[]; withTransactionSync(task: () => void): void }
export function expoDriver(db: SyncSqlite): SqlDriver;
// src/db/provider.tsx
export function useDb(): SqlDriver;            // throws outside the provider
export function useData<T>(read: (db: SqlDriver) => T): T; // re-reads when cafe-data reports a change
// src/security/pin.ts
export function hashPin(pin: string, salt: string): Promise<string>; // SHA-256 hex of `${salt}:${pin}`, via expo-crypto
export function isValidPin(pin: string): boolean;                     // 4 to 6 digits
// src/theme/tokens.ts
export const color, space, radius, type; // see Step 6
```

- [ ] **Step 1: Check current Expo guidance, then scaffold**

Read the Expo docs for the current SDK's `create-expo-app` template, monorepo page and `expo-sqlite` page. Scaffold into `apps/cafe-android` with the default Expo Router TypeScript template and remove its sample screens. Set `package.json` name `@masalapos/cafe-android`, `"private": true`, version `0.1.0`. In `app.json`: `name` "MasalaPOS Cafe", `slug` "masalapos-cafe", `scheme` "masalapos-cafe", `android.package` "app.masalapos.cafe", new architecture on, `platforms` `["android"]`. Add dependencies with `npx expo install`: `expo-sqlite`, `expo-crypto`, `expo-dev-client`, `react-native-svg`, and workspace dependencies `@masalapos/cafe-data`, `@masalapos/print`, `@masalapos/domain` at `"*"`.

- [ ] **Step 2: Settle the React versions** (spec risk 1)

Run `npm install` at the root, then `npm why react-native` and `npm why react`, then `npx expo-doctor` in the app folder.
Expected: one `react-native`; the app resolves the React version the SDK asks for (a second React for `apps/ui` and `apps/portal` elsewhere in the tree is fine). If the app picks up the web apps' React, declare the SDK's exact React version in the app's own `package.json` so npm nests it, and re-run. Then run `npm test` and `npm run build:desktop` to prove the Windows POS is unaffected by the new lockfile.

- [ ] **Step 3: TypeScript and tests**

App `tsconfig.json` extends `expo/tsconfig.base` with `strict`, `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` on, excludes `**/*.test.ts`, and has a `typecheck` script `tsc --noEmit`. Use relative imports inside the app, not the template's `@/` alias, so the import guard can follow them. Add `"apps/cafe-android"` to the root `tsconfig.json` `exclude`, and `&& npm run typecheck -w @masalapos/cafe-android` to the root `typecheck` script. Add to `.gitignore`: `apps/cafe-android/android/` and `apps/cafe-android/.expo/`.

- [ ] **Step 4: Teach Metro the repo's import style** in `metro.config.js`

The shared packages import their own files as `./gst.js` although the files are `.ts`. Metro does not map that by itself:

```js
const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);
const upstream = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  const resolve = upstream ?? context.resolveRequest;
  if (moduleName.startsWith(".") && moduleName.endsWith(".js")) {
    try { return resolve(context, moduleName.slice(0, -3), platform); } catch { /* a real .js file: fall through */ }
  }
  return resolve(context, moduleName, platform);
};
module.exports = config;
```

- [ ] **Step 5: Write the failing driver test, then the driver and provider**

```ts
// expo-driver.test.ts — `fakeSyncSqlite()` is a helper in this file that wraps an in-memory better-sqlite3 database
// in the SyncSqlite shape; `base` is the cafe input from Task 5. This proves the adapter, not expo.
it("passes cafe-data's own flow through the adapter", () => {
  const db = expoDriver(fakeSyncSqlite());
  expect(migrate(db)).toBe(1);
  saveCafe(db, base, 1);
  expect(getCafe(db)!.name).toBe("Chai Point");
  expect(db.get("SELECT 1 AS one WHERE 1 = 0")).toBeUndefined(); // null from expo becomes undefined
  expect(db.transaction(() => 42)).toBe(42);                      // the callback's value comes back
});
```

`provider.tsx` opens `cafe.db` with `openDatabaseSync`, runs `PRAGMA foreign_keys = ON` and `PRAGMA journal_mode = WAL`, runs `migrate`, and shows a plain error screen with the message if that throws. `src/polyfills.ts` sets `globalThis.crypto.getRandomValues` from `expo-crypto` when it is missing and is the first import in `src/app/_layout.tsx`.

- [ ] **Step 6: Design tokens and base components**

Load the `mobile-design-system` skill and follow it to produce `src/theme/tokens.ts` and the base components in `src/ui/` (`Button`, `Tile`, `Sheet`, `Field`, `Keypad`, `Money`, `Banner`, `ListRow`, `Screen`). Fixed inputs: light theme only; the accent is the MasalaPOS orange used by the website (read it from the `feat/website` worktree at `E:\Softwares\masalapos-website`; do not invent a new one); amounts use tabular figures; every pressable is at least 48 dp; text on the accent passes WCAG AA; layouts switch from phone to tablet at a window width of 840 dp.

- [ ] **Step 7: Routes**

`_layout.tsx`: polyfills, database provider, then first run when `getCafe` is null, otherwise the tabs. `(tabs)/_layout.tsx`: bottom tabs below 840 dp, a side rail from 840 dp, in the order Bill, Bills, Reports, Menu, More. The five tab screens are placeholders showing their title. `first-run.tsx`: three steps. (1) Cafe name (required), address, phone, GSTIN (optional), tax mode and default rate, owner PIN entered twice. (2) "Start with an empty menu" or "Add a sample menu". (3) Printer, with **Skip** (the real printer step arrives in Task 9). Finishing calls `saveCafe`, `setOwnerPinHash(hashPin(pin, device.id))`, optionally `seedSampleMenu`.

- [ ] **Step 8: The build script** `tools/build-cafe-android.mjs`

Model it on `tools/build-captain-android.mjs`: reuse its `javaHome()` and `sdkDir()` logic, run `npx expo prebuild --platform android --no-install` in the app folder, write `android/local.properties`, then `gradlew assembleDebug`. Print the APK path. `--install` also runs `adb install -r` on it. Release signing is Phase 5 and is not built here. Add root scripts `"build:cafe-android": "node tools/build-cafe-android.mjs"` and `"dev:cafe": "npm run start -w @masalapos/cafe-android"`.

- [ ] **Step 9: DEVICE — prove the shared code runs on the phone**

Add `src/app/self-check.tsx`, reachable only in development builds from More. It shows: a fresh `uuidv7()`; `calculateBill([{ pricePaise: 1800, qty: 2, gstRate: 5 }]).totalPaise` (expect 3600); `receiptSlip(sampleBill, 58).length`; the QR from `upiQrSvg("upi://pay?pa=test@upi&am=1.00")` drawn with `SvgXml`; `dateTime(Date.now())`.
Run: `node tools/build-cafe-android.mjs --install`, `adb reverse tcp:8081 tcp:8081`, `npm run dev:cafe`.
Expected: the app opens to first run; completing it lands on the tabs; the self-check screen shows 3600, a byte count above zero, a scannable QR and a readable Indian-format date. Force-close and reopen: it goes straight to the tabs. This settles spec risks 2 (`qrcode` under Hermes) and 3 (synchronous `expo-sqlite`).

- [ ] **Step 10: Extend the guard and verify**

In the guard test, append every non-test `.ts`/`.tsx` file under `apps/cafe-android/src` to the entries (scan the folder; skip `*.test.ts`). Run `npm test` and `npm run typecheck`.

- [ ] **Step 11: Commit** `feat(cafe): the Android app shell with first run`

---

### Task 9: Printing

**Files:**
- Create: `apps/cafe-android/modules/printer/` (via `npx create-expo-module@latest printer --local`, Android only), `apps/cafe-android/src/print/print-queue.ts`, `printer.ts`, `test-slip.ts`, `packages/cafe-data/src/printers.ts`, `apps/cafe-android/src/app/more/printers.tsx`
- Test: `src/print/print-queue.test.ts`, `src/print/test-slip.test.ts`, `packages/cafe-data/src/printers.test.ts`

**Interfaces:**
- Produces:

```ts
// modules/printer (native module "MasalaposPrinter")
pairedPrinters(): Promise<Array<{ name: string; address: string }>>;
bluetoothState(): Promise<"ready" | "off" | "no_permission" | "unsupported">;
requestBluetoothPermission(): Promise<boolean>;
print(target: PrintTarget, bytes: Uint8Array): Promise<void>; // rejects with code PRINTER_UNREACHABLE | BLUETOOTH_OFF | NO_PERMISSION | WRITE_FAILED
// src/print/print-queue.ts
export type { PrintTarget } from "@masalapos/cafe-data"; // defined beside the printers repository, below
export interface PrintJob { id: string; label: string; target: PrintTarget; bytes: Uint8Array; copies: number }
export type QueuedJob = PrintJob & { state: "queued" | "printing" | "done" | "failed"; error: string | null };
export function createPrintQueue(send: (target: PrintTarget, bytes: Uint8Array) => Promise<void>): {
  enqueue(job: PrintJob): void; retry(id: string): void; dismiss(id: string): void;
  jobs(): readonly QueuedJob[]; subscribe(fn: () => void): () => void };
export function printErrorMessage(code: string): string;
// src/print/test-slip.ts
export function testSlip(cafeName: string, paperWidth: 58 | 80, now: number): Uint8Array;
// packages/cafe-data/src/printers.ts
export type PrintTarget = { transport: "bluetooth"; address: string } | { transport: "network"; host: string; port: number };
export interface Printer { id: string; name: string; transport: "bluetooth" | "network"; address: string; paperWidth: 58 | 80; role: "receipt" | "kitchen"; profile: PrintProfileInput }
export function listPrinters(db: SqlDriver): Printer[];
export function savePrinter(db: SqlDriver, input: Omit<Printer, "id" | "profile"> & { id?: string; profile?: PrintProfileInput }): Printer; // one printer per role: saving replaces that role's printer
export function deletePrinter(db: SqlDriver, id: string): void;
export function printerFor(db: SqlDriver, role: "receipt" | "kitchen"): Printer | null;
export function printTarget(p: Printer): PrintTarget; // a network address "host" or "host:port", port 9100 by default, via networkPrinterAddress
```

Messages from `printErrorMessage`: `PRINTER_UNREACHABLE` "Could not reach the printer. Check it is switched on and nearby."; `BLUETOOTH_OFF` "Bluetooth is off. Turn it on and try again."; `NO_PERMISSION` "MasalaPOS Cafe needs permission to use Bluetooth printers."; `WRITE_FAILED` "The printer stopped responding. Check paper and try again."; anything else "The receipt did not print. Try again."

- [ ] **Step 1: Write the failing tests**

```ts
// print-queue.test.ts — `send` is a fake that records calls and can be told to reject
it("sends jobs one at a time, in order", async () => { /* enqueue a, b while a is pending: send called once; resolve a -> b starts; states end done, done */ });
it("sends a job once per copy", async () => { /* copies 2 -> two sends of the same bytes */ });
it("marks a failed job, keeps its message and carries on with the next", async () => { /* a rejects { code: "BLUETOOTH_OFF" } -> a failed with printErrorMessage text; b done */ });
it("prints a failed job again on retry", async () => { /* retry(a) -> queued -> done */ });
it("forgets a dismissed job and tells subscribers on every change", async () => { /* dismiss removes it; subscriber count > 0 */ });
// test-slip.test.ts
it("prints the cafe name, a ruler as wide as the paper and the time", () => {
  const text = renderBytes(testSlip("Chai Point", 58, T0));
  expect(text).toContain("Chai Point"); expect(text).toContain("Printer test");
  expect(text).toContain("12345678901234567890123456789012"); // 32 characters on 58 mm
  expect(renderBytes(testSlip("Chai Point", 80, T0))).toContain("123456789012345678901234567890123456789012345678");
});
// printers.test.ts
it("keeps one printer per role and builds its target", () => { /* save BT receipt, save network receipt -> list has 1; printTarget "192.168.1.50" -> port 9100; "192.168.1.50:9101" -> 9101; printerFor("kitchen") null */ });
```

- [ ] **Step 2: Run and confirm they fail. Step 3: Implement the queue, the test slip and the printers repository. Step 4: Verify** with `npm test`.

- [ ] **Step 5: Write the Kotlin module**

- Manifest in the module: `BLUETOOTH_CONNECT`; `BLUETOOTH` and `BLUETOOTH_ADMIN` with `android:maxSdkVersion="30"`; `INTERNET`.
- `bluetoothState`: `unsupported` with no adapter; `no_permission` on Android 12+ without `BLUETOOTH_CONNECT`; `off` when disabled; else `ready`.
- `pairedPrinters`: the adapter's bonded devices, name and address, sorted by name.
- `print`, Bluetooth: cancel discovery, `createRfcommSocketToServiceRecord(UUID 00001101-0000-1000-8000-00805F9B34FB)`, connect, write in 4,096-byte chunks, flush, wait 300 ms (cheap printers drop the tail if the socket closes at once), close. One retry after 500 ms on a connect failure.
- `print`, network: `Socket` with a 4,000 ms connect timeout to the host and port, write, flush, close.
- Accept the bytes as a Kotlin `ByteArray`. If the SDK's argument conversion rejects a `Uint8Array`, pass base64 text instead and decode it in Kotlin; keep the TypeScript signature above either way by converting inside `src/print/printer.ts`.
- All I/O runs off the main thread; close the socket in `finally`.

- [ ] **Step 6: The Printers screen** (`more/printers.tsx`) and first-run step 3

Shows the receipt printer or "No printer set up". **Add Bluetooth printer** asks for permission when needed, explains that the printer must first be paired in Android's Bluetooth settings (with a button that opens them), and lists paired devices. **Add network printer** takes an address. Both ask for paper width (58 mm or 80 mm). **Test print** enqueues `testSlip`. A failed job shows its message with **Try again**. First-run step 3 is this same screen with **Skip**.

- [ ] **Step 7: DEVICE** — rebuild (`node tools/build-cafe-android.mjs --install`, since native code changed), pair a real thermal printer, add it and run a test print. Expected: the slip prints with the ruler filling the line exactly. Switch the printer off and test again: the screen shows the unreachable message and **Try again** works once it is back on. Deny the Bluetooth permission once: the permission message appears.

- [ ] **Step 8: Commit** `feat(cafe): Bluetooth and network receipt printing`

---

### Task 10: The Menu screen

**Files:**
- Create: `apps/cafe-android/src/menu/printable.ts`, `src/money.ts`; replace `src/app/(tabs)/menu.tsx`; create `src/app/menu/item.tsx` (add and edit)
- Test: `src/menu/printable.test.ts`, `src/money.test.ts`

**Interfaces:**
- Consumes: Task 5 menu functions, `MenuError`.
- Produces:

```ts
export function hasUnprintable(text: string): boolean;   // true when any character is outside printable ASCII (0x20 to 0x7e)
export function formatRupees(paise: number): string;     // 123450 -> "₹1,234.50"; Indian digit grouping; always two decimals
export function parseRupees(text: string): number | null; // "12" -> 1200, "12.5" -> 1250, "1,234.50" -> 123450; null for "", "abc", "-1", "1.234"
```

- [ ] **Step 1: Write the failing tests**

```ts
it.each([["Masala Chai", false], ["Café", true], ["चाय", true], ["Tea ☕", true], ["Tea (Large) - 250ml", false]])("hasUnprintable(%s) is %s", (t, e) => expect(hasUnprintable(t)).toBe(e));
it.each([[0, "₹0.00"], [5, "₹0.05"], [1800, "₹18.00"], [123450, "₹1,234.50"], [12345678, "₹1,23,456.78"]])("formats %i as %s", (p, s) => expect(formatRupees(p)).toBe(s));
it.each([["12", 1200], ["12.5", 1250], ["12.50", 1250], ["1,234.50", 123450], [" 7 ", 700], ["", null], ["abc", null], ["-1", null], ["1.234", null]])("parses %s", (t, p) => expect(parseRupees(t)).toBe(p));
```

- [ ] **Step 2: Run, implement, verify** with `npx vitest run apps/cafe-android`.

- [ ] **Step 3: Build the screens**

Menu tab: categories as sections with their items; each item row shows name, price (or "from ₹x" with variants) and an **Available** switch (`setItemAvailable`). **Add category**, **Add item**. An **Edit order** mode shows up and down buttons (`moveInList`). The item screen has name, category, price, GST rate ("Cafe default" or 0, 5, 12, 18, 28) and a variants list (name and price each); with variants present the base price field is hidden. Under the name field, when `hasUnprintable(name)`: "Receipts print English letters and numbers only. Other characters will print as ?". Deleting asks for confirmation. `MenuError` codes map to: `duplicate_name` "There is already a category with this name."; `category_not_empty` "Move or delete this category's items first."; `invalid` "Check the name and price."

- [ ] **Step 4: DEVICE** — add a category and items with and without variants, mark one unavailable, reorder, delete; reopen the app and confirm everything persisted.

- [ ] **Step 5: Commit** `feat(cafe): the menu editor`

---

### Task 11: The Bill screen and payment

**Files:**
- Create: `apps/cafe-android/src/cart/cart-store.ts`, `src/payment/tender.ts`; replace `src/app/(tabs)/bill.tsx`; create `src/app/payment.tsx` (modal), `src/bill/CustomItemSheet.tsx`, `VariantSheet.tsx`, `CartPanel.tsx`, `TokenScreen.tsx`
- Test: `src/cart/cart-store.test.ts`, `src/payment/tender.test.ts`

**Interfaces:**
- Consumes: `listMenu`, `previewBill`, `createBill`, `BillError`, `lastBillAt`, `getCafe`, `printerFor`, `printTarget`; `receiptSlip`, `upiPaymentUri`, `upiQrSvg` from `@masalapos/print`; the print queue; `uuidv7`.
- Produces:

```ts
// cart-store.ts
export interface CartEntry { key: string; itemId: string | null; variantId: string | null; name: string; pricePaise: number; gstRate: number | null; qty: number }
export type Discount = { kind: "amount"; paise: number } | { kind: "percent"; bp: number };
export function createCartStore(): {
  entries(): readonly CartEntry[];
  add(e: Omit<CartEntry, "key" | "qty">): void;      // same itemId + variantId adds 1 to that line; custom lines (itemId null) never merge
  setQty(key: string, qty: number): void;            // 0 removes; capped at 999
  setDiscount(d: Discount | null, note?: string): void;
  discount(): { value: Discount | null; note: string };
  discountPaise(subtotalPaise: number): number;      // percent: round half up; never above the subtotal
  toLines(): CartLine[];
  clear(): void;
  subscribe(fn: () => void): () => void };
// tender.ts
export function changeDue(totalPaise: number, tenderedPaise: number): number | null; // null when tendered is less than the total
export function cashSuggestions(totalPaise: number): number[];                       // the exact total, then the total rounded up to a multiple of ₹10, ₹50, ₹100 and ₹500 (a total already on a multiple stays); unique, ascending, the first 4; [] for 0
export function remaining(totalPaise: number, parts: readonly number[]): number;     // what a split still has to cover
```

- [ ] **Step 1: Write the failing tests**

```ts
// cart-store.test.ts
it("adds to the same line for the same item and variant, and a new line otherwise", () => { /* chai Small twice -> 1 line qty 2; chai Large -> 2 lines */ });
it("never merges custom lines", () => { /* two custom "Item" ₹40 -> 2 lines */ });
it("removes a line at quantity 0 and caps at 999", () => {});
it("turns a percent discount into paise, rounding half up, never above the subtotal", () => {
  cart.setDiscount({ kind: "percent", bp: 1250 }); expect(cart.discountPaise(3333)).toBe(417);
  cart.setDiscount({ kind: "amount", paise: 9999 }); expect(cart.discountPaise(3333)).toBe(3333);
});
it("turns the cart into bill lines", () => { /* menu line -> { itemId, variantId, qty }; custom -> { itemId: null, variantId: null, qty, custom: { name, pricePaise, gstRate } } */ });
it("clears lines and discount together and notifies", () => {});
// tender.test.ts
it.each([[3600, 3600, 0], [3600, 5000, 1400], [3600, 3500, null]])("change for %i with %i tendered is %s", (t, g, c) => expect(changeDue(t, g)).toBe(c));
it("suggests the exact amount and round notes above it", () => {
  expect(cashSuggestions(3600)).toEqual([3600, 4000, 5000, 10000]);
  expect(cashSuggestions(10000)).toEqual([10000, 50000]);
  expect(cashSuggestions(0)).toEqual([]);
});
it("says what a split still has to cover", () => { expect(remaining(3600, [2000])).toBe(1600); expect(remaining(3600, [2000, 1600])).toBe(0); });
```

- [ ] **Step 2: Run, implement the two modules, verify** with `npx vitest run apps/cafe-android`.

- [ ] **Step 3: Build the Bill screen**

- Left or top: a category rail, a search field, and item tiles (name, price). An unavailable item is dimmed and cannot be added. A tile with variants opens `VariantSheet`. A **Custom item** button opens `CustomItemSheet`: a keypad for the price, optional name, quantity, GST rate (cafe default preselected), and a "Save to menu" switch that needs a category and calls `saveItem`.
- When the menu has no items the screen opens straight on `CustomItemSheet` with a line above it: "No menu yet. Enter a price to make your first bill."
- `CartPanel` (a bottom sheet below 840 dp, a right-hand panel from 840 dp): lines with name, quantity stepper and amount; **Discount** (amount or percent, optional note); totals from `previewBill`; **Charge ₹x**, disabled for an empty cart.
- When `lastBillAt` is later than the phone's clock, a banner above the cart: "This phone's clock is behind your last bill. Check the date and time." Billing stays allowed.

- [ ] **Step 4: Build payment**

`payment.tsx` makes the bill id once when it opens (`uuidv7()`), so a second tap on **Paid** can never make a second bill. It shows the total and three choices. **Cash**: `cashSuggestions` as buttons with the exact amount selected, a field for another amount, and the change from `changeDue`. **UPI**: when the cafe has a UPI id, the QR from `upiQrSvg(upiPaymentUri({ upiId, payeeName: cafe.name, amountPaise, ref: billId without dashes, note: "MasalaPOS Cafe" }))`; otherwise the text "Add your UPI ID in More, Cafe details, to show a QR code here." UPI can be chosen either way. **Card**. **Split** lets the cashier enter an amount for one mode and puts `remaining` on another. **Paid** is enabled when the parts cover the total exactly, disables itself while saving, calls `createBill` with `now = Date.now()` and `tzOffsetMinutes = -new Date(now).getTimezoneOffset()`, enqueues `receiptSlip(bill, printer.paperWidth, printer.profile)` when a receipt printer exists, shows `TokenScreen` (the token in very large type, the total, change due, and the print job's state with **Try again** if it failed), clears the cart and returns to Bill on tap or after 3 seconds. With no printer, `TokenScreen` adds "No printer set up. This bill is saved in Bills."

`BillError` messages: `item_unavailable` "<line name> is no longer available. Remove it to continue." (and that cart line is marked); `payments_mismatch` "The payments do not add up to the total."; `counter_exhausted` "This year's bill numbers are used up. Change the bill prefix in More, Receipt."; `discount_too_large` "The discount is more than the bill."; any other "This bill could not be saved. Try again."

- [ ] **Step 5: DEVICE**

With the sample menu and a printer: tap Tea, **Charge**, **Paid** with Cash preselected; that is three taps, and a receipt prints with `TOKEN 1`. Then: a variant; a custom item; a percent discount; a split cash + UPI; a UPI QR scanned by a payment app (it opens with the right payee and amount; do not pay); mark an item unavailable from Menu while it is in the cart and try to pay (the message names it); tap **Paid** twice fast (one bill in Bills).

- [ ] **Step 6: Commit** `feat(cafe): instant billing with cash, UPI and card`

---

### Task 12: Bills and Reports

**Files:**
- Replace: `src/app/(tabs)/bills.tsx`, `src/app/(tabs)/reports.tsx`
- Create: `src/app/bill/[id].tsx`, `src/bill/ReceiptView.tsx`, `src/security/PinPrompt.tsx`, `src/print/day-summary-slip.ts`
- Test: `src/print/day-summary-slip.test.ts`

**Interfaces:**
- Consumes: `listBills`, `getBill`, `voidBill`, `daySummary`, `ownerPinHash`, `getDevice`, `hashPin`, `businessDate`, the print queue, `receiptSlip`, `EscPos`, `slipWriter`, `finishSlip`, `money`.
- Produces: `daySummarySlip(summary: DaySummary, cafeName: string, paperWidth: 58 | 80, profile: PrintProfileInput): Uint8Array`.

- [ ] **Step 1: Write the failing test** using the Task 7 three-bill day

```ts
it("prints the day's totals, payment modes, tax, items and voids", () => {
  const text = renderBytes(daySummarySlip(summary, "Chai Point", 58, DEFAULT_PROFILE));
  for (const part of ["Chai Point", "DAY SUMMARY", "13 Nov 2026", "Bills", "2", "Net sales", "96.00", "Cash", "76.00", "UPI", "20.00", "Card", "0.00",
    "Discounts", "5.00", "Samosa", "Cookie", "Voids", "CPA/26-27/0003"]) expect(text).toContain(part);
  for (const line of text.split("\n")) expect(line.length).toBeLessThanOrEqual(32);
});
```

- [ ] **Step 2: Run, implement, verify.**

- [ ] **Step 3: Build Bills**

A date control (today by default, from `businessDate(Date.now(), offset)` with the same offset rule as payment; previous and next day; a date picker) and a search field. Rows show token, invoice number, time, total, payment modes and a **VOID** badge. A bill opens `bill/[id].tsx` with `ReceiptView` (the receipt drawn with native text from the `Bill`: header, lines, totals, tax, payments, token) and two actions. **Reprint** enqueues `receiptSlip`. **Void** opens `PinPrompt`, compares `hashPin(pin, device.id)` with `ownerPinHash`, asks for a reason, calls `voidBill`, and offers to print the voided receipt. A wrong PIN says "Wrong PIN." and allows another try; five wrong tries close the prompt.

- [ ] **Step 4: Build Reports**

The same date control. Cards for bills, net sales, discounts and voids; a payment-mode breakdown; tax by rate; items sold with quantity and amount; the voids list. **Print summary** enqueues `daySummarySlip`. An empty day says "No bills on this day."

- [ ] **Step 5: DEVICE** — reprint a bill; void one with the PIN and check it shows VOID, prints VOID, and leaves the day's sales; compare every figure on Reports with the bills made that day; print the summary.

- [ ] **Step 6: Commit** `feat(cafe): bills list, voids and the day report`

---

### Task 13: Settings, the full device check and the handover

**Files:**
- Replace: `src/app/(tabs)/more.tsx`; create `src/app/more/cafe.tsx`, `tax.tsx`, `receipt.tsx`, `pin.tsx`, `about.tsx`
- Create: `docs/operations/cafe-app.md`, `docs/agents/handoff/2026-11-13-cafe-mobile-phase-1.md`
- Modify: the spec, where this plan changed a detail

- [ ] **Step 1: Build More**

Rows: Cafe details (name, address, phone, GSTIN, FSSAI, UPI ID), Tax (mode, default rate, round-off), Receipt (bill prefix of up to three letters or digits with the note "Changing the prefix starts a new series of bill numbers.", header, footer, style), Printers (Task 9), Owner PIN (current PIN, then the new one twice), About (app version, device name and series letter). Each form saves through `saveCafe` and shows the zod error for the field that failed. Changes apply to new bills only; Task 6's test already proves old bills keep their receipt.

- [ ] **Step 2: DEVICE — the whole spec checklist, in flight mode**

Uninstall, reinstall, switch the phone to flight mode with Bluetooth on, then: first run with an empty menu; a bill with no menu entered; add items; a one-item cash bill in three taps; a variant; a discount; a split payment; UPI QR shown; reprint; void; the day report matches; print the summary; switch the printer off mid-sale and confirm the bill is saved and **Try again** prints it once the printer is back; rotate a tablet, or widen the window, and confirm the side rail and right-hand cart appear. Record each result in the handoff note.

- [ ] **Step 3: Write the docs**

`docs/operations/cafe-app.md`: what the app is, how to build and install a debug APK, how to pair and add a printer, what works offline, and what is not built yet (Phases 2 to 5). In the spec, update: the guard test's location (`tools/`), `createBill`'s `id` and `tzOffsetMinutes`, and the financial year taken from the device offset. The handoff note records what was built, the device results, anything pending because no phone or printer was attached, and "Next: the Phase 2 spec addendum, then its plan."

- [ ] **Step 4: Final verification**

Run: `npm test`, `npm run typecheck`, `npm run build:desktop`, `node tools/build-cafe-android.mjs`.
Expected: all pass with no failures beyond the Step 1 baseline of Task 1.

- [ ] **Step 5: One review of the whole branch**

Use superpowers:requesting-code-review once, on `main...feat/cafe-mobile`, pointing the reviewer at the Review Focus list. Fix what it finds, re-run Step 4.

- [ ] **Step 6: Commit** `feat(cafe): settings, operations guide and Phase 1 handover`, then tell the user Phase 1 is ready and offer the next steps together: push, open a PR, and start the Phase 2 spec in a new session.
