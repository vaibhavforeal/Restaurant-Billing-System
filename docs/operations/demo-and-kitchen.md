# Customer demo and separate Kitchen app

## Start a customer demo

Install `dist/demo/ForkFlow-Demo-Setup-0.7.0.exe`, or double-click
`Start ForkFlow Demo.cmd` from this workspace. Demo runs on port **4110** and
stores its database in `%APPDATA%\forkflow-demo\data`. It has a separate app
identity and can run alongside the ordinary POS on port 4100.

The licensed customer app is built separately with `npm run package:commercial`
and appears in `dist/commercial/ForkFlow-Setup-0.7.0.exe`. It requires your public
license verification key during the build, then a signed customer license during
activation. Use `Start ForkFlow Customer.cmd` for its workspace build. Demo never
becomes the licensed app; install the customer edition for the real restaurant.
See [customer builds and activation](commercial-licensing.md).

The sample restaurant includes 14 dishes, 8 tables, 5 stock ingredients,
6 recipes, 8 paid bills, and 3 open orders with kitchen tickets. Thermal printer
jobs are simulated in the demo server. The app displays a permanent Demo banner.

| Role | Demo PIN |
| --- | --- |
| Admin | 1234 |
| Cashier | 2345 |
| Captain | 3456 |
| Kitchen | 4567 |

Edits persist between sessions. For the next customer, use the desktop menu
**Demo → Reset sample data**, or that option in the demo tray menu. Confirm the
reset to stop the demo server, archive the demo database in a `reset-*` folder,
and recreate the samples. Connected demo devices sign in again afterward.
The reset refuses unmarked data directories; the regular POS database is never
selected by the demo launcher. Database archives remain available for inspection.

## Connect a Windows kitchen display

1. Keep the main POS or Demo app running.
2. Install `dist/kitchen/ForkFlow-Kitchen-Setup-0.7.0.exe`, or run
   `Start ForkFlow Kitchen.cmd` from this workspace.
3. Enter the main PC's address. For a demo on this same PC, use
   **http://127.0.0.1:4110**. On another PC, use the main PC's LAN address,
   such as `http://192.168.1.20:4110` for Demo or port `4100` for the normal POS.
4. Sign in with a **Kitchen** staff PIN created on the main POS. Use **4567**
   with the sample demo restaurant.

The address is saved in `%APPDATA%\forkflow-kitchen\connection.json` and is
reused on launch. **Kitchen → Connect to a different POS** changes it. **F11**
toggles full screen. This app runs no database or POS server of its own.
It connects to the selected POS for sign-in, tickets and all saved actions.

## Tablet or browser

On the same restaurant network, open the main PC's `/kitchen/` address. Find
the exact link in **Settings → Backups & connections → Kitchen displays**.
Example: `http://192.168.1.20:4110/kitchen/` for the demo. A different device
must use the main PC's LAN address; `127.0.0.1` refers to itself.

The browser works directly over the LAN. For home-screen installation, configure
and trust the restaurant HTTPS connection as described in [Captain setup](captain-app.md).
Use the same trusted host and port with `/kitchen/`. In Chrome select
**Install Kitchen** or its install menu. On iPad use Safari → Share → Add to
Home Screen. Demo can use its own HTTPS setup in the demo data directory;
choose a free HTTPS port if another POS is already using 4443.

## Ticket workflow and connectivity

Sending an order from POS or Captain creates the same ticket on connected
kitchen displays. **Accept order** acknowledges it and unlocks the existing
dine-in billing rule (an administrator can switch that rule off in Settings for
restaurants that only print KOTs). **Done** completes it and updates the main POS and other
displays. Kitchen sign-in has its own browser session and does not replace a
cashier session on the same origin. Existing server roles and device licensing
still apply; the Kitchen role cannot access billing/orders APIs.

During disconnection the board keeps the last received tickets, shows a
reconnection message, and disables ticket actions. On reconnect it refreshes
from the POS. Failed writes remain available for retry. Installed Kitchen caches
only the application shell and static assets, never ticket/API responses.
Internet is unnecessary, but the main POS and restaurant network must be running.

## Build and verify

- `npm run build:demo` / `npm run package:demo`
- `npm run build:kitchen` / `npm run package:kitchen`
- `npm test` and `npm run typecheck`
- `npm run test:packaging` checks edition separation and installer guards

After building both editions, run
`node tools/e2e/distribution-smoke.mjs C:\secure\license-private.pem` on the
provider's build PC. It starts the compiled servers on temporary free ports with
fresh scratch databases, verifies demo samples, then checks customer setup,
activation enforcement and signed license/device registration. It leaves the
scratch databases under `.e2e-scratch` and stops only its own test processes.
The key must match the customer build; no private key or test license is packaged.

The demo and Kitchen installers have distinct application IDs, install folders,
shortcuts and data folders. Updating the normal POS to serve `/kitchen/` requires
the current UI build; its existing KOT APIs and database remain the source of
truth. Neither customer installer contains your restaurant database.

`tools/e2e/demo-kitchen.js` exercises sending a ticket from Demo and verifies
that billing remains blocked until a second Kitchen client accepts it. Then
run its `window.__kitchenBillingGate.afterAcceptance()` continuation. On the
Kitchen browser run `tools/e2e/kitchen-app.js` for permissions, storage isolation,
failed refresh/write retry, completion and cache checks. These scripts require
the sample demo on port 4110 and must not be pointed at a restaurant server.
