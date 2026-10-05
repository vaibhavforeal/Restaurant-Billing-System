# ForkFlow E2E Gate

## Zomato setup and reconciliation

Build the UI and start `node --import tsx tools/e2e/zomato-server.mts`.
Open `http://127.0.0.1:4177/`, sign in as admin (1234), and run `tools/e2e/zomato.js`
through agent-browser with UTF-8 stdin. Require `status: passed`. The disposable
in-memory fixture covers all reconciliation states, UI imports, duplicate handling,
adjustments, connection settings, filtered CSV and refresh recovery. Check desktop
and mobile in both themes, then cashier (2345) and waiter (3456) access. There are no
Zomato API calls. Restart the fixture before repeating the complete gate.

## Cloud backup framework

Build the UI and start `node --import tsx tools/e2e/backups-server.mts`.
Open `http://127.0.0.1:4169/`, sign in as admin (1234), and run
`tools/e2e/cloud-backups.js` through agent-browser with UTF-8 stdin. Require
`status: passed`. Check saved preferences, disabled unconfigured actions,
API guards, honest upload status and working local snapshots. Inspect desktop
and mobile layouts in light/dark themes. This uses a temporary restaurant and
makes no Google requests.

## Table billing requires kitchen acceptance

Build the UI and start `node --import tsx tools/e2e/captain-server.mts`.
Open `http://127.0.0.1:4139/` in two separate agent-browser sessions. Sign in
as admin (1234) in the first and kitchen (4567) in the second. Run
`tools/e2e/kitchen-billing.js` with UTF-8 stdin in the admin session. Require
`status: awaiting-kitchen-acceptance`, and inspect the disabled Preview bill
button and waiting message. In the kitchen session, click **Accept order** on
the returned table/KOT. Then evaluate
`window.__kitchenBillingGate.afterAcceptance()` in the admin session and require
`status: passed`. This covers sending from the cart, disabled billing and F10,
both API guards, live acceptance updates, and issuing before **Done**. All orders
and printing belong to the disposable fixture.

## Reports analytics

Build the UI and start `node --import tsx tools/e2e/order-analytics-server.mts`.
Open `http://127.0.0.1:4163/` with agent-browser and sign in as admin (1234).
Run `tools/e2e/order-analytics.js` through `agent-browser eval --stdin` with UTF-8 stdin.
This disposable fixture contains both service types, 12 products, multiple categories,
unpaid bills and seven days of data. The checks cover reconciliation, ranking, filters,
CSV, dates across tabs, keyboard chart interaction, busy hours, empty/error states,
refresh recovery and out-of-order responses. Also inspect light/dark screenshots at
1280×720 and 390×844, including the scrolled item/category/hour sections.

## KOT from the desktop cart

Build the UI and start `node --import tsx tools/e2e/captain-server.mts`.
Open `http://127.0.0.1:4139/` at desktop size and sign in as admin (1234)
or cashier (2345). Run `tools/e2e/kot-send.js` through agent-browser eval
with UTF-8 stdin. It chooses two unused tables in the disposable fixture.

The 12 checks cover empty F9, saving an unpunched cart before KOT, double
clicks, kitchen routing, Punch then F9, captured printing, lost-response
replay and non-kitchen items. Require `status: passed`. Physical printing
and the live restaurant database are not used. Unit coverage in
`apps/ui/src/retry-queue.test.ts` checks recovery of rejected empty KOTs
without discarding carts, other users' requests or real/ambiguous actions.

## Sales dashboard

Build the UI, then run `node --import tsx tools/e2e/sales-dashboard-server.mts`.
It creates an in-memory restaurant with 30 days of API-issued bills, split
payments, later collections, unpaid bills and a zero-activity date. It uses a
fake printer and never opens the live restaurant database.

Open `http://127.0.0.1:4145/` with agent-browser at **1280×720**, sign in with
admin PIN **1234**, then run:

```powershell
$OutputEncoding = [Text.UTF8Encoding]::new()
Get-Content -Raw -Encoding utf8 tools/e2e/sales-dashboard.js |
  npx --no-install agent-browser --session sales-dashboard eval --stdin
```

The 26-check gate exercises the simplified dashboard graphs and report metrics
against the API, presets/custom dates in Reports, exact
keyboard chart values, report navigation, actual CSV downloads, day-end drill-down,
empty/invalid ranges, failed refresh and late responses. It restores fetch and
download instrumentation in `finally`; the result is `window.__salesDashboardResult`.
Fixture expectations are `.e2e-scratch/sales-dashboard-expected.json`.

Also sign in as cashier **2345** and waiter **3456** to verify dashboard access
versus Captain service views and a 403 reporting response. Check light/dark,
1920×1080, 768×1024 and 390×844. Screenshots and results are saved under
`output/sales-dashboard/`. Stop this disposable server after testing.

## Captain PWA

Build with `npm run build -w @forkflow/ui`, then start
`node --import tsx tools/e2e/captain-server.mts`. This creates an in-memory
restaurant with a fake printer on `http://127.0.0.1:4139/captain/`, never the
real POS database. Staff PINs: admin 1234, waiter 3456, cashier 2345, kitchen 4567.

Use a fresh agent-browser session at 1024×768, sign in as waiter, and open T01.
Run `tools/e2e/captain-app.js` through `agent-browser eval --stdin`. It checks
typed quantity, note, variant, remove/undo, unchanged ₹630 subtotal, one KOT,
print-queue output, denied billing and absence of cached API data. Start a fresh
fixture for each main run. Loopback HTTP supports service workers for this test;
real tablets require trusted HTTPS.

Optional fixture HTTPS: before starting, run
`tools/setup-captain-https.ps1 -ServerAddress 127.0.0.1 -DataDirectory .e2e-scratch/captain-tls-qa -Port 4140`.
The TLS integration test independently creates/cleans disposable certificates
and checks trusted HTTPS and authenticated WSS without bypassing validation.
The setup script never trusts a root automatically.

For interrupted-connection checks, add an item, use agent-browser's
`set offline on`, and Send to kitchen. Require a retained queued draft and no
successful-send message. Restore connectivity and require one item/KOT.
Repeat with an offline reload: require the reconnect screen, then reconnect,
open the order and review/send any saved pending items. Check portrait/landscape,
light/dark theme, account/install panel, and a reduced viewport for note entry.
`output/captain/results.json` and screenshots record the completed checks.

## Licensing management and recovery

Build the UI, then run `node --import tsx tools/e2e/licensing-server.mts`. This
starts a commercial test server on `http://127.0.0.1:4128`, with a fresh scratch
database and an in-memory signing key. It prints the fixture and clock-offset
file paths. No production key or restaurant database is used.

Open the server using agent-browser session `licensing`, complete setup with
admin name `QA Admin` and PIN `1234`, and load the printed `browser-fixtures.js`
through `agent-browser eval --stdin`. Then run:

```powershell
Get-Content -Raw -Encoding utf8 tools/e2e/licensing.js |
  .\.e2e-scratch\qa\node_modules\.bin\agent-browser.cmd --session licensing eval --stdin
```

Require 21 passing checks: activation request download, file limits, signatures,
verified previews, interrupted activation and safe retry, device registration,
remote rename/removal, downgrade impact, stale previews, already-installed grants,
upgrades, history, and failed-refresh recovery.

Set the printed `clock-offset.txt` to `10800000` (ASCII text). This advances only
the test license clock by three hours; never change the PC's system time. Set the
browser viewport to 390 × 844 and run `licensing-recovery.js` the same way.
Require 10 passing checks: expiry enforcement, mobile layout, verified backups
and history during expiry, renewal preview and application, preserved devices,
resumed operational APIs, and rejection of late status responses.

The test browser should have no page errors. Desktop and mobile screenshots were
visually inspected. Type checking, production UI build, and all 396 automated
tests passed, including 19 licensing integration tests. Close the browser and
stop the disposable server afterward. Each main gate run needs a fresh server
and fixture set; do not reuse its signed test grants for product builds.

## Table reservation gates

Build the UI and start the server using a disposable data directory on
`http://127.0.0.1:4127`. Complete setup with admin PIN `1234`. Run the main gate
as admin, then the role gate in the same browser session:

```powershell
Get-Content -Raw -Encoding utf8 tools/e2e/reservations.js |
  .\.e2e-scratch\qa\node_modules\.bin\agent-browser.cmd --session reservations eval --stdin
.\.e2e-scratch\qa\node_modules\.bin\agent-browser.cmd --session reservations set viewport 390 844
Get-Content -Raw -Encoding utf8 tools/e2e/reservations-roles.js |
  .\.e2e-scratch\qa\node_modules\.bin\agent-browser.cmd --session reservations eval --stdin
```

The main gate verifies creation, held table cards, overlaps, rescheduling across
dates, cancellation, lost save responses, duplicate protection, unsaved/busy
navigation guards, stale edits, failed refresh recovery, and seating into an
existing order workspace. Require `status: passed` with 17 checks.

The role gate creates disposable cashier/waiter users using PINs `2345` and
`3456`, signs in through the UI, and checks phone layout, cashier creation and
no-show handling, waiter viewing, and opening a seated order. Require 8 passing
checks. It finishes signed in as waiter. Sign out and back in as admin before
rerunning the main gate.

Both gates passed; desktop and 390px phone screenshots were inspected with no
overflow or browser errors. Type checking, the UI build, and all 385 automated
tests passed, including 13 reservation integration tests and a reserved-table
QR acceptance regression test. Never run these fixtures against restaurant data.

## Report CSV export gate

Build the UI, start a disposable server on `http://127.0.0.1:4126`, and complete
setup/sign in as admin. Run `report-export.js` through agent-browser:

```powershell
Get-Content -Raw -Encoding utf8 tools/e2e/report-export.js |
  .\.e2e-scratch\qa\node_modules\.bin\agent-browser.cmd --session report-export eval --stdin
```

The gate creates paid/unpaid bills, checks downloaded CSV bytes and filenames
against the report, covers signed rounding and empty dates, and verifies export
is unavailable during loading or failed refreshes. It also checks late-response
handling, recovery and the shared catalog download helper. Require
`status: passed` with 11 checks. The focused export, billing/report and catalog
tests passed 31 checks; production build and type checking passed.

## Item CSV transfer gate

Build the UI and run the current server with a disposable data directory on
`http://127.0.0.1:4125`. Complete setup/sign in as admin, then run:

```powershell
Get-Content -Raw -Encoding utf8 tools/e2e/catalog-transfer.js |
  .\.e2e-scratch\qa\node_modules\.bin\agent-browser.cmd --session catalog-transfer eval --stdin
```

The gate creates uniquely named menu items and exercises template/export Blob
downloads, file selection, preview without writes, item/variant creation,
row-level validation, stale-preview rejection and updating by ID. It checks
download contents before importing them. Require `status: passed` with 10 checks.
The gate passed at desktop and 390px phone widths. The 390px view had no page
overflow; page errors were empty. The accompanying full suite passed 364 tests.

## M10 quick takeaway gate

Use a fresh, signed-Pro disposable server on `http://127.0.0.1:4121` with the
latest UI. Sign in as admin and register the test browser. Provide a higher
revision Basic grant for that same disposable installation in
`window.__m10BasicLicense` before the first run; the gate verifies Basic billing.
Do not use restaurant data or port 4100.

```powershell
Get-Content -Raw -Encoding utf8 tools/e2e/m10-takeaway.js |
  .\.e2e-scratch\qa\node_modules\.bin\agent-browser.cmd --session takeaway-qa eval --stdin
```

The gate persists its own phase under `forkflow.qa.m10.takeaway`. When it returns
`reload-required`, reload that browser page and run the same script again.
Four real page reloads exercise cart, create, bill, and settlement recovery.
Require a final `status: passed`; failures return their completed assertions
and page context. Re-running after completion returns the saved results.

The completed gate passed 56 checks: parcel creation without a table, automatic
kitchen send, mixed kitchen/stationless stock timing, cash change, UPI/card,
Basic access, double clicks, draft recovery, and lost-response retries with one
bill/payment and no duplicate stock deductions.

After the main gate completes, run `m10-takeaway-get-failure.js` in the same
registered browser on the latest build. Its eight checks force order-refresh
GET failures during payment confirmation and verify that payment, receipt,
and saved-request recovery remain correct.

## M9 menu, preparation, and table-service gates

Use the latest production UI and server with a disposable database on
`http://127.0.0.1:4120`. Both scripts refuse other origins. Activate a signed Pro
license with `qrOrdering` enabled, sign in as an administrator, and register each
test browser first. Keep the license unchanged while the gates run. Do not point
them at the restaurant desktop on port 4100.

Each gate creates its own uniquely named table, category, products, and order
fixtures. The guest-flow gate also needs at least one active kitchen station.
Use separate browser sessions as below, or finish one gate before starting the
other. Setup/PIN sign-in and device registration must already be complete in
each session.

```powershell
Get-Content -Raw -Encoding utf8 tools/e2e/m9-menu.js |
  .\.e2e-scratch\qa\node_modules\.bin\agent-browser.cmd --session menu-qa eval --stdin
Get-Content -Raw -Encoding utf8 tools/e2e/m9-guest-flow.js |
  .\.e2e-scratch\qa\node_modules\.bin\agent-browser.cmd --session guest-live eval --stdin
```

`m9-menu.js` drives the real product editor and creates a PNG fixture with canvas
and File/DataTransfer. It checks description persistence, bounded JPEG conversion,
public raster responses, content hashes, photo removal, and preservation of a
saved image when its preview fetch fails. It also tests unsaved/busy navigation
and logout guards, guest/staff sold-out controls for base products and variants,
server rejection of sold-out requests, existing-item preservation, and restored
availability. It leaves a saved product editor open. The report is
`window.__m9MenuReport`.

`m9-guest-flow.js` checks waiter/bill calls, staff **Mark handled**, absence of
unintended bill creation, guest receipt recovery after reload, staff acceptance,
and actual **Send to kitchen**/**Done** transitions. It verifies that **Order
more** retains earlier request tracking and that completing an earlier KOT shows
**Ready** on that receipt while a newer request remains pending. It also checks
that guest activity consumes no staff-device slots. The report is
`window.__m9GuestFlow`; its `status` must be `passed` because the script returns
a failure report rather than throwing for every assertion failure. The guest
iframe remains open for inspection.

Verified on the disposable port-4120 server: **33 menu checks** and **14 guest-flow
checks** passed. The full Vitest suite passed **328 tests across 45 files**.
The menu editor was visually checked at desktop size and 390×844; the 390px view
had no horizontal page overflow. Browser errors were empty. These checks do not
verify physical printing, guest Wi-Fi routing, cloud deployment, or installer
rollout.

## M8 QR ordering gates

Use a disposable, seeded Pro server on `http://127.0.0.1:4117`, serving the built
UI. Sign in and register the browser first. The fixture needs a kitchen-linked
`Paneer rice bowl` with a `Large` variant priced at 24000 paise, a `Masala chai`
at 4000 paise, and a recipe deducting 0.125 kg of `Rice` per bowl. Keep this data
isolated from a restaurant database. Each gate creates real requests and orders.

Run the scripts sequentially in the same browser session, waiting for each result:

```powershell
Get-Content -Raw -Encoding utf8 tools/e2e/m8-qr.js |
  .\.e2e-scratch\qa\node_modules\.bin\agent-browser.cmd --session forkflow-m8 eval --stdin
Get-Content -Raw -Encoding utf8 tools/e2e/m8-qr-review.js |
  .\.e2e-scratch\qa\node_modules\.bin\agent-browser.cmd --session forkflow-m8 eval --stdin
```

The first gate checks QR generation/print-sheet selection, guest isolation,
persisted lost-response retry, explicit acceptance, and normal recipe deductions
on kitchen send (14 checks). The second checks price review, accepting into an
existing bill, rejection, code rotation/disable, and saved receipts (9 checks).
Reports remain in `window.__m8Report` and `window.__m8ReviewReport`. Printing is
intercepted to check sheet selection; physical printer output and real-phone QR
scanning still require a deployment check.

## M7 recipe gate

Build the UI with `npm run build -w @forkflow/ui`, then start
`node --import tsx tools/e2e/recipes-server.mts`. It uses an in-memory database,
signed Pro/Basic licenses and a fake printer. Open `http://127.0.0.1:4155`, sign in
as admin **1234**, and register the browser when prompted. Cashier PIN is **2345**.

```powershell
$OutputEncoding = [Text.UTF8Encoding]::new()
Get-Content -Raw -Encoding utf8 tools/e2e/m7-recipes.js |
  npx --no-install agent-browser --session recipes eval --stdin
Get-Content -Raw -Encoding utf8 tools/e2e/recipes-edge-cases.js |
  npx --no-install agent-browser --session recipes eval --stdin
```

The 30-check main gate covers conversion, precision errors, stock creation,
save failures/locking, stale writes, draft protection, variant deductions,
original-quantity reversals, confirmed clearing and Basic/Pro/cashier access.
The 9-check edge gate covers live refresh, failed reloads, lost creation responses,
limits and empty lists. Results are `window.__m7Report` and
`window.__recipeEdgeChecks`. Restart the fixture before rerunning the main gate,
since license revisions are monotonic. Inspect light/dark layouts at 1280×720,
1920×1080 and 390×844; stop the disposable server after testing.

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
- On Windows: identify the PID for this test server, verify its command line,
  then `Stop-Process -Id <test-server-pid>`.
- On Unix: identify this test server's PID and `kill <test-server-pid>`.

## M4 billing gate

`m4-billing.js` verifies both GST settings, cart guards, preview/issue, cash+UPI
split settlement, card payment, receipt iframe, history, immutable tax mode and
the day-end report. It creates test menu items and bills: use a **scratch DB**.
Build the current UI first, start the server with that DB, open it in
agent-browser and complete setup/sign in as an admin.

```powershell
# Substitute your installed agent-browser executable if different.
Get-Content -Raw -Encoding utf8 tools/e2e/m4-billing.js |
  .\.e2e-scratch\qa\node_modules\.bin\agent-browser.cmd --session forkflow-m4 eval --stdin
```

The gate uses DOM events in the real browser (works around native-click issues
seen with agent-browser 0.38 on Windows), with API fixture setup and persisted
result assertions. It prints 12 passing checks, or throws at the failed step.
The gate must run on localhost/127.0.0.1 and is repeatable on the scratch DB.

## M5 inventory gate

With the current production UI built, a restarted test server, and an admin
signed into agent-browser against a scratch database:

```powershell
Get-Content -Raw -Encoding utf8 tools/e2e/m5-inventory.js |
  .\.e2e-scratch\qa\node_modules\.bin\agent-browser.cmd --session forkflow-m5 eval --stdin
```

The gate creates menu fixtures through the API, then exercises stock creation,
fractional product links, kitchen deductions, low-stock warnings, cancellation
reversal, stationless billing, settlement, purchases, wastage, physical counts,
concurrent-count rejection and history through browser DOM events. It verifies
saved balances and ledger totals and reports **18 checks**. It creates test
orders and stock movements; run only on a disposable scratch database.

The M4 gate is also run after inventory changes to check both GST modes, receipts
and payment/report behavior. Its receipt check waits for iframe print readiness.

## M6 resilience gate

Build the UI and start a server against a disposable data folder. Sign in as an
admin, starting on Home (not Settings), then run:

```powershell
Get-Content -Raw -Encoding utf8 tools/e2e/m6-resilience.js |
  .\.e2e-scratch\qa\node_modules\.bin\agent-browser.cmd --session forkflow-m6 eval --stdin
```

The gate checks manual backup/download, LAN QR and shortcut generation, draft
navigation, queued offline punch while adding new rows, and lost acknowledgements
for kitchen send, bill issue and settlement. It restores the original browser
fetch function after fault injection. With a LAN interface it reports 12 checks.
Run the M4 and M5 gates as checkout/stock regression checks.

For packaged-runtime QA, set `FORKFLOW_DATA_DIR` to an absolute scratch folder,
`FORKFLOW_PORT` to an unused port, and `FORKFLOW_DISABLE_AUTOSTART=1` before
launching `dist/installer/win-unpacked/ForkFlow.exe --remote-debugging-port=4122`.
Connect agent-browser to 4122. Check the rendered setup flow, complete setup,
verify SQLite-backed API calls and backup creation, terminate only its identified
utility server child and check that a new health instance ID appears. Quit the
test app after verification. This does not install the app or change firewall
rules. Close any app/server using staged dependencies before rebuilding.

For the automated six-check desktop gate, additionally launch with
`--inspect=9233`, then run `node tools/e2e/m6-desktop.mjs`. It checks that the
process is the unpacked package with a scratch data path and autostart disabled
before terminating its identified server child. The app stays open afterward
for visual inspection. Quit it from the tray after verification; debug ports
are only for QA and should not be enabled in a restaurant launch shortcut.

## Captain picker

Build the UI, start `npx tsx tools/e2e/captain-server.mts`,
open `http://127.0.0.1:4139`, sign in with fixture PIN 1234, and open an occupied
table. Run `tools/e2e/captain-picker.js` through agent-browser `eval --stdin`.
Its 10 checks cover picker focus, active choices, failed-save retry, duplicate
click protection, persisted assignment/removal, and table-card updates.
Use only this disposable fixture. Also verify mouse opening, Escape/Enter and
Tab navigation, and the 390px light/dark layout.

## Return to tables after settlement

Build the UI, then run `node --import tsx tools/e2e/operational-reports-server.mts`
for the disposable in-memory restaurant on port 4157. Sign in as admin (1234)
and run:

```powershell
Get-Content -Raw -Encoding utf8 tools/e2e/settle-tables.js |
  .\.e2e-scratch\qa\node_modules\.bin\agent-browser.cmd --session settle-tables eval --stdin
```

The gate verifies that **Go to tables** appears after confirmed payment, closes
the billing dialog and opens Tables. It checks that a fully settled table is
free and that another unpaid split keeps it occupied. It reports 10 checks
and saves the result to `window.__settleTablesResult`. Use only the disposable
fixture: the gate creates menu items, orders and payments.
