# Browser POS with the existing interface

The new architecture uses `apps/ui` for restaurant operations. Its dashboard, left navigation, tables/orders, reports, inventory, catalog, users, marketplace and settings retain the established React components and styles. The Windows outlet service packages this same UI directory; Electron is not required to render it.

Run `npm run start:pos` from the repository root for a local preview. It rebuilds the existing UI and starts the outlet Fastify server at `http://localhost:4110`, bound to loopback. It uses `.forkflow/browser-outlet` for separate local state. On first use, complete restaurant/admin setup; this is a new data directory, so existing desktop staff PINs are not copied automatically. Keep this preview running while using the browser.

`FORKFLOW_DATA_DIR` and `FORKFLOW_PORT` can explicitly select a different preview directory/port. Never point a second process at a data directory already owned by an outlet server. The existing data-directory lock remains enforced.

The cloud owner portal at `http://localhost:4301` provides remote accounts, reports and queued configuration. It is separate from the cashier POS. Production staff browsers connect to the Windows outlet service's trusted HTTPS address on port 4443. The preview does not install a Windows service or change certificate trust.

The POS continues to use local `/api` and WebSocket endpoints, local staff PIN authentication, and the existing payment/printing workflow. Cloud synchronization operates in the background. UI changes for synchronization and identity recovery remain confined to their existing connection/settings flows.

## Restaurant staff permissions

Restaurant administrators use Users & roles to create accounts, change roles, set PINs, remove/restore access, and open Permissions for non-admin staff. The checkbox grid controls View, Create, Modify, and Delete/reverse for supported restaurant functions. Save permissions applies explicit choices; Role defaults clears individual overrides. Permission administration is checked server-side and cannot be delegated by granting ordinary staff-account CRUD. Existing platform-owner policies remain enforced.

Delete access deactivates an account while retaining financial attribution; it does not erase staff history. The last active administrator cannot be removed. Local permission edits use the synchronized staff policy table, so pending remote commands based on an older revision conflict rather than overwriting them.

## Sample restaurant

Run `npm run start:demo` for an isolated sample restaurant at `http://localhost:4111`. State lives in `.forkflow/browser-demo`. Admin PIN: 1234; cashier: 2345; captain: 3456; kitchen: 4567. Demo printing uses a fake sink.

Includes 14 menu products across four categories, AC/takeaway pricing, eight tables across two areas, four staff roles, five stock ingredients with purchase costs, six recipes, eight issued bills including one void/refund, three open orders/KOTs, three reservations, two sample printer configurations and a receipt job. Reports derive from those transactions. Restaurant profile and KDS marketplace settings are populated. Delivery platforms, live cloud subscriptions and external storage are not connected by the mock dataset.

The seed runs once and preserves demo edits on restart. It refuses existing non-demo restaurant databases. Existing POS data on port 4110 remains separate.

## Loading a rebuilt UI

The offline POS pins an open till to its current release. A normal refresh may still load the previous cached stylesheet. After saving work, close every POS tab/window for that origin, then reopen it to activate the downloaded release. Do not clear site data: that may remove local queues and outlet bindings. Match browser zoom and Windows display scaling when comparing screenshots. The supplied desktop references use approximately 150% physical display scaling.
