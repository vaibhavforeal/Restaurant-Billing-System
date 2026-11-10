# Devices — design

Date: 2026-11-10 · Branch: `feat/devices` · Status: Phases 1 to 4 built (migrations 65 and 66; Phases 3 and 4 needed none)

The next migration is 67. Operations guide: `docs/operations/devices.md`.

How Phase 4 settled what the spec left open (plan: `docs/superpowers/plans/2026-11-10-devices-phase-4.md`):

- Settings opens for staff who can see printers but do not manage settings. They get the Devices card only, with the
  Printers, Kitchen stations and Print jobs tabs.
- The device list, renaming, removing and device history stay reachable when the licence has stopped this browser, and
  the licence recovery screen shows the device list (rename and remove only), so a slot can still be freed.
- The Add device dialog learns that a device joined from the device history (a `joined` or `replaced` event newer than
  the code), and also asks every five seconds while a code is on screen.
- Kitchen displays have no bill printer or starting payment method.
- Each printer in a printers response carries `usedBy` (device names and active kitchen station names).
- `/api/license/devices`, `Licensing.devices`, `rename`, `revoke` and the `LicensedDevice` type are removed with no alias.
- A captain join code carries Android pairing codes (`pairings`). The Android app keeps the join code in memory only
  and ignores one that is not well formed.
- The Captain page reads the code from `#join=<code>` on any path.
- The tab is called "Kitchen stations". `printer-settings.css` and `connections.css` are kept for the shared printer
  controls and the connection help.

How Phase 3 settled what the spec left open (plan: `docs/superpowers/plans/2026-11-10-devices-phase-3.md`):

- Until Phase 4, an administrator sets a device's bill printer and starting payment method on that device, under
  **This device**. The values that were in browser storage are not carried over.
- A print route with nothing to print to (the field is `null`, or absent on a device with no active printer) answers
  400 "Choose an active receipt printer". Issuing a bill in the same situation succeeds without a thermal print.
- `GET /api/devices/me/settings` gives `billPrinterId: null` while the saved printer is switched off, so the counter's
  buttons match what the server will do. The saved id is kept and comes back when the printer is switched on.
- `last_seen_at` is also set when a device's last socket closes, so builds without licensing have a "last seen".
- The per-bill **Receipt printer** choice lasts for one order.
- The counter keeps the last settings the main PC gave it in browser storage (`masalapos.device-settings.v1`), so a
  page that loads while the main PC cannot be reached still knows its printer; the main PC's answer always replaces it.
- `GET /api/devices/me/settings` also carries `printerInactive`. **This device** shows a note when the saved printer is
  switched off, with **Forget that printer** for an administrator.
- The counter loads its device settings at sign-in. Until the list of active printers has loaded (a counter that is
  offline), it does not second-guess the printer it has, so a bill saved offline is not sent with "do not print".

How Phase 2 settled what the spec left open (plan: `docs/superpowers/plans/2026-11-10-devices-phase-2.md`):

- Dev and demo servers do not refuse an unjoined browser; the join screen in the UI is what every build shares.
  Licensed builds refuse unjoined devices in the server, as before.
- A removed browser that joins again is a new device with the code's name and kind. Its old row stays removed and its
  credential hash is retired.
- `ensureMain` keeps its limit. With no main counter and every slot in use, a replace code is the way in.
- A new-device code entered after the slots filled gets 409 and stays usable.
- Captain join links use the HTTPS origins when the HTTPS listener is on, because a credential belongs to one origin.

## Why

The owner has no single place to see or manage the other devices in the restaurant.

- The device list belongs to licensing (`licensed_devices`, shown under **Plan & devices**). It holds a name and a
  credential hash and nothing else: no device type, no settings. Dev and demo builds have no list at all.
- **Backups & connections** shows how to connect each kind of device, but it is instructions only. It creates nothing
  on the server and does not show which devices actually connected.
- A device's bill printer and starting payment method live in that browser's `localStorage`
  (`apps/ui/src/device-preferences.ts`). The server cannot see them, the owner cannot set them from the main counter,
  and they are lost when the browser is cleared. With no saved printer, bills silently do not print.
- A new device can only be added by an admin signing in on it and registering it there. The Android Captain "pairing"
  QR is static, identical for every tablet, and records nothing on the server.
- Printers and KOT stations sit on their own card with no link to the devices that print to them.

This adds one **Devices** area: a device registry that always exists, joining by a short-lived code, per-device
settings stored on the server, and printers in the same place.

It is the first of three settings sub-projects. The other two, each with its own spec, are a settings foundation (one
consistent way to store and save settings, per-card saves, change history) and further bill options (logo, bill
copies, delivery charge, tips, separate invoice series).

MasalaPOS is not live with any restaurant and has no demo installs, so there is no upgrade path to protect. Every
phase still ships a forward migration, using the next free number at the time it is built.

## Fixed constraints

- Device types are **billing counter**, **kitchen display** and **captain**. There is no customer-facing display.
- Every staff device uses a licence slot (Basic 2, Pro 5), as today. Guest phones on the QR menu do not.
- Printers are reachable only from the main PC: network, Windows-installed, or Bluetooth COM
  (`apps/server/src/print/sinks.ts`). Assigning a printer to a device means "which of those printers this device's
  bills go to".
- A device is identified by a 64-hex secret in browser storage (`masalapos.device.v1`, `apps/ui/src/api.ts`), sent as
  the `x-masalapos-device` header and in the WebSocket auth frame. The server stores its SHA-256. Clearing storage, or
  switching between the HTTP and HTTPS origin, makes a new credential.
- Settings are managed by the restaurant's admin inside the app. There is no vendor-side remote configuration.

## Delivery

Four phases, each with its own implementation plan, session and commit, built in this order. Each leaves the app
working.

| # | Phase | Visible change |
|---|---|---|
| 1 | Device registry | None |
| 2 | Join codes | New devices join by code; self-registration removed |
| 3 | Device settings, printing, presence | Server picks each device's bill printer |
| 4 | Devices area | The four-tab screen; Settings cards regrouped; docs; Android pairing code |

## Phase 1 — device registry

### Tables

`devices` replaces `licensed_devices`:

| Column | Notes |
|---|---|
| `id` | Text primary key |
| `kind` | `counter`, `kitchen` or `captain` (CHECK) |
| `name` | Shown in the list |
| `credential_hash` | Unique; SHA-256 of the device credential |
| `is_main` | 0 or 1; at most one row is 1 (partial unique index) |
| `settings` | JSON, default `{}`; shape defined in Phase 3 |
| `created_at`, `removed_at`, `last_seen_at` | As on `licensed_devices` (`removed_at` replaces `revoked_at`) |
| `version` | Optimistic concurrency, as today |

The migration copies each `licensed_devices` row across as `kind = 'counter'`, marks the oldest active row as main,
moves the index, and drops the old table. `license_events.device_id` keeps pointing at the same ids.

`device_events` records what happens to devices: `occurred_at`, `actor_name`, `device_id`, `kind` (`joined`,
`renamed`, `replaced`, `removed`, `settings_changed`), `summary`. Device events move out of `license_events`, which
keeps licence-only kinds.

### Behaviour

- The registry exists in every build. With licensing disabled (dev, demo) there is no device limit. In this phase
  such builds gain only the main counter from setup, and other browsers keep working unjoined as they do today; from
  Phase 2 every build requires a device to join.
- A database that was set up before this change and has no devices gets its main counter the first time an admin
  signs in from loopback on the main PC.
- Licensing reads active devices from the registry ordered `created_at, id` and applies `maxDevices` exactly as now:
  only the first `maxDevices` may operate, and later ones are kept but blocked.
- First-run setup creates the setup browser as the main counter (`is_main = 1`, kind `counter`), as it does today
  under the name "Main counter". The main counter cannot be removed.
- A new module, `apps/server/src/devices.ts`, owns the registry: list, find by credential, rename, remove, record
  events. `Licensing` calls it instead of querying the table.
- The auth pre-handlers resolve the credential header to a device row once per request and expose it as `req.device`
  beside `req.user`. Later phases use it for printing and settings.
- Rename and remove keep their optimistic `version` checks. Remove still deletes the device's sessions and closes its
  sockets.
- Existing routes under `/api/license/devices` keep working in this phase by delegating to the registry, so the UI is
  unchanged. They are replaced in Phase 4.

## Phase 2 — join codes

### Table

`device_join_codes`: `id`, `code_hash` (unique), `kind`, `name`, `replaces_device_id` (nullable), `created_by`,
`created_at`, `expires_at`, `used_at`.

### Creating a code

`POST /api/devices/join-codes` (needs `settings.manage`) with `{ kind, name }` or `{ replacesDeviceId }`.

- The code is six characters from an alphabet without look-alikes (no `0`, `O`, `1`, `I`, `L`), valid for 10 minutes,
  single use. Only its hash is stored.
- A new-device code is refused with 409 when active devices have reached `maxDevices`. A replace code is always
  allowed, since it uses no extra slot.
- The response carries the code, its expiry, and a QR for `<origin>/join#<code>` for each LAN origin, built with the
  existing `lanUrls` helper. For kind `captain` it also carries the Android pairing URI with the code added (Phase 4).
- Creating a new code for the same target cancels any unused earlier one.

### Joining

`POST /api/devices/join` with `{ code }`. Unauthenticated; requires the `x-masalapos-device` header; rate-limited per
IP in the same way as the guest routes (`apps/server/src/guest-ordering.ts`).

- A valid new-device code creates the `devices` row with the code's name and kind and this credential.
- A valid replace code swaps `credential_hash` on the existing row, deletes that device's sessions and closes its
  sockets. Name, kind, settings, `created_at` (and so its licence slot) are kept.
- Wrong, expired and used codes all return the same 400 "That code is not valid or has expired".
- A credential that is already an active device is rejected with 409.
- The response gives the device's kind, so the client can route.

### Client

- A device whose credential is not in the registry sees only an **Enter join code** screen, in the POS, `/kitchen/`
  and `/captain/` alike. It replaces the current "Register this device" form and the "Ask your administrator" notice.
  Opening `/join#<code>` fills the code in.
- After joining, the device goes to the screen for its kind (POS, `/kitchen/`, `/captain/`) and the normal sign-in.
- `GET /api/devices/me` (unauthenticated, credential header) returns whether this credential is joined and its kind,
  so the client can choose between the join screen and sign-in.

### Main-PC safety net

If the main counter's browser storage is cleared, an admin signing in from loopback on the main PC (`fromMainPc`,
`apps/server/src/system.ts`) is offered **Re-join as main counter**. It swaps the main device's credential to this
browser, records a `replaced` event, and needs no code.

### Removed

- `POST /api/license/devices` (admin self-registration on the new device).
- The first-run path is unchanged: setup still creates the main counter directly.

## Phase 3 — device settings, printing, presence

### Device settings

`DeviceSettings` (zod, in `packages/domain`), stored in `devices.settings` and filled from defaults when a key is
missing:

| Key | Values | Default |
|---|---|---|
| `billPrinterId` | An active printer's id, or `null` for Browser / A4 | `null` |
| `paymentStart` | `last`, `cash`, `card`, `upi` | `last` |

- `PATCH /api/devices/:id/settings` (needs `settings.manage`) takes a partial object and the device `version`, and
  records a `settings_changed` event. A `billPrinterId` that is not an active printer is rejected.
- `GET /api/devices/me/settings` (any signed-in user) returns the calling device's settings.
- The device receives `devices.changed` over the WebSocket and re-reads its settings.
- Theme, keyboard shortcuts, the last-used payment method and the QR alert sound stay in browser storage. They belong
  to whoever is using the device.
- Deactivating a printer that devices use is allowed; those devices fall back to Browser / A4 and the Devices list
  marks them "Printer inactive".

### Printing

`BillCreate.printerId` and the body of the bill-print and credit-note-print routes change from "the printer" to "an
override":

- Field absent: the server uses `req.device`'s `billPrinterId`. `null` there means no thermal print, as today.
- Field present: that printer is used for this request only (the per-bill **Receipt printer** picker on the billing
  panel). An explicit `null` means "do not print this one".

`BillingPanel`, the quick-takeaway path and `CreditNoteDialog` stop reading `masalapos.receipt-printer`. They read the
device's settings from the server to label their buttons ("Save & print bill" or "Issue bill") and send `printerId`
only when the user picks an override. KOT routing (product → station → printer) is unchanged.

### Presence

- At WebSocket auth the hub resolves the credential to a device id and keeps a count of open sockets per device.
- `GET /api/devices` includes `online` for each device.
- The hub broadcasts `devices.presence` when a device's first socket opens or its last one closes.
- A device on the sign-in screen has no socket and counts as offline. The list shows "last seen" from `last_seen_at`
  for offline devices.

## Phase 4 — Devices area

### Settings cards

The Settings grid (`apps/ui/src/settings-sections.ts`) changes as follows:

- **Devices** (new card) replaces **Printers**.
- **This device** keeps theme and the QR alert controls only.
- **Backups & connections** becomes **Backups**. Its Connections tab is removed.
- **Plan & devices** becomes **Plan**. Its device list, history of device events and "Register this device" form are
  removed; plan, activation and licence history stay.

The section-ids test and the Marketplace and e2e checks that rely on the titles "Backups & connections" and "Plan &
devices" are updated.

### Devices card

Four tabs. The card is visible with `settings.manage` or `printers.read`; the Devices tab needs `settings.manage`, the
other three keep `printers.read` and `printers.manage`.

**Devices**

- A row per device: name, type, online dot or "last seen", bill printer, and badges for "Main", "This device",
  "Over limit" and "Printer inactive".
- "n of max devices used" from the licence; hidden in builds without a limit.
- **Add device**: choose a type and a name, or **Replace an existing device** and pick it. The next step shows the
  code, its countdown, the QR, and the connection help for that type, moved from `SystemSettings.tsx`: LAN addresses
  and the Edge shortcut for a counter; the kitchen link and desktop app for a kitchen display; the APK download, HTTPS
  address and certificate for a captain. When the device joins, the dialog confirms it and closes.
- Clicking a row opens the device: rename, bill printer, starting payment method, Replace, Remove. Remove confirms and
  signs staff out on that device, as today.
- Device history (from `device_events`), paged.

**Printers**

The existing printer list and add form from `Settings.tsx`, with:

- a **Used by** column listing the devices and KOT stations that print to each printer;
- a line at the top: "Printers must be reachable from the main PC: on the network, installed in Windows on the main
  PC, or paired to it by Bluetooth."

**Kitchen stations** and **Print jobs**

The existing content from `Settings.tsx`, moved as is.

The moved printer, station and job markup loses its inline styles and hard-coded colours and uses the POS stylesheet
classes, so it is correct in the dark theme. The area uses plain CSS like the rest of the POS UI; BoardUI and Tailwind
remain limited to the dashboard.

### Routes

`/api/devices` (list), `/api/devices/:id` (PATCH rename, DELETE remove) and `/api/devices/events` replace the
`/api/license/devices` routes, which are removed. `/api/system/connections` stays as the source of connection details
for the Add device flow.

### Android Captain

The pairing URI becomes `masalapos-captain://pair?server=<origin>&ca=<fingerprint>&code=<code>`. The wrapper loads
`<origin>/captain/#join=<code>` after pairing, so one scan connects and joins. A URI without `code` still pairs and
then shows the join screen. This needs an app rebuild and is the last item built.

### Docs

Updated: `docs/operations/commercial-licensing.md` (registering devices), `captain-app.md` (pairing),
`demo-and-kitchen.md` (kitchen connection), `printer-settings.md` (where printers live, per-device bill printer),
`rollout-checklist.md`. A new `docs/operations/devices.md` covers adding, replacing and removing a device.

## Security

- LAN peers are not trusted. Join codes are single use, expire in 10 minutes, are stored hashed, and the join route is
  rate-limited per IP.
- Join failures return one message, so a code cannot be probed for "expired" versus "wrong".
- Codes travel over plain HTTP on the LAN unless the optional HTTPS listener is set up, as device credentials and
  session tokens already do. The short life and single use limit what a captured code is worth.
- The code-free re-join is limited to loopback on the main PC and to a signed-in admin.

## Testing

Each phase is built test-first against the server suite (vitest).

- **Phase 1:** migration carries existing devices across; registry list, rename and remove with version conflicts;
  the limit and "oldest first" rule unchanged; devices created in unlicensed builds; `req.device` set; existing
  licensing tests pass with `test-helpers.ts` registering through the registry.
- **Phase 2:** code creation refused at the limit and allowed for a replace; join with a valid, wrong, expired and
  used code; replace keeps name, settings and slot and ends the old sessions; rate limit; loopback re-join allowed
  for an admin and refused from another address.
- **Phase 3:** settings defaults and validation; bill, reprint, quick-takeaway and credit-note printing with the field
  absent, present and `null`; inactive assigned printer; presence across one and several sockets.
- **Phase 4:** section-ids test; UI tests for the Add device flow and device detail; then a run-through in the app:
  add a second counter by code, assign it a printer, issue a bill from it and confirm it prints without choosing a
  printer, see it online, clear its browser storage, replace it and confirm name, settings and slot carry over, add a
  kitchen display and a captain the same way, and check the dark theme.

## Out of scope

- Assigning a kitchen display to particular KOT stations.
- A customer-facing display.
- Printing to a printer attached to a second counter rather than the main PC.
- Letting cashiers change their own device's settings.
- Changing which devices count against the licence, or the plan limits.
- Per-device invoice series or bill layout (part of the later bill-options work).
