# Devices Phase 3 — device settings, printing, presence: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Each device's bill printer and starting payment method are stored on the server, the server picks the
printer for a bill unless the cashier overrides it, and the server knows which devices are online.

**Architecture:** `DeviceSettings` (zod, `packages/domain/src/devices.ts`) is read from `devices.settings` with
defaults; `Devices.updateSettings` writes it and records the event. A new `apps/server/src/device-routes.ts` serves the
device list, the settings PATCH and "my settings". One helper, `receiptPrinter` (`apps/server/src/print/target.ts`),
turns "field absent / present / null" into a printer for the bill, reprint and credit-note routes. A small
`DevicePresence` counter is fed by the WebSocket hub. In the UI a `useDeviceSettings` hook replaces the two
`localStorage` keys.

**Tech Stack:** TypeScript, zod, better-sqlite3, Fastify, `@fastify/websocket`, React, vitest.

**Spec:** `docs/superpowers/specs/2026-11-10-devices-design.md` (section "Phase 3 — device settings, printing,
presence", plus the Phase 3 line under "Testing")

## Decisions the spec leaves open (approve before building)

1. **No migration.** `devices.settings` and the `settings_changed` event kind already exist (migration 65), and
   presence is kept in memory. 67 stays the next free number for Phase 4.
2. **The interim control is the existing "This device" card.** Until Phase 4 builds the device detail, its **Bill
   printer** and **Payment method a new bill starts on** selects save to the server for the device they are opened on,
   and only a user with `settings.manage` can change them (others see them read-only). Without this nobody could set a
   printer between Phase 3 and Phase 4. Phase 4 removes them from that card, as the spec says.
3. **Values already in `localStorage` are not carried over** (`masalapos.receipt-printer`, `masalapos.payment-start`).
   Nothing is live; an admin sets each device once.
4. **A print route with nothing to print to answers 400** `Choose an active receipt printer`: the bill-print and
   credit-note-print routes when the field is `null`, or absent and the device has no active printer. Issuing a bill
   in the same situation still succeeds without a thermal print.
5. **"My settings" gives the printer that will be used.** `GET /api/devices/me/settings` returns `billPrinterId: null`
   when the saved printer is inactive, so the button label matches what the server will do. The stored id is kept, and
   `GET /api/devices` reports it with `printerInactive: true`; reactivating the printer brings it back.
6. **`last_seen_at` is also set when a device's last socket closes.** Today only licensed builds set it, so dev and
   demo builds would have no "last seen".
7. **`GET /api/devices` is built in full now** (the row Phase 4 needs, with `online`). The `/api/license/devices`
   routes stay until Phase 4 removes them.
8. **The per-bill printer choice lasts for one order.** It no longer sticks to the browser; the next order starts on
   the device's printer again.

## Global Constraints

- `DeviceSettings` keys and defaults: `billPrinterId` (an active printer's id, or `null` for Browser / A4; default
  `null`), `paymentStart` (`last`, `cash`, `card`, `upi`; default `last`). A missing or unreadable key reads as its
  default.
- Printer field on `POST /api/orders/:id/bill`, `POST /api/bills/:id/print`, `POST /api/credit-notes/:id/print`:
  absent = the calling device's bill printer; present = that printer for this request only; `null` = do not print.
- A printer id that is not an active printer is refused with 400 `Choose an active receipt printer` (routes) or 400
  `Choose an active printer` (settings PATCH).
- A stale device `version` gets 409 `This device changed. Refresh the device list and try again.`
- Theme, keyboard shortcuts, the last-used payment method (`masalapos.payment-mode`) and the QR alert sound stay in
  browser storage. KOT routing is unchanged.
- No response, event or log line carries a device credential or its hash.
- The UI imports values from `@masalapos/domain` subpaths only, never the root (`apps/ui/src/domain-imports.test.ts`).
- The working tree has unrelated uncommitted edits from another session (`apps/ui/src/main.tsx`,
  `apps/ui/src/light-buttons.css`, `docs/offers/README.md`, and untracked `AGENTS.md`, `References/`, `.claude/`,
  `docs/agents/handoff/`). Stage only this plan's files, by path; never `git add -A`.
- Branch `feat/devices`. One commit per task (Tasks 6 and 7 share one). Nothing is pushed.
- Run one test file with `npx vitest run <path>`; the whole suite with `npm test`; types with `npm run typecheck`.

## Review Focus

1. **A device whose saved printer was switched off issues a bill**: the bill is issued, nothing is queued, no error
   (Task 5).
2. **Changing only the payment method on a device whose saved printer is inactive**: the saved printer id is kept, not
   wiped and not rejected (Task 2).
3. **A browser that is not a device (dev build, no credential header) issues a bill with no printer field**: issued,
   no print, as today (Task 5).
4. **A socket closed by the server and then by the browser** (sign-out, removed device, the 60 s recheck): the device
   goes offline once, and one `devices.presence` is sent (Task 3).
5. **A bill replayed after the device's printer changed** (the offline queue re-sends the same body): the first answer
   comes back, and nothing prints a second time (Task 5).

---

### Task 1: `DeviceSettings` and the printer field in the domain

**Files:**
- Modify: `packages/domain/src/devices.ts`
- Modify: `packages/domain/src/devices.test.ts`
- Modify: `packages/domain/src/billing.ts:33-47` (`BillCreate.printerId`, `BillPrint`)
- Modify: `packages/domain/src/billing.test.ts`
- Modify: `apps/server/src/billing.ts:430-431`, `apps/server/src/credit-notes.ts:331-332` (keep them compiling)

**Interfaces:**
- Produces, from `@masalapos/domain` and `@masalapos/domain/devices`:

```ts
export const PAYMENT_STARTS = ["last", "cash", "card", "upi"] as const;
export type PaymentStart = (typeof PAYMENT_STARTS)[number];
export const DeviceSettings = z.object({
  billPrinterId: z.string().min(1).nullable().default(null).catch(null),
  paymentStart: z.enum(PAYMENT_STARTS).default("last").catch("last"),
});
export type DeviceSettings = z.infer<typeof DeviceSettings>;
/** What is stored for a device, with defaults for whatever is missing or unreadable. Unknown keys are dropped. */
export function deviceSettings(stored: unknown): DeviceSettings;
/** A change to some settings, with the device version it was made against. */
export const DeviceSettingsPatch = z.object({
  version: z.number().int().positive(),
  billPrinterId: z.string().min(1).nullable().optional(),
  paymentStart: z.enum(PAYMENT_STARTS).optional(),
}).strict();
export type DeviceSettingsPatch = z.infer<typeof DeviceSettingsPatch>;
/** A row of the device list. `settings` is what is saved; `printerInactive` says its printer is switched off. */
export interface DeviceInfo {
  id: string; kind: DeviceKind; name: string; isMain: boolean; createdAt: number; lastSeenAt: number | null; version: number;
  current: boolean; allowed: boolean; online: boolean; settings: DeviceSettings; printerInactive: boolean;
}
export interface DeviceList { devices: DeviceInfo[]; maxDevices: number | null }
/** The calling device's own settings, as they apply now. `deviceId` is null for a browser that is not a device. */
export interface MyDeviceSettings { deviceId: string | null; version: number | null; settings: DeviceSettings }
```

- Produces, in `billing.ts`: `BillCreate.printerId` becomes `z.string().min(1).nullable().optional()`;
  `BillPrint` becomes `z.object({ printerId: z.string().min(1).nullable().optional() })`.

- [ ] **Step 1: Write the failing tests**

In `devices.test.ts`:

```ts
describe("device settings", () => {
  it("fills defaults for missing, unknown and unreadable values", () => {
    expect(deviceSettings({})).toEqual({ billPrinterId: null, paymentStart: "last" });
    expect(deviceSettings(null)).toEqual({ billPrinterId: null, paymentStart: "last" });
    expect(deviceSettings({ billPrinterId: "p1", paymentStart: "upi", x: 1 })).toEqual({ billPrinterId: "p1", paymentStart: "upi" });
    expect(deviceSettings({ billPrinterId: 7, paymentStart: "wallet" })).toEqual({ billPrinterId: null, paymentStart: "last" });
  });
  it("a patch needs a version and takes only known keys", () => {
    expect(DeviceSettingsPatch.parse({ version: 2, paymentStart: "cash" })).toEqual({ version: 2, paymentStart: "cash" });
    expect(DeviceSettingsPatch.parse({ version: 2, billPrinterId: null })).toEqual({ version: 2, billPrinterId: null });
    expect(DeviceSettingsPatch.safeParse({ paymentStart: "cash" }).success).toBe(false);
    expect(DeviceSettingsPatch.safeParse({ version: 1, theme: "dark" }).success).toBe(false);
    expect(DeviceSettingsPatch.safeParse({ version: 1, paymentStart: "wallet" }).success).toBe(false);
  });
});
```

In `billing.test.ts` (`ref` is any valid client ref the file already uses):

```ts
it("tells an absent printer from no printer", () => {
  const base = { clientRef: ref, previewKey: "k" };
  expect("printerId" in BillCreate.parse(base)).toBe(false);
  expect(BillCreate.parse({ ...base, printerId: null }).printerId).toBeNull();
  expect(BillCreate.parse({ ...base, printerId: "p1" }).printerId).toBe("p1");
  expect(BillPrint.parse({})).toEqual({});
  expect(BillPrint.parse({ printerId: null })).toEqual({ printerId: null });
});
```

- [ ] **Step 2: Run them and see them fail**

Run: `npx vitest run packages/domain/src/devices.test.ts packages/domain/src/billing.test.ts`
Expected: FAIL (`deviceSettings` is not exported; `printerId` is `null` where absent is expected).

- [ ] **Step 3: Add the exports above to `devices.ts` and change the two schemas in `billing.ts`**

`deviceSettings` parses `stored` when it is a plain object and `{}` otherwise.

- [ ] **Step 4: Keep the two print routes behaving as they do now**

In `apps/server/src/billing.ts` (bill print) and `apps/server/src/credit-notes.ts` (credit-note print), a request
without a printer id still gets 400 `Choose an active receipt printer`. Task 5 replaces both.

- [ ] **Step 5: Run the tests and the types**

Run: `npx vitest run packages/domain apps/server/src/billing.test.ts apps/server/src/print` then `npx tsc --noEmit`
Expected: PASS, no type errors.

- [ ] **Step 6: Commit**

```bash
git add packages/domain/src/devices.ts packages/domain/src/devices.test.ts packages/domain/src/billing.ts packages/domain/src/billing.test.ts apps/server/src/billing.ts apps/server/src/credit-notes.ts
git commit -m "feat(domain): device settings schema; the bill printer field can be left out"
```

---

### Task 2: Settings in the registry

**Files:**
- Modify: `apps/server/src/devices.ts`
- Modify: `apps/server/src/devices.test.ts`

**Interfaces:**
- Consumes: `deviceSettings`, `DeviceSettings`, `DeviceSettingsPatch` (Task 1).
- Produces, on `Devices`:

```ts
/** What is saved for the device, with defaults. */
settings(device: DeviceRecord): DeviceSettings;
/** The device's bill printer if it is set and active, else null. Null for a browser that is not a device. */
billPrinterId(device: DeviceRecord | null): string | null;
/** True when a printer is saved for the device and that printer is not active. */
printerInactive(device: DeviceRecord): boolean;
/** Saves the keys given, records one settings_changed event, bumps the version. Saving the values it has does nothing. */
updateSettings(id: string, patch: Omit<DeviceSettingsPatch, "version">, version: number, actorName: string): DeviceRecord;
```

`updateSettings` rules: 404 `Device not found` for an unknown or removed device; 409 with the existing `CHANGED`
message on a stale version; a `billPrinterId` in the patch that is not `null` must be a row of `printers` with
`is_active = 1`, else 400 `Choose an active printer`; keys not in the patch keep their **saved** value, even a printer
that is now inactive. The event summary is one sentence per changed key, joined by a space:

- `Bill printer of <device> set to <printer name>.` (or `Browser / A4` for `null`)
- `Starting payment method of <device> set to <label>.` with labels `the method used last`, `Cash`, `Card`, `UPI`

- [ ] **Step 1: Write the failing tests** in `devices.test.ts`, using that file's existing `Devices` fixture and
  credential constants, and a helper `printer(id, active = 1)` that inserts into `printers` with name `Front`
  (`kind 'network'`, `connection '127.0.0.1:9100'`, `paper_width 80`, profiles `'{}'`):

```ts
describe("device settings", () => {
  it("a new device has the defaults", () => {
    const d = devices.add({ credentialHash: deviceHash(A)!, name: "Two", kind: "counter" }, "Asha");
    expect(devices.settings(d)).toEqual({ billPrinterId: null, paymentStart: "last" });
    expect(devices.billPrinterId(d)).toBeNull();
    expect(devices.billPrinterId(null)).toBeNull();
    expect(devices.printerInactive(d)).toBe(false);
  });
  it("saves a change, bumps the version and records it", () => {
    printer("p1");
    const d = devices.add({ credentialHash: deviceHash(A)!, name: "Two", kind: "counter" }, "Asha");
    const saved = devices.updateSettings(d.id, { billPrinterId: "p1", paymentStart: "upi" }, d.version, "Asha");
    expect(saved.version).toBe(d.version + 1);
    expect(devices.settings(saved)).toEqual({ billPrinterId: "p1", paymentStart: "upi" });
    expect(devices.billPrinterId(saved)).toBe("p1");
    expect(devices.events().events[0]).toMatchObject({ kind: "settings_changed", deviceId: d.id, actorName: "Asha",
      summary: "Bill printer of Two set to Front. Starting payment method of Two set to UPI." });
  });
  it("saving the same values changes nothing", () => {
    const d = devices.add({ credentialHash: deviceHash(A)!, name: "Two", kind: "counter" }, "Asha");
    const before = devices.events().events.length;
    expect(devices.updateSettings(d.id, { paymentStart: "last" }, d.version, "Asha").version).toBe(d.version);
    expect(devices.events().events.length).toBe(before);
  });
  it("refuses a stale version, an unknown or inactive printer and a removed device", () => {
    printer("off", 0);
    const d = devices.add({ credentialHash: deviceHash(A)!, name: "Two", kind: "counter" }, "Asha");
    expect(() => devices.updateSettings(d.id, { paymentStart: "cash" }, d.version + 1, "Asha")).toThrow(/This device changed/);
    expect(() => devices.updateSettings(d.id, { billPrinterId: "nope" }, d.version, "Asha")).toThrow("Choose an active printer");
    expect(() => devices.updateSettings(d.id, { billPrinterId: "off" }, d.version, "Asha")).toThrow("Choose an active printer");
    devices.remove(d.id, "Asha");
    expect(() => devices.updateSettings(d.id, { paymentStart: "cash" }, d.version + 1, "Asha")).toThrow("Device not found");
  });
  it("a printer switched off later is kept but not used", () => {
    printer("p1");
    const d = devices.add({ credentialHash: deviceHash(A)!, name: "Two", kind: "counter" }, "Asha");
    let saved = devices.updateSettings(d.id, { billPrinterId: "p1" }, d.version, "Asha");
    db.prepare("UPDATE printers SET is_active = 0 WHERE id = 'p1'").run();
    expect(devices.billPrinterId(saved)).toBeNull();
    expect(devices.printerInactive(saved)).toBe(true);
    saved = devices.updateSettings(d.id, { paymentStart: "cash" }, saved.version, "Asha");
    expect(devices.settings(saved)).toEqual({ billPrinterId: "p1", paymentStart: "cash" });
  });
  it("a replaced device keeps its settings", () => {
    printer("p1");
    const d = devices.add({ credentialHash: deviceHash(A)!, name: "Two", kind: "counter" }, "Asha");
    devices.updateSettings(d.id, { billPrinterId: "p1" }, d.version, "Asha");
    const moved = devices.replaceCredential(d.id, deviceHash(B)!, "Asha", "Replaced.");
    expect(devices.settings(moved).billPrinterId).toBe("p1");
  });
});
```

- [ ] **Step 2: Run** `npx vitest run apps/server/src/devices.test.ts` — expected FAIL (`devices.settings is not a function`).
- [ ] **Step 3: Implement the four methods on `Devices`**, `updateSettings` in one transaction like `rename`.
- [ ] **Step 4: Run** `npx vitest run apps/server/src/devices.test.ts` — expected PASS.
- [ ] **Step 5: Commit**

```bash
git add apps/server/src/devices.ts apps/server/src/devices.test.ts
git commit -m "feat(server): per-device settings in the registry"
```

---

### Task 3: Presence

**Files:**
- Create: `apps/server/src/device-presence.ts`
- Create: `apps/server/src/device-presence.test.ts`
- Modify: `apps/server/src/ws.ts`
- Modify: `apps/server/src/server.ts:134` (pass the clock: `registerWs(app, opts.authTimeoutMs, opts.licensing?.now)`)
- Modify: `apps/server/src/test-helpers.ts` (`wsAuth(app, token, device?)` puts `device` in the auth frame)

**Interfaces:**
- Produces:

```ts
/** Open sockets per device. `onChange` runs when a device's first socket opens (true) or its last one closes (false). */
export class DevicePresence {
  constructor(onChange: (deviceId: string, online: boolean) => void);
  open(deviceId: string): void;
  close(deviceId: string): void;   // closing a device with no open socket does nothing
  online(deviceId: string): boolean;
}
```

- Produces on the Fastify instance: `app.deviceOnline(deviceId: string): boolean`.
- Produces the WebSocket event `devices.presence` with data `{ deviceId: string, online: boolean }`.
- `registerWs(app, authTimeoutMs = 5000, now: () => number = Date.now)`.

Hub changes: at auth, `ClientInfo` gains `deviceId: string | null` from
`app.devices.findByCredential(frame.device)?.id ?? null`, and `presence.open` is called for a non-null id. Every place
a socket leaves `clients` (the `close` handler and both branches of `wsRevalidate`) goes through one function that
removes the socket and calls `presence.close` only if the socket was still in `clients`, so a socket is counted out
exactly once. `onChange` broadcasts `devices.presence` and, when a device goes offline, calls
`app.devices.touch(deviceId, now())`.

- [ ] **Step 1: Write the failing tests**

`device-presence.test.ts`:

```ts
it("is online from the first socket to the last", () => {
  const seen: Array<[string, boolean]> = [];
  const p = new DevicePresence((id, online) => seen.push([id, online]));
  expect(p.online("a")).toBe(false);
  p.open("a"); p.open("a"); p.open("b");
  expect(p.online("a")).toBe(true);
  p.close("a");
  expect(p.online("a")).toBe(true);
  p.close("a"); p.close("a");
  expect(p.online("a")).toBe(false);
  expect(seen).toEqual([["a", true], ["b", true], ["a", false]]);
});
```

In the same file, against a server (dev build set up from browser `A` so it is the main counter, as `dev()` does in
`device-join-routes.test.ts`; `events(ws, name)` collects the `data` of frames whose `event` is `name`; `closed(ws)`
resolves on the socket's `close` event):

```ts
it("a device is online while it has a socket", async () => {
  const { app, token } = await dev();
  const main = app.devices.main()!;
  const seen = events(await wsAuth(app, token), "devices.presence");   // no device: counts for nobody
  expect(app.deviceOnline(main.id)).toBe(false);
  const one = await wsAuth(app, token, A), two = await wsAuth(app, token, A);
  expect(app.deviceOnline(main.id)).toBe(true);
  one.close(); await closed(one);
  expect(app.deviceOnline(main.id)).toBe(true);
  two.close(); await closed(two);
  expect(app.deviceOnline(main.id)).toBe(false);
  expect(seen).toEqual([{ deviceId: main.id, online: true }, { deviceId: main.id, online: false }]);
  expect(app.devices.main()!.lastSeenAt).not.toBeNull();
});
it("signing out takes the device offline once", async () => {
  const { app, token, headers } = await dev();
  const main = app.devices.main()!;
  const watcherToken = (await app.inject({ method: "POST", url: "/api/login", payload: ADMIN_LOGIN })).json().token;
  const seen = events(await wsAuth(app, watcherToken), "devices.presence");
  const ws = await wsAuth(app, token, A);
  await app.inject({ method: "POST", url: "/api/logout", headers });
  await closed(ws);
  expect(app.deviceOnline(main.id)).toBe(false);
  expect(seen.filter((e) => !e.online)).toEqual([{ deviceId: main.id, online: false }]);
});
```

- [ ] **Step 2: Run** `npx vitest run apps/server/src/device-presence.test.ts` — expected FAIL (module not found).
- [ ] **Step 3: Implement `DevicePresence`, then the hub changes and the `wsAuth` parameter.**
- [ ] **Step 4: Run** `npx vitest run apps/server/src/device-presence.test.ts apps/server/src/ws.test.ts apps/server/src/licensing.test.ts` — expected PASS.
- [ ] **Step 5: Commit**

```bash
git add apps/server/src/device-presence.ts apps/server/src/device-presence.test.ts apps/server/src/ws.ts apps/server/src/server.ts apps/server/src/test-helpers.ts
git commit -m "feat(server): the hub knows which devices are online"
```

---

### Task 4: Device list and settings routes

**Files:**
- Create: `apps/server/src/device-routes.ts`
- Create: `apps/server/src/device-routes.test.ts`
- Modify: `apps/server/src/server.ts` (call `registerDevices(app)` right after `registerDeviceJoin`)
- Modify: `apps/server/src/printers.ts:57-81` (broadcast after a printer is switched on or off)

**Interfaces:**
- Consumes: `Devices.settings`, `billPrinterId`, `printerInactive`, `updateSettings` (Task 2); `app.deviceOnline`
  (Task 3); `DeviceInfo`, `DeviceList`, `MyDeviceSettings`, `DeviceSettingsPatch` (Task 1).
- Produces `export function registerDevices(app: FastifyInstance): void` with:

| Route | Needs | Answers |
|---|---|---|
| `GET /api/devices` | `settings.manage` | `DeviceList`, `Cache-Control: no-store` |
| `PATCH /api/devices/:id/settings` | `settings.manage` | `{ device: DeviceInfo }` |
| `GET /api/devices/me/settings` | signed in (`app.requireAuth`) | `MyDeviceSettings`, `Cache-Control: no-store` |

  - `devices` are `app.devices.active()` in their order. `current` compares `req.device?.id`. `maxDevices` is
    `app.licensing.status().maxDevices`; `allowed` is `maxDevices === null || index < maxDevices`.
  - `:id` is a uuid (zod), the body is `DeviceSettingsPatch`, the actor is `req.user.name`.
  - `me/settings` for a device: `{ deviceId, version, settings: { ...saved, billPrinterId: app.devices.billPrinterId(device) } }`.
    For a browser that is not a device: `{ deviceId: null, version: null, settings: deviceSettings({}) }`.
- Produces the WebSocket event `devices.changed`: data `{ deviceId }` after a settings change that saved something;
  data `{}` after `PATCH /api/printers/:id` changed `is_active`.

- [ ] **Step 1: Write the failing tests** in `device-routes.test.ts`. Fixture: a dev build set up from browser `A`
  (`adminToken`; headers `admin` carry the token and `x-masalapos-device: A`), `B` joined as counter "Two" and signed
  in as a cashier created with `createUser` (`cashierToken`; headers `cashier` carry `x-masalapos-device: B`), a
  printer made through `POST /api/printers` (`printerId`), `two()` = the "Two" row of `GET /api/devices`, and
  `events(ws, name)` as in Task 3.

```ts
it("lists devices with their settings and who is online", async () => {
  const list = (await app.inject({ method: "GET", url: "/api/devices", headers: admin })).json();
  expect(list.maxDevices).toBeNull();
  expect(list.devices).toMatchObject([
    { name: "Main counter", kind: "counter", isMain: true, current: true, allowed: true, online: false, printerInactive: false, settings: { billPrinterId: null, paymentStart: "last" } },
    { name: "Two", isMain: false, current: false, allowed: true, online: false },
  ]);
  expect(JSON.stringify(list)).not.toMatch(/credential/i);
  const ws = await wsAuth(app, cashierToken, B);
  expect((await two()).online).toBe(true);
  ws.close();
});
it("only an administrator sees the list or changes settings", async () => {
  expect((await app.inject({ method: "GET", url: "/api/devices", headers: cashier })).statusCode).toBe(403);
  const d = await two();
  expect((await app.inject({ method: "PATCH", url: `/api/devices/${d.id}/settings`, headers: cashier, payload: { version: d.version, paymentStart: "cash" } })).statusCode).toBe(403);
});
it("an administrator sets a device's printer and the device reads it", async () => {
  const d = await two();
  const seen = events(await wsAuth(app, cashierToken, B), "devices.changed");
  const res = await app.inject({ method: "PATCH", url: `/api/devices/${d.id}/settings`, headers: admin, payload: { version: d.version, billPrinterId: printerId, paymentStart: "upi" } });
  expect(res.statusCode).toBe(200);
  expect(res.json().device).toMatchObject({ id: d.id, version: d.version + 1, settings: { billPrinterId: printerId, paymentStart: "upi" } });
  expect(seen).toEqual([{ deviceId: d.id }]);
  const mine = await app.inject({ method: "GET", url: "/api/devices/me/settings", headers: cashier });
  expect(mine.json()).toEqual({ deviceId: d.id, version: d.version + 1, settings: { billPrinterId: printerId, paymentStart: "upi" } });
  expect((await app.inject({ method: "GET", url: "/api/devices/me/settings", headers: admin })).json().settings.billPrinterId).toBeNull();
});
it("refuses a stale version, an unknown printer and unknown keys", async () => {
  const d = await two();
  const patch = (payload: object) => app.inject({ method: "PATCH", url: `/api/devices/${d.id}/settings`, headers: admin, payload });
  expect((await patch({ version: d.version + 5, paymentStart: "cash" })).statusCode).toBe(409);
  expect((await patch({ version: d.version, billPrinterId: "nope" })).json()).toMatchObject({ error: "Choose an active printer" });
  expect((await patch({ version: d.version, theme: "dark" })).statusCode).toBe(400);
  expect((await patch({ paymentStart: "cash" })).statusCode).toBe(400);
});
it("a printer switched off falls back to Browser / A4 and is marked", async () => {
  const d = await two();
  await app.inject({ method: "PATCH", url: `/api/devices/${d.id}/settings`, headers: admin, payload: { version: d.version, billPrinterId: printerId } });
  const seen = events(await wsAuth(app, cashierToken, B), "devices.changed");
  expect((await app.inject({ method: "PATCH", url: `/api/printers/${printerId}`, headers: admin, payload: { isActive: false } })).statusCode).toBe(200);
  expect(seen).toEqual([{}]);
  expect(await two()).toMatchObject({ printerInactive: true, settings: { billPrinterId: printerId } });
  expect((await app.inject({ method: "GET", url: "/api/devices/me/settings", headers: cashier })).json().settings.billPrinterId).toBeNull();
  await app.inject({ method: "PATCH", url: `/api/printers/${printerId}`, headers: admin, payload: { name: "Renamed" } });
  expect(seen).toEqual([{}]);   // a rename is not a device change
});
it("a browser that is not a device gets the defaults", async () => {
  const res = await app.inject({ method: "GET", url: "/api/devices/me/settings", headers: auth(adminToken) });
  expect(res.json()).toEqual({ deviceId: null, version: null, settings: { billPrinterId: null, paymentStart: "last" } });
});
it("a licensed build reports the limit", async () => {
  const { app: licensed, headers } = await commercialApp("basic");   // 2 devices
  await joinDevice(licensed, headers, "b".repeat(64));
  const list = (await licensed.inject({ method: "GET", url: "/api/devices", headers })).json();
  expect(list.maxDevices).toBe(2);
  expect(list.devices.map((d: { allowed: boolean }) => d.allowed)).toEqual([true, true]);
  await licensed.close(); licensed.db.close();
});
```

- [ ] **Step 2: Run** `npx vitest run apps/server/src/device-routes.test.ts` — expected FAIL (404 on `/api/devices`).
- [ ] **Step 3: Implement `registerDevices`, register it, and add the broadcast to the printer PATCH** (compare
  `row.is_active` with the saved value).
- [ ] **Step 4: Run** `npx vitest run apps/server/src/device-routes.test.ts apps/server/src/printers.test.ts apps/server/src/device-join-routes.test.ts` — expected PASS.
- [ ] **Step 5: Commit**

```bash
git add apps/server/src/device-routes.ts apps/server/src/device-routes.test.ts apps/server/src/server.ts apps/server/src/printers.ts
git commit -m "feat(server): device list with presence, and per-device settings routes"
```

---

### Task 5: The server picks the bill printer

**Files:**
- Create: `apps/server/src/print/target.ts`
- Create: `apps/server/src/device-printing.test.ts`
- Modify: `apps/server/src/billing.ts:288-293` (drop the local `printer`), `:374` (bill create), `:426-432` (reprint)
- Modify: `apps/server/src/credit-notes.ts:329-338`

**Interfaces:**
- Consumes: `Devices.billPrinterId` (Task 2); the optional `printerId` of `BillCreate` and `BillPrint` (Task 1);
  `PATCH /api/devices/:id/settings` (Task 4) in the tests.
- Produces:

```ts
export interface ReceiptPrinterRow { id: string; name: string; kind: "network" | "windows" | "bluetooth"; connection: string; paper_width: 58 | 80; receipt_profile: string }
/**
 * The printer for one request. `override` absent: the calling device's bill printer, or null when it has none or that
 * printer is switched off. `null`: no printer. An id: that printer, which must be active (400 "Choose an active receipt printer").
 */
export function receiptPrinter(app: FastifyInstance, device: DeviceRecord | null, override: string | null | undefined): ReceiptPrinterRow | null;
```

- Routes:
  - `POST /api/orders/:id/bill`: `const target = receiptPrinter(app, req.device, body.printerId)`; no printer means no
    thermal print. The replay record (`requestJson`) is still built from the parsed body, so a body without the
    field replays as the same request.
  - `POST /api/bills/:id/print` and `POST /api/credit-notes/:id/print`: parse `req.body ?? {}`; no printer →
    400 `Choose an active receipt printer`.

- [ ] **Step 1: Write the failing tests** in `device-printing.test.ts`. Fixture: `freshAppWithFakeSink()`, set up from
  browser `A` (`mainToken`; headers `main` carry the credential), `B` joined as "Two" with an admin signed in on it
  (headers `two`), a category and product as in `billing.test.ts:19-21`, two printers `front` and `back`, and "Two"
  given `front` through the settings PATCH. `order(headers)` and `billRequest(headers, orderId, extra)` are the
  helpers of `billing.test.ts:24-37` taking the headers to use; `issue(headers, extra = {})` makes an order, posts
  its bill and returns the response; `voided(headers)` issues a bill with `printerId: null`, voids it
  (`POST /api/bills/:id/void`, the payload `print/credit-note.test.ts` uses) and returns the credit note id.

```ts
describe("which printer a bill goes to", () => {
  it("field absent: the device's printer", async () => {
    const res = await issue(two);
    expect(res.statusCode).toBe(201);
    expect(res.json().job).toMatchObject({ printerId: front, kind: "receipt" });
  });
  it("field absent on a device with no printer, or a browser that is not a device: no print", async () => {
    expect((await issue(main)).json().job).toBeNull();
    expect((await issue(auth(mainToken))).json().job).toBeNull();
  });
  it("field present: that printer, for this bill only", async () => {
    expect((await issue(two, { printerId: back })).json().job).toMatchObject({ printerId: back });
    expect((await issue(two)).json().job).toMatchObject({ printerId: front });
    expect((await issue(main, { printerId: back })).json().job).toMatchObject({ printerId: back });
  });
  it("null: do not print this one", async () => {
    expect((await issue(two, { printerId: null })).json().job).toBeNull();
  });
  it("an override that is not an active printer is refused and no bill is issued", async () => {
    const id = await order(two);
    const res = await app.inject({ method: "POST", url: `/api/orders/${id}/bill`, headers: two, payload: { ...(await billRequest(two, id)), printerId: "nope" } });
    expect(res.statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: `/api/orders/${id}/bill`, headers: two })).json().bill).toBeNull();
  });
  it("the device's printer switched off: the bill is issued without a print", async () => {
    await app.inject({ method: "PATCH", url: `/api/printers/${front}`, headers: main, payload: { isActive: false } });
    const res = await issue(two);
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ job: null, printError: null });
  });
  it("a replay answers as before and prints nothing more, even after the device's printer changed", async () => {
    const id = await order(two); const body = await billRequest(two, id);
    const send = () => app.inject({ method: "POST", url: `/api/orders/${id}/bill`, headers: two, payload: body });
    const first = await send();
    const d = (await app.inject({ method: "GET", url: "/api/devices", headers: main })).json().devices.find((x: { name: string }) => x.name === "Two");
    await app.inject({ method: "PATCH", url: `/api/devices/${d.id}/settings`, headers: main, payload: { version: d.version, billPrinterId: back } });
    const replay = await send();
    expect(replay.statusCode).toBe(200);
    expect(replay.json().bill).toEqual(first.json().bill);
    expect(app.printQueue.jobs().filter((j) => j.kind === "receipt")).toHaveLength(1);
  });
});
describe("reprinting a bill", () => {
  const print = (headers: Record<string, string>, billId: string, payload?: object) =>
    app.inject({ method: "POST", url: `/api/bills/${billId}/print`, headers, ...(payload ? { payload } : {}) });
  it("uses the device's printer, an override, or refuses when there is nothing to print to", async () => {
    const billId = (await issue(two, { printerId: null })).json().bill.id;
    expect((await print(two, billId)).json().job).toMatchObject({ printerId: front });
    expect((await print(two, billId, {})).statusCode).toBe(202);
    expect((await print(two, billId, { printerId: back })).json().job).toMatchObject({ printerId: back });
    for (const res of [await print(two, billId, { printerId: null }), await print(main, billId), await print(two, billId, { printerId: "nope" })]) {
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: "Choose an active receipt printer" });
    }
  });
});
describe("the quick takeaway path", () => {
  it("issues without a print, then prints the paid bill on the device's printer", async () => {
    const issued = await issue(two, { printerId: null });
    const bill = issued.json().bill;
    expect(issued.json().job).toBeNull();
    await app.inject({ method: "POST", url: `/api/bills/${bill.id}/settle`, headers: two, payload: { clientRef: uuidv7(), payments: [{ mode: "cash", amountPaise: bill.totalPaise }] } });
    const printed = await app.inject({ method: "POST", url: `/api/bills/${bill.id}/print`, headers: two });
    expect(printed.json().job).toMatchObject({ printerId: front, kind: "receipt" });
  });
});
describe("printing a credit note", () => {
  const print = (headers: Record<string, string>, noteId: string, payload?: object) =>
    app.inject({ method: "POST", url: `/api/credit-notes/${noteId}/print`, headers, ...(payload ? { payload } : {}) });
  it("uses the device's printer, an override, or refuses when there is nothing to print to", async () => {
    const noteId = await voided(two);
    expect((await print(two, noteId)).json().job).toMatchObject({ printerId: front, kind: "credit_note" });
    expect((await print(two, noteId, { printerId: back })).json().job).toMatchObject({ printerId: back });
    expect((await print(two, noteId, { printerId: null })).statusCode).toBe(400);
    expect((await print(main, noteId)).statusCode).toBe(400);
  });
});
```

- [ ] **Step 2: Run** `npx vitest run apps/server/src/device-printing.test.ts` — expected FAIL (the absent-field cases
  get `job: null` or a 400).
- [ ] **Step 3: Implement `receiptPrinter` and use it in the three routes.** `billing.ts` keeps `printBill` and
  `printNewBill`, typed against `ReceiptPrinterRow`.
- [ ] **Step 4: Run the printing and billing suites and the types**

Run: `npx vitest run apps/server/src/device-printing.test.ts apps/server/src/billing.test.ts apps/server/src/quick-takeaway.test.ts apps/server/src/print apps/server/src/printer-profiles.test.ts apps/server/src/zomato-desk.test.ts` then `npx tsc --noEmit`
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/print/target.ts apps/server/src/device-printing.test.ts apps/server/src/billing.ts apps/server/src/credit-notes.ts
git commit -m "feat(server): bills print on the calling device's printer unless the request says otherwise"
```

---

### Task 6: Device settings in the UI (hook and helpers)

**Files:**
- Create: `apps/ui/src/device-settings.ts`
- Create: `apps/ui/src/device-settings.test.ts`
- Modify: `apps/ui/src/device-preferences.ts`
- Modify: `apps/ui/src/device-preferences.test.ts`
- Modify: `apps/ui/src/types.ts:67,73` (`printerId?: string | null` on both request types)

**Interfaces:**
- Consumes: `GET /api/devices/me/settings`, the `devices.changed` event (Task 4); types `MyDeviceSettings`,
  `DeviceSettings`, `PaymentStart` from `@masalapos/domain/devices` (type-only imports).
- Produces, from `device-settings.ts`:

```ts
export const NO_DEVICE: MyDeviceSettings;   // { deviceId: null, version: null, settings: { billPrinterId: null, paymentStart: "last" } }
/**
 * This device's settings from the main PC, reloaded on `devices.changed` and when the connection comes back. Starts
 * from the last value any screen loaded (else NO_DEVICE) and keeps it when a load fails.
 */
export function useDeviceSettings(): MyDeviceSettings & { reload: () => Promise<void> };
/** What the Receipt printer picker shows: the cashier's choice for this bill, else the device's printer; "" is Browser / A4. A printer that is not in `active` shows as "". */
export function shownPrinter(choice: string | undefined, devicePrinterId: string | null, active: ReadonlyArray<{ id: string }>): string;
/** The printer field to send: nothing when `shown` is the device's own printer, null for Browser / A4, else the id. */
export function printerField(shown: string, devicePrinterId: string | null): { printerId?: string | null };
```

- Changes in `device-preferences.ts`: `PaymentStart` is re-exported from the domain type; `PAYMENT_START_KEY`,
  `RECEIPT_PRINTER_KEY`, `readPaymentStart` and `savePaymentStart` are removed; `preferredPayment` becomes
  `preferredPayment(start: PaymentStart): PaymentMode`. `PAYMENT_LAST_KEY`, `startingPayment`, `allowedPayment` and
  `rememberPayment` are unchanged.

- [ ] **Step 1: Write the failing tests**

`device-settings.test.ts`:

```ts
const active = [{ id: "front" }, { id: "back" }];
it("shows the device's printer until the cashier picks another", () => {
  expect(shownPrinter(undefined, "front", active)).toBe("front");
  expect(shownPrinter(undefined, null, active)).toBe("");
  expect(shownPrinter("back", "front", active)).toBe("back");
  expect(shownPrinter("", "front", active)).toBe("");
});
it("shows Browser / A4 for a printer that is not active", () => {
  expect(shownPrinter(undefined, "gone", active)).toBe("");
  expect(shownPrinter("gone", "front", active)).toBe("");
});
it("sends the printer only when it differs from the device's", () => {
  expect(printerField("front", "front")).toEqual({});
  expect(printerField("", null)).toEqual({});
  expect(printerField("back", "front")).toEqual({ printerId: "back" });
  expect(printerField("", "front")).toEqual({ printerId: null });
  expect(printerField("front", null)).toEqual({ printerId: "front" });
});
```

In `device-preferences.test.ts`: delete the `readPaymentStart` / `savePaymentStart` cases and add

```ts
it("starts on the device's method, or the one used last", () => {
  store.set(PAYMENT_LAST_KEY, "card");
  expect(preferredPayment("last")).toBe("card");
  expect(preferredPayment("upi")).toBe("upi");
  store.delete(PAYMENT_LAST_KEY);
  expect(preferredPayment("last")).toBe("cash");
});
```

- [ ] **Step 2: Run** `npx vitest run apps/ui/src/device-settings.test.ts apps/ui/src/device-preferences.test.ts` — expected FAIL (module not found).
- [ ] **Step 3: Implement.** The hook follows `useOrderSettings` (`apps/ui/src/order-settings.ts:28-43`): `apiFetch`
  with `cache: "no-store"`, `connectWs` with `onEvent` for `devices.changed` and `onStatus` for reconnects, and a
  module-level variable holding the last loaded value.
- [ ] **Step 4: Run** the two test files again — expected PASS. (`npm run typecheck -w @masalapos/ui` fails in the
  three screens until Task 7.)
- [ ] **Step 5: No commit here**; Task 7 commits both, since the UI does not compile between the two.

---

### Task 7: Billing, credit notes and "This device" use the server's settings

**Files:**
- Modify: `apps/ui/src/screens/BillingPanel.tsx` (lines 18, 84, 103, 155, 227, 248, 263-267, 311-314, 387-389, 421-424, 444-445, 453, 461)
- Modify: `apps/ui/src/screens/CreditNoteDialog.tsx` (`CreditNoteActions`, `CreditNoteList`, `CreditNoteDialog`, `CreditBody` props)
- Modify: `apps/ui/src/screens/DeviceSettings.tsx`

**Interfaces:**
- Consumes: `useDeviceSettings`, `shownPrinter`, `printerField` and `preferredPayment(start)` (Task 6);
  `PATCH /api/devices/:id/settings` (Task 4).

**`BillingPanel`**
- State `printerChoice: string | undefined` replaces `printerId`; it is set to `undefined` when `order.id` changes.
  `const device = useDeviceSettings()` and
  `const printerId = shownPrinter(printerChoice, device.settings.billPrinterId, printers)` keep every existing
  `printerId ? … : …` label working ("Save & print bill" / "Issue bill", "Pay & print" / "Record payment",
  "Print UPI bill" / "Issue UPI bill").
- `changePrinter(value)` sets `printerChoice` and clears the preview as now; it writes nothing to browser storage.
  The `setPrinterId` call in the loader (line 155) goes, since `shownPrinter` covers an inactive printer.
- The bill request built at preview time spreads `...printerField(printerId, device.settings.billPrinterId)` in place
  of `printerId: printerId || null`.
- The quick-takeaway path still issues with `printerId: null`, and afterwards, when `printerId` is not `""`, posts
  `printerField(printerId, device.settings.billPrinterId)` as the body of `/api/bills/:id/print`. The **Print
  receipt** button (line 444) posts the same body.
- `startMode` uses `preferredPayment(device.settings.paymentStart)`, read through a ref like `taken`.
- `CreditNoteList` and `CreditNoteDialog` get `printerId` and `devicePrinterId={device.settings.billPrinterId}`.

**`CreditNoteDialog.tsx`**
- `CreditNoteActions`, `CreditNoteList`, `CreditNoteDialog` and `CreditBody` take a new prop
  `devicePrinterId: string | null` beside `printerId`. The print request body is
  `printerField(target, devicePrinterId)`.

**`DeviceSettings.tsx`**
- Printer and payment-start values come from `useDeviceSettings()`.
- A change calls `PATCH /api/devices/${deviceId}/settings` with `{ version, billPrinterId }` or
  `{ version, paymentStart }`, then `reload()`. An error shows in the existing `role="alert"` line and also reloads.
- Both selects are disabled when `deviceId` is null or the user lacks `settings.manage` (`useCan`, as `BillingPanel`
  does).
- Copy, exactly:
  - Top line: `Theme and QR alerts are saved in this browser. The bill printer and starting payment method are saved on the main PC for this device.`
  - Under the fieldset legend when the user lacks the permission: `Only an administrator can change these.`
  - When `deviceId` is null: `This browser has not joined as a device, so it has no saved printer.`
  - The "saved printer is no longer active" note is removed; Phase 4's list shows "Printer inactive".

- [ ] **Step 1: Make the changes above.**
- [ ] **Step 2: Check types and the UI tests**

Run: `npm run typecheck` then `npx vitest run apps/ui`
Expected: no errors; PASS. A search for `receipt-printer`, `payment-start`, `RECEIPT_PRINTER_KEY` and
`readPaymentStart` under `apps/` finds nothing.

- [ ] **Step 3: Check it in the app** (`npm run dev`, sign in as `admin` / `demo1234`; stop the server by PID after).
  1. Settings → Printers: add a network printer `127.0.0.1:9100`.
  2. Settings → This device: choose it as the bill printer and `UPI` as the starting method. Reload the page: both
     are still set. Delete every `localStorage` key except `masalapos.device.v1` and the session: still set.
  3. Open an order: the button reads "Save & print bill", Bill options shows the printer, and the payment row starts
     on UPI. Issue the bill: Settings → Printers → Print jobs shows a receipt job for that printer.
  4. On another order pick "Browser / A4 receipt" in Bill options: the button reads "Issue bill" and no job is
     queued. The next order shows the printer again.
  5. Quick takeaway: "Pay & print" queues one receipt job after payment.
  6. Deactivate the printer: without a reload the billing button changes to "Issue bill".
  7. Sign in as a cashier: This device shows the two selects disabled with "Only an administrator can change these."

- [ ] **Step 4: Commit (Tasks 6 and 7)**

```bash
git add apps/ui/src/device-settings.ts apps/ui/src/device-settings.test.ts apps/ui/src/device-preferences.ts apps/ui/src/device-preferences.test.ts apps/ui/src/types.ts apps/ui/src/screens/BillingPanel.tsx apps/ui/src/screens/CreditNoteDialog.tsx apps/ui/src/screens/DeviceSettings.tsx
git commit -m "feat(ui): the bill printer and starting payment method come from the device's settings on the server"
```

---

### Task 8: Docs, spec status and the full run

**Files:**
- Modify: `docs/superpowers/specs/2026-11-10-devices-design.md` (status line and pick-up point)
- Modify: `docs/operations/quick-takeaway.md:44`
- Modify: `docs/operations/printer-settings.md` (one paragraph)

- [ ] **Step 1: Update the spec header.** Status: `Phases 1 to 3 built (migrations 65 and 66; Phase 3 needed none);
  Phase 4 not built`. Replace the pick-up paragraph with the Phase 4 one: `GET /api/devices` (with `online`,
  `printerInactive`, `allowed`) and `PATCH /api/devices/:id/settings` exist in `apps/server/src/device-routes.ts`;
  the hub sends `devices.changed` and `devices.presence`; the interim controls are in
  `apps/ui/src/screens/DeviceSettings.tsx` and `JoinCodePanel.tsx`; next migration is 67. Add a "How Phase 3 settled
  what the spec left open" list from decisions 2 to 8 above, naming this plan, as the Phase 2 list does.
- [ ] **Step 2: Update the two operations docs.** `quick-takeaway.md`: the paid receipt prints on this device's bill
  printer; **Receipt printer** under Bill options changes it for one bill. `printer-settings.md`: each device has a
  bill printer, set by an administrator under Settings → This device on that device; a device whose printer is
  switched off uses the browser receipt.
- [ ] **Step 3: Run everything**

Run: `npm test` then `npm run typecheck`
Expected: all tests pass and there are no type errors. A failure in a test this plan did not touch is reported with
its output, not fixed here.

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/specs/2026-11-10-devices-design.md docs/operations/quick-takeaway.md docs/operations/printer-settings.md docs/superpowers/plans/2026-11-10-devices-phase-3.md
git commit -m "docs: devices phase 3 (device settings, printing, presence)"
```
