# Devices Phase 2 — join codes: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A new device joins the restaurant by typing a six-character code an admin created, a lost device is replaced
the same way, and the "Register this device" self-registration is gone.

**Architecture:** A `JoinCodes` class (`apps/server/src/device-join.ts`) owns the `device_join_codes` table and turns a
code plus a device credential into a registry change, through two additions to `Devices` (`replaceCredential`, and
`add` no longer reviving removed rows). Four routes under `/api/devices` sit beside it. In the UI a `DeviceGate` wraps
the POS, `/kitchen/` and `/captain/` and shows `JoinScreen` until `GET /api/devices/me` says the browser has joined;
admins create codes from a small panel under **Plan & devices** until Phase 4 builds the Devices area.

**Tech Stack:** TypeScript, zod, better-sqlite3, Fastify, `qrcode`, React, vitest.

**Spec:** `docs/superpowers/specs/2026-11-10-devices-design.md` (section "Phase 2 — join codes", plus "Security")

## Decisions the spec leaves open (approve before building)

1. **Dev and demo servers do not refuse an unjoined browser; only the UI does.** The spec says every build requires a
   device to join. Enforcing that in the server for unlicensed builds would fail about 70 server test files that call
   the API with no device header. So: every build shows the join screen (the UI gate), and the server keeps refusing
   unjoined devices only where licensing is on, as today.
2. **A minimal "Add a device" panel ships in this phase**, under **Plan & devices**, and that device list becomes
   visible in dev builds. Without it nobody could create a code between Phase 2 and Phase 4. Phase 4 moves it.
3. **A removed browser that joins again becomes a new device.** Phase 1 gave it its old row back with its old kind
   (the pick-up point in the spec). Now the old row stays removed, its credential hash is retired, and the join code's
   name and kind make a new row.
4. **`ensureMain` keeps its limit.** A restaurant with no main counter and every slot in use gets out by a replace
   code, which uses no slot; the next admin sign-in on the main PC then marks that device as main.
5. **Joining with a new-device code after the slots filled returns 409** "Device limit reached…" and leaves the code
   unused. The spec only covers the limit when the code is created.
6. **Captain join links use the HTTPS origins when the HTTPS listener is on.** The credential is per origin, so a
   tablet that joined on `http://` would not be joined on `https://`. Other kinds use `lanUrls`, as the spec says.

## Global Constraints

- Migration number is **66**, name `device-join-codes`; re-check `packages/domain/src/migrations/index.ts` first and
  take the next free number if 66 is gone.
- A join code is 6 characters from `ABCDEFGHJKMNPQRSTUVWXYZ23456789` (no `0`, `O`, `1`, `I`, `L`), valid for 10
  minutes, single use. Only its SHA-256 is stored. No response, event or log line carries a code hash, a device
  credential or a credential hash.
- Wrong, expired and used codes all return 400 `That code is not valid or has expired`.
- A credential that is already an active device gets 409 `This device has already joined.`
- At the limit: 409 `Device limit reached. Remove an old device or upgrade your plan.` With licensing off
  (`maxDevices` is `null`) there is no limit.
- Active devices are still read `WHERE removed_at IS NULL ORDER BY created_at, id`; a replace keeps `created_at`.
- Device kinds are `counter`, `kitchen`, `captain`. Device names are trimmed, 1 to 80 characters.
- The UI imports values from `@masalapos/domain` subpaths only, never the root (`apps/ui/src/domain-imports.test.ts`).
- First-run setup is unchanged: it still creates the main counter directly.
- The working tree has unrelated uncommitted edits from another session (`apps/ui/src/main.tsx`,
  `apps/ui/src/light-buttons.css`, `docs/offers/README.md`, and untracked `AGENTS.md`, `References/`, `.claude/`,
  `docs/agents/handoff/`). Stage only this plan's files, by path; never `git add -A`.
- Branch `feat/devices`. One commit per task. Nothing is pushed.

## Review Focus

1. **A code typed in lower case, or with spaces or a hyphen** (`k7m 2qp`, `K7M-2QP`): it joins, the same as `K7M2QP`
   (Tasks 1 and 3).
2. **The same code used twice, or by two devices at once**: the first joins, the second gets the one 400 message
   (Task 3).
3. **A new-device code used after the last slot was taken**: 409, no device is created and the code still works once
   a slot is free (Task 3).
4. **A browser that was removed joins again with a code for another kind**: it becomes a new device of the code's
   kind; the old row stays removed (Tasks 2 and 3).
5. **The hub cannot be reached when the gate checks** (a captain tablet out of Wi-Fi range): the gate lets the app
   through to its existing offline handling instead of showing the join screen (Task 6).

---

### Task 1: Migration 66 and join-code helpers

**Files:**
- Create: `packages/domain/src/migrations/device-join-codes.ts`
- Create: `packages/domain/src/migrations/device-join-codes.test.ts` (same shape as `migrations/devices.test.ts`)
- Modify: `packages/domain/src/migrations/index.ts` (import and append `deviceJoinCodes`)
- Modify: `packages/domain/src/devices.ts`
- Create: `packages/domain/src/devices.test.ts`
- Modify: `packages/domain/package.json` (add `"./devices": "./src/devices.ts"` to `exports`)

**Interfaces:**
- Produces the table:

```sql
CREATE TABLE device_join_codes (
  id TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('counter','kitchen','captain')),
  name TEXT NOT NULL,
  replaces_device_id TEXT REFERENCES devices(id),
  created_by TEXT NOT NULL,          -- the admin's name; becomes the actor of the join event
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);
```

  A replace code copies `kind` and `name` from the device it replaces when it is created.

- Produces, from `@masalapos/domain` and `@masalapos/domain/devices`:

```ts
export const JOIN_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const JOIN_CODE_LENGTH = 6;
export const JOIN_CODE_TTL_MS = 10 * 60_000;
/** Upper-cases and drops spaces and hyphens; null unless what is left is 6 alphabet characters. */
export function normalizeJoinCode(input: unknown): string | null;
export const JoinCodeCreate = z.union([
  z.object({ kind: z.enum(DEVICE_KINDS), name: z.string().trim().min(1).max(80) }).strict(),
  z.object({ replacesDeviceId: z.string().uuid() }).strict(),
]);
export type JoinCodeCreate = z.infer<typeof JoinCodeCreate>;
export interface JoinCodeIssued {
  code: string; expiresAt: number; kind: DeviceKind; name: string; replacesDeviceId: string | null;
  links: { url: string; qr: string }[];
}
export interface DeviceMe { joined: boolean; kind: DeviceKind | null; mainPc: boolean }
export interface DeviceJoined { kind: DeviceKind; name: string }
```

- [ ] **Step 1: Write the failing tests**

`device-join-codes.test.ts`: after `migrate(db, MIGRATIONS)` the table accepts a row; a second row with the same
`code_hash` throws; `kind = 'display'` throws; `replaces_device_id` naming no device throws (foreign keys are on).

`packages/domain/src/devices.test.ts`:

```ts
it("normalises a typed join code", () => {
  expect(normalizeJoinCode("k7m 2qp")).toBe("K7M2QP");
  expect(normalizeJoinCode(" K7M-2QP ")).toBe("K7M2QP");
  for (const bad of ["K7M2Q", "K7M2QPX", "K7M2Q0", "K7M2QO", "K7M2QI", "K7M2QL", "K7M2Q1", "", null, 123456]) expect(normalizeJoinCode(bad)).toBeNull();
});
it("accepts a new device or a replacement, not both", () => {
  expect(JoinCodeCreate.parse({ kind: "kitchen", name: "  Pass  " })).toEqual({ kind: "kitchen", name: "Pass" });
  expect(JoinCodeCreate.safeParse({ replacesDeviceId: crypto.randomUUID() }).success).toBe(true);
  for (const bad of [{ kind: "display", name: "X" }, { kind: "counter", name: " " }, { kind: "counter", name: "x".repeat(81) },
    { kind: "counter", name: "X", replacesDeviceId: crypto.randomUUID() }, {}]) expect(JoinCodeCreate.safeParse(bad).success).toBe(false);
});
```

- [ ] **Step 2: Run them and see them fail**

Run: `npx vitest run packages/domain/src/migrations/device-join-codes.test.ts packages/domain/src/devices.test.ts`
Expected: FAIL (no such table; `normalizeJoinCode` is not exported)

- [ ] **Step 3: Write the migration (version 66) and the exports above**

- [ ] **Step 4: Run the same command; expected PASS. Then `npx vitest run packages/domain` and `npx vitest run apps/ui/src/domain-imports.test.ts`; expected PASS**

- [ ] **Step 5: Commit**

```bash
git add packages/domain/src/migrations/device-join-codes.ts packages/domain/src/migrations/device-join-codes.test.ts packages/domain/src/migrations/index.ts packages/domain/src/devices.ts packages/domain/src/devices.test.ts packages/domain/package.json
git commit -m "feat(domain): device join codes table and code helpers (migration 66)"
```

---

### Task 2: Registry — replace a credential, stop reviving removed devices

**Files:**
- Modify: `apps/server/src/devices.ts`
- Test: `apps/server/src/devices.test.ts`

**Interfaces:**
- Produces, on `Devices`:

```ts
/** The summary defaults to `Registered ${name}.` A removed row holding this hash is retired and a new row is made. */
add(input: { credentialHash: string; name: string; kind: DeviceKind; isMain?: boolean }, actorName: string, summary?: string): DeviceRecord;
/** Moves an active device to another browser. Name, kind, settings, created_at and is_main are kept. */
replaceCredential(id: string, credentialHash: string, actorName: string, summary: string): DeviceRecord;
/** The active main counter, or null. */
main(): DeviceRecord | null;
```

- Retiring: `UPDATE devices SET credential_hash = 'retired:' || id WHERE credential_hash = ? AND removed_at IS NOT NULL`.
  It frees the unique hash and can never match a real credential hash. `add` and `replaceCredential` both do it first.
- `replaceCredential`: 404 `Device not found` when `id` is not an active device; 409 `This device has already joined.`
  when an active device (this one included) holds the hash. Then, in one transaction: set `credential_hash`, clear
  `last_seen_at`, `version + 1`, delete the sessions of the **old** hash, record a `replaced` event with the summary.
- `add`'s 409 message changes from `This device is already registered` to `This device has already joined.`

- [ ] **Step 1: Write the failing tests** (in `describe("device registry")`, using its `add`, `session` and `sessions` helpers)

Replace the Phase 1 test "revives a removed device that registers again" with:

```ts
it("a removed browser that joins again is a new device of the kind asked for", () => {
  const first = add(A, "One");
  devices.remove(first.id, "Asha");
  now = 300;
  const again = add(A, "Back", "kitchen");
  expect(again.id).not.toBe(first.id);
  expect(again).toMatchObject({ name: "Back", kind: "kitchen", createdAt: 300, removedAt: null, version: 1, settings: {} });
  expect(devices.active().map((d) => d.id)).toEqual([again.id]);
  expect(db.prepare("SELECT credential_hash AS h, removed_at IS NOT NULL AS removed FROM devices WHERE id = ?").get(first.id)).toEqual({ h: `retired:${first.id}`, removed: 1 });
});
```

Change the regex in "refuses a credential an active device already holds" to `/already joined/`. Add:

```ts
it("moves a device to another browser and keeps everything else", () => {
  now = 100; add(A, "Main", "counter", true);
  now = 200; const pass = add(B, "Pass", "kitchen");
  db.prepare("UPDATE devices SET settings = '{\"x\":1}', last_seen_at = 150 WHERE id = ?").run(pass.id);
  session(deviceHash(B)!); session(deviceHash(A)!);
  now = 900;
  const moved = devices.replaceCredential(pass.id, deviceHash(C)!, "Asha", "Replaced the browser of Pass.");
  expect(moved).toMatchObject({ id: pass.id, name: "Pass", kind: "kitchen", settings: { x: 1 }, createdAt: 200, lastSeenAt: null, version: 2, credentialHash: deviceHash(C) });
  expect(devices.active().map((d) => d.name)).toEqual(["Main", "Pass"]);
  expect(devices.findByCredential(B)).toBeNull();
  expect(sessions(deviceHash(B)!)).toEqual({ n: 0 });
  expect(sessions(deviceHash(A)!)).toEqual({ n: 1 });
  expect(devices.events().events[0]).toMatchObject({ kind: "replaced", summary: "Replaced the browser of Pass.", actorName: "Asha", deviceId: pass.id });
});
it("keeps the main counter the main counter when it is replaced", () => {
  const main = add(A, "Main", "counter", true);
  expect(devices.replaceCredential(main.id, deviceHash(B)!, "Asha", "x").isMain).toBe(true);
  expect(devices.main()?.id).toBe(main.id);
});
it("refuses to replace with a browser that is already a device, or a device that is gone", () => {
  const one = add(A, "One"), two = add(B, "Two");
  expect(() => devices.replaceCredential(one.id, deviceHash(B)!, "Asha", "x")).toThrow(/already joined/);
  expect(() => devices.replaceCredential(one.id, deviceHash(A)!, "Asha", "x")).toThrow(/already joined/);
  devices.remove(two.id, "Asha");
  expect(() => devices.replaceCredential(two.id, deviceHash(C)!, "Asha", "x")).toThrow(/Device not found/);
  // The removed device's old browser can take over another device.
  expect(devices.replaceCredential(one.id, deviceHash(B)!, "Asha", "x").credentialHash).toBe(deviceHash(B));
});
```

(`const C = "c".repeat(64)` joins `A` and `B` at the top of the file.) In "in a licensed build with no main counter",
the test that signs in with the removed counter's browser now expects `SELECT count(*) FROM devices` to be `{ n: 2 }`.

- [ ] **Step 2: Run and see them fail**

Run: `npx vitest run apps/server/src/devices.test.ts`
Expected: FAIL (`replaceCredential` is not a function; the revived row keeps its old id)

- [ ] **Step 3: Implement the three members and the retire step in `apps/server/src/devices.ts`; update the class comment on `add`**

- [ ] **Step 4: Run `npx vitest run apps/server/src/devices.test.ts apps/server/src/licensing.test.ts`; expected PASS**

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/devices.ts apps/server/src/devices.test.ts
git commit -m "feat(server): replace a device's browser; a removed browser joins as a new device"
```

---

### Task 3: Join codes — create and redeem

**Files:**
- Create: `apps/server/src/device-join.ts`
- Create: `apps/server/src/device-join.test.ts`

**Interfaces:**
- Consumes: `Devices.add`, `Devices.replaceCredential`, `Devices.active`, `Devices.findByCredential` (Task 2);
  `deviceHash` from `./devices.js`; `JOIN_CODE_*`, `normalizeJoinCode`, `JoinCodeCreate` (Task 1).
- Produces:

```ts
export interface IssuedCode { code: string; expiresAt: number; kind: DeviceKind; name: string; replacesDeviceId: string | null }
export class JoinCodes {
  constructor(db: Database, devices: Devices, now?: () => number, randomCode?: () => string);
  /** `limit` is the licence's maxDevices, or null for no limit. */
  create(input: JoinCodeCreate, createdBy: string, limit: number | null): IssuedCode;
  /** Joins the browser holding `credential` and returns its device. */
  redeem(code: unknown, credential: unknown, limit: number | null): DeviceRecord;
}
```

- `create`, in one transaction: delete every row with `expires_at < now`; for a replace code, 404 `Device not found`
  unless the target is active, and take its kind and name; for a new-device code, 409 (limit message) when
  `limit !== null && active().length >= limit`; delete unused codes for the same target (same `replaces_device_id`,
  or for a new device the same kind and the same name ignoring case); insert with `expires_at = now + JOIN_CODE_TTL_MS`.
  The default `randomCode` draws each character with `crypto.randomInt`; on a `code_hash` collision draw again.
- `redeem`, in one transaction and in this order: 400 `A device credential is required` when `deviceHash(credential)`
  is null; 409 `This device has already joined.` when the credential is an active device; the one 400 message when
  the code does not normalise, has no row, is used, has `expires_at <= now`, or replaces a device that is no longer
  active; for a new-device code the limit check (409, code left unused); then `add(..., row.created_by,
  "Joined as <name>.")` or `replaceCredential(target, hash, row.created_by, "Replaced the browser of <name>.")`, and
  set `used_at = now`.
- `code_hash` is `sha256(normalised code)` in hex.

- [ ] **Step 1: Write the failing tests**

Fixture: in-memory db with `MIGRATIONS`, `now = 1_000`, `devices = new Devices(db, () => now)`, a queue of codes
`["AAAAAA", "BBBBBB", "CCCCCC", ...]` handed out by the injected `randomCode`, `codes = new JoinCodes(db, devices, () => now, next)`,
credentials `A`, `B`, `C`, and `devices.add({ credentialHash: deviceHash(A)!, name: "Main counter", kind: "counter", isMain: true }, "Asha")`.
`INVALID = /not valid or has expired/`.

```ts
it("makes a code that lasts ten minutes and stores only its hash", () => {
  const issued = codes.create({ kind: "kitchen", name: "Pass" }, "Asha", null);
  expect(issued).toEqual({ code: "AAAAAA", expiresAt: 1_000 + 600_000, kind: "kitchen", name: "Pass", replacesDeviceId: null });
  expect(JSON.stringify(db.prepare("SELECT * FROM device_join_codes").all())).not.toContain("AAAAAA");
});
it("the default generator uses only the alphabet", () => {
  const real = new JoinCodes(db, devices, () => now);
  for (let i = 0; i < 50; i++) expect(real.create({ kind: "counter", name: `C${i}` }, "Asha", null).code).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ2-9]{6}$/);
});
it("joins a new device with the code's name and kind", () => {
  codes.create({ kind: "kitchen", name: "Pass" }, "Asha", null);
  now = 5_000;
  expect(codes.redeem("aaa aaa", B, null)).toMatchObject({ name: "Pass", kind: "kitchen", isMain: false, createdAt: 5_000, credentialHash: deviceHash(B) });
  expect(devices.events().events[0]).toMatchObject({ kind: "joined", summary: "Joined as Pass.", actorName: "Asha" });
});
it("gives wrong, used and expired codes the same answer", () => {
  codes.create({ kind: "counter", name: "Two" }, "Asha", null);
  expect(() => codes.redeem("ZZZZZZ", B, null)).toThrow(INVALID);
  expect(() => codes.redeem("nope", B, null)).toThrow(INVALID);
  codes.redeem("AAAAAA", B, null);
  expect(() => codes.redeem("AAAAAA", C, null)).toThrow(INVALID);
  codes.create({ kind: "counter", name: "Three" }, "Asha", null);   // BBBBBB
  now = 1_000 + 600_000;
  expect(() => codes.redeem("BBBBBB", C, null)).toThrow(INVALID);
  expect(devices.active()).toHaveLength(2);
});
it("refuses a browser that is already a device, without using the code", () => {
  codes.create({ kind: "counter", name: "Two" }, "Asha", null);
  expect(() => codes.redeem("AAAAAA", A, null)).toThrow(/already joined/);
  expect(codes.redeem("AAAAAA", B, null).name).toBe("Two");
});
it("refuses a missing or malformed credential", () => {
  codes.create({ kind: "counter", name: "Two" }, "Asha", null);
  for (const bad of [undefined, "short"]) expect(() => codes.redeem("AAAAAA", bad, null)).toThrow(/device credential is required/);
});
it("refuses a new-device code at the limit, when made and when used", () => {
  expect(() => codes.create({ kind: "counter", name: "Two" }, "Asha", 1)).toThrow(/Device limit reached/);
  codes.create({ kind: "counter", name: "Two" }, "Asha", 2);        // AAAAAA
  codes.create({ kind: "kitchen", name: "Pass" }, "Asha", 2);       // BBBBBB
  codes.redeem("AAAAAA", B, 2);
  expect(() => codes.redeem("BBBBBB", C, 2)).toThrow(/Device limit reached/);
  expect(devices.active()).toHaveLength(2);
  expect(codes.redeem("BBBBBB", C, 3).name).toBe("Pass");
});
it("a replace code works at the limit and keeps name, kind, settings and place", () => {
  now = 2_000; const pass = devices.add({ credentialHash: deviceHash(B)!, name: "Pass", kind: "kitchen" }, "Asha");
  db.prepare("UPDATE devices SET settings = '{\"x\":1}' WHERE id = ?").run(pass.id);
  db.prepare("INSERT INTO users (id, name, pin_hash, role, created_at) VALUES ('u1', 'Asha', 'x', 'admin', 1)").run();
  db.prepare("INSERT INTO sessions (token, user_id, created_at, expires_at, device) VALUES ('t', 'u1', 1, 9999999999999, ?)").run(deviceHash(B));
  const issued = codes.create({ replacesDeviceId: pass.id }, "Asha", 2);
  expect(issued).toMatchObject({ kind: "kitchen", name: "Pass", replacesDeviceId: pass.id });
  now = 3_000;
  expect(codes.redeem(issued.code, C, 2)).toMatchObject({ id: pass.id, name: "Pass", kind: "kitchen", settings: { x: 1 }, createdAt: 2_000 });
  expect(devices.active().map((d) => d.name)).toEqual(["Main counter", "Pass"]);
  expect(db.prepare("SELECT count(*) AS n FROM sessions").get()).toEqual({ n: 0 });
  expect(devices.events().events[0]).toMatchObject({ kind: "replaced", summary: "Replaced the browser of Pass." });
});
it("refuses a replace code for a device that is not there, and one whose device was removed since", () => {
  expect(() => codes.create({ replacesDeviceId: crypto.randomUUID() }, "Asha", null)).toThrow(/Device not found/);
  const pass = devices.add({ credentialHash: deviceHash(B)!, name: "Pass", kind: "kitchen" }, "Asha");
  const issued = codes.create({ replacesDeviceId: pass.id }, "Asha", null);
  devices.remove(pass.id, "Asha");
  expect(() => codes.redeem(issued.code, C, null)).toThrow(INVALID);
});
it("a new code for the same target cancels the unused earlier one", () => {
  codes.create({ kind: "counter", name: "Two" }, "Asha", null);     // AAAAAA
  codes.create({ kind: "counter", name: "two" }, "Asha", null);     // BBBBBB, same target
  codes.create({ kind: "kitchen", name: "Two" }, "Asha", null);     // CCCCCC, another target
  expect(() => codes.redeem("AAAAAA", B, null)).toThrow(INVALID);
  expect(codes.redeem("BBBBBB", B, null).kind).toBe("counter");
  expect(codes.redeem("CCCCCC", C, null).kind).toBe("kitchen");
});
it("a removed browser joins again as the code's kind", () => {
  const old = devices.add({ credentialHash: deviceHash(B)!, name: "Old", kind: "counter" }, "Asha");
  devices.remove(old.id, "Asha");
  codes.create({ kind: "captain", name: "Tablet" }, "Asha", null);
  expect(codes.redeem("AAAAAA", B, null)).toMatchObject({ name: "Tablet", kind: "captain" });
  expect(devices.active().map((d) => d.name)).toEqual(["Main counter", "Tablet"]);
});
it("clears expired codes when the next one is made", () => {
  codes.create({ kind: "counter", name: "Two" }, "Asha", null);
  now += 600_001;
  codes.create({ kind: "counter", name: "Three" }, "Asha", null);
  expect(db.prepare("SELECT count(*) AS n FROM device_join_codes").get()).toEqual({ n: 1 });
});
```

- [ ] **Step 2: Run and see them fail**

Run: `npx vitest run apps/server/src/device-join.test.ts`
Expected: FAIL (cannot find `./device-join.js`)

- [ ] **Step 3: Implement `JoinCodes` in `apps/server/src/device-join.ts`**

- [ ] **Step 4: Run the same command; expected PASS**

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/device-join.ts apps/server/src/device-join.test.ts
git commit -m "feat(server): device join codes"
```

---

### Task 4: Routes — create a code, join, who am I, re-join as main counter

**Files:**
- Modify: `apps/server/src/device-join.ts` (add `registerDeviceJoin`)
- Modify: `apps/server/src/server.ts` (call `registerDeviceJoin(app, opts.port, opts.captainHttps, opts.licensing?.now)` after `registerLicensing(app)`)
- Modify: `apps/server/src/licensing.ts` (`assertAccess`: let `/api/devices/rejoin-main` through, with the reason in a comment)
- Modify: `apps/server/src/test-helpers.ts` (add `joinDevice`)
- Test: `apps/server/src/device-join.test.ts`

**Interfaces:**
- Consumes: `JoinCodes` (Task 3); `Devices.main`, `Devices.replaceCredential` (Task 2); `lanUrls`, `fromMainPc` from
  `./system.js`; `guestRateLimiter` from `./guest-rate.js`; `app.licensing.status().maxDevices`;
  `app.licensing.announceChange()` (closes the sockets of deleted sessions and tells the other screens).
- Produces:

| Route | Guard | Body | Reply |
|---|---|---|---|
| `POST /api/devices/join-codes` | `requirePermission("settings.manage")` | `JoinCodeCreate` | 201 `JoinCodeIssued` |
| `POST /api/devices/join` | none; 10 a minute per IP (`rate(req, "device-join", 10)`) | `{ code: string }` (max 40) | `DeviceJoined` |
| `GET /api/devices/me` | none | | `DeviceMe` |
| `POST /api/devices/rejoin-main` | `requireAuth` | none | `DeviceJoined` |

  Every reply sets `Cache-Control: no-store`. `join` and `rejoin-main` call `announceChange()` after they succeed.

- `links`: one `{ url: "<origin>/join#<code>", qr }` per origin, `qr` from `QRCode.toDataURL(url, { width: 220, margin: 2 })`.
  Origins are `lanUrls(port)`; for kind `captain` with `captainHttps?.enabled` and at least one address they are
  `https://<address>:<captainHttps.port>` instead.
- `me`: `{ joined, kind, mainPc: fromMainPc(req) }` from `app.devices.findByCredential(header)`; an absent or malformed
  header is `joined: false`.
- `rejoin-main`, in this order: 403 `Only an administrator can re-join the main counter.` unless
  `req.user.role === "admin"`; 403 `Re-join the main counter from the main POS PC.` unless `fromMainPc(req)`; 400
  `A device credential is required`; 409 `There is no main counter to re-join.` when `devices.main()` is null; then
  `replaceCredential(main.id, hash, req.user.name, "Re-joined <name> from the main PC.")`.
- `export async function joinDevice(app: FastifyInstance, adminHeaders: Record<string, string>, credential: string, device: { kind: DeviceKind; name: string } = { kind: "counter", name: "Counter 2" }): Promise<void>`
  in `test-helpers.ts`: creates a code with `adminHeaders`, joins with `credential`, throws with the response body if
  either call fails.

- [ ] **Step 1: Write the failing tests** (a second `describe` in `device-join.test.ts`; `freshApp`, `commercialApp`, `SETUP`, `ADMIN_LOGIN`, `auth`, `createUser`, `testLogin` from `./test-helpers.js`; apps closed in `afterEach` as in `devices.test.ts`)

`D = "d".repeat(64)` is the credential `commercialApp` sets up with; `LAN = "192.168.1.20"`.

```ts
it("an admin makes a code and another browser joins with it", async () => {
  const { app, headers } = await commercialApp("basic");
  const made = await app.inject({ method: "POST", url: "/api/devices/join-codes", headers, payload: { kind: "kitchen", name: "Pass" } });
  expect(made.statusCode).toBe(201);
  expect(made.headers["cache-control"]).toBe("no-store");
  const issued = made.json();
  expect(issued).toMatchObject({ kind: "kitchen", name: "Pass", replacesDeviceId: null });
  expect(issued.code).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ2-9]{6}$/);
  for (const link of issued.links) { expect(link.url).toMatch(new RegExp(`^http://[\\d.]+:\\d+/join#${issued.code}$`)); expect(link.qr).toMatch(/^data:image\/png/); }
  expect((await app.inject({ url: "/api/devices/me", headers: { "x-masalapos-device": B }, remoteAddress: LAN })).json()).toEqual({ joined: false, kind: null, mainPc: false });
  const joined = await app.inject({ method: "POST", url: "/api/devices/join", headers: { "x-masalapos-device": B }, payload: { code: issued.code.toLowerCase() }, remoteAddress: LAN });
  expect([joined.statusCode, joined.json()]).toEqual([200, { kind: "kitchen", name: "Pass" }]);
  expect((await app.inject({ url: "/api/devices/me", headers: { "x-masalapos-device": B } })).json()).toEqual({ joined: true, kind: "kitchen", mainPc: true });
  // The joined device can sign in and work.
  const signedIn = await app.inject({ method: "POST", url: "/api/login", payload: ADMIN_LOGIN, headers: { "x-masalapos-device": B } });
  expect((await app.inject({ url: "/api/products", headers: { ...auth(signedIn.json().token), "x-masalapos-device": B } })).statusCode).toBe(200);
});
it("only someone who manages settings can make a code", async () => {
  // dev app, cashier via createUser: POST /api/devices/join-codes → 403; with no token → 401
});
it("refuses a new-device code at the plan's limit and allows a replace code", async () => {
  const { app, headers } = await commercialApp("basic");          // 2 devices
  await joinDevice(app, headers, B);
  const full = await app.inject({ method: "POST", url: "/api/devices/join-codes", headers, payload: { kind: "counter", name: "Three" } });
  expect([full.statusCode, full.json().error]).toEqual([409, "Device limit reached. Remove an old device or upgrade your plan."]);
  const second = app.devices.findByCredential(B)!;
  expect((await app.inject({ method: "POST", url: "/api/devices/join-codes", headers, payload: { replacesDeviceId: second.id } })).statusCode).toBe(201);
});
it("a dev build has no limit", async () => {
  // freshApp + setup with credential A; joinDevice for B, C and D all succeed; app.devices.active() has 4
});
it("answers every bad code alike", async () => {
  // dev app: join with "ZZZZZZ", with "x", and with a used code → each 400 { error: "That code is not valid or has expired" }
});
it("refuses a joined browser, a missing credential and a malformed body", async () => {
  // join from the setup browser with a valid code → 409 "This device has already joined."
  // join with no x-masalapos-device header → 400 "A device credential is required"
  // join with payload {} → 400
});
it("limits join attempts per address", async () => {
  // 10 wrong codes from LAN → each 400; the 11th → 429 "Please wait a minute and try again"; one from "192.168.1.21" → 400
});
it("replacing a device signs its old browser out", async () => {
  const { app, headers } = await commercialApp("basic");
  await joinDevice(app, headers, B, { kind: "counter", name: "Second" });
  const old = await app.inject({ method: "POST", url: "/api/login", payload: ADMIN_LOGIN, headers: { "x-masalapos-device": B } });
  const oldHeaders = { ...auth(old.json().token), "x-masalapos-device": B };
  const code = (await app.inject({ method: "POST", url: "/api/devices/join-codes", headers, payload: { replacesDeviceId: app.devices.findByCredential(B)!.id } })).json().code;
  expect((await app.inject({ method: "POST", url: "/api/devices/join", headers: { "x-masalapos-device": C }, payload: { code } })).json()).toEqual({ kind: "counter", name: "Second" });
  expect((await app.inject({ url: "/api/products", headers: oldHeaders })).statusCode).toBe(401);
  expect(app.devices.active().map((d) => d.name)).toEqual(["Main counter", "Second"]);
});
it("an admin on the main PC re-joins as the main counter without a code", async () => {
  const { app, headers } = await commercialApp("basic");
  const fresh = await app.inject({ method: "POST", url: "/api/login", payload: ADMIN_LOGIN, headers: { "x-masalapos-device": B } });
  const freshHeaders = { ...auth(fresh.json().token), "x-masalapos-device": B };
  expect((await app.inject({ url: "/api/products", headers: freshHeaders })).statusCode).toBe(403);
  const rejoined = await app.inject({ method: "POST", url: "/api/devices/rejoin-main", headers: freshHeaders });
  expect([rejoined.statusCode, rejoined.json()]).toEqual([200, { kind: "counter", name: "Main counter" }]);
  expect((await app.inject({ url: "/api/products", headers: freshHeaders })).statusCode).toBe(200);
  expect((await app.inject({ url: "/api/products", headers })).statusCode).toBe(401);          // the old browser
  expect(app.devices.active()).toHaveLength(1);
  expect(app.devices.events().events[0]).toMatchObject({ kind: "replaced", summary: "Re-joined Main counter from the main PC.", actorName: SETUP.adminName });
});
it("refuses the re-join from another address, for a cashier, and from a browser that is already a device", async () => {
  // same start; POST rejoin-main with remoteAddress LAN → 403 "Re-join the main counter from the main POS PC."
  // a cashier signed in on B from loopback → 403 "Only an administrator can re-join the main counter."
  // the main counter's own browser (headers) → 409 "This device has already joined."
  // after each: app.devices.findByCredential(D) is still the main counter
});
it("has nothing to re-join when there is no main counter", async () => {
  // dev app, setupAdmin (no device header, so no main), admin token + credential A → 409 "There is no main counter to re-join."
});
```

The comment-only tests are written out in full with the statuses and messages their comments give.

- [ ] **Step 2: Run and see them fail**

Run: `npx vitest run apps/server/src/device-join.test.ts`
Expected: the route tests FAIL with 404s

- [ ] **Step 3: Implement `registerDeviceJoin(app, port = 4100, captainHttps?: CaptainHttpsInfo, now?: () => number)`, the `assertAccess` exemption, the `server.ts` call and `joinDevice`**

- [ ] **Step 4: Run `npx vitest run apps/server/src/device-join.test.ts apps/server/src/devices.test.ts apps/server/src/licensing.test.ts`; expected PASS**

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/device-join.ts apps/server/src/device-join.test.ts apps/server/src/server.ts apps/server/src/licensing.ts apps/server/src/test-helpers.ts
git commit -m "feat(server): join by code, device status and re-join as main counter"
```

---

### Task 5: Remove self-registration

**Files:**
- Modify: `apps/server/src/licensing.ts` (delete the `POST /api/license/devices` route and `Licensing.register`; the
  status message `An administrator must register this browser before it can be used for billing.` becomes
  `This device has not joined. Ask an administrator for a join code.`)
- Modify: `apps/server/src/test-helpers.ts` (`commercialApp` drops its registration call; its doc comment says the
  setup browser is the main counter, "Main counter")
- Modify: `apps/server/src/licensing.test.ts`, `devices.test.ts`, `guest-ordering.test.ts`, `guest-services.test.ts`,
  `recipes.test.ts`, `quick-takeaway.test.ts` (all in `apps/server/src/`)

**Interfaces:**
- Consumes: `joinDevice` (Task 4).
- Produces: `GET`, `PATCH` and `DELETE /api/license/devices…` are unchanged and stay until Phase 4.

Setup already makes the setup browser the main counter, so every test call that registered **that** browser is simply
deleted, and names the tests expected from it ("Counter") become "Main counter". Every call that registered **another**
browser becomes `joinDevice(app, adminHeaders, credential, { kind: "counter", name })`. Expected versions and event
counts that came from the deleted rename go down by that rename.

- [ ] **Step 1: Write the failing test** (in `licensing.test.ts`)

```ts
it("has no self-registration route", async () => {
  const f = await fixture();
  expect((await f.app.inject({ method: "POST", url: "/api/license/devices", headers: f.headers, payload: { name: "Mine" } })).statusCode).toBe(404);
});
it("tells an unjoined browser to get a join code", async () => {
  const f = await fixture(); await f.activate();
  expect(f.app.licensing.status("b".repeat(64))).toMatchObject({ canOperate: false, deviceRegistered: false, message: "This device has not joined. Ask an administrator for a join code." });
});
```

(Use the file's own fixture and activation helpers under whatever names they have.)

- [ ] **Step 2: Run `npx vitest run apps/server/src/licensing.test.ts`; expected: the two new tests FAIL**

- [ ] **Step 3: Delete the route and `register`, change the message, and convert the test files as described above**

- [ ] **Step 4: Run `npx vitest run apps/server apps/licensing-node apps/licensing-worker` then `npx tsc --noEmit`; expected PASS and no errors, and `grep -rn '"/api/license/devices", *payload\|license/devices", "POST"\|licensing.register(' apps` finds nothing**

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/licensing.ts apps/server/src/test-helpers.ts apps/server/src/licensing.test.ts apps/server/src/devices.test.ts apps/server/src/guest-ordering.test.ts apps/server/src/guest-services.test.ts apps/server/src/recipes.test.ts apps/server/src/quick-takeaway.test.ts
git commit -m "feat(server)!: devices join by code; self-registration removed"
```

---

### Task 6: Join screen and the device gate

**Files:**
- Create: `apps/ui/src/join-code.ts`, `apps/ui/src/join-code.test.ts`
- Create: `apps/ui/src/screens/JoinScreen.tsx`
- Create: `apps/ui/src/DeviceGate.tsx`
- Modify: `apps/ui/src/App.tsx:64-65` (wrap `<KitchenApp />` and `<StaffApp />` in `<DeviceGate>`; the guest menu and
  feedback pages stay outside it)

**Interfaces:**
- Consumes: `GET /api/devices/me`, `POST /api/devices/join`, `POST /api/devices/rejoin-main` (Task 4);
  `normalizeJoinCode` from `@masalapos/domain/devices`; `apiFetch`, `session`, `ApiError` from `./api`; `Login` from
  `./screens/Login`; `isUnreachable` from `./offline-cache`.
- Produces:

```ts
// join-code.ts
/** The code in `/join#<code>`, normalised; "" on any other path or when the hash is not a code. */
export function codeFromLocation(location: { pathname: string; hash: string }): string;
export function homeForKind(kind: DeviceKind): "/" | "/kitchen/" | "/captain/";
/** What the gate does with the two answers; `me` or `needsSetup` is "unreachable" when that request could not reach the hub. */
export function gateDecision(me: DeviceMe | "unreachable", needsSetup: boolean | "unreachable", pathname: string):
  { show: "app" } | { show: "join"; me: DeviceMe } | { redirect: string };
/** "9:05" for 545_000; "0:00" at or below zero. */
export function countdown(msLeft: number): string;
```

- `gateDecision`: unreachable (either answer) → app; needs setup → app; not joined → join; joined on `/join` →
  redirect to `homeForKind(kind)`; joined elsewhere → app.
- `DeviceGate({ children })`: asks `/api/devices/me` and `/api/needs-setup` together, shows `StartupScreen` meanwhile,
  applies `gateDecision` (a redirect is `location.replace`), and asks again on the `masalapos:license-changed` window
  event. A request error that is not `isUnreachable` shows the join screen's own "Cannot reach the main POS" message
  with a Retry button rather than the app.
- `JoinScreen({ me, onJoined })`, `onJoined(kind)` does `location.replace(homeForKind(kind))`. Laid out with the Login
  screen's classes. Exact copy:
  - Heading `Enter join code`; help `Ask an administrator for a code. On the main counter: Settings, Plan & devices, Add a device.`
  - Field label `Join code`, 6 characters, `autoCapitalize="characters"`, `autoComplete="off"`, filled from
    `codeFromLocation(location)`; button `Join`, disabled until `normalizeJoinCode` accepts the field.
  - Errors show the server's message.
  - Only when `me.mainPc`: a button `This is the main counter`. It shows `Login`; a non-admin is signed out again with
    `Only an administrator can re-join the main counter.`; for an admin the screen asks `/api/devices/me` again, goes
    on if the browser is now joined (sign-in made it the main counter), and otherwise shows the button
    `Re-join as main counter` with `The main counter's old browser will be signed out.`, which posts to
    `/api/devices/rejoin-main`.

- [ ] **Step 1: Write the failing tests** (`apps/ui/src/join-code.test.ts`)

```ts
const me = (joined: boolean, kind: DeviceKind | null = null, mainPc = false): DeviceMe => ({ joined, kind, mainPc });
it("reads the code from a join link", () => {
  expect(codeFromLocation({ pathname: "/join", hash: "#k7m2qp" })).toBe("K7M2QP");
  expect(codeFromLocation({ pathname: "/join/", hash: "#K7M2QP" })).toBe("K7M2QP");
  expect(codeFromLocation({ pathname: "/join", hash: "#nope" })).toBe("");
  expect(codeFromLocation({ pathname: "/", hash: "#K7M2QP" })).toBe("");
});
it("sends each kind of device to its screen", () => {
  expect([homeForKind("counter"), homeForKind("kitchen"), homeForKind("captain")]).toEqual(["/", "/kitchen/", "/captain/"]);
});
it("decides between the app and the join screen", () => {
  expect(gateDecision(me(false), false, "/")).toEqual({ show: "join", me: me(false) });
  expect(gateDecision(me(false), false, "/kitchen/")).toEqual({ show: "join", me: me(false) });
  expect(gateDecision(me(false), true, "/")).toEqual({ show: "app" });                 // first-run setup
  expect(gateDecision(me(true, "counter"), false, "/")).toEqual({ show: "app" });
  expect(gateDecision(me(true, "counter"), false, "/kitchen/")).toEqual({ show: "app" });
  expect(gateDecision(me(true, "kitchen"), false, "/join")).toEqual({ redirect: "/kitchen/" });
  expect(gateDecision("unreachable", "unreachable", "/captain/")).toEqual({ show: "app" });   // offline captain keeps working
  expect(gateDecision("unreachable", false, "/")).toEqual({ show: "app" });
});
it("counts down in minutes and seconds", () => {
  expect([countdown(600_000), countdown(545_000), countdown(9_400), countdown(0), countdown(-5)]).toEqual(["10:00", "9:05", "0:10", "0:00", "0:00"]);
});
```

- [ ] **Step 2: Run `npx vitest run apps/ui/src/join-code.test.ts`; expected FAIL (module not found)**

- [ ] **Step 3: Implement `join-code.ts`, `JoinScreen.tsx`, `DeviceGate.tsx` and the `App.tsx` wrap**

- [ ] **Step 4: Run `npx vitest run apps/ui` and `npm run typecheck -w @masalapos/ui`; expected PASS and no errors**

- [ ] **Step 5: Commit**

```bash
git add apps/ui/src/join-code.ts apps/ui/src/join-code.test.ts apps/ui/src/screens/JoinScreen.tsx apps/ui/src/DeviceGate.tsx apps/ui/src/App.tsx
git commit -m "feat(ui): unjoined devices see the join screen"
```

`apps/ui/src/main.tsx` has another session's uncommitted edit and is not part of this task.

---

### Task 7: Creating codes in Plan & devices, e2e scripts, docs

**Files:**
- Create: `apps/ui/src/screens/JoinCodePanel.tsx`
- Modify: `apps/ui/src/screens/LicenseSettings.tsx` (lines 57, 154, 197-220)
- Modify: `apps/ui/src/license-settings.css` (the code and its QR codes; POS stylesheet variables only, so the dark theme works)
- Modify: `tools/e2e/licensing.js:28,71,109`, `tools/e2e/distribution-smoke.mjs:69`
- Modify: `docs/operations/commercial-licensing.md` (lines 23-24, 171, 218-219, 238-240), `docs/superpowers/specs/2026-11-10-devices-design.md` (status line and pick-up point)

**Interfaces:**
- Consumes: `POST /api/devices/join-codes` → `JoinCodeIssued` (Task 4); `countdown` (Task 6); `LicensedDevice` and the
  existing `run`, `busy`, `devices` state of `LicenseSettings`.
- Produces: `JoinCodePanel({ devices, atLimit, disabled }: { devices: LicensedDevice[]; atLimit: boolean; disabled: boolean })`,
  which Phase 4 moves into the Devices area.

`JoinCodePanel`, exact copy:
- Heading `Add a device`. Choice `New device` / `Replace an existing device`.
- New device: `Type` select with `Billing counter`, `Kitchen display`, `Captain`; `Device name` (max 80). While
  `atLimit`, the new-device fields are disabled under `Device limit reached. Remove an unused device or upgrade the plan. Replacing a device uses no extra slot.`
- Replace: a `Device` select of `devices`, with `The new browser takes over this device's name and place. Its old browser is signed out.`
- Button `Create join code`. Then: the code in large spaced type, `Valid for <countdown>` updated every second, each
  link's QR with its URL beneath, `On the new device, open this address or scan the code, then enter the code.`, and
  a `Done` button. At zero: `This code has expired. Create a new one.`
- Server errors show the server's message.

`LicenseSettings` changes:
- Delete the "Register this device" form and the limit warning under it (lines 215-219) with the state only they use;
  render `<JoinCodePanel>` there, `atLimit` being `status.maxDevices !== null && devices.length >= status.maxDevices`.
- Move the whole "Registered devices" section out of the `status?.mode === "commercial"` block so dev and demo builds
  show it; the section heading becomes `Devices`.
- Line 198 help: `Each PC, tablet or phone browser uses a slot. Tabs in the same browser share one. Add a device to get a join code for it.`
- Line 154: `This browser is registered` → `This device has joined`; `This browser needs registration` →
  `This device has not joined`; the label `Registered devices` → `Devices`.
- Line 57 (staff notice when the plan stops billing): `Ask your administrator to renew the plan or free a device slot.`

e2e scripts: where they registered a browser by `POST /api/license/devices` or the "Register this device" button,
they create a code with `POST /api/devices/join-codes` as the admin and join with `POST /api/devices/join` sending the
new browser's `x-masalapos-device`. The setup browser needs neither. The stale-list check at `licensing.js:109`
asserts on the `Create join code` button instead.

Docs: `commercial-licensing.md` describes adding a device by join code, replacing one, and re-joining the main
counter on the main PC, in place of "sign in as an administrator on each device and register it". The spec's status
line becomes "Phases 1 and 2 built (migrations 65 and 66); Phases 3 and 4 not built", with a Phase 3 pick-up point:
`req.device` is set for every joined device, `devices.settings` is still `{}`, and the join-code panel lives in
`JoinCodePanel.tsx` under Plan & devices until Phase 4.

- [ ] **Step 1: Build `JoinCodePanel.tsx` and make the `LicenseSettings` and CSS changes**

- [ ] **Step 2: Run `npx vitest run apps/ui` and `npm run typecheck`; expected PASS and no errors**

- [ ] **Step 3: Update the two e2e scripts; run `node --check tools/e2e/licensing.js` and `node --check tools/e2e/distribution-smoke.mjs`; expected no output**

- [ ] **Step 4: Run through it in the app** (dev server on the main PC, a second browser profile as the new device; kill the dev server by PID afterwards)

  1. A fresh database: setup still lands the admin in the POS with no join screen.
  2. The second profile at `/` shows only **Enter join code**; so do `/kitchen/` and `/captain/`.
  3. Settings → Plan & devices → Add a device (Kitchen display, "Pass") shows a code, a countdown and QR codes.
  4. The second profile opens `/join#<code>`: the code is filled in, **Join** lands on `/kitchen/` and its sign-in.
  5. A wrong code and the used code both say "That code is not valid or has expired".
  6. Clear the second profile's storage, create a replace code for "Pass", join: the list still shows one "Pass" in
     the same place.
  7. Clear the main browser's storage: join screen → **This is the main counter** → admin sign-in →
     **Re-join as main counter** → the POS opens, and the device list shows one main counter.
  8. Both themes: the panel and the join screen are readable in dark.

- [ ] **Step 5: Run the whole suite: `npm test` and `npm run typecheck`; expected PASS and no errors**

- [ ] **Step 6: Update the docs and the spec status line, then commit**

```bash
git add apps/ui/src/screens/JoinCodePanel.tsx apps/ui/src/screens/LicenseSettings.tsx apps/ui/src/license-settings.css tools/e2e/licensing.js tools/e2e/distribution-smoke.mjs docs/operations/commercial-licensing.md docs/superpowers/specs/2026-11-10-devices-design.md
git commit -m "feat(ui): create join codes from Plan & devices; docs for joining by code"
```
