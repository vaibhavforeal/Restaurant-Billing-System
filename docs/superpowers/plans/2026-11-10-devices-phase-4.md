# Devices Phase 4 — Devices area: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One **Devices** card in Settings holds the device list, adding and replacing devices, each device's
settings, printers, kitchen stations and print jobs; the other cards lose their device parts; one scan pairs and joins
an Android Captain tablet.

**Architecture:** The server gains rename, remove and history routes under `/api/devices` and loses
`/api/license/devices`; printers report who uses them; a captain join code carries Android pairing QRs. In the UI the
printer, station and job markup moves out of `Settings.tsx` into one component per tab, a new Devices tab and Add
device dialog sit beside them, and everything that can be decided without React lives in `devices-model.ts` so it is
tested with vitest (the UI package has no DOM test library). The Android wrapper passes the code from the pairing URI
to the Captain page as `#join=<code>`.

**Tech Stack:** TypeScript, zod, better-sqlite3, Fastify, React 19, plain CSS, vitest, Kotlin (Android wrapper).

**Spec:** `docs/superpowers/specs/2026-11-10-devices-design.md` (section "Phase 4 — Devices area", the Phase 4 line
under "Testing", and the status header at the top)

## Decisions the spec leaves open (approve before building)

1. **No migration.** Nothing in Phase 4 changes the schema. 67 stays the next free number.
2. **Settings opens for staff who have `printers.read` but not `settings.manage`.** The spec says the Devices card is
   visible with either. Today the Settings tab and `GET /api/settings` need `settings.manage`, so such a person cannot
   reach Settings at all. They get the Settings tab with the Devices card only, showing Printers, Kitchen stations and
   Print jobs, and Settings does not load `/api/settings` for them.
3. **The device list stays reachable when the licence stops this browser.** `/api/license/*` is exempt from the
   licence check, which is how an administrator on an expired or over-limit installation removes a device today.
   `GET /api/devices`, `PATCH` and `DELETE /api/devices/:id` and `GET /api/devices/events` get the same exemption, and
   the licence recovery screen shows the Devices tab in a reduced form (list, rename, remove, history; no Add device,
   no printer or payment controls, since those routes stay behind the licence).
4. **The Add device dialog knows a device joined from the device history**, not from the list: a `joined` event for
   a device id it had not seen, or a `replaced` event for the device being replaced, newer than the newest event when
   the code was made. A rename during the wait cannot be mistaken for a join.
5. **Kitchen displays have no bill printer or starting payment method.** The list shows "—" for them and the device
   dialog leaves both controls out.
6. **"Used by" comes from the server.** Every printer in a printers response carries
   `usedBy: { devices: string[]; stations: string[] }`, so someone with only `printers.read` sees it too.
7. **`/api/license/devices` is removed with no alias**, with `Licensing.devices`, `rename`, `revoke` and the
   `LicensedDevice` type. Nothing is live.
8. **The Android app does not store the join code.** It goes from the scan to the first page load in memory. A `code`
   that is not a well-formed join code is ignored and the tablet pairs as it does today.
9. **The tab is called "Kitchen stations"** (it was "KOT stations"), as in the spec.

## Global Constraints

- Card titles: **Devices** (replaces Printers), **This device** (theme and QR alerts only), **Backups** (was "Backups
  & connections"), **Plan** (was "Plan & devices"). Section ids: `devices` replaces `printers`; `device`, `backups`
  and `plan` keep their ids.
- Devices card tabs, in order: **Devices** (needs `settings.manage`), **Printers**, **Kitchen stations**, **Print
  jobs** (need `printers.read`; their buttons and forms need `printers.manage`).
- Device row badges: "Main", "This device", "Over limit", "Printer inactive". Device types read "Billing counter",
  "Kitchen display", "Captain".
- The Printers tab starts with: "Printers must be reachable from the main PC: on the network, installed in Windows on
  the main PC, or paired to it by Bluetooth."
- Routes: `GET /api/devices`, `PATCH /api/devices/:id`, `DELETE /api/devices/:id`, `GET /api/devices/events`.
  `/api/system/connections` stays.
- Pairing URI: `masalapos-captain://pair?server=<origin>&ca=<fingerprint>&code=<code>`; the wrapper loads
  `<origin>/captain/#join=<code>`. A URI without `code` still pairs.
- A stale device `version` gets 409 `This device changed. Refresh the device list and try again.` The main counter
  cannot be removed: 409 `The main counter can't be removed.`
- No response, event or log line carries a device credential or its hash.
- The moved and new markup has no `style=` attributes and no hard-coded colours; colours come from the POS tokens
  (`pos-tokens.css`, `theme.css`). Plain CSS only; no BoardUI or Tailwind classes.
- The UI imports values from `@masalapos/domain` subpaths only, never the root (`apps/ui/src/domain-imports.test.ts`).
- The working tree has unrelated uncommitted edits from another session (`apps/ui/src/main.tsx`,
  `apps/ui/src/light-buttons.css`, `docs/offers/README.md`, untracked `AGENTS.md`, `References/`, `.claude/`,
  `docs/agents/handoff/`). Do not edit them. Stage only this plan's files, by path; never `git add -A`.
- Branch `feat/devices`. One commit per task. Push only when asked.
- One test file: `npx vitest run <path>`; the whole suite: `npm test`; types: `npm run typecheck`; CSS scoping:
  `npm run check:css-isolation -w @masalapos/ui`.

## Review Focus

1. **An administrator on a browser the licence has stopped** (expired, or over the device limit) opens the recovery
   screen: the device list loads and a device can be removed (Tasks 1 and 8).
2. **A person with `printers.read` and not `settings.manage`** opens Settings: one card, three tabs, and no request
   that needs `settings.manage` (Task 5).
3. **A device is renamed, or its settings change, while the Add device dialog waits for it to be replaced:** the
   dialog keeps waiting (Task 4).
4. **Every licence slot is in use:** Add device still offers Replace an existing device, and a new device is refused
   with the reason shown (Task 4).
5. **A printer is switched off while devices and stations still point at it:** its Used by column still names them
   (Task 2).

## File Structure

| File | Responsibility |
|---|---|
| `apps/server/src/device-routes.ts` | Device list, rename, remove, history, settings |
| `apps/server/src/printers.ts` | `usedBy` on each printer |
| `apps/server/src/device-join.ts`, `system.ts` | Pairing QRs on a captain join code |
| `apps/ui/src/devices-model.ts` | Everything the Devices card decides without React |
| `apps/ui/src/screens/DevicesSettings.tsx` | The card: tabs and who sees which |
| `apps/ui/src/screens/PrintersTab.tsx`, `StationsTab.tsx`, `PrintJobsTab.tsx` | Moved from `Settings.tsx`, one per tab |
| `apps/ui/src/screens/DevicesTab.tsx` | Device list, slots line, history |
| `apps/ui/src/screens/DeviceDialog.tsx` | One device: rename, settings, Replace, Remove |
| `apps/ui/src/screens/AddDeviceDialog.tsx` | Choose, code, joined |
| `apps/ui/src/screens/ConnectionHelp.tsx` | Per-type connection help, moved from `SystemSettings.tsx` |
| `apps/ui/src/devices.css` | Styles for all of the above |

---

### Task 1: Rename, remove and history under `/api/devices`

**Files:**
- Modify: `packages/domain/src/devices.ts`, `packages/domain/src/devices.test.ts`
- Modify: `apps/server/src/device-routes.ts`, `apps/server/src/device-routes.test.ts`
- Modify: `apps/server/src/licensing.ts:305-318` (`assertAccess`), `apps/server/src/licensing.test.ts:187-200`

**Interfaces:**
- Produces, in `@masalapos/domain` and `@masalapos/domain/devices`:

```ts
export const DeviceRename = z.object({ name: z.string().trim().min(1).max(80), version: z.number().int().positive() }).strict();
export const DeviceRemove = z.object({ version: z.number().int().positive().optional() }).strict();
```

- Produces routes, all needing `settings.manage`, all `Cache-Control: no-store`:
  - `PATCH /api/devices/:id` body `DeviceRename` → `{ device: DeviceInfo }`
  - `DELETE /api/devices/:id` body `DeviceRemove` or none → 204
  - `GET /api/devices/events?before=<id>` → `DeviceHistory`
- The old `/api/license/devices` routes stay until Task 8.

- [ ] **Step 1: Write the failing tests**

In `devices.test.ts`: `DeviceRename.parse({ name: "  Bar ", version: 2 })` equals `{ name: "Bar", version: 2 }`;
a blank name, a missing version and an extra key each fail `safeParse`.

In `device-routes.test.ts`, a new `describe("renaming, removing and history")` using the file's fixture:

```ts
it("renames a device with a stale-write check", async () => {
  const d = await two();
  const res = await app.inject({ method: "PATCH", url: `/api/devices/${d.id}`, headers: admin, payload: { name: "Bar", version: d.version } });
  expect(res.statusCode).toBe(200);
  expect(res.json().device).toMatchObject({ id: d.id, name: "Bar", version: d.version + 1 });
  const stale = await app.inject({ method: "PATCH", url: `/api/devices/${d.id}`, headers: admin, payload: { name: "Pass", version: d.version } });
  expect(stale.statusCode).toBe(409);
  expect(stale.json().error).toBe("This device changed. Refresh the device list and try again.");
  expect((await app.inject({ method: "PATCH", url: `/api/devices/${d.id}`, headers: cashier, payload: { name: "X", version: d.version + 1 } })).statusCode).toBe(403);
  expect((await app.inject({ method: "PATCH", url: `/api/devices/${d.id}`, headers: admin, payload: { name: " ", version: d.version + 1 } })).statusCode).toBe(400);
});
it("removes a device, signs its staff out and tells every screen", async () => {
  const d = await two();
  const seen = events(await wsAuth(app, adminToken, A), "license.changed");
  expect((await app.inject({ method: "DELETE", url: `/api/devices/${d.id}`, headers: admin, payload: { version: d.version } })).statusCode).toBe(204);
  await settle();
  expect(seen.length).toBe(1);
  expect((await list()).devices.map((x) => x.name)).toEqual(["Main counter"]);
  expect((await app.inject({ method: "GET", url: "/api/me", headers: cashier })).statusCode).toBe(401);
  expect((await app.inject({ method: "DELETE", url: `/api/devices/${d.id}`, headers: admin })).statusCode).toBe(204);
});
it("refuses to remove the main counter", async () => {
  const main = (await list()).devices.find((x) => x.isMain)!;
  const res = await app.inject({ method: "DELETE", url: `/api/devices/${main.id}`, headers: admin, payload: { version: main.version } });
  expect(res.statusCode).toBe(409);
  expect(res.json().error).toBe("The main counter can't be removed.");
});
it("pages the device history", async () => {
  const d = await two();
  await app.inject({ method: "PATCH", url: `/api/devices/${d.id}`, headers: admin, payload: { name: "Bar", version: d.version } });
  const res = await app.inject({ method: "GET", url: "/api/devices/events", headers: admin });
  expect(res.headers["cache-control"]).toBe("no-store");
  expect(res.json().events[0]).toMatchObject({ kind: "renamed", deviceId: d.id, summary: "Renamed Two to Bar." });
  expect(res.json().nextBefore).toBeNull();
  expect(res.body).not.toMatch(/credential/i);
  expect((await app.inject({ method: "GET", url: "/api/devices/events?before=nope", headers: admin })).statusCode).toBe(400);
  expect((await app.inject({ method: "GET", url: "/api/devices/events", headers: cashier })).statusCode).toBe(403);
});
```

In `licensing.test.ts`, in "keeps device and history APIs available after expiry and denies staff management", add
after the existing assertions (same fixture, licence expired): `GET /api/devices` 200, `GET /api/devices/events` 200,
`PATCH /api/devices/<target.id>` with a new name and the current version 200, and both
`PATCH /api/devices/<target.id>/settings` and `POST /api/devices/join-codes` 403.

- [ ] **Step 2: Run `npx vitest run packages/domain/src/devices.test.ts apps/server/src/device-routes.test.ts apps/server/src/licensing.test.ts`; expected FAIL (404 on the new routes, `DeviceRename` not exported)**

- [ ] **Step 3: Implement**

`device-routes.ts`: the three routes call `app.devices.rename`, `app.devices.remove` and `app.devices.events`, then
`app.licensing.announceChange()` after rename and remove (it closes the removed device's sockets and sends
`license.changed`). `before` is parsed as in `licensing.ts:358`. `assertAccess` lets `req.routeOptions.url` equal to
`/api/devices`, `/api/devices/:id` or `/api/devices/events` through, with a comment saying why (Decision 3).

- [ ] **Step 4: Run the same three files, then `npm run typecheck`; expected PASS and no errors**

- [ ] **Step 5: Commit**

```bash
git add packages/domain/src/devices.ts packages/domain/src/devices.test.ts apps/server/src/device-routes.ts apps/server/src/device-routes.test.ts apps/server/src/licensing.ts apps/server/src/licensing.test.ts
git commit -m "feat(server): rename, remove and device history under /api/devices"
```

---

### Task 2: Printers say who uses them

**Files:**
- Modify: `apps/server/src/printers.ts`, `apps/server/src/printers.test.ts`
- Modify: `apps/ui/src/types.ts:51-60` (`PrinterInfo`)

**Interfaces:**
- Produces: every printer object from `GET`, `POST` and `PATCH /api/printers…` has
  `usedBy: { devices: string[]; stations: string[] }`: names of active (not removed) devices whose saved
  `billPrinterId` is this printer, and of active KOT stations whose printer it is, each sorted by name.
  `PrinterInfo` in `types.ts` gains the same field.

- [ ] **Step 1: Write the failing test** in `printers.test.ts` (use the file's own fixture for an admin; `joinDevice`
  from `test-helpers.ts` for the second device, as `device-routes.test.ts` does):

```ts
it("lists the devices and stations that print to each printer", async () => {
  // printers "Front" and "Spare"; device "Two" set to Front; active station "Grill" on Front; a second station "Old" on Front, deactivated
  const byName = async () => Object.fromEntries(((await app.inject({ method: "GET", url: "/api/printers", headers: admin })).json().printers as PrinterJson[]).map((p) => [p.name, p.usedBy]));
  expect(await byName()).toEqual({ Front: { devices: ["Two"], stations: ["Grill"] }, Spare: { devices: [], stations: [] } });
  // Review Focus 5: switching Front off keeps the names, so the owner sees what stopped printing.
  await app.inject({ method: "PATCH", url: `/api/printers/${frontId}`, headers: admin, payload: { isActive: false } });
  expect((await byName()).Front).toEqual({ devices: ["Two"], stations: ["Grill"] });
  // A removed device is no longer listed.
  await app.inject({ method: "DELETE", url: `/api/devices/${twoId}`, headers: admin });
  expect((await byName()).Front.devices).toEqual([]);
});
```

- [ ] **Step 2: Run `npx vitest run apps/server/src/printers.test.ts`; expected FAIL (`usedBy` undefined)**
- [ ] **Step 3: Implement** in `printers.ts`. Device settings are JSON in `devices.settings`; read them with
  `app.devices.active()` and `app.devices.settings(device)`, not with SQL on the JSON.
- [ ] **Step 4: Run the test file and `npm run typecheck`; expected PASS**
- [ ] **Step 5: Commit**

```bash
git add apps/server/src/printers.ts apps/server/src/printers.test.ts apps/ui/src/types.ts
git commit -m "feat(server): each printer lists the devices and stations that print to it"
```

---

### Task 3: A captain join code carries Android pairing; the Captain page reads `#join=`

**Files:**
- Modify: `packages/domain/src/devices.ts` (`JoinCodeIssued`)
- Modify: `apps/server/src/system.ts:38-42`, `apps/server/src/system.test.ts`
- Modify: `apps/server/src/device-join.ts:99-107`, `apps/server/src/device-join-routes.test.ts`
- Modify: `apps/ui/src/join-code.ts:6-9`, `apps/ui/src/join-code.test.ts`

**Interfaces:**
- Produces:

```ts
// system.ts
export function captainPairingUri(origin: string, fingerprint?: string, code?: string): string;
// domain: JoinCodeIssued gains
pairings: { origin: string; secure: boolean; qr: string }[];   // kind "captain" only; [] for other kinds
// join-code.ts: unchanged signature, new behaviour
export function codeFromLocation(location: { pathname: string; hash: string }): string;
```

- `pairings` has one entry per origin in `links` (the same origins, in the same order); `secure` is true for the
  HTTPS origins; the QR encodes `captainPairingUri(origin, <CA fingerprint when secure>, code)`. A replace code for a
  captain device carries them too.
- `codeFromLocation` also returns the code from a hash of the form `#join=<code>` on any path.

- [ ] **Step 1: Write the failing tests**

`system.test.ts`:

```ts
const withCode = new URL(captainPairingUri("https://192.168.1.50:4443", "ab:cd:01", "K7M2QP"));
expect(withCode.searchParams.get("code")).toBe("K7M2QP");
expect(withCode.searchParams.get("ca")).toBe("ABCD01");
expect(new URL(captainPairingUri("http://192.168.1.50:4100")).searchParams.has("code")).toBe(false);
```

`device-join-routes.test.ts`: a code for `{ kind: "captain", name: "Tab 1" }` has `pairings.length === links.length`,
each with `secure: false`, an `origin` that `links[i].url` starts with, and a `qr` starting `data:image/png`; a code
for a counter has `pairings` equal to `[]`.

`join-code.test.ts`, in "reads the code from a join link":

```ts
expect(codeFromLocation({ pathname: "/captain/", hash: "#join=k7m2qp" })).toBe("K7M2QP");
expect(codeFromLocation({ pathname: "/", hash: "#join=K7M2QP" })).toBe("K7M2QP");
expect(codeFromLocation({ pathname: "/captain/", hash: "#join=nope" })).toBe("");
expect(codeFromLocation({ pathname: "/captain/", hash: "#K7M2QP" })).toBe("");
```

and in "decides between the app and the join screen" (a tablet that has already joined scans a code again and just
opens Captain): `expect(gateDecision(me(true, "captain"), false, "/captain/")).toEqual({ show: "app" });`

- [ ] **Step 2: Run `npx vitest run apps/server/src/system.test.ts apps/server/src/device-join-routes.test.ts apps/ui/src/join-code.test.ts`; expected FAIL**
- [ ] **Step 3: Implement.** `JoinScreen` already reads `codeFromLocation(window.location)`, so it needs no change.
- [ ] **Step 4: Run the three files and `npm run typecheck`; expected PASS**
- [ ] **Step 5: Commit**

```bash
git add packages/domain/src/devices.ts apps/server/src/system.ts apps/server/src/system.test.ts apps/server/src/device-join.ts apps/server/src/device-join-routes.test.ts apps/ui/src/join-code.ts apps/ui/src/join-code.test.ts
git commit -m "feat: a captain join code carries Android pairing codes, and the Captain page reads #join="
```

---

### Task 4: `devices-model.ts`

**Files:**
- Create: `apps/ui/src/devices-model.ts`, `apps/ui/src/devices-model.test.ts`

**Interfaces:**
- Consumes: `DeviceInfo`, `DeviceList`, `DeviceEvent`, `DeviceKind`, `JoinCodeIssued` (types from
  `@masalapos/domain/devices`), `PrinterInfo` (`./types`).
- Produces:

```ts
export type DevicesTabId = "devices" | "printers" | "stations" | "jobs";
export const DEVICES_TABS: ReadonlyArray<{ id: DevicesTabId; label: string }>;   // Devices, Printers, Kitchen stations, Print jobs
/** The tabs this person sees: Devices needs settings.manage, the other three printers.read. */
export function devicesTabs(can: (slug: string) => boolean): DevicesTabId[];
export const KIND_LABELS: Record<DeviceKind, string>;   // Billing counter, Kitchen display, Captain
/** In this order: Main, This device, Over limit, Printer inactive. Over limit only when the build has a limit. */
export function deviceBadges(device: DeviceInfo, hasLimit: boolean): string[];
/** "Online", "Last seen <date and time>", or "Not seen yet". */
export function presenceText(device: DeviceInfo, timezone?: string): string;
/** "2 of 5 devices used"; null in builds without a limit. */
export function slotsText(list: DeviceList): string | null;
/** "—" for a kitchen display; "Browser / A4" for none; the printer's name; "Printer inactive" when it is switched off or gone. */
export function billPrinterText(device: DeviceInfo, activePrinters: ReadonlyArray<{ id: string; name: string }>): string;
/** The list with one device's `online` changed (a devices.presence event). */
export function withPresence(devices: DeviceInfo[], change: { deviceId: string; online: boolean }): DeviceInfo[];
/** Device names then station names, comma separated; "—" when nothing prints to it. */
export function usedByText(usedBy: PrinterInfo["usedBy"]): string;
/** Whether Add device can make a code for a new device; `reason` is shown when it cannot. Replacing is always possible. */
export function canAddNew(list: DeviceList): { allowed: boolean; reason: string };
/** The newest event id, or 0: what the dialog remembers when it makes a code. */
export function newestEventId(events: DeviceEvent[]): number;
/**
 * The event that says the device this code is for has joined, or null. A new device: a `joined` event newer than
 * `sinceId` for a device id not in `knownIds`. A replacement: a `replaced` event newer than `sinceId` for
 * `issued.replacesDeviceId`.
 */
export function joinEvent(issued: JoinCodeIssued, events: DeviceEvent[], sinceId: number, knownIds: ReadonlySet<string>): DeviceEvent | null;
```

`canAddNew` reason when at the limit: `Device limit reached. Remove an unused device or upgrade the plan. Replacing a device uses no extra slot.`

- [ ] **Step 1: Write the failing tests** in `devices-model.test.ts`. `device(over)` builds a `DeviceInfo` from
  defaults (`kind: "counter"`, `online: false`, `allowed: true`, `current: false`, `isMain: false`,
  `printerInactive: false`, `lastSeenAt: null`, `settings: { billPrinterId: null, paymentStart: "last" }`).

```ts
it("shows each person the tabs they may use", () => {
  const can = (...slugs: string[]) => (slug: string) => slugs.includes(slug);
  expect(devicesTabs(can("settings.manage", "printers.read"))).toEqual(["devices", "printers", "stations", "jobs"]);
  expect(devicesTabs(can("printers.read"))).toEqual(["printers", "stations", "jobs"]);   // Review Focus 2
  expect(devicesTabs(can("settings.manage"))).toEqual(["devices"]);
  expect(devicesTabs(can())).toEqual([]);
});
it("badges a device", () => {
  expect(deviceBadges(device({ isMain: true, current: true }), true)).toEqual(["Main", "This device"]);
  expect(deviceBadges(device({ allowed: false, printerInactive: true }), true)).toEqual(["Over limit", "Printer inactive"]);
  expect(deviceBadges(device({ allowed: false }), false)).toEqual([]);
});
it("says when a device was seen", () => {
  expect(presenceText(device({ online: true, lastSeenAt: 5 }))).toBe("Online");
  expect(presenceText(device({}))).toBe("Not seen yet");
  expect(presenceText(device({ lastSeenAt: Date.UTC(2026, 10, 10, 6, 30) }), "Asia/Kolkata")).toMatch(/^Last seen .*2026/);
});
it("counts slots only where there is a limit", () => {
  expect(slotsText({ devices: [device({}), device({})], maxDevices: 5 })).toBe("2 of 5 devices used");
  expect(slotsText({ devices: [device({})], maxDevices: null })).toBeNull();
});
it("names a device's bill printer", () => {
  const printers = [{ id: "p1", name: "Front" }];
  expect(billPrinterText(device({}), printers)).toBe("Browser / A4");
  expect(billPrinterText(device({ settings: { billPrinterId: "p1", paymentStart: "last" } }), printers)).toBe("Front");
  expect(billPrinterText(device({ settings: { billPrinterId: "gone", paymentStart: "last" }, printerInactive: true }), printers)).toBe("Printer inactive");
  expect(billPrinterText(device({ kind: "kitchen" }), printers)).toBe("—");
});
it("applies a presence change to one device", () => {
  const list = [device({ id: "a" }), device({ id: "b" })];
  expect(withPresence(list, { deviceId: "b", online: true }).map((d) => d.online)).toEqual([false, true]);
  expect(withPresence(list, { deviceId: "zz", online: true })).toEqual(list);
});
it("lists who prints to a printer", () => {
  expect(usedByText({ devices: ["Two"], stations: ["Grill", "Bar"] })).toBe("Two, Grill, Bar");
  expect(usedByText({ devices: [], stations: [] })).toBe("—");
});
it("allows a new device only while a slot is free", () => {   // Review Focus 4
  expect(canAddNew({ devices: [device({})], maxDevices: 2 })).toEqual({ allowed: true, reason: "" });
  expect(canAddNew({ devices: [device({}), device({})], maxDevices: 2 })).toEqual({ allowed: false, reason: "Device limit reached. Remove an unused device or upgrade the plan. Replacing a device uses no extra slot." });
  expect(canAddNew({ devices: [device({}), device({})], maxDevices: null }).allowed).toBe(true);
});
it("knows the device a code was for has joined", () => {
  const event = (id: number, kind: DeviceEvent["kind"], deviceId: string): DeviceEvent => ({ id, kind, deviceId, occurredAt: 0, actorName: "Asha", summary: "" });
  const code = (replacesDeviceId: string | null): JoinCodeIssued => ({ code: "K7M2QP", expiresAt: 0, kind: "counter", name: "Two", replacesDeviceId, links: [], pairings: [] });
  const known = new Set(["a", "b"]);
  expect(newestEventId([event(9, "joined", "a"), event(4, "renamed", "a")])).toBe(9);
  expect(newestEventId([])).toBe(0);
  expect(joinEvent(code(null), [event(10, "joined", "c")], 9, known)?.deviceId).toBe("c");
  expect(joinEvent(code(null), [event(9, "joined", "c")], 9, known)).toBeNull();            // older than the code
  expect(joinEvent(code(null), [event(10, "joined", "b")], 9, known)).toBeNull();           // a device already there
  expect(joinEvent(code("b"), [event(10, "replaced", "b")], 9, known)?.id).toBe(10);
  // Review Focus 3: the device being replaced is renamed, or its settings change, while the dialog waits.
  expect(joinEvent(code("b"), [event(11, "renamed", "b"), event(10, "settings_changed", "b")], 9, known)).toBeNull();
  expect(joinEvent(code("b"), [event(10, "replaced", "a")], 9, known)).toBeNull();
});
```

- [ ] **Step 2: Run `npx vitest run apps/ui/src/devices-model.test.ts`; expected FAIL (module not found)**
- [ ] **Step 3: Implement `devices-model.ts`.** `presenceText` formats with
  `toLocaleString("en-IN", { timeZone })`, as `LicenseSettings.tsx:50` does.
- [ ] **Step 4: Run the test file and `npx vitest run apps/ui/src/domain-imports.test.ts`; expected PASS**
- [ ] **Step 5: Commit**

```bash
git add apps/ui/src/devices-model.ts apps/ui/src/devices-model.test.ts
git commit -m "feat(ui): what the Devices card decides, as plain functions"
```

---

### Task 5: The Devices card, with printers, kitchen stations and print jobs moved into it

**Files:**
- Create: `apps/ui/src/screens/DevicesSettings.tsx`, `PrintersTab.tsx`, `StationsTab.tsx`, `PrintJobsTab.tsx` (all in
  `apps/ui/src/screens/`), `apps/ui/src/devices.css`, `apps/ui/src/devices-ui.test.ts`
- Modify: `apps/ui/src/settings-sections.ts`, `apps/ui/src/settings-sections.test.ts`
- Modify: `apps/ui/src/integrations-model.ts:24-31`, `apps/ui/src/integrations-model.test.ts`
- Modify: `apps/ui/src/screens/Settings.tsx` (printer, station and job state, actions and markup leave: about lines
  47-48, 64-77, 102-156, 173-257 and 329-572), `apps/ui/src/App.tsx:204`
- Delete: `apps/ui/src/printer-settings.css` once its rules are in `devices.css` (keep any rule another screen uses;
  check with a search for each class first)

**Interfaces:**
- Consumes: `devicesTabs`, `DEVICES_TABS`, `usedByText`, `DevicesTabId` (Task 4); `PrinterInfo.usedBy` (Task 2).
- Produces:

```ts
// settings-sections.ts: "devices" takes the place of "printers" in SettingsSectionId and in the list
{ id: "devices", title: "Devices", blurb: "Devices, printers, kitchen stations and print jobs", icon: "printer" }
export function visibleSettingsSections(who: { canManageSettings: boolean; canReadPrinters: boolean; canManageTables: boolean; crmActive: boolean }): typeof SETTINGS_SECTIONS;
// integrations-model.ts: the settings tab shows with settings.manage or printers.read
// DevicesSettings.tsx
export function DevicesSettings(props: { initialTab?: DevicesTabId }): JSX.Element;
// PrintersTab.tsx, StationsTab.tsx, PrintJobsTab.tsx: no props; each loads its own data
```

- `visibleSettingsSections`: without `canManageSettings` only `devices` is returned, and only with
  `canReadPrinters`; with `canManageSettings` the rules are as today, and `devices` is always included.
- In this task `DevicesSettings` renders the three moved tabs. Task 6 adds the Devices tab.

- [ ] **Step 1: Write the failing tests**

`settings-sections.test.ts`: the ids list has `"devices"` where `"printers"` was; and

```ts
it("shows only Devices to someone who can see printers but not manage settings", () => {
  const ids = (canManageSettings: boolean, canReadPrinters: boolean) =>
    visibleSettingsSections({ canManageSettings, canReadPrinters, canManageTables: false, crmActive: false }).map((s) => s.id);
  expect(ids(false, true)).toEqual(["devices"]);
  expect(ids(false, false)).toEqual([]);
  expect(ids(true, false)).toContain("devices");
  expect(ids(true, false)).toContain("profile");
});
```

Existing calls in that file gain `canManageSettings: true, canReadPrinters: true`.

`integrations-model.test.ts`:

```ts
expect(staffTabVisible("settings", (slug) => slug === "printers.read")).toBe(true);
expect(staffTabVisible("settings", (slug) => slug === "settings.manage")).toBe(true);
expect(staffTabVisible("settings", () => false)).toBe(false);
```

`devices-ui.test.ts` (reads source files as text; `offers-ui.test.ts` shows the pattern):

```ts
const FILES = ["screens/DevicesSettings.tsx", "screens/PrintersTab.tsx", "screens/StationsTab.tsx", "screens/PrintJobsTab.tsx", "devices.css"];
it.each(FILES)("%s has no inline styles and no hard-coded colours", (file) => {
  const source = readFileSync(new URL(`./${file}`, import.meta.url), "utf8");
  expect(source).not.toMatch(/style=\{/);
  expect(source).not.toMatch(/#[0-9a-fA-F]{3,8}\b|\b(crimson|green|red)\b|rgba?\(/);
});
it("Settings no longer holds the printer markup", () => {
  const settings = readFileSync(new URL("./screens/Settings.tsx", import.meta.url), "utf8");
  expect(settings).not.toMatch(/api\/printers|kot-stations|print-jobs/);
});
it("the Printers tab says where printers must be", () => {
  expect(readFileSync(new URL("./screens/PrintersTab.tsx", import.meta.url), "utf8"))
    .toContain("Printers must be reachable from the main PC: on the network, installed in Windows on the main PC, or paired to it by Bluetooth.");
});
```

- [ ] **Step 2: Run `npx vitest run apps/ui/src/settings-sections.test.ts apps/ui/src/integrations-model.test.ts apps/ui/src/devices-ui.test.ts`; expected FAIL**

- [ ] **Step 3: Implement**

  - Move the markup and its actions as they are, one tab per file, each with its own `useAction` and its own load.
    `StationsTab` also loads printers for its select. `PrintJobsTab` keeps the `print.job` socket handling and the
    reload on reconnect from `Settings.tsx:102-128`.
  - `PrintersTab`: the reachability line first; a **Used by** column (`usedByText(printer.usedBy)`) after Paper.
  - Without `printers.manage` a tab shows its table or list and none of its buttons, selects or add forms.
  - `DevicesSettings`: a `.tabs` group labelled "Devices sections" with the tabs `devicesTabs(can)` returns, opening
    on `initialTab` when that tab is allowed, else the first.
  - `Settings.tsx`: `active === "devices"` renders `<DevicesSettings initialTab={devicesTab} />`;
    `BillSettings`'s `onOpenPrinters` opens the Devices card on `"printers"`. It loads `/api/settings` only with
    `settings.manage` and otherwise goes straight to the grid.
  - `App.tsx:204`: Settings renders with `settings.manage` or `printers.read`.
  - Styles go to `devices.css` using the existing tokens (`var(--line)`, `var(--muted)`, `var(--danger-text)`,
    `var(--pos-success)`, the `--space-*` scale), scoped under a `.devices-settings` root class.

- [ ] **Step 4: Run `npx vitest run apps/ui`, `npm run typecheck` and `npm run check:css-isolation -w @masalapos/ui`; expected PASS and no errors**

- [ ] **Step 5: See it** with `npm run dev` (demo sign-in `admin` / `demo1234`): Settings shows **Devices** where
  Printers was; the three tabs work as before (add a printer, test print, add a station, the jobs list); the Bill
  settings link "Bill copies are set per printer" opens the Printers tab; switch **This device** to Dark and check the
  three tabs. Stop the dev server by PID afterwards (it leaves port 4100 and Vite running otherwise).

- [ ] **Step 6: Commit** (list every created, modified and deleted file by path)

```bash
git commit -m "feat(ui): Devices card holds printers, kitchen stations and print jobs; staff who can see printers can open it"
```

---

### Task 6: The Devices tab: list, one device, history

**Files:**
- Create: `apps/ui/src/screens/DevicesTab.tsx`, `apps/ui/src/screens/DeviceDialog.tsx`
- Modify: `apps/ui/src/screens/DevicesSettings.tsx`, `apps/ui/src/devices.css`, `apps/ui/src/devices-ui.test.ts`

**Interfaces:**
- Consumes: Task 1's routes; `GET /api/devices`, `PATCH /api/devices/:id/settings`, `GET /api/billing-printers`;
  socket events `devices.changed` and `devices.presence` (`{ deviceId, online }`); the window event
  `masalapos:license-changed`; from Task 4 `deviceBadges`, `presenceText`, `slotsText`, `billPrinterText`,
  `withPresence`, `KIND_LABELS`.
- Produces:

```ts
/** `recovery` is the licence recovery screen: list, rename, remove and history only. */
export function DevicesTab(props: { recovery?: boolean }): JSX.Element;
export function DeviceDialog(props: {
  device: DeviceInfo; printers: ReadonlyArray<{ id: string; name: string }>; recovery: boolean;
  onChanged: (device: DeviceInfo) => void; onRemoved: () => void; onReplace: (device: DeviceInfo) => void; onClose: () => void;
}): JSX.Element;
```

- [ ] **Step 1: Extend `devices-ui.test.ts`**: add `screens/DevicesTab.tsx` and `screens/DeviceDialog.tsx` to
  `FILES`. Run it; expected FAIL (files missing).

- [ ] **Step 2: Implement `DevicesTab`**

  - Loads the list and the active printers; reloads on `devices.changed`, on `masalapos:license-changed`, and when
    the socket reconnects; applies `devices.presence` with `withPresence`. A failed load shows the error with
    **Retry** and no rows.
  - Above the table: `slotsText(list)` when it is not null. A table with a row per device: name with its badges,
    type (`KIND_LABELS`), an online dot with `presenceText`, bill printer (`billPrinterText`). The whole row is a
    button that opens `DeviceDialog`.
  - Below: **Device history**, from `GET /api/devices/events`, newest first, each line the summary with its time and
    who did it, and **Load older changes** while `nextBefore` is not null. It reloads its first page whenever the
    list reloads.
  - If the open device is no longer in a reloaded list, its dialog closes and a status line says
    "That device was removed."
  - Task 7 adds the **Add device** button; leave `onReplace` wired to a state it will use.

- [ ] **Step 3: Implement `DeviceDialog`** as a modal `<dialog>` in the style of `CreditNoteDialog.tsx`

  - **Name** with **Save name** → `PATCH /api/devices/:id` with the device's `version`.
  - **Bill printer** ("Browser / A4 receipt" and the active printers) and **Payment method a new bill starts on**
    (the four options and labels from `DeviceSettings.tsx:12-17`) → `PATCH /api/devices/:id/settings`, saved on
    change. Left out for a kitchen display and in `recovery`. When `device.printerInactive`, the note and **Forget
    that printer** button from `DeviceSettings.tsx:83-86`, reworded for "this device" → "the device".
  - Each successful save calls `onChanged` with the `device` in the response, so the next save uses the new version.
    A failed save shows the server's message and reloads the list (a 409 means someone else changed the device).
  - **Replace** calls `onReplace(device)`; left out in `recovery`.
  - **Remove** is absent for the main counter, with the line "The main counter can't be removed." Otherwise it
    confirms with `Remove <name>? Staff on that device will be signed out.` (for the current device: `Remove <name>?
    You will be signed out of this browser.`), then `DELETE /api/devices/:id` with the version, then `onRemoved`.

- [ ] **Step 4: `DevicesSettings` renders `DevicesTab` for the `devices` tab.** Run `npx vitest run apps/ui`,
  `npm run typecheck`, `npm run check:css-isolation -w @masalapos/ui`; expected PASS.

- [ ] **Step 5: See it** with `npm run dev`: the Devices tab lists the main counter with "Main" and "This device";
  rename it and see the history line; set its bill printer and payment method and see **This device** agree; in a
  second browser profile join a device (the join-code panel under Plan & devices still exists), see it go online and
  offline here, and remove it. Check the dark theme.

- [ ] **Step 6: Commit**

```bash
git add apps/ui/src/screens/DevicesTab.tsx apps/ui/src/screens/DeviceDialog.tsx apps/ui/src/screens/DevicesSettings.tsx apps/ui/src/devices.css apps/ui/src/devices-ui.test.ts
git commit -m "feat(ui): the Devices tab lists devices with presence, edits one device and shows device history"
```

---

### Task 7: Add device, with the connection help; Backups loses Connections

**Files:**
- Create: `apps/ui/src/screens/AddDeviceDialog.tsx`, `apps/ui/src/screens/ConnectionHelp.tsx`
- Modify: `apps/ui/src/screens/DevicesTab.tsx`, `apps/ui/src/devices.css`, `apps/ui/src/devices-ui.test.ts`
- Modify: `apps/ui/src/screens/SystemSettings.tsx` (keeps `BackupSettings` only), `apps/ui/src/connections.css`
  (rules that moved with the markup go to `devices.css`; delete the file if nothing is left)
- Modify: `apps/ui/src/settings-sections.ts`, `apps/ui/src/settings-sections.test.ts`
- Modify: `apps/ui/src/screens/JoinScreen.tsx:67`

**Interfaces:**
- Consumes: `POST /api/devices/join-codes` → `JoinCodeIssued` with `pairings` (Task 3); `GET /api/system/connections`;
  `GET /captain/android/version.json`; `GET /api/devices/events`; from Task 4 `canAddNew`, `newestEventId`,
  `joinEvent`, `KIND_LABELS`; `countdown` (`join-code.ts`); `JOIN_CODE_TTL_MS`.
- Produces:

```ts
/** `replace` opens the dialog on replacing that device. `changes` goes up each time the device list reloads. */
export function AddDeviceDialog(props: { list: DeviceList; replace?: DeviceInfo; changes: number; onClose: () => void }): JSX.Element;
export function ConnectionHelp(props: { kind: DeviceKind; issued: JoinCodeIssued }): JSX.Element;
// settings-sections.ts
{ id: "backups", title: "Backups", blurb: "Backups and cloud", icon: "cloud" }
```

- [ ] **Step 1: Tests.** `settings-sections.test.ts`: the "keeps the section names" test becomes

```ts
it("names the cards as the Devices area left them", () => {
  const titles = SETTINGS_SECTIONS.map((section) => section.title);
  expect(titles).toContain("Devices");
  expect(titles).toContain("Backups");
  expect(titles).not.toContain("Backups & connections");
});
```

`devices-ui.test.ts`: add the two new files to `FILES`, and

```ts
it("Backups no longer explains how to connect devices", () => {
  expect(readFileSync(new URL("./screens/SystemSettings.tsx", import.meta.url), "utf8")).not.toMatch(/system\/connections|Connect your team/);
});
```

Run `npx vitest run apps/ui/src/settings-sections.test.ts apps/ui/src/devices-ui.test.ts`; expected FAIL.

- [ ] **Step 2: Implement `AddDeviceDialog`** (a modal `<dialog>`; the code logic is `JoinCodePanel.tsx`'s)

  1. **Choose.** "New device" or "Replace an existing device". New: **Type** (`KIND_LABELS`; Kitchen display only
     while the `kds` integration is on, as `SystemSettings.tsx:57`) and **Device name**. When
     `canAddNew(list).allowed` is false, the new-device fields are disabled and its `reason` is shown. Replace: a
     select of the devices, with the line "The new browser takes over this device's name and place. Its old browser
     is signed out." **Create join code** → `POST /api/devices/join-codes`. Before posting, read
     `GET /api/devices/events` and remember `newestEventId` and the ids in `list`.
  2. **Code.** The code in large type (`aria-label` spelling it out, as today), "Valid for m:ss" counting from when
     the reply arrived, then `<ConnectionHelp kind issued />`. When the time runs out: "This code has expired. Create
     a new one." and a button back to step 1; the QR codes are no longer shown.
  3. **Joined.** Each time `changes` goes up while a code is showing, read `GET /api/devices/events` and call
     `joinEvent`. When it returns an event: "<name> has joined." in a status line, and the dialog closes itself after
     3 seconds or on **Done**.

  Closing the dialog while a code is showing asks nothing; the code stays valid until it expires.

- [ ] **Step 3: Implement `ConnectionHelp`**, moving the markup and copy from `SystemSettings.tsx:71-117`. It loads
  `/api/system/connections` and `/captain/android/version.json` itself. The join links (`issued.links`: QR and
  address) come first for every type, under "On the new device, open this address or scan the code." with the
  no-network line from `JoinCodePanel.tsx:59` when there are none. Then, by type:

  - **Billing counter:** the Edge shortcut download for each LAN address and the router footnote.
  - **Kitchen display:** the three numbered instructions (create a Kitchen staff member, install MasalaPOS Kitchen
    or open the Kitchen link, sign in), the kitchen addresses, and the secure links and certificate when Captain
    HTTPS is on.
  - **Captain:** when the build includes the Android app: step 1 the download QRs, step 2 "Open the app, tap
    **Scan pairing code** and scan a code below. The tablet connects and joins in one step." with
    `issued.pairings` (label "Secure pairing" or "Unencrypted pairing"), and the footnote about the certificate.
    Then "Captain in the browser": the certificate download, the HTTPS address and the certificate details.

- [ ] **Step 4: Wire it up.** `DevicesTab` gets an **Add device** button (not in `recovery`) and opens the dialog
  from `DeviceDialog`'s **Replace** with `replace` set. `SystemSettings` drops the view switch, the `backupOnly`
  prop's branches and everything connection-related, and renders `BackupSettings`; `LicenseSettings.tsx:58` keeps
  compiling (`<SystemSettings />`). `JoinScreen.tsx:67` reads "Ask an administrator for a code. On the main counter:
  Settings, Devices, Add device."

- [ ] **Step 5: Run `npx vitest run apps/ui`, `npm run typecheck`, `npm run check:css-isolation -w @masalapos/ui`; expected PASS**

- [ ] **Step 6: See it** with `npm run dev`: add a counter by code from a second browser profile and watch the
  dialog confirm and close; start a replace from a device's dialog; open each type and read its help; let a code
  expire (or set the PC clock forward 11 minutes) and see the expired message; **Backups** has no Connections view.

- [ ] **Step 7: Commit** (list files by path)

```bash
git commit -m "feat(ui): Add device shows the code with the connection help for its type; Backups loses Connections"
```

---

### Task 8: Plan and This device slimmed; the old device routes removed

**Files:**
- Modify: `apps/ui/src/screens/LicenseSettings.tsx`, `apps/ui/src/license-settings.css` (drop rules only the device
  list and join-code panel used)
- Delete: `apps/ui/src/screens/JoinCodePanel.tsx`
- Modify: `apps/ui/src/screens/DeviceSettings.tsx`
- Modify: `apps/ui/src/settings-sections.ts`, `apps/ui/src/settings-sections.test.ts`, `apps/ui/src/devices-ui.test.ts`
- Modify: `apps/server/src/licensing.ts:170-182` and `:361-375`, `apps/server/src/device-routes.ts:6-9` (comment)
- Modify: `packages/domain/src/licensing.ts`, `packages/domain/src/index.ts` (`LicensedDevice` removed)
- Modify: `apps/server/src/licensing.test.ts`, `device-routes.test.ts:64-65`, `guest-ordering.test.ts:304`,
  `guest-services.test.ts:105`
- Modify: `apps/server/src/ai/provider.ts:15`
- Modify: `tools/e2e/licensing.js`, `licensing-recovery.js`, `marketplace.js:153-172`, `m8-qr.js:45,114`,
  `m9-guest-flow.js:39,93`
- Modify: `APPLICATION_OVERVIEW.md:406`

**Interfaces:**
- Consumes: `DevicesTab` with `recovery` (Task 6).
- Produces:

```ts
{ id: "device", title: "This device", blurb: "Theme and QR order alerts here", icon: "monitor" }
{ id: "plan", title: "Plan", blurb: "Licence, plan and activation", icon: "badge" }
```

- [ ] **Step 1: Write the failing tests**

  - `settings-sections.test.ts`: titles contain `"Plan"` and not `"Plan & devices"`.
  - `devices-ui.test.ts`:

```ts
it("Plan and This device hold no device management", () => {
  const read = (file: string) => readFileSync(new URL(`./screens/${file}`, import.meta.url), "utf8");
  expect(read("LicenseSettings.tsx")).not.toMatch(/license\/devices|JoinCodePanel|Rename |Remove /);
  expect(read("DeviceSettings.tsx")).not.toMatch(/billPrinterId|paymentStart|api\/devices/);
  expect(existsSync(new URL("./screens/JoinCodePanel.tsx", import.meta.url))).toBe(false);
});
```

  - `device-routes.test.ts:64-65` becomes: `GET /api/license/devices` answers 404.
  - `licensing.test.ts`: every `/api/license/devices` request becomes the `/api/devices` one (lines 133-148, 192-198,
    315-319, 365, 373, 766). The list is now `{ devices, maxDevices }` and `PATCH` answers `{ device }`, so
    assertions that read `.json().devices` after a rename read the list again. In a development build the old list
    gave `allowed: false`; the new one gives `true`. Line 58 (no self-registration route) stays.
  - `guest-ordering.test.ts:304`, `guest-services.test.ts:105`: the URL becomes `/api/devices`.

- [ ] **Step 2: Run `npx vitest run apps/ui/src/settings-sections.test.ts apps/ui/src/devices-ui.test.ts apps/server/src/device-routes.test.ts`; expected FAIL**

- [ ] **Step 3: Implement**

  - `licensing.ts`: delete the three routes, `devices()`, `rename()`, `revoke()` and the `deviceName` schema.
    `LicensedDevice` leaves the domain package.
  - `LicenseSettings`: delete the devices section, the rename form, `JoinCodePanel`, the device half of `reload` and
    of the dirty check. The heading and `aria-label` become "Plan". The history `<summary>` becomes "Licence
    history". The summary tile **Devices** (`n / max` and whether this device has joined) stays. In a development
    build the card shows the status message only.
  - `LicenseGate`'s recovery view for an administrator becomes
    `<LicenseSettings /><DevicesTab recovery /><SystemSettings />`, the Devices tab under an `<h2>Devices</h2>`.
  - `DeviceSettings`: delete the "Billing at this counter" fieldset and everything only it used (`useDeviceSettings`,
    the printers load, `save`, `useCan`). The opening line becomes "Theme and QR alerts are saved in this browser.
    An administrator sets this device's bill printer and starting payment method under Settings, Devices."
  - `ai/provider.ts:15`: "…Check the licence in Settings → Plan."
  - e2e scripts: `/license/devices` → `/devices` in the API calls (`PATCH` at `licensing.js:93` keeps its body); the
    steps in `licensing.js:83-112` that rename and remove "Dining phone" and check the join-code button open the
    **Devices** card (`[data-section="devices"]`) and drive the device dialog; `marketplace.js:170-172` waits for
    the heading `Plan`; `licensing-recovery.js` keeps finding `Refresh plan`.

- [ ] **Step 4: Run `npm test` and `npm run typecheck`; expected PASS and no errors.** Then
  `grep -rn "license/devices\|LicensedDevice\|Plan & devices\|Plan &amp; devices" apps packages tools --include=*.ts --include=*.tsx --include=*.js --include=*.mjs --include=*.mts`
  (leave `apps/ui/dev-ui-snapshot` out); expected: only the 404 assertion in `device-routes.test.ts`.

- [ ] **Step 5: Run the touched e2e scripts** as `tools/e2e/README.md` describes for licensing, licensing recovery
  and the Marketplace; expected: every check passes. Report any script that could not be run and why.

- [ ] **Step 6: Commit** (list files by path)

```bash
git commit -m "feat!: Plan and This device lose their device controls; /api/license/devices is removed"
```

---

### Task 9: Docs

**Files:**
- Create: `docs/operations/devices.md`
- Modify: `docs/operations/commercial-licensing.md`, `captain-app.md`, `demo-and-kitchen.md`, `printer-settings.md`,
  `rollout-checklist.md`, `updates.md:25`, `marketplace.md:69`, `google-drive-backups.md:3`,
  `backup-and-recovery.md:83` (all in `docs/operations/`), `README.md:139`
- Modify: `docs/superpowers/specs/2026-11-10-devices-design.md` (status header)

- [ ] **Step 1: Write `devices.md`**: where the Devices card is and who sees which tab; adding a device of each type
  (the code, its ten minutes, the QR, what the new device does); replacing a device and what carries over (name,
  type, settings, slot); removing a device and what it does to staff signed in there; the main counter and
  re-joining it from the main PC; what the badges mean; a device's bill printer and starting payment method; what an
  administrator can still do when the licence has stopped this browser.
- [ ] **Step 2: Update the others.** Every "Settings → Backups & connections → …" for connecting a device becomes
  "Settings → Devices → Add device", and for backups "Settings → Backups"; "Plan & devices" becomes "Plan".
  `commercial-licensing.md`: registering devices points to `devices.md`. `captain-app.md`: pairing scans the code
  shown in Add device, which connects and joins in one step; a code without `code=` still pairs.
  `printer-settings.md`: printers live under Devices → Printers, the Used by column, the per-device bill printer is
  set in the device's dialog. `rollout-checklist.md`: the Captain line reads from Add device. Plain language, as the
  existing files.
- [ ] **Step 3: Spec header**: status "Phases 1 to 4 built" once Task 10 is in; replace the Phase 4 pick-up
  paragraph with a "How Phase 4 settled what the spec left open" list from this plan's Decisions, with the plan's
  path.
- [ ] **Step 4: Check**: `grep -rn "Backups & connections\|Plan & devices" docs/operations README.md`; expected: no
  output.
- [ ] **Step 5: Commit**

```bash
git add docs/operations README.md docs/superpowers/specs/2026-11-10-devices-design.md
git commit -m "docs: the Devices area"
```

Stage `docs/operations` by the files changed, not the folder, if `git status` shows anything there this task did not
touch.

---

### Task 10: Android Captain pairs and joins from one scan

**Files:**
- Modify: `apps/captain-android/app/src/main/java/app/masalapos/captain/Pairing.kt`, `SetupActivity.kt`,
  `CaptainActivity.kt`, `ServerStore.kt`
- Modify: `apps/captain-android/app/src/test/java/app/masalapos/captain/PairingTest.kt`

**Interfaces:**
- Consumes: the pairing URI with `code` (Task 3); `/captain/#join=<code>` (Task 3).
- Produces:

```kotlin
data class PairingRequest(val origin: String, val caFingerprint: String?, val joinCode: String? = null)
// Pairing: 6 characters from "ABCDEFGHJKMNPQRSTUVWXYZ23456789" after upper-casing; anything else is null
fun joinCode(value: String?): String?
// PairedServer
fun captainUrl(joinCode: String?): String   // "$origin/captain/" or "$origin/captain/#join=$joinCode"
// CaptainActivity
const val EXTRA_JOIN_CODE = "join_code"
```

- [ ] **Step 1: Write the failing tests** in `PairingTest.kt`:

```kotlin
@Test fun readsTheJoinCodeFromAPairingCode() {
    val request = Pairing.parse("masalapos-captain://pair?server=https%3A%2F%2F192.168.1.50%3A4443&ca=$fingerprint&code=k7m2qp").single()
    assertEquals("K7M2QP", request.joinCode)
    assertEquals("https://192.168.1.50:4443", request.origin)
}
@Test fun pairsWithoutAJoinCode() {
    assertNull(Pairing.parse("masalapos-captain://pair?server=http%3A%2F%2F192.168.1.50%3A4100").single().joinCode)
    assertNull(Pairing.parse("masalapos-captain://pair?server=http%3A%2F%2F192.168.1.50%3A4100&code=O0O0O0").single().joinCode)
    assertNull(Pairing.parse("masalapos-captain://pair?server=http%3A%2F%2F192.168.1.50%3A4100&code=TOOLONG1").single().joinCode)
    assertNull(Pairing.parse("192.168.1.50").first().joinCode)
}
@Test fun opensCaptainWithTheCode() {
    val server = PairedServer("http://192.168.1.50:4100", null)
    assertEquals("http://192.168.1.50:4100/captain/", server.captainUrl(null))
    assertEquals("http://192.168.1.50:4100/captain/#join=K7M2QP", server.captainUrl("K7M2QP"))
}
```

- [ ] **Step 2: Run `./gradlew.bat test` in `apps/captain-android`; expected FAIL (does not compile)**
- [ ] **Step 3: Implement.** `SetupActivity.pair` takes the request's `joinCode` and passes it to `CaptainActivity`
  as `EXTRA_JOIN_CODE`. `CaptainActivity` keeps it in a field, loads `server.captainUrl(code)`, and clears the field
  in `onPageFinished` when the load did not fail, so **Retry** after a failed load still carries the code and a later
  reload does not. It is never written to `ServerStore`.
- [ ] **Step 4: Run `./gradlew.bat test`; expected PASS.** Then `npm run build:captain-android`; expected: an APK
  under `apps/captain-android/app/build/outputs/apk/release`.
- [ ] **Step 5: Commit**

```bash
git add apps/captain-android/app/src/main/java/app/masalapos/captain/Pairing.kt apps/captain-android/app/src/main/java/app/masalapos/captain/SetupActivity.kt apps/captain-android/app/src/main/java/app/masalapos/captain/CaptainActivity.kt apps/captain-android/app/src/main/java/app/masalapos/captain/ServerStore.kt apps/captain-android/app/src/test/java/app/masalapos/captain/PairingTest.kt
git commit -m "feat(captain-android): a pairing code with a join code connects and joins in one scan"
```

---

## After the last task: run-through in the app

From the spec's Phase 4 testing line. The VM has no Android emulator, so the tablet steps need a real tablet; say
which steps were done and which are left for the owner.

- [ ] Add a second counter by code; assign it a printer; issue a bill from it and confirm it prints without choosing
  a printer; see it online in the list.
- [ ] Clear its browser storage; replace it; confirm its name, settings and slot carried over.
- [ ] Add a kitchen display the same way.
- [ ] Add a captain: in a browser by join link, and on a real tablet by scanning the pairing code (pairs and joins
  in one scan; an old pairing code without `code` pairs and shows the join screen).
- [ ] Sign in as staff with `printers.read` only: Settings shows the Devices card with three tabs.
- [ ] Dark theme on all four tabs and both dialogs.
- [ ] `npm test`, `npm run typecheck`, `npm run check:css-isolation -w @masalapos/ui` all pass.
