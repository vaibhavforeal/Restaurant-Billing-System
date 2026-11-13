# MasalaPOS Cafe Phase 2: Counter Extras Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task, inline. Do not use subagent-driven-development (see `CLAUDE.md`: tasks here build on each other). Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Two sessions.** Session 2A is Tasks 1-9 and ends with a commit and the handover note (Task 9). Session 2B is Tasks 10-15 and starts by reading that note. Do not start 2B in the 2A session.

**Goal:** The phone till handles several staff with PINs and roles, Takeaway or Delivery, customers, held carts, a kitchen slip, add-ons, offers and sharing a bill as an image, all offline.

**Architecture:** Every rule lives in `packages/cafe-data` (tested in Node on `better-sqlite3`) and reuses the domain's add-on, offer and RBAC code; `packages/print` gains two optional fields; `apps/cafe-android` adds screens and sheets that call `cafe-data`. Migration 4 carries all of 2A's schema, migration 5 all of 2B's.

**Tech Stack:** As Phase 1 (TypeScript, zod 4, vitest 4, Expo SDK 58, Expo Router, expo-sqlite), plus `@noble/hashes` (2A) and `react-native-view-shot` and `expo-sharing` (2B).

**Spec:** `docs/superpowers/specs/2026-11-13-cafe-mobile-phase-2-design.md` (the addendum; read it first), with the parent `docs/superpowers/specs/2026-11-13-cafe-mobile-design.md` for the rules it builds on. Phase 1's handover: `docs/agents/handoff/2026-11-13-cafe-mobile-phase-1.md`.

## Global Constraints

- Work only in the worktree `E:\Softwares\masalapos-cafe` on branch `feat/cafe-mobile`. Never edit the main checkout.
- Each session runs on Opus 5.5 and executes inline. Do not switch models mid-session.
- Money is integer paise; times epoch ms; percentages as basis points (10000 = 100%).
- New synced tables have `id` (UUIDv7 via `uuidv7` from `@masalapos/domain/id`), `updated_at`, `deleted_at`, and deletes are soft. `held_carts` is the only new table that is not synced.
- Code the phone can reach never imports the `@masalapos/domain` root, `db.ts`, `better-sqlite3` or `node:` modules; `tools/phone-safe-imports.test.ts` must stay green.
- Windows POS output must not change: `packages/print` and `apps/server` suites pass unchanged, and each new optional field has a test showing that bills without it print the same bytes.
- PINs are 4 to 6 digits. Roles are `owner`, `manager`, `cashier` with exactly the permission table in the spec.
- Text limits: staff name 30, customer name 60, address note and delivery note 200, line note 60, hold note 40.
- Touch targets at least 48 dp; every new sheet works in the phone and the tablet (840 dp and wider) layout.
- Install Expo packages with `npx expo install <name>`. Check current docs before using a library API (context7: `/expo/expo`, and the library's own id for `@noble/hashes` and `react-native-view-shot`).
- **DEVICE** steps need the phone. The build machine is a VM: reach the phone over Tailscale (`adb connect <phone-ts-ip>:<port>` after `adb pair`), or build `node tools/build-cafe-android.mjs --standalone` and send the APK with Taildrop (see `docs/operations/cafe-app.md`). If no phone is reachable, finish the rest of the task, list the check in the handover note, and tell the user.
- A test shown as a name with a comment is written in full with exactly the assertions the comment states.
- Commit at the end of each task (`feat(cafe): ...`, `fix(cafe): ...`). Do not push or open a PR unless asked.
- Verification at the end of every task: `npx vitest run packages/cafe-data packages/print apps/cafe-android tools/phone-safe-imports.test.ts` and `npm run typecheck`. Tasks that touch `packages/print` also run `npm test`.

## Review Focus

Failure modes the spec implies but no feature test is aimed at. Each is pinned by a test in the task named.

1. **A cashier bypasses the discount limit by sending a bill straight to `createBill`** (or a stale approval). `createBill` itself checks the discount against the staff member's role and the approver's, and refuses with `approval_needed` (Task 4).
2. **The last owner is demoted or deactivated, including by an owner editing themselves.** Refused with `last_owner`, and a cafe with no active owner sends the app to Set owner PIN (Tasks 2 and 6).
3. **A held cart whose item, variant, custom line or customer was deleted meanwhile.** Opening it keeps the other lines, names the missing ones, and drops a deleted customer with a message, never a crash (Tasks 3 and 7).
4. **An offer that would discount an add-on line or a custom line.** Item offers never target custom lines; add-on lines are offer lines with their own item and category; a bill offer counts both towards its minimum (Task 12).
5. **The same phone typed as `+91 98765 43210`, `098765 43210` and `9876543210`.** All normalise to one customer; the second save is `phone_taken` with the existing customer's id (Task 3).

## File Structure

```
packages/cafe-data/src/
  migrations/004-counter.ts       create (2A schema)      migrations/005-addons-offers.ts   create (2B schema)
  pin-hash.ts                     create: PBKDF2 hash, verify, legacy SHA-256 check
  roles.ts                        create: cafe roles and permission checks
  staff.ts                        create: staff repository
  counter-settings.ts             create: cashier limit, lock time, kitchen slip, served-by switch
  customers.ts                    create                   held.ts      create: held carts
  bills.ts                        modify: staff, customer, order kind, notes (2A); add-ons, offers, pricedAt (2B)
  reports.ts                      modify: by staff, by order kind (2A); by offer (2B)
  addons.ts  offers.ts            create (2B)
  time.ts                         modify: cafeOfferClock (2B)
  cafe.ts                         modify: drop ownerPinHash / setOwnerPinHash
  menu.ts                         modify: addon_only, item deletion clears add-on options (2B)
  testing/fixtures.ts             modify: staff in the fixtures
packages/print/src/templates.ts   modify: KotSlipCtx.token, KotSlipCtx.note
packages/print/src/receipt.ts     modify: deliveryNote on slip and HTML
packages/domain/src/billing.ts    modify: ReceiptSnapshot.deliveryNote
apps/cafe-android/src/
  staff/session.ts  staff/useApproval.tsx  staff/ApproveSheet.tsx  staff/StaffPicker.tsx      create
  app/lock.tsx  app/set-owner.tsx  app/more/staff.tsx  app/more/customers.tsx  app/customer/[id].tsx  create
  bill/CustomerSheet.tsx  bill/HoldSheet.tsx  bill/HeldList.tsx  bill/LineNoteSheet.tsx  bill/ItemSheet.tsx  create
  bill/OffersStrip.tsx  share/share-receipt.ts  print/kitchen-slip.ts  offers/describe.ts           create
  app/menu/addon-groups.tsx  app/menu/addon-group.tsx  app/menu/offers.tsx  app/menu/offer.tsx    create
  cart/cart-store.ts  cart/cart.ts  payment/complete.ts  security/pin-attempts.ts  dates.ts         modify
  bill/VariantSheet.tsx                                                                              delete (replaced by ItemSheet, Task 13)
  security/pin.ts  security/useOwnerConfirm.tsx  security/PinPrompt.tsx                              delete (Task 6)
```

---

# Session 2A

### Task 1: Migration 4, PIN hashing and roles

**Files:**
- Create: `packages/cafe-data/src/migrations/004-counter.ts`, `packages/cafe-data/src/pin-hash.ts`, `packages/cafe-data/src/roles.ts`
- Modify: `packages/cafe-data/src/migrations/index.ts`, `packages/cafe-data/src/index.ts`, `packages/cafe-data/package.json` (add `@noble/hashes`; also add it to `apps/cafe-android/package.json` so Metro resolves it)
- Test: `packages/cafe-data/src/migrations/004-counter.test.ts`, `pin-hash.test.ts`, `roles.test.ts`

**Interfaces:**
- Consumes: `Migration` from `migrate.ts`; `can`, `withinDiscountCap`, `Role` from `@masalapos/core`; `uuidv7`.
- Produces:

```ts
// pin-hash.ts
export const PIN_HASH_ITERATIONS: number;            // start 50_000; Task 6 sets the final value from the phone
export function isValidPin(pin: string): boolean;    // /^\d{4,6}$/
export function hashPin(pin: string, opts?: { iterations?: number; salt?: Uint8Array }): Promise<string>;
export function verifyPin(pin: string, stored: string, legacy?: { deviceId: string }): Promise<{ ok: boolean; rehash: boolean }>;
// roles.ts
export type CafeRole = "owner" | "manager" | "cashier";
export const CAFE_ROLES: readonly CafeRole[];
export type CafePermission = "bills.create" | "bills.print" | "bills.discount" | "bills.refund" | "customers.manage"
  | "reports.read" | "catalog.manage" | "printers.manage" | "staff.manage" | "settings.manage";
export function cafeCan(role: CafeRole, permission: CafePermission): boolean;
export function discountAllowed(role: CafeRole, discountPaise: number, subtotalPaise: number, cashierDiscountBp: number): boolean;
```

Migration 4 (version 4), one statement per `db.run`:
- `staff (id, name, role CHECK IN ('owner','manager','cashier'), pin_hash TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, sort INTEGER NOT NULL, updated_at, deleted_at)`.
- `customers (id, name, phone TEXT NOT NULL, address_note TEXT NOT NULL DEFAULT '', updated_at, deleted_at)` and `CREATE UNIQUE INDEX customers_phone ON customers (phone) WHERE deleted_at IS NULL`.
- `held_carts (id PRIMARY KEY, cart_json TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', staff_id TEXT, created_at INTEGER NOT NULL)`.
- `bills` + `staff_id TEXT`, `approved_by TEXT`, `customer_id TEXT`, `order_kind TEXT NOT NULL DEFAULT 'takeaway' CHECK (order_kind IN ('takeaway','delivery'))`, `delivery_note TEXT`. `bill_voids` + `staff_id TEXT`. `bill_lines` + `note TEXT`.
- `cafe` + `cashier_discount_bp INTEGER NOT NULL DEFAULT 0`, `lock_after_minutes INTEGER NOT NULL DEFAULT 5`, `kitchen_slip TEXT NOT NULL DEFAULT 'off' CHECK (kitchen_slip IN ('off','kitchen','receipt'))`, `show_served_by INTEGER NOT NULL DEFAULT 0`.
- When `cafe.owner_pin_hash` is set, insert one staff row: `uuidv7()`, name `Owner`, role `owner`, that hash, sort 1, `updated_at` = the cafe row's `updated_at`.

Hash format: `pbkdf2-sha256$<iterations>$<salt base64>$<hash base64>`, 16-byte salt from `crypto.getRandomValues`, 32-byte key, `pbkdf2Async` from `@noble/hashes`. A stored value without the `pbkdf2-sha256$` prefix is the Phase 1 form: lowercase hex SHA-256 of `` `${deviceId}:${pin}` `` (compute with `@noble/hashes` SHA-256); it verifies only when `legacy` is given, and then `rehash` is true. `rehash` is also true when the stored iteration count is below `PIN_HASH_ITERATIONS`. Comparison is constant-time over equal-length bytes.

Roles: `owner` is `["*"]`; `manager` holds everything but `staff.manage` and `settings.manage`; `cashier` holds `bills.create`, `bills.print`, `customers.manage`. `cafeCan` builds the `Role` and calls `can`. `discountAllowed`: true for a zero discount or when the role holds `bills.discount`; otherwise `withinDiscountCap` with `limits.max_discount_percent = cashierDiscountBp / 100` and percent `= discountPaise * 100 / subtotalPaise`.

- [ ] **Step 1: Write the failing tests.**

```ts
// 004-counter.test.ts
it("migrates an empty database to version 4 with the new tables and columns", () => { /* user_version 4; staff, customers, held_carts exist; bills.order_kind defaults 'takeaway'; cafe.kitchen_slip defaults 'off' */ });
it("turns a Phase 1 owner PIN into an owner staff row", () => { /* migrate to 3, saveCafe, set owner_pin_hash 'abc', migrate -> one staff row: name Owner, role owner, pin_hash 'abc', active 1 */ });
it("adds no staff when there was no owner PIN", () => { /* staff empty */ });
// pin-hash.test.ts
it("verifies the PIN it hashed and refuses another", async () => { /* iterations 1000 for speed; ok true/false; rehash false */ });
it("salts each hash differently", async () => { /* two hashes of '1234' differ */ });
it("accepts a Phase 1 hash once and asks for a rehash", async () => { /* stored = sha256 hex of 'dev1:1234' (node:crypto in the test); verifyPin('1234', stored, { deviceId: 'dev1' }) -> { ok: true, rehash: true }; without legacy -> ok false */ });
it("asks for a rehash when the stored count is below the current one", async () => { /* hash with iterations 1000 -> rehash true */ });
it("rejects malformed stored values without throwing", async () => { /* 'pbkdf2-sha256$x$y' -> ok false */ });
it.each([["123", false], ["1234", true], ["123456", true], ["1234567", false], ["12a4", false]])("isValidPin(%s) is %s", ...);
// roles.test.ts
it.each(TABLE)("%s %s %s", (role, permission, allowed) => { /* every cell of the spec's role table */ });
it("lets a cashier give a discount up to the cafe's limit and not above it", () => { /* bp 500: 500 of 10000 true, 501 false; bp 0: 0 true, 1 false */ });
it("lets a manager and an owner give any discount", () => { /* 10000 of 10000 true */ });
```

- [ ] **Step 2: Run and confirm they fail:** `npx vitest run packages/cafe-data/src/migrations packages/cafe-data/src/pin-hash.test.ts packages/cafe-data/src/roles.test.ts`
- [ ] **Step 3: Implement** the three files to the interfaces and decisions above; register migration 4; export the new names from `index.ts`.
- [ ] **Step 4: Verify** (global verification line). The phone-safe guard must pass with `@noble/hashes`.
- [ ] **Step 5: Commit** `feat(cafe): migration 4, PBKDF2 staff PINs and cafe roles`

---

### Task 2: Staff and counter settings

**Files:**
- Create: `packages/cafe-data/src/staff.ts`, `packages/cafe-data/src/counter-settings.ts`
- Modify: `packages/cafe-data/src/cafe.ts` (remove `ownerPinHash`, `setOwnerPinHash`), `packages/cafe-data/src/index.ts`
- Test: `packages/cafe-data/src/staff.test.ts`, `counter-settings.test.ts`

**Interfaces:**
- Consumes: `CafeRole` (Task 1); `dataChanged`.
- Produces:

```ts
export interface Staff { id: string; name: string; role: CafeRole; active: boolean; sort: number }
export type StaffErrorCode = "invalid" | "not_found" | "last_owner";
export class StaffError extends Error { constructor(readonly code: StaffErrorCode, message: string) }
export function listStaff(db: SqlDriver, opts?: { includeInactive?: boolean }): Staff[];   // by sort, then name
export function getStaff(db: SqlDriver, id: string): Staff | null;                        // includes inactive
export function staffPinHash(db: SqlDriver, id: string): string | null;
export function addStaff(db: SqlDriver, input: { name: string; role: CafeRole; pinHash: string }, now: number): Staff;
export function updateStaff(db: SqlDriver, id: string, change: { name?: string; role?: CafeRole; active?: boolean }, now: number): Staff;
export function setStaffPinHash(db: SqlDriver, id: string, pinHash: string, now: number): void;
export function hasActiveOwner(db: SqlDriver): boolean;

export interface CounterSettings { cashierDiscountBp: number; lockAfterMinutes: number; kitchenSlip: "off" | "kitchen" | "receipt"; showServedBy: boolean }
export const CounterSettingsInput: z.ZodType<CounterSettings>;  // bp 0..10000; minutes one of 0, 1, 2, 5, 10, 15, 30
export function getCounterSettings(db: SqlDriver): CounterSettings;   // defaults when no cafe row
export function saveCounterSettings(db: SqlDriver, input: unknown, now: number): CounterSettings;
```

Decisions: names trimmed, 1 to 30 characters, else `invalid`. A new person gets `sort` = max + 1. `updateStaff` refuses with `last_owner` when the change would leave no active, undeleted owner. `kitchenSlip: "kitchen"` is allowed to save without a kitchen printer (the screen disables it; printing falls back to nothing and says so).

- [ ] **Step 1: Write the failing tests.**

```ts
it("adds staff in order and lists only active ones by default", () => { /* add owner, cashier, manager; deactivate cashier; listStaff -> owner, manager; includeInactive -> all three */ });
it("refuses a blank or over-long name", () => { /* '' and 31 chars -> invalid */ });
it("refuses to demote or deactivate the last owner", () => { /* one owner: role cashier -> last_owner; active false -> last_owner; with two owners both allowed once */ });
it("stores and reads a PIN hash", () => { /* setStaffPinHash then staffPinHash */ });
it("reports whether an active owner exists", () => { /* false on empty; true after addStaff owner */ });
it("reads defaults before any save and round-trips counter settings", () => { /* defaults {0,5,'off',false}; save {500,10,'receipt',true} -> read back */ });
it.each([[{ cashierDiscountBp: 10001 }], [{ lockAfterMinutes: 7 }], [{ kitchenSlip: "both" }]])("refuses counter settings %j", ...);
```

- [ ] **Step 2: Run and confirm they fail.**
- [ ] **Step 3: Implement** both files; delete the owner-PIN functions from `cafe.ts` and fix their callers' imports only as far as `cafe-data` (the app is changed in Task 6; until then `npm run typecheck` may fail in `apps/cafe-android` only, which Task 6 fixes; note this in the commit message).
- [ ] **Step 4: Verify** with `npx vitest run packages/cafe-data`.
- [ ] **Step 5: Commit** `feat(cafe): staff and counter settings in cafe-data`

---

### Task 3: Customers and held carts

**Files:**
- Create: `packages/cafe-data/src/customers.ts`, `packages/cafe-data/src/held.ts`
- Modify: `packages/cafe-data/src/index.ts`
- Test: `packages/cafe-data/src/customers.test.ts`, `held.test.ts`

**Interfaces:**
- Produces:

```ts
// customers.ts
export interface Customer { id: string; name: string; phone: string; addressNote: string }
export type CustomerErrorCode = "invalid" | "phone_taken" | "not_found";
export class CustomerError extends Error { constructor(readonly code: CustomerErrorCode, message: string, readonly existingId?: string) }
export function normalisePhone(raw: string): string | null;
export function saveCustomer(db: SqlDriver, input: { id?: string; name: string; phone: string; addressNote?: string }, now: number): Customer;
export function getCustomer(db: SqlDriver, id: string): Customer | null;               // live rows only
export function findCustomers(db: SqlDriver, query: string, limit?: number): Customer[]; // default limit 20
export function deleteCustomer(db: SqlDriver, id: string, now: number): void;
export const maskPhone = (phone: string): string;                                       // "******" + last four
// held.ts
export const HeldCartSchema: z.ZodType<HeldCart>;
export interface HeldLine { itemId: string | null; variantId: string | null; qty: number;
  custom?: { name: string; pricePaise: number; gstRate: number | null }; note?: string | null; addonOptionIds?: string[] }
export interface HeldCart { lines: HeldLine[]; discount: { kind: "amount"; paise: number } | { kind: "percent"; bp: number } | null;
  discountNote: string; orderKind: "takeaway" | "delivery"; deliveryNote: string; customerId: string | null; removedOfferIds: string[] }
export interface HeldSummary { id: string; note: string; staffName: string | null; lineCount: number; createdAt: number }
export function holdCart(db: SqlDriver, input: { id: string; cart: HeldCart; note: string; staffId: string | null; now: number }): void;
export function listHeld(db: SqlDriver): HeldSummary[];           // oldest first
export function takeHeld(db: SqlDriver, id: string): HeldCart | null; // reads, parses and deletes in one transaction
export function deleteHeld(db: SqlDriver, id: string): void;
```

Decisions: `normalisePhone` strips spaces, dashes and brackets, then a leading `+91`, `91` (only when 12 digits) or `0` (only when 11 digits), and accepts exactly 10 digits starting 6-9; anything else is null, which `saveCustomer` reports as `invalid` "Enter a 10-digit mobile number". A save whose phone belongs to another live customer is `phone_taken` with `existingId`. `findCustomers` matches the digits of the query anywhere in the phone (when it has 3+ digits) or the name, case-insensitive, live rows, by name. `HeldCart.lines[].addonOptionIds` and `removedOfferIds` default to `[]` (used in 2B). The hold note is trimmed to 40 characters. `takeHeld` on a row that fails the schema deletes it and returns null.

- [ ] **Step 1: Write the failing tests.**

```ts
it.each([["+91 98765 43210"], ["098765-43210"], ["9876543210"], ["919876543210"]])("normalises %s to 9876543210", ...);
it.each([["12345"], ["5876543210"], ["+1 415 555 0100"]])("refuses %s", ...);
it("refuses a second customer with the same phone and names the first", () => { /* phone_taken, existingId = first.id */ });
it("lets a deleted customer's phone be used again", () => { /* delete, save new with same phone -> ok */ });
it("finds customers by part of the phone or the name", () => { /* '4321' and 'ash' */ });
it("masks a phone to its last four digits", () => { /* '******3210' */ });
it("holds carts and lists them oldest first with the holder's name and line count", () => { /* two holds; staffName from staff table */ });
it("takes a held cart once", () => { /* takeHeld returns cart, second call null, listHeld empty */ });
it("drops a held cart that no longer parses", () => { /* write bad cart_json directly; takeHeld -> null and row gone */ });
```

- [ ] **Step 2: Run and confirm they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Verify** with `npx vitest run packages/cafe-data`.
- [ ] **Step 5: Commit** `feat(cafe): customers and held carts in cafe-data`

---

### Task 4: Bills with staff, approvals, customers, order kind and notes; the report

**Files:**
- Modify: `packages/cafe-data/src/bills.ts`, `packages/cafe-data/src/reports.ts`, `packages/cafe-data/src/testing/fixtures.ts`, `packages/domain/src/billing.ts` (only the `deliveryNote?: string` field on `ReceiptSnapshot`, with a doc comment)
- Test: `packages/cafe-data/src/bills.test.ts`, `void.test.ts`, `reports.test.ts`

**Interfaces:**
- Consumes: Tasks 1-3.
- Produces (changes only):

```ts
export type BillErrorCode = /* Phase 1 codes */ | "unknown_staff" | "unknown_customer" | "approval_needed" | "not_allowed";
export interface CartLine { itemId: string | null; variantId: string | null; qty: number;
  custom?: { name: string; pricePaise: number; gstRate: number | null }; note?: string | null }
export interface CreateBillInput { /* Phase 1 fields */ staffId: string; approvedBy: string | null; customerId: string | null;
  orderKind: "takeaway" | "delivery"; deliveryNote: string | null }
export interface CafeBill extends Bill { /* Phase 1 fields */ staffId: string | null; staffName: string | null; approvedBy: string | null;
  customerId: string | null; orderKind: "takeaway" | "delivery"; deliveryNote: string | null }
export interface KitchenLine { name: string; qty: number; note: string | null; addonOf: number | null } // addonOf: index of the dish line (2B)
export function kitchenLines(db: SqlDriver, billId: string): KitchenLine[];
export function voidBill(db: SqlDriver, input: { billId: string; reason: string; staffId: string; now: number; tzOffsetMinutes: number }): CafeBill;
// reports.ts
export interface DaySummary { /* Phase 1 fields */
  byStaff: Array<{ staffId: string | null; name: string; billCount: number; totalPaise: number }>;   // largest total first
  byOrderKind: { takeaway: { billCount: number; totalPaise: number }; delivery: { billCount: number; totalPaise: number } } }
```

Decisions:
- `staffId` must be an active staff row, else `unknown_staff`. `approvedBy`, when set, must be an active staff row holding `bills.discount`, else `approval_needed`. When `discountAllowed(staff.role, discountPaise, subtotalPaise, counter.cashierDiscountBp)` is false and there is no valid approver, the error is `approval_needed`. These checks run before any number is taken.
- `customerId`, when set, must be a live customer, else `unknown_customer`.
- `deliveryNote` is trimmed, cut to 200, stored only for `delivery` (null for takeaway). Line `note` is trimmed, cut to 60, empty becomes null.
- Receipt snapshot: `orderTypeKind` = `orderKind`, `orderTypeName` `"Takeaway"` or `"Delivery"`, `deliveryNote` when set, `servedBy` = staff name, `customer: { name, phone: maskPhone(phone) }` when set, `billShow: { ...DEFAULT_BILL_SHOW, servedBy: counter.showServedBy }`. Line notes are not in the receipt.
- `voidBill` requires `staffId` to be an active staff row holding `bills.refund`, else `not_allowed`; it stores it in `bill_voids.staff_id`.
- `fixtures.ts`: `menuCafe()` also adds `owner` ("Asha", owner) and `cashier` ("Ravi", cashier) with pin hash `"x"`, and returns them; `threeBillDay()` bills as the owner. Update existing tests to pass `staffId: owner.id, approvedBy: null, customerId: null, orderKind: "takeaway", deliveryNote: null`; their expected values do not change.

- [ ] **Step 1: Write the failing tests.**

```ts
it("records who made the bill and puts their name in the snapshot", () => { /* staffId cashier; bill.staffName 'Ravi'; receipt.servedBy 'Ravi'; billShow.servedBy false by default, true after saveCounterSettings showServedBy */ });
it("refuses a bill from unknown or inactive staff", () => { /* unknown_staff; nothing written */ });
it("refuses a cashier discount above the limit without approval, and takes it with a manager's", () => { /* limit 500bp; 10% -> approval_needed; approvedBy manager -> ok, approved_by stored; approvedBy another cashier -> approval_needed */ });
it("takes a cashier discount within the limit with no approval", () => { /* 5% on limit 500 */ });
it("stores a delivery bill's kind and note and prints them in the snapshot", () => { /* orderKind delivery, note ' Flat 4 ' -> 'Flat 4'; receipt orderTypeKind 'delivery', orderTypeName 'Delivery', deliveryNote 'Flat 4' */ });
it("drops a delivery note on a takeaway bill", () => { /* note given with takeaway -> null, no deliveryNote in receipt */ });
it("attaches a customer with a masked phone", () => { /* receipt.customer { name, phone '******3210' }; bill.customerId */ });
it("refuses a deleted customer", () => { /* unknown_customer */ });
it("stores line notes and gives them back for the kitchen", () => { /* note ' less sugar ' -> kitchenLines [{ name, qty, note: 'less sugar', addonOf: null }] */ });
// void.test.ts
it("lets a manager void and records them", () => { /* bill_voids.staff_id */ });
it("refuses a void by a cashier", () => { /* not_allowed; no void row */ });
// reports.test.ts
it("totals live bills by staff and by order kind", () => { /* 2 cashier takeaway bills, 1 owner delivery, 1 voided cashier bill -> byStaff Ravi 2 / Asha 1; byOrderKind counts and totals exclude the void */ });
```

- [ ] **Step 2: Run and confirm they fail.**
- [ ] **Step 3: Implement.** Keep the Phase 1 rule: every check before any `nextSequence`.
- [ ] **Step 4: Verify** with `npx vitest run packages/cafe-data` and `npm test` (the domain type change).
- [ ] **Step 5: Commit** `feat(cafe): bills record staff, approvals, customers, order kind and line notes`

---

### Task 5: Token kitchen slip and delivery note in print

**Files:**
- Modify: `packages/print/src/templates.ts`, `packages/print/src/receipt.ts`
- Test: `packages/print/src/templates.test.ts`, `packages/print/src/receipt.test.ts`

**Interfaces:**
- Produces: `KotSlipCtx.token?: number` and `KotSlipCtx.note?: string | null`. `receiptSlip` and `receiptHtml` print `receipt.deliveryNote`.

Decisions: with `token` set, the first heading line is `TOKEN <n>` (double size, as `KOT #n` is) and `kotNo` is not printed. `note` prints after the items, after a rule, as `Note: <text>` wrapped to the paper width. On the receipt, `deliveryNote` prints on the line after the order line (`DELIVERY`) as `Deliver to: <text>`, and in the HTML under the order row as a `<p class="delivery-note">`.

- [ ] **Step 1: Write the failing tests.**

```ts
it("heads a kitchen slip with the token when one is given", () => { /* decoded text contains 'TOKEN 7' and not 'KOT #' */ });
it("prints a slip note after the items", () => { /* 'Note: Flat 4, ring twice' after the last item line */ });
it("prints a Windows KOT exactly as before", () => { /* existing ctx without token/note: bytes equal the stored snapshot (the existing snapshot test must still pass untouched) */ });
it("prints the delivery note under the order line on the slip and in HTML", () => { /* 'Deliver to: Flat 4' ; html contains class="delivery-note" */ });
it("prints a bill without a delivery note exactly as before", () => { /* existing receipt snapshots unchanged */ });
```

- [ ] **Step 2: Run and confirm they fail:** `npx vitest run packages/print`
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Verify** with `npm test` and `npm run typecheck` (whole repo: the server imports these).
- [ ] **Step 5: Commit** `feat(print): token heading and note on the kitchen slip, delivery note on the receipt`

---

### Task 6: Lock screen, staff sessions, approvals and the Staff screen

**Files:**
- Create: `apps/cafe-android/src/staff/session.ts` (+ `session.test.ts`), `staff/StaffPicker.tsx`, `staff/ApproveSheet.tsx`, `staff/useApproval.tsx`, `src/app/lock.tsx`, `src/app/set-owner.tsx`, `src/app/more/staff.tsx`
- Modify: `src/app/index.tsx`, `src/app/_layout.tsx`, `src/app/first-run.tsx`, `src/app/self-check.tsx`, `src/app/(tabs)/_layout.tsx`, `(tabs)/bill.tsx` (Switch staff), `(tabs)/more.tsx`, `(tabs)/reports.tsx`, `(tabs)/menu.tsx`, `src/app/more/{cafe,tax,receipt,printers,pin}.tsx`, `src/app/bill/[id].tsx` (void), `security/pin-attempts.ts` (+ test)
- Delete: `security/pin.ts`, `security/useOwnerConfirm.tsx`, `security/PinPrompt.tsx`, `src/app/more/pin.tsx` (its job moves to the Staff screen)

**Interfaces:**
- Consumes: Tasks 1-2.
- Produces:

```ts
// staff/session.ts
export interface Session { staff: Staff | null; lastTouch: number }
export function createSessionStore(now: () => number): {
  get(): Session; subscribe(fn: () => void): () => void;
  signIn(staff: Staff): void; signOut(): void; touch(): void;
  shouldLock(lockAfterMinutes: number): boolean };   // false when lockAfterMinutes is 0 or nobody is signed in
export const session: ReturnType<typeof createSessionStore>;
export function useCurrentStaff(): Staff | null;
export function useCan(permission: CafePermission): boolean;
// staff/useApproval.tsx
export function useApproval(): { approve(permission: CafePermission, opts: { title: string; always?: boolean }): Promise<string | null>; sheet: ReactNode };
// security/pin-attempts.ts
export const staffPinAttempts: (db: SqlDriver, staffId: string) => ReturnType<typeof createPinAttempts>; // keys pin:<staffId>:wrong|locks|lockedAt|lockedUntil
```

Behaviour:
- `index.tsx` routes: no cafe → `/first-run`; cafe but `!hasActiveOwner` → `/set-owner`; nobody signed in → `/lock`; else `/bill`.
- First run's PIN step also asks "Your name" (default "Owner") and creates the owner with `addStaff`, then signs them in. `/set-owner` asks name and PIN twice, creates an owner, signs in.
- `/lock`: `StaffPicker` tiles of active staff (name and role), then the keypad. `verifyPin(pin, hash, { deviceId })`; on `rehash` store a new `hashPin`. Wrong tries use `staffPinAttempts`. On success `session.signIn` and `router.replace("/bill")`.
- Idle lock: the root layout wraps the stack in a `View` with `onTouchStart={() => session.touch()}`; an `AppState` listener, on `active`, calls `session.shouldLock(getCounterSettings(db).lockAfterMinutes)` and if true signs out and replaces to `/lock`. **Switch staff** (Bill header and More) signs out and goes to `/lock`.
- `useApproval().approve(permission, { title, always })`: resolves the current staff id at once when they hold the permission and `always` is not set; otherwise opens `ApproveSheet` listing active staff with that permission (picker, then PIN, with lockout), resolving the approver's id, or null on cancel.
- Gates: Reports tab and Menu tab call `approve("reports.read" | "catalog.manage")` on focus and go back to Bill on null. More shows Staff only with `staff.manage`; Cafe details, Tax and Receipt save with `approve("settings.manage", { always: true })` (keeps the Phase 1 rule that a save asks the owner's PIN); Printers needs `printers.manage`. Void uses `approve("bills.refund")` and passes the id as `staffId`.
- Staff screen (owner): list with role; add (name, role, PIN twice); edit name/role; **Reset PIN** (PIN twice); **Deactivate**. `StaffError` messages shown inline; the last-owner message is "The cafe needs at least one owner".
- Self-check gains a line "PIN check: <ms> ms" timing one `hashPin("1234")`.

- [ ] **Step 1: Write the failing tests** (`session.test.ts`, `pin-attempts.test.ts`).

```ts
it("locks only after the idle time and only when someone is signed in", () => { /* fake clock; signIn; +4m59s false; +5m true; minutes 0 -> never */ });
it("touch restarts the idle time", () => { /* +4m, touch, +4m -> false */ });
it("signOut clears the staff and notifies subscribers", () => { ... });
it("keeps each person's wrong tries apart", () => { /* staffPinAttempts(db,'a') five wrong -> locked; 'b' not locked; survives a new instance */ });
```

- [ ] **Step 2: Run and confirm they fail:** `npx vitest run apps/cafe-android/src/staff apps/cafe-android/src/security`
- [ ] **Step 3: Implement** the files and behaviour above.
- [ ] **Step 4: Verify** (global line; `npm run typecheck` is clean again).
- [ ] **Step 5: DEVICE.** Install, open Self-check, read the PIN check time. Set `PIN_HASH_ITERATIONS` in `pin-hash.ts` to the largest multiple of 10,000 that keeps it at or under 300 ms (never below 20,000), rebuild, and record the phone model, count and time in the commit message. Then: first run creates the owner; add a cashier; sign in as the cashier; Reports asks for a manager or owner PIN; set lock time to 1 minute, background the app for 70 s, reopen: lock screen; five wrong PINs for the cashier lock only the cashier.
- [ ] **Step 6: Commit** `feat(cafe): staff lock screen, approvals and the Staff screen`

---

### Task 7: The cart: order kind, customer, line notes, discount approval, hold

**Files:**
- Create: `apps/cafe-android/src/bill/CustomerSheet.tsx`, `bill/HoldSheet.tsx`, `bill/HeldList.tsx`, `bill/LineNoteSheet.tsx`, `src/app/more/customers.tsx`, `src/app/customer/[id].tsx`
- Modify: `cart/cart-store.ts` (+ test), `cart/cart.ts` (+ test), `bill/CartPanel.tsx`, `(tabs)/bill.tsx`, `src/app/payment.tsx`, `payment/complete.ts` (+ test), `(tabs)/more.tsx`

**Interfaces:**
- Consumes: Tasks 3, 4, 6.
- Produces (cart-store additions):

```ts
export interface CartEntry { /* Phase 1 */ note: string | null }
export interface CartSnapshot { /* Phase 1 */ orderKind: "takeaway" | "delivery"; deliveryNote: string;
  customer: { id: string; name: string; phone: string } | null; approvedBy: string | null }
// store methods added
setOrderKind(kind: "takeaway" | "delivery"): void;  setDeliveryNote(text: string): void;
setCustomer(c: { id: string; name: string; phone: string; addressNote: string } | null): void; // fills an empty delivery note from addressNote when Delivery
setLineNote(key: string, note: string | null): void;  setApproval(staffId: string | null): void; // cleared by any discount change
toHeld(): HeldCart;  load(held: HeldCart, entries: CartEntry[], customer: CartSnapshot["customer"]): void;
// cart.ts
export function entriesFromHeld(db: SqlDriver, held: HeldCart): { entries: CartEntry[]; missing: string[]; customer: CartSnapshot["customer"]; customerMissing: boolean };
```

Behaviour:
- Cart header: Takeaway | Delivery switch; with Delivery a one-line note field (200). **Customer** button opens `CustomerSheet`: search as you type with `findCustomers`; **Add customer** form (name, phone, address note) using `saveCustomer`; on `phone_taken` it offers "Use <name>". The chosen customer shows as a chip with remove.
- Long press on a cart line opens `LineNoteSheet` (60 characters, quick chips "Less sugar", "No onion", "Extra hot" are plain text the cashier can edit).
- Discount: on applying a discount, if `!discountAllowed(current.role, ...)`, call `approve("bills.discount", { title: "Approve discount" })`; on an id, `setApproval(id)`; on null, the discount is not applied and the banner says "A manager or the owner must approve this discount".
- Payment passes `staffId: current.id`, `approvedBy`, `customerId`, `orderKind`, `deliveryNote` and line notes to `createBill` via `completePayment`. After Paid, `clear()` resets kind to Takeaway, customer, notes and approval.
- **Hold** (cart has lines) opens `HoldSheet` (note, 40) → `holdCart(..., cart.toHeld())`, then `clear()`. **Held (n)** opens `HeldList` (`listHeld`, age as "12 min", "yesterday" or the date); opening calls `takeHeld`, then `entriesFromHeld`; if the cart has lines it first asks **Hold this one and open** / **Cancel**. Missing lines are listed in a banner ("Removed: Samosa — no longer on the menu"); a missing customer gives "The customer was deleted".
- More, **Customers**: search list → `customer/[id]` (edit form, delete with confirm, the customer's bills via `listBillsForCustomer` — add `listBillsForCustomer(db, customerId): CafeBill[]` newest first to `bills.ts` with a test in `bills.test.ts`).

- [ ] **Step 1: Write the failing tests.**

```ts
// cart-store.test.ts
it("defaults to Takeaway and resets kind, customer, notes and approval on clear", ...);
it("fills an empty delivery note from the customer's address and leaves a typed one", ...);
it("clears an approval when the discount changes", ...);
it("round-trips a cart through toHeld and load", () => { /* lines with note and custom line, discount, kind, note, customer id */ });
// cart.test.ts
it("rebuilds held lines from the menu and names the ones that are gone", () => { /* deleted item -> missing ['Samosa']; others priced from the menu now */ });
it("reports a deleted customer", ...);
// complete.test.ts
it("passes staff, approval, customer, kind and notes to createBill", ...);
// packages/cafe-data/src/bills.test.ts
it("lists a customer's bills newest first", ...);
```

- [ ] **Step 2: Run and confirm they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Verify** (global line).
- [ ] **Step 5: DEVICE.** Delivery bill for a new customer, address fills the note; line note; cashier 10% discount with limit 5% asks for approval, manager approves; hold a cart, bill another, open the held one; held cart with an item deleted meanwhile shows the banner.
- [ ] **Step 6: Commit** `feat(cafe): order kind, customers, line notes, discount approval and held carts on the Bill screen`

---

### Task 8: Kitchen slip printing

**Files:**
- Create: `apps/cafe-android/src/print/kitchen-slip.ts` (+ test)
- Modify: `payment/complete.ts` (+ test), `bill/TokenScreen.tsx`, `src/app/bill/[id].tsx`, `src/app/more/printers.tsx`

**Interfaces:**
- Consumes: `kitchenLines` (Task 4), `KotSlipCtx.token/note` (Task 5), `getCounterSettings`, `printerFor`.
- Produces:

```ts
export function kitchenSlipBytes(bill: CafeBill, lines: KitchenLine[], paperWidth: 58 | 80, profile?: PrintProfileInput): Uint8Array;
export function kitchenTarget(db: SqlDriver): { printer: Printer } | { reason: "off" | "no_kitchen_printer" | "no_printer" };
// complete.ts: the result gains kitchenJobId: string | null and kitchenProblem: string | null
```

Decisions: the slip uses `kotSlip` with `kotNo: bill.token`, `token: bill.token`, `orderType: "parcel"`, `orderTypeName` "Takeaway"/"Delivery", `tableName: null`, `splitLabel: null`, `note: bill.deliveryNote`, `atMs: bill.createdAt`, items from `kitchenLines` (each `addonOf !== null` line becomes `addon: true` with no `forItem`). `kitchenTarget`: `off` → reason off; `kitchen` → the kitchen-role printer or `no_kitchen_printer`; `receipt` → the receipt printer or `no_printer`. The kitchen job is queued after the receipt job, one copy. Token screen shows "Receipt" and "Kitchen slip" print states, each with its own **Try again**; with `no_kitchen_printer` it says "No kitchen printer. Add one in More, Printers." A bill's screen gets **Reprint kitchen slip** when the setting is not off. More, Printers shows the three-way choice (saved with `saveCounterSettings` behind `approve("settings.manage", { always: true })`), with `kitchen` disabled and the reason shown when no kitchen printer exists.

- [ ] **Step 1: Write the failing tests.**

```ts
it("builds a token kitchen slip with notes, add-ons and the delivery note", () => { /* decode bytes: 'TOKEN 3', the context line 'Delivery' (from orderTypeName), '(less sugar)', 'Note: Flat 4' */ });
it.each([["off", null, "off"], ["kitchen", null, "no_kitchen_printer"], ["receipt", "receipt", "printer"]])("picks the kitchen target for %s", ...);
it("queues the kitchen slip after the receipt and never fails the saved bill", () => { /* complete.test: kitchen send rejects -> bill saved, kitchenProblem set, receipt printed */ });
```

- [ ] **Step 2: Run and confirm they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Verify** (global line).
- [ ] **Step 5: DEVICE.** Setting "receipt printer": Paid prints receipt then `TOKEN n` slip with the line note; printer off → both show Try again, both work after; reprint the kitchen slip from the bill.
- [ ] **Step 6: Commit** `feat(cafe): kitchen slip with the token, printed after the receipt`

---

### Task 9: Phase 1 fixes, Counter settings screen, 2A check and handover

**Files:**
- Modify: `apps/cafe-android/src/dates.ts` (+ test), `(tabs)/bills.tsx`, `(tabs)/reports.tsx`, `src/app/payment.tsx`, `payment/tender.ts` (+ test), `cart/cart-store.ts` (+ test), `bill/CartPanel.tsx`, `(tabs)/more.tsx`, `docs/operations/cafe-app.md`
- Create: `src/app/more/counter.tsx`, `src/start-route.ts` (+ test; `index.tsx` calls it), `docs/agents/handoff/2026-11-13-cafe-mobile-phase-2a.md`

**Interfaces:**
- Produces:

```ts
// dates.ts
export function msUntilNextLocalMidnight(now: number, tzOffsetMinutes: number): number;
export function useToday(): string;   // business date, re-rendering at local midnight
// tender.ts
export function parseAmountPaise(text: string): number | null;   // "120", "120.5", "120.50" -> paise; anything else null
export function splitComplete(totalPaise: number, parts: ReadonlyArray<{ mode: "cash" | "upi" | "card"; amountPaise: number }>): boolean;
// cart-store.ts
export function discountProblem(discount: Discount | null, subtotalPaise: number): string | null; // "The discount is more than the bill"
```

Behaviour:
1. Bills and Reports keep `picked: string | null`; the shown date is `picked ?? useToday()`, so they follow midnight unless a date was picked.
2. Payment's split shows a row per mode (cash, UPI, card), each optional; Paid enables when `splitComplete` (positive parts adding up to the total, each mode at most once). Only the cash row takes "tendered" with change.
3. "Another amount" with `parseAmountPaise` null shows "Enter an amount like 120 or 120.50" and disables Paid.
4. `discountPaiseFor` no longer caps; `discountProblem` drives a cart banner and the discount is not applied while it stands.
5. `/set-owner` (Task 6) already covers the first-run crash; add the test below that proves the route.
- More, **Counter** (owner, `approve("settings.manage", { always: true })` on save): cashier discount limit (percent field → bp), lock after (Never, 1, 2, 5, 10, 15, 30 min), print who served (switch). Kitchen slip stays in Printers.
- `docs/operations/cafe-app.md`: staff and PINs, the lock, approvals, counter settings, kitchen slip; and "If every owner forgets their PIN, the app must be reinstalled until Phase 3 adds Google sign-in. Data on the phone is lost."

- [ ] **Step 1: Write the failing tests.**

```ts
it("counts to the next local midnight in IST", () => { /* 23:59:30 IST -> 30_000 */ });
it.each([["120", 12000], ["120.5", 12050], ["120.50", 12050], ["", null], ["12a", null], ["1.234", null]])("parseAmountPaise(%s)", ...);
it("needs a three-way split to add up with each mode once", () => { /* cash 100 + upi 100 + card 100 of 300 true; two cash rows false; 0 amount false */ });
it("reports a discount above the bill and does not cap it", () => { /* amount 5000 on 3000 -> message; discountPaiseFor -> 5000 */ });
it("sends a cafe without an active owner to Set owner PIN", () => { /* extract the route choice in index.tsx into startRoute({ hasCafe, hasOwner, signedIn }) in src/start-route.ts and test all four outcomes */ });
```

- [ ] **Step 2: Run and confirm they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Verify:** global line, then `npm test` and `npm run build:desktop` (the desktop app must be unaffected).
- [ ] **Step 5: DEVICE, the 2A check** (spec, "2A is done when"), in flight mode with Bluetooth on: the owner adds a cashier; the cashier signs in, makes a Delivery bill for a new customer with a line note, needs a manager's PIN for 10% with the limit at 5%, holds a second cart and opens it; receipt and `TOKEN n` kitchen slip print; the app locks after the idle time; Reports shows staff and order-kind figures. Also: Bills left open across midnight moves to the new day; a three-way split; tablet layout of the new sheets.
- [ ] **Step 6: Write the handover note** `docs/agents/handoff/2026-11-13-cafe-mobile-phase-2a.md`: what was built, the PIN iteration count and timing, each device check with its result, anything pending, and "Next: session 2B, Task 10, on Opus 5.5".
- [ ] **Step 7: Commit** `feat(cafe): Phase 1 fixes, counter settings and the 2A handover`

---

# Session 2B

Start by reading `docs/agents/handoff/2026-11-13-cafe-mobile-phase-2a.md` and the 2B half of the spec.

### Task 10: Migration 5 and add-ons in cafe-data

**Files:**
- Create: `packages/cafe-data/src/migrations/005-addons-offers.ts`, `packages/cafe-data/src/addons.ts`
- Modify: `migrations/index.ts`, `menu.ts`, `index.ts`
- Test: `migrations/005-addons-offers.test.ts`, `addons.test.ts`, `menu.test.ts`

**Interfaces:**
- Consumes: `AddonGroupCreate`, `AddonGroupUpdate`, `AddonGroup`, `AddonOption` from `@masalapos/domain/addons`.
- Produces:

```ts
export function listAddonGroups(db: SqlDriver): AddonGroup[];                  // by sort; options in sort order
export function getAddonGroup(db: SqlDriver, id: string): AddonGroup | null;
export function saveAddonGroup(db: SqlDriver, input: unknown, now: number, id?: string): AddonGroup; // Create schema when new, Update when id given
export function deleteAddonGroup(db: SqlDriver, id: string, now: number): void;  // also detaches it from items
export function groupsForItem(db: SqlDriver, itemId: string): AddonGroup[];     // attached, in attachment order
export function setItemAddonGroups(db: SqlDriver, itemId: string, groupIds: string[], now: number): void;
export class AddonError extends Error { constructor(readonly code: "invalid" | "not_found", message: string) }
// menu.ts
export interface Item { /* Phase 1 */ addonOnly: boolean }   export interface ItemInput { /* Phase 1 */ addonOnly?: boolean }
export function listMenu(db: SqlDriver, opts?: { forBilling?: boolean }): { categories: Category[]; items: Item[] }; // forBilling hides addonOnly
```

Migration 5 (version 5): `addon_groups (id, name, min_picks, max_picks, active, sort, updated_at, deleted_at)` with the domain's CHECKs; `addon_group_options (id, group_id, item_id, variant_id, sort, updated_at, deleted_at)`; `item_addon_groups (id, item_id, group_id, sort, updated_at, deleted_at)` with a unique index on `(item_id, group_id) WHERE deleted_at IS NULL`; `items.addon_only INTEGER NOT NULL DEFAULT 0`; `bill_lines.addon_of_line_id TEXT`; and the `offers` table of Task 11 (columns as in the spec; JSON columns `TEXT NOT NULL DEFAULT '[]'`).

Decisions: an option's `productId` in the domain types is the cafe's item id. Option `name` is the item name, with ` (<variant>)` when a variant is set; `unavailable` when the item is deleted or unavailable or the variant deleted. A domain validation failure becomes `AddonError("invalid", <first issue message>)`. Saving keeps option ids passed in and soft-deletes options left out. `deleteItem` soft-deletes that item's options and its attachments; a group whose last option goes is set `active = 0`.

- [ ] **Step 1: Write the failing tests.**

```ts
it("migrates a version 4 database to 5", () => { /* tables exist; items.addon_only 0 */ });
it("saves a group with options named after their items and variants", () => { /* Extra shot; 'Masala Chai (Large)' */ });
it("refuses a group whose minimum is above its maximum, with the domain's message", ...);
it("keeps option ids across an edit and drops the removed ones", ...);
it("marks an option unavailable when its item is", ...);
it("attaches groups to an item in order and replaces them", ...);
it("hides add-on-only items from the billing menu but not the editor", ...);
it("removes a deleted item from its groups and deactivates a group left empty", ...);
```

- [ ] **Step 2: Run and confirm they fail.**  - [ ] **Step 3: Implement.**  - [ ] **Step 4: Verify.**
- [ ] **Step 5: Commit** `feat(cafe): migration 5 and add-on groups in cafe-data`

---

### Task 11: Offers in cafe-data and the device offer clock

**Files:**
- Create: `packages/cafe-data/src/offers.ts`
- Modify: `time.ts`, `index.ts`
- Test: `offers.test.ts`, `time.test.ts`

**Interfaces:**
- Consumes: `OfferInput`, `Offer`, `OfferInputValue`, `OfferContext` from `@masalapos/domain/offers`.
- Produces:

```ts
export function listOffers(db: SqlDriver): Offer[];                          // live rows, by created_at
export function saveOffer(db: SqlDriver, input: unknown, now: number, id?: string): Offer;
export function setOfferActive(db: SqlDriver, id: string, active: boolean, now: number): void;
export function deleteOffer(db: SqlDriver, id: string, now: number): void;
export class OfferError extends Error { constructor(readonly code: "invalid" | "not_found", message: string, readonly field?: string) }
// time.ts
export function cafeOfferClock(ms: number, tzOffsetMinutes: number): Pick<OfferContext, "localDate" | "weekday" | "minutes">;
```

Decisions: validation by `OfferInput`; the first issue becomes `OfferError("invalid", message, path[0])`. `orderTypeIds` may only hold `takeaway` and `delivery` (else `invalid`, "Pick Takeaway or Delivery"). `productIds` hold item ids. `createdAt` is set on create and kept on edit.

- [ ] **Step 1: Write the failing tests.**

```ts
it("gives the IST date, Monday-based weekday and minutes for a moment", () => { /* 2026-11-16 (a Monday) 22:00 UTC -> localDate '2026-11-17', weekday 1, minutes 210 */ });
it("saves and lists a buy-get offer with its targets", ...);
it("reports OfferInput's message and field", () => { /* bill_off with productIds -> field 'categoryIds' */ });
it("refuses an unknown order type", ...);
it("switches an offer off and deletes it", ...);
```

- [ ] **Step 2: Run and confirm they fail.**  - [ ] **Step 3: Implement.**  - [ ] **Step 4: Verify.**
- [ ] **Step 5: Commit** `feat(cafe): offers in cafe-data with the device's offer clock`

---

### Task 12: Pricing bills with add-ons and offers

**Files:**
- Modify: `packages/cafe-data/src/bills.ts`, `reports.ts`, `held.ts` (nothing new; the schema already has the fields)
- Test: `bills.test.ts`, `reports.test.ts`, new `pricing.test.ts`

**Interfaces:**
- Consumes: Tasks 10-11; `resolveAddonPicks`, `AddonPickError`; `applyOffers`, `OfferLine`.
- Produces:

```ts
export type BillErrorCode = /* ... */ | "addon_invalid";
export interface CartLine { /* ... */ addonOptionIds?: string[] }
export interface PricingInput { lines: CartLine[]; discountPaise: number; orderKind: "takeaway" | "delivery";
  removedOfferIds: string[]; pricedAt: number; tzOffsetMinutes: number }
export interface BillPreview { totals: BillTotals; subtotalAfterOffersPaise: number;
  offers: Array<{ offerId: string; name: string; discountPaise: number }>; removed: Array<{ offerId: string; name: string }> }
export function previewBill(db: SqlDriver, input: PricingInput): BillPreview;
export interface CreateBillInput extends PricingInput { /* id, payments, discountNote, now, staff/customer fields */ }
// reports.ts
export interface DaySummary { /* ... */ offers: Array<{ name: string; discountPaise: number }> } // largest first
```

Decisions:
- `resolveLines` expands each dish: dish line, then its add-ons from `resolveAddonPicks(groupsForItem(itemId), addonOptionIds ?? [])` in the returned order, each priced from its own item or variant with its own GST rate, `qty` = the dish's qty, `addonOf` = the dish's resolved index. An `AddonPickError` is `BillError("addon_invalid", e.message, cartIndex)`. A dish whose item has active groups with a minimum still goes through `resolveAddonPicks`, so a missing pick is refused.
- Offer lines: every resolved line becomes an `OfferLine` with `id` = its index as a string; menu lines use their item id and category id; custom lines use `productId: "custom:<index>"`, `categoryId: ""`, so item offers never match them but the bill offer counts them.
- Context: `cafeOfferClock(pricedAt, tzOffsetMinutes)`, `orderTypeId: orderKind`, `orderTypeKind: orderKind`, `removedOfferIds`. Line discounts go to `calculateBill` as `offerDiscountPaise`; the bill discount is checked against `subtotalAfterOffersPaise`. `discountAllowed` (Task 4) uses `subtotalAfterOffersPaise` too.
- `createBill` stores `offer_discount_paise` per line, `addon_of_line_id` (the dish line's row id), and `receipt.offers` = applied `{ name, discountPaise }` when any; receipt items get `addon: true` for add-on lines. `kitchenLines` fills `addonOf`.
- `daySummary.offers` sums `receipt.offers` of live bills by name.
- Update the app's callers of `previewBill` (`cart/cart.ts`) to the new input and output in this task so typecheck stays clean: pass `orderKind`, `removedOfferIds: []`, `pricedAt: Date.now()`, the device offset; read `.totals`.

- [ ] **Step 1: Write the failing tests** (`pricing.test.ts` unless noted). Fixture: chai (variants) and samosa from `menuCafe()`, plus an add-on-only item "Extra shot" ₹10 GST 18, a group "Extras" (min 0, max 2) with Extra shot and Samosa, attached to chai, and a group "Milk" (min 1, max 1) with "Oat milk" ₹15 attached to a new "Latte" ₹120.

```ts
it("bills a dish with two add-ons as three lines with the dish's quantity", () => { /* Large chai x2 + Extra shot + Samosa; receipt items: chai, '+'-marked shot qty 2 at 1000 gst 18, samosa qty 2 addon true; bill_lines addon_of_line_id = chai line id */ });
it("refuses a dish missing a required add-on with the domain's message", () => { /* Latte with [] -> addon_invalid 'Choose 1 from Milk', lineIndex 0 */ });
it("refuses a pick from another dish's group", () => { /* chai with Oat milk's option id -> addon_invalid 'The add-ons changed. Choose them again.' */ });
it("applies a buy-2-get-1 offer and stores the discount on the line and the receipt", ...);
it("applies an item offer to an add-on line by its own item", ...);
it("never applies an item offer to a custom line, but counts it towards a bill offer's minimum", ...);
it("applies an offer for Delivery only to delivery bills", ...);
it("leaves a removed offer off and lists it as removed", ...);
it("prices by pricedAt, not now, at the edge of a time window", () => { /* offer 16:00-18:00 IST; pricedAt 17:59, now 18:01 -> applied */ });
it("checks the bill discount against the total after offers", () => { /* discount equal to subtotal before offers -> discount_too_large */ });
it("previews exactly what it bills", () => { /* previewBill totals and offers equal createBill's */ });
// reports.test.ts
it("totals offer discounts by name, voids excluded", ...);
```

- [ ] **Step 2: Run and confirm they fail.**  - [ ] **Step 3: Implement.**
- [ ] **Step 4: Verify** (global line and `npm test`).
- [ ] **Step 5: Commit** `feat(cafe): bills priced with add-ons and offers`

---

### Task 13: Add-ons in the app

**Files:**
- Create: `apps/cafe-android/src/bill/ItemSheet.tsx`, `src/bill/item-sheet-state.ts` (+ test), `src/app/menu/addon-groups.tsx`, `src/app/menu/addon-group.tsx`
- Modify: `cart/cart-store.ts` (+ test), `cart/cart.ts`, `bill/CartPanel.tsx`, `(tabs)/bill.tsx`, `(tabs)/menu.tsx`, `src/app/menu/item.tsx`, `print/kitchen-slip.ts` (+ test)
- Delete: `bill/VariantSheet.tsx`

**Interfaces:**
- Produces:

```ts
// item-sheet-state.ts
export interface ItemSheetState { variantId: string | null; picks: string[] }
export function togglePick(groups: AddonGroup[], state: ItemSheetState, optionId: string): ItemSheetState; // a max-1 group swaps
export function sheetProblem(item: Item, groups: AddonGroup[], state: ItemSheetState): string | null;     // first unmet rule, else null
// cart-store.ts
export interface CartEntry { /* ... */ addonOptionIds: string[]; addonNames: string[] }
add(entry): void  // two entries merge only when item, variant, picks and note are all equal
```

Behaviour: tapping an item with variants or attached groups opens `ItemSheet` (variants, then each active group with "Choose 1" / "Up to 3" / "Choose 1 to 2", unavailable options greyed); **Add** is disabled with `sheetProblem` shown. Without either, the item is added directly. The cart shows add-on names under the dish (`+ Extra shot`); the stepper moves them together. Bill tiles use `listMenu(db, { forBilling: true })`. Menu tab gets **Add-on groups** (list, add, edit with name, min, max, options picked from the menu with a search, active, delete); item screen gets **Add-on only** and **Add-on groups** (attach, detach, reorder). Messages come from `AddonError`.

- [ ] **Step 1: Write the failing tests.**

```ts
it("swaps the pick in a choose-1 group and stops at a group's maximum", ...);
it("names the first unmet rule: variant, then a group minimum", ...);
it("keeps the same dish with different add-ons as separate cart lines", ...);
it("prints add-ons under their dish on the kitchen slip", () => { /* '  + Extra shot' after the chai line */ });
```

- [ ] **Step 2: Run and confirm they fail.**  - [ ] **Step 3: Implement.**  - [ ] **Step 4: Verify.**
- [ ] **Step 5: DEVICE.** Make the Extras and Milk groups; a latte refuses Add until milk is picked; chai with two add-ons prints `+` lines on the receipt and kitchen slip; an add-on-only item is not on the tiles.
- [ ] **Step 6: Commit** `feat(cafe): add-on picker, cart add-ons and the add-on group editor`

---

### Task 14: Offers in the app

**Files:**
- Create: `apps/cafe-android/src/offers/describe.ts` (+ test), `bill/OffersStrip.tsx`, `src/app/menu/offers.tsx`, `src/app/menu/offer.tsx`
- Modify: `cart/cart-store.ts` (+ test), `cart/cart.ts` (+ test), `bill/CartPanel.tsx`, `src/app/payment.tsx`, `payment/complete.ts` (+ test), `(tabs)/menu.tsx`, `(tabs)/reports.tsx`, `print/day-summary-slip.ts` (+ test)

**Interfaces:**
- Produces:

```ts
export function describeOffer(offer: Offer, names: { items: Map<string, string>; categories: Map<string, string> }): string;
// cart-store: CartSnapshot.removedOfferIds: string[]; removeOffer(id), restoreOffer(id); cleared by clear()
// payment.tsx keeps pricedAt = the time it opened; complete.ts passes it to createBill
```

`describeOffer` examples, exact: `buy_get` 2/1/10000 on category Coffee, days Mon-Fri, 16:00-18:00 → `"Buy 2 get 1 free on Coffee, Mon–Fri 4–6 pm"`; `item_off` amountPaise 1000 on Samosa → `"₹10 off each Samosa"`; `bill_off` 1000 bp, min ₹500, max ₹100 → `"10% off bills of ₹500 or more, up to ₹100"`; `getQty` at 5000 bp → `"Buy 2 get 1 at half price on ..."`, other percents `"at 30% off"`; every day and no time window add nothing; a Delivery-only offer ends with `", Delivery only"`.

Behaviour: the cart shows `OffersStrip`: each applied offer with its saving and a remove button; removed ones listed with **Restore**. The percent discount is worked on `subtotalAfterOffersPaise`. Menu, **Offers** (`catalog.manage`): list with switch and `describeOffer`; editor with kind, amounts (rupees typed, stored paise; percent typed, stored bp), items/categories picker, dates, days, times, Takeaway/Delivery; `OfferError.field` puts the message by its field. Reports and the printed day summary gain the offers section.

- [ ] **Step 1: Write the failing tests.**

```ts
it.each(DESCRIBE_CASES)("describes %s", ...);   // the exact strings above
it("removes and restores an offer and clears removals on clear", ...);
it("prices the cart with the removed offers left off", ...);
it("passes pricedAt from when payment opened, not when Paid was tapped", ...);
it("prints the offers section on the day summary", ...);
```

- [ ] **Step 2: Run and confirm they fail.**  - [ ] **Step 3: Implement.**  - [ ] **Step 4: Verify.**
- [ ] **Step 5: DEVICE.** A time-window offer applies, removing it raises the total, Restore brings it back; the receipt shows `Offer: <name>`; Reports shows it.
- [ ] **Step 6: Commit** `feat(cafe): offers on the cart and the offer editor`

---

### Task 15: Sharing a bill, the Phase 2 check and handover

**Files:**
- Create: `apps/cafe-android/src/share/share-receipt.ts`, `docs/agents/handoff/2026-11-13-cafe-mobile-phase-2b.md`
- Modify: `apps/cafe-android/package.json` (`npx expo install react-native-view-shot expo-sharing`), `bill/TokenScreen.tsx`, `src/app/bill/[id].tsx`, `bill/ReceiptView.tsx` (accepts a ref), `docs/operations/cafe-app.md`

**Interfaces:**
- Produces: `shareReceipt(view: RefObject<View>, invoiceNo: string): Promise<"shared" | "cancelled" | "unavailable">`.

Decisions: first confirm from current docs that `captureRef` (view-shot) and `Sharing.shareAsync` (expo-sharing) work with SDK 58 and the new architecture; if view-shot does not, stop and ask the user before choosing another library. Capture as PNG at the 80 mm receipt width the view already uses, into the cache directory as `receipt-<invoiceNo with / as ->.png`; delete the previous file before writing. `Sharing.isAvailableAsync()` false → `"unavailable"` with a message. A cancel is not logged. Errors go to the error log with `[share]`. A voided bill shares with its VOID mark.

- [ ] **Step 1: Implement** and wire **Share** on the token screen and a bill's screen.
- [ ] **Step 2: Verify** global line, `npm test`, `npm run build:desktop`, and `node tools/build-cafe-android.mjs --standalone`.
- [ ] **Step 3: DEVICE, the Phase 2 check** (spec, "2B is done when"), in flight mode: cashier signs in with a PIN; a Delivery bill for a saved customer with a dish and two add-ons and a time-window offer; a manager's PIN approves a discount above the limit; receipt and `TOKEN n` kitchen slip print with add-ons under their dish; Share to WhatsApp shows the receipt image (sharing needs the network; turn flight mode off for that step only); the day report shows staff, order-kind and offer figures. Also run the Phase 1 printer checks still pending in its handover.
- [ ] **Step 4: Whole-phase review:** one fresh reviewer on Opus over `git diff <2A start>..HEAD`; fix what it finds, each with a test where code allows.
- [ ] **Step 5: Write the handover note** `docs/agents/handoff/2026-11-13-cafe-mobile-phase-2b.md` (built, verified, device results, deferred items, "Next: Phase 3 spec addendum, in a new session"), and update `docs/operations/cafe-app.md` (add-ons, offers, sharing).
- [ ] **Step 6: Commit** `feat(cafe): share a bill as an image; Phase 2 handover`
