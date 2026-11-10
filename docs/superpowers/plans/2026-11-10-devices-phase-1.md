# Devices Phase 1 — device registry: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One `devices` table that exists in every build and holds each device's type, with the licence counting its
slots from it. Nothing changes on screen.

**Architecture:** A new `Devices` class (`apps/server/src/devices.ts`, decorated as `app.devices`) owns the `devices`
and `device_events` tables. `Licensing` stops querying a device table and calls the registry for the list, register,
rename and remove; it keeps the licence limit and the `/api/license/devices` routes. First-run setup creates the main
counter through the registry, and the auth pre-handlers put the calling device on `req.device`.

**Deviation from the spec (approve before building):** the spec says the UI is unchanged in this phase and also that
device events move out of `license_events`. Both cannot hold: the history list under **Plan & devices** reads
`license_events`, so from this phase until Phase 4 adds the device history it shows licence events only. Device events
are still recorded, in `device_events`.

**Tech Stack:** TypeScript, zod, better-sqlite3, Fastify, vitest.

**Spec:** `docs/superpowers/specs/2026-11-10-devices-design.md` (section "Phase 1 — device registry")

## Global Constraints

- Migration number is **65**, name `devices`; re-check `packages/domain/src/migrations/index.ts` first (other sessions
  add migrations) and take the next free number if 65 is gone.
- Device kinds are exactly `counter`, `kitchen`, `captain`. Everything this phase creates is `counter`.
- Active devices are always read `WHERE removed_at IS NULL ORDER BY created_at, id`. Only the first `maxDevices` of
  that list may operate; later ones are kept and blocked. This rule must not change.
- At most one device has `is_main = 1`. The main counter cannot be removed: 409 "The main counter can't be removed."
- Rename and remove keep their messages: 404 "Device not found", 409 "This device changed. Refresh the device list
  and try again."
- Removing a device deletes its sessions (`DELETE FROM sessions WHERE device = <credential_hash>`).
- A device credential is 64 lowercase hex characters; only its SHA-256 is stored. No response or event may contain a
  credential or its hash.
- With licensing disabled (dev, demo) there is no device limit and unjoined browsers keep working, as today.
- The working tree has unrelated uncommitted edits from another session (`apps/ui/src/main.tsx`,
  `apps/ui/src/light-buttons.css`, `docs/offers/README.md`). Stage only this plan's files, by path; never
  `git add -A`.
- Branch `feat/devices`. One commit per task.

## Review Focus

1. **A removed device registers again with the same browser**: the old row is revived (same `id` and `kind`, new
   `created_at`, `removed_at` cleared, `version` bumped) rather than failing on the unique `credential_hash` (Task 2).
2. **Someone tries to remove the main counter**: 409, the row is unchanged and its sessions survive (Task 2).
3. **A database where every licensed device had been revoked, or none was ever registered**: the migration marks no
   main; the next admin sign-in from the main PC gets one (Tasks 1 and 4).
4. **An admin signs in from another PC on the LAN while no main counter exists**: no main counter is created there
   (Task 4).
5. **A dev build request with no device header**: `req.device` is `null` and the request works as before (Task 4).

---

### Task 1: Migration 65 and domain types

**Files:**
- Create: `packages/domain/src/migrations/devices.ts`
- Create: `packages/domain/src/migrations/devices.test.ts`
- Create: `packages/domain/src/devices.ts`
- Modify: `packages/domain/src/migrations/index.ts` (import and append `devices` to `MIGRATIONS`)
- Modify: `packages/domain/src/index.ts` (export `./devices.js` the way its neighbours are exported)
- Modify: `packages/domain/src/licensing.ts:74-78` (`LicenseEvent.kind` becomes `"license_activated"` only)

**Interfaces:**
- Produces, from `@masalapos/domain`:

```ts
export const DEVICE_KINDS = ["counter", "kitchen", "captain"] as const;
export type DeviceKind = (typeof DEVICE_KINDS)[number];
export interface DeviceEvent {
  id: number; occurredAt: number; actorName: string; deviceId: string;
  kind: "joined" | "renamed" | "replaced" | "removed" | "settings_changed";
  summary: string;
}
export interface DeviceHistory { events: DeviceEvent[]; nextBefore: number | null }
```

- Produces the schema:

```sql
CREATE TABLE devices (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('counter','kitchen','captain')),
  name TEXT NOT NULL,
  credential_hash TEXT NOT NULL UNIQUE,
  is_main INTEGER NOT NULL DEFAULT 0 CHECK (is_main IN (0,1)),
  settings TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  removed_at INTEGER,
  last_seen_at INTEGER,
  version INTEGER NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX idx_devices_main ON devices(is_main) WHERE is_main = 1;
CREATE INDEX idx_devices_active ON devices(removed_at, created_at);
CREATE TABLE device_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  occurred_at INTEGER NOT NULL,
  actor_name TEXT NOT NULL,
  device_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('joined','renamed','replaced','removed','settings_changed')),
  summary TEXT NOT NULL
);
```

- [ ] **Step 1: Write the failing tests** in `devices.test.ts`, following `service-settings.test.ts` (`openDb(":memory:")`,
  `migrate(db, MIGRATIONS.filter((m) => m.version < 65))` to seed, then `migrate(db, MIGRATIONS)`):

```ts
describe("migration 65: devices", () => {
  it("creates empty devices and device_events tables and drops licensed_devices", () => {
    // after migrate(db, MIGRATIONS):
    expect(db.pragma("user_version", { simple: true })).toBeGreaterThanOrEqual(65);
    expect(db.prepare("SELECT count(*) AS n FROM devices").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT count(*) AS n FROM device_events").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name IN ('licensed_devices','idx_licensed_devices_active')").all()).toEqual([]);
  });

  it("carries licensed devices across as counters and marks the oldest active one as main", () => {
    // seed before 65: A (created_at 100, revoked_at 500), B (200, last_seen_at 900, version 3), C (300)
    // after: rows keep id, name, credential_hash, created_at, last_seen_at, version; revoked_at becomes removed_at
    expect(rows).toEqual([
      { id: "A", kind: "counter", is_main: 0, removed_at: 500, settings: "{}" },
      { id: "B", kind: "counter", is_main: 1, removed_at: null, settings: "{}" },
      { id: "C", kind: "counter", is_main: 0, removed_at: null, settings: "{}" },
    ]); // selected columns only, ORDER BY created_at
    expect(db.prepare("SELECT last_seen_at, version FROM devices WHERE id = 'B'").get()).toEqual({ last_seen_at: 900, version: 3 });
  });

  it("marks no main when every licensed device was revoked", () => {
    expect(db.prepare("SELECT count(*) AS n FROM devices WHERE is_main = 1").get()).toEqual({ n: 0 });
  });

  it("moves device events out of license_events", () => {
    // seed license_events: license_activated (rev 1), device_registered/B, device_renamed/B, device_removed/A
    expect(db.prepare("SELECT kind FROM license_events").all()).toEqual([{ kind: "license_activated" }]);
    expect(db.prepare("SELECT device_id, kind FROM device_events ORDER BY id").all()).toEqual([
      { device_id: "B", kind: "joined" }, { device_id: "B", kind: "renamed" }, { device_id: "A", kind: "removed" },
    ]); // occurred_at, actor_name and summary are copied unchanged
  });

  it("allows one main counter and only the three kinds", () => {
    // second INSERT with is_main = 1 throws; INSERT with kind 'tablet' throws
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run packages/domain/src/migrations/devices.test.ts`
Expected: FAIL (no migration 65; `devices` table missing).

- [ ] **Step 3: Implement** `export const devices: Migration = { version: 65, name: "devices", up(db) { ... } }` with the
  schema above, then in the same `db.exec`: copy `licensed_devices` into `devices` (`revoked_at` → `removed_at`, kind
  `'counter'`); set `is_main = 1` on the first row of `WHERE removed_at IS NULL ORDER BY created_at, id`; copy
  `license_events` rows whose kind is `device_registered` / `device_renamed` / `device_removed` and whose `device_id`
  is not null into `device_events` as `joined` / `renamed` / `removed`, in `id` order; delete those rows from
  `license_events`; drop `idx_licensed_devices_active` and `licensed_devices`. Leave the `license_events` CHECK as it
  is. Add the domain types and narrow `LicenseEvent.kind`.

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run packages/domain/src/migrations`
Expected: PASS, including the other migration tests.

- [ ] **Step 5: Commit**

```bash
git add packages/domain/src/migrations/devices.ts packages/domain/src/migrations/devices.test.ts packages/domain/src/migrations/index.ts packages/domain/src/devices.ts packages/domain/src/index.ts packages/domain/src/licensing.ts
git commit -m "feat(domain): devices table and device events (migration 65)"
```

The server does not compile until Task 3 (`licensing.ts` still names `licensed_devices` and the old event kinds).
That is expected; Tasks 1–3 land together before the suite is run in full.

---

### Task 2: The device registry

**Files:**
- Create: `apps/server/src/devices.ts`
- Create: `apps/server/src/devices.test.ts`
- Modify: `apps/server/src/server.ts:128` (call `configureDevices` immediately before `configureLicensing`)
- Modify: `apps/server/src/licensing.ts:62-65` (`deviceHash` moves to `devices.ts`; `licensing.ts` re-exports it so
  existing imports keep working)

**Interfaces:**
- Consumes: Task 1's tables and `DeviceKind`, `DeviceEvent`, `DeviceHistory`.
- Produces:

```ts
export function deviceHash(credential: unknown): string | null;   // moved unchanged

export interface DeviceRecord {
  id: string; kind: DeviceKind; name: string; credentialHash: string; isMain: boolean;
  settings: Record<string, unknown>; createdAt: number; removedAt: number | null;
  lastSeenAt: number | null; version: number;
}

export class Devices {
  constructor(db: Database, now?: () => number);
  /** Not removed, ordered created_at, id. */
  active(): DeviceRecord[];
  /** The active device holding this credential, or null (also for a malformed credential). */
  findByCredential(credential: unknown): DeviceRecord | null;
  /** Adds a device, or revives the removed row with the same credential hash. Records "joined". Throws 409
   *  "This device is already registered" if an active device holds the hash. */
  add(input: { credentialHash: string; name: string; kind: DeviceKind; isMain?: boolean }, actorName: string): DeviceRecord;
  /** Records "renamed"; a rename to the same name does nothing. */
  rename(id: string, name: string, version: number, actorName: string): void;
  /** Sets removed_at, deletes the device's sessions, records "removed". Already removed: does nothing. */
  remove(id: string, actorName: string, version?: number): void;
  /** If no active main counter exists and the credential is valid: marks the active device holding it as main, or
   *  adds it as "Main counter" (kind counter). Returns the main device it made, else null. */
  ensureMain(credential: unknown, actorName: string): DeviceRecord | null;
  touch(id: string, at: number): void;                      // sets last_seen_at only; version unchanged
  events(before?: number): DeviceHistory;                   // newest first, 20 a page, same paging as Licensing.history
}

export function configureDevices(app: FastifyInstance, now?: () => number): void;   // app.decorate("devices", ...)
declare module "fastify" { interface FastifyInstance { devices: Devices } }
```

  `configureDevices` is called with `opts.licensing?.now`, so the registry and `Licensing` share one clock in tests.
  Event summaries: `Registered <name>.`, `Renamed <old> to <new>.`, `Removed <name>.` (the wording `Licensing` uses
  today). Every write runs in a `db.transaction`.

- [ ] **Step 1: Write the failing tests** in `devices.test.ts` against a bare database (`openDb(":memory:")`,
  `migrate`, `new Devices(db, () => now)`); insert a user and a session row directly where a test needs sessions:

```ts
const A = "a".repeat(64), B = "b".repeat(64);

it("adds devices and lists them oldest first", () => {
  // add A at now=100, B at now=200
  expect(devices.active().map((d) => [d.name, d.kind, d.isMain, d.version])).toEqual([["One", "counter", false, 1], ["Two", "kitchen", false, 1]]);
  expect(devices.findByCredential(A)?.name).toBe("One");
  expect(devices.findByCredential("nope")).toBeNull();
  expect(devices.events().events.map((e) => [e.kind, e.summary])).toEqual([["joined", "Registered Two."], ["joined", "Registered One."]]);
});

it("refuses a credential an active device already holds", () => {
  expect(() => devices.add({ credentialHash: deviceHash(A)!, name: "Again", kind: "counter" }, "Asha")).toThrow(/already registered/);
});

it("revives a removed device that registers again", () => {
  // add A (now 100) → remove → add same hash as "Back" (now 300)
  expect(revived).toMatchObject({ id: first.id, name: "Back", kind: "counter", createdAt: 300, removedAt: null, version: 3 });
  expect(devices.active()).toHaveLength(1);
});

it("renames with a stale-write check", () => {
  expect(() => devices.rename(d.id, "New", 99, "Asha")).toThrow(/This device changed/);
  devices.rename(d.id, "New", d.version, "Asha");
  expect(devices.active()[0]).toMatchObject({ name: "New", version: 2, createdAt: d.createdAt });
  devices.rename(d.id, "New", 2, "Asha");                       // same name: no version bump, no event
  expect(devices.active()[0]!.version).toBe(2);
  expect(() => devices.rename("missing", "X", 1, "Asha")).toThrow(/Device not found/);
});

it("removes a device, ends its sessions, and is idempotent", () => {
  devices.remove(d.id, "Asha", d.version);
  devices.remove(d.id, "Asha", d.version);                      // no throw
  expect(db.prepare("SELECT count(*) AS n FROM sessions WHERE device = ?").get(d.credentialHash)).toEqual({ n: 0 });
  expect(devices.events().events.filter((e) => e.kind === "removed")).toHaveLength(1);
});

it("never removes the main counter", () => {
  expect(() => devices.remove(main.id, "Asha")).toThrow(/main counter can't be removed/);
  expect(devices.active()).toHaveLength(1);
  expect(db.prepare("SELECT count(*) AS n FROM sessions WHERE device = ?").get(main.credentialHash)).toEqual({ n: 1 });
});

it("makes one main counter", () => {
  expect(devices.ensureMain("nope", "Asha")).toBeNull();
  expect(devices.ensureMain(A, "Asha")).toMatchObject({ name: "Main counter", kind: "counter", isMain: true });
  expect(devices.ensureMain(B, "Asha")).toBeNull();             // one already exists
  expect(devices.active().filter((d) => d.isMain)).toHaveLength(1);
});

it("promotes an existing device to main instead of adding a second row", () => {
  // add A as "Old counter" with no main → ensureMain(A)
  expect(devices.active()).toMatchObject([{ name: "Old counter", isMain: true }]);
});

it("touch updates last seen without changing the version", () => { /* lastSeenAt set, version unchanged */ });

it("pages history 20 at a time and never exposes a credential", () => {
  // 25 renames after one add → first page 20 events with nextBefore set, second page 6 with nextBefore null
  expect(JSON.stringify(first)).not.toContain(deviceHash(A)!);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run apps/server/src/devices.test.ts`
Expected: FAIL (`./devices.js` has no `Devices`).

- [ ] **Step 3: Implement** `Devices`, `deviceHash` and `configureDevices` in `apps/server/src/devices.ts` to the
  interface above, using `httpError` from `./http-error.js` for the 404 and 409 cases. Wire `configureDevices` in
  `server.ts` and re-export `deviceHash` from `licensing.ts`.

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run apps/server/src/devices.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/devices.ts apps/server/src/devices.test.ts apps/server/src/server.ts apps/server/src/licensing.ts
git commit -m "feat(server): device registry"
```

---

### Task 3: Licensing reads the registry

**Files:**
- Modify: `apps/server/src/licensing.ts` (lines 60, 93-99, 113-131, 153-160, 173-224)
- Modify: `apps/server/src/licensing.test.ts`

**Interfaces:**
- Consumes: `app.devices` (Task 2).
- Produces: `Licensing`'s public methods keep their signatures and results. `register`, `rename` and `revoke` delegate
  to the registry; `history()` returns licence events only; `Licensing` contains no SQL naming a device table.

- [ ] **Step 1: Change the existing tests to the new behaviour** in `licensing.test.ts`:
  - line 59: count rows in `devices`, not `licensed_devices` (still `{ n: 0 }` here; setup changes it in Task 4).
  - line 136: assert `f.app.devices.events().events.filter((e) => e.kind === "removed")` has length 1.
  - lines 139-151 ("records successful changes once and pages history…"): licence history is now
    `["license_activated"]` after two activations and two registrations; `f.app.devices.events()` holds one `joined`
    with `actorName` `SETUP.adminName`. After the 25 renames, page **device** history through
    `f.app.devices.events()` / `events(first.nextBefore)` (20 then 6, 26 distinct ids). Keep the
    `/api/license/history` assertions that it returns 200, contains neither `device` nor `"ff1."`, and rejects
    `?before=nope` with 400.
  - Add: `it("keeps licence and device history apart", …)` asserting no `license_events` row has a `device_id`.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run apps/server/src/licensing.test.ts`
Expected: FAIL (SQL errors: no such table `licensed_devices`).

- [ ] **Step 3: Implement.** In `Licensing`:
  - `activeDevices()` returns `this.app.devices.active()`; update the field names its callers read (`credentialHash`,
    `createdAt`, `lastSeenAt`) and drop the `DeviceRow` interface.
  - `status()` writes last seen through `this.app.devices.touch(id, now)`, with the same 60-second throttle.
  - `register()` keeps its checks in this order: valid credential, licence `active` or `grace`, same credential
    already active → rename if the name differs and return, limit reached → 409 "Device limit reached. Remove an old
    device or upgrade your plan." Then `this.app.devices.add({ credentialHash: hash, name, kind: "counter" }, actorName)`.
  - `rename()` and `revoke()` call `this.app.devices.rename` / `remove` with the same arguments.
  - `audit()` loses its `deviceId` parameter and is used for `license_activated` only.

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run apps/server/src/licensing.test.ts apps/server/src/devices.test.ts`
Expected: PASS. If the WebSocket test at line 315 or any other test fails only because it removes the first-registered
device, leave it for Task 4, which makes that device the main counter and rewrites those tests.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/licensing.ts apps/server/src/licensing.test.ts
git commit -m "refactor(server): licensing counts devices from the registry"
```

---

### Task 4: Main counter at setup, device on the request, docs

**Files:**
- Modify: `apps/server/src/auth.ts` (setup block at 193-201, `/api/login`, `requireAuth` 111-116, `requirePermission`
  124-134, the `FastifyRequest` declaration at 249-251)
- Modify: `apps/server/src/system.ts:14-18` (export `fromMainPc`)
- Modify: `apps/server/src/devices.test.ts`, `apps/server/src/licensing.test.ts`
- Modify: `docs/operations/commercial-licensing.md`

**Interfaces:**
- Consumes: `app.devices.ensureMain`, `app.devices.findByCredential` (Task 2); `fromMainPc(req)` from `system.ts`.
- Produces: `req.device: DeviceRecord | null` on every request that passed `requireAuth` or `requirePermission`. Later
  phases read it for printing and settings.

- [ ] **Step 1: Write the failing tests.** In `devices.test.ts`, a new `describe("devices on the server", …)` using
  `freshApp()` / `commercialApp()` from `test-helpers.ts`:

```ts
it("setup makes the setup browser the main counter in a dev build", async () => {
  const app = freshApp();
  await app.inject({ method: "POST", url: "/api/setup", payload: SETUP, headers: { "x-masalapos-device": A } });
  expect(app.devices.active()).toMatchObject([{ name: "Main counter", kind: "counter", isMain: true }]);
});

it("setup without a device credential in a dev build makes no device", async () => {
  const app = freshApp(); await setupAdmin(app);
  expect(app.devices.active()).toEqual([]);
});

it("an admin signing in on the main PC becomes the main counter when there is none", async () => {
  const app = freshApp(); await setupAdmin(app);
  const lan = await app.inject({ method: "POST", url: "/api/login", payload: ADMIN_LOGIN, headers: { "x-masalapos-device": B }, remoteAddress: "192.168.1.20" });
  expect(lan.statusCode).toBe(200);
  expect(app.devices.active()).toEqual([]);                                  // not from the LAN
  await app.inject({ method: "POST", url: "/api/login", payload: ADMIN_LOGIN, headers: { "x-masalapos-device": A } });
  expect(app.devices.active()).toMatchObject([{ name: "Main counter", isMain: true }]);
  await app.inject({ method: "POST", url: "/api/login", payload: ADMIN_LOGIN, headers: { "x-masalapos-device": B } });
  expect(app.devices.active()).toHaveLength(1);                              // one main only
});

it("a cashier signing in on the main PC does not become the main counter", async () => { /* createUser cashier, login with credential → active() is [] */ });

it("puts the calling device on the request", async () => {
  // register app.get("/api/test-device", { preHandler: app.requireAuth }, async (req) => ({ name: req.device?.name ?? null }))
  // dev build, no device header            → { name: null }, status 200
  // dev build, header of the main counter  → { name: "Main counter" }
  // same route behind app.requirePermission("settings.manage") → { name: "Main counter" }
});
```

  In `licensing.test.ts`:
  - line 59: `devices` holds `{ n: 1 }` before and after the preview (setup made the main counter).
  - line 684: `registeredDevices: 1`.
  - line 665-666 stays as it is and must pass.
  - lines 315-329 (WebSocket test): the socket that must close with 4401 belongs to a second device (`b`×64, logged in
    and registered as "Kitchen"); remove that device, not `devices(device)[0]`.
  - Add: `it("refuses to remove the main counter", …)`: `DELETE /api/license/devices/<main id>` returns 409 and
    `/api/products` with the main counter's headers still returns 200.
  - Any other test that removes the first-registered device removes a second one instead.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run apps/server/src/devices.test.ts apps/server/src/licensing.test.ts`
Expected: FAIL (no main counter after setup; `req.device` undefined).

- [ ] **Step 3: Implement.**
  - `/api/setup`: replace the block at 193-201 with `if (app.devices.ensureMain(credential, body.adminName)) app.licensing.announceChange();`
    It no longer depends on the licence state.
  - `/api/login`: after a successful password check for a user whose role is `admin`, when `fromMainPc(req)`, call
    `app.devices.ensureMain(req.headers["x-masalapos-device"], user.name)` and announce a change if it returned a device.
  - `app.decorateRequest("device", null)`; in `requireAuth` and `requirePermission`, after `req.user = user`, set
    `req.device = app.devices.findByCredential(req.headers["x-masalapos-device"])`. Add `device: DeviceRecord | null`
    to the `FastifyRequest` declaration.
  - Export `fromMainPc` from `system.ts`.
  - `docs/operations/commercial-licensing.md`: in the section on registering devices, state that the browser that
    runs first-time setup becomes the main counter whether or not a licence is installed yet, that the main counter
    cannot be removed, and that device changes are recorded in the device history rather than the licence history.

- [ ] **Step 4: Run the whole suite and the type check**

Run: `npm test`
Expected: PASS, no failures. Tests elsewhere that call `POST /api/license/devices` through `commercialApp()` still
pass: the setup browser is already the main counter, so the call renames it to "Counter".

Run: `npm run typecheck`
Expected: no errors (the UI still compiles against the narrowed `LicenseEvent.kind`).

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/auth.ts apps/server/src/system.ts apps/server/src/devices.test.ts apps/server/src/licensing.test.ts docs/operations/commercial-licensing.md
git commit -m "feat(server): main counter at setup and the device on each request"
```

---

## After this phase

Update the spec's status line to "Phase 1 built" and note the pick-up point for Phase 2 (join codes): the registry's
`add` is where a join code creates a device, and `POST /api/license/devices` is the route Phase 2 removes.
