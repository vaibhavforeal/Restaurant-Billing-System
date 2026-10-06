# ForkFlow

**Two distribution apps:** **ForkFlow Demo** contains resettable sample data;
**ForkFlow** is the licensed customer app with a fresh restaurant setup and
Basic/Pro activation. They have separate installers, app identities and data.
Use `npm run package:demo` or `npm run package:commercial` (requires your public
license verification key). Customer builds go to `dist/commercial`; demo builds
go to `dist/demo`. See [distribution and licensing](docs/operations/commercial-licensing.md).

**Zomato setup and reconciliation:** Open **Zomato** to save restaurant connection
details, preview/import order history and settlement entries, and review/export
missing or mismatched amounts in a separate ledger. Live activation requires approved
Zomato POS access and a verified provider integration; it is not active in this build.
See [Zomato setup, CSV templates and activation requirements](docs/operations/zomato.md).

**Customer demo and Kitchen display:** Use **Start ForkFlow Demo.cmd** for an
isolated sample restaurant with reset, and **Start ForkFlow Kitchen.cmd** for
the separate Windows kitchen client. Tablets and browsers use the main server's
`/kitchen/` address. See [setup, demo PINs, installers and reset instructions](docs/operations/demo-and-kitchen.md).

**Detailed reports and captains:** Reports now includes item/category sales,
cashier collections, hourly sales, KOT performance, cancellation details and stock
consumption/wastage, with date filters and CSV exports. Admins create captains in
**Users**; staff choose a captain on each customer's open order. See [report definitions and captain setup](docs/operations/detailed-reports-and-captains.md).

**Multiple item prices:** Set Non-AC, AC and takeaway prices per item and portion
in Catalog. Tables choose AC or Non-AC; parcels use takeaway automatically.
Blank service prices use the item's existing price. See
[service pricing](docs/operations/service-pricing.md) for setup and CSV fields.

Commercial direction: **cloud plus offline**, with Basic (2 devices) and Pro
(5 devices, recipe editing and QR ordering entitlements). Local licensing includes
verified file import, renewal previews, device management and change history;
hosted accounts, automatic subscription renewal and business-data sync remain
to be built. See [commercial licensing](docs/operations/commercial-licensing.md).
The existing development build still runs without activation.

A local-only desktop POS for restaurants. One Windows PC runs everything —
an Electron shell, a Fastify server, and a SQLite database. Extra billing
counters, waiter phones, and the kitchen display are just browsers pointed
at the server's LAN address. No cloud.

Spec: [`docs/superpowers/specs/2026-08-13-desktop-pos-design.md`](./docs/superpowers/specs/2026-08-13-desktop-pos-design.md)

## Status — Milestone 10 (Quick takeaway billing)

Implemented: PIN roles, catalog and variants, tables with separate group orders,
KOT/kitchen display, printer settings and queue, GST billing, cash/UPI/card split
settlement, receipts and day-end reporting, plus stock items, product stock links,
automatic deductions, cancellation reversals, adjustments and low-stock warnings.
Table reservations include guest details, conflict checks, a live reserved-table
status, and seating into a bill. Admins/cashiers manage bookings; waiters view
them. See [table reservations](docs/operations/table-reservations.md).
M6 adds verified daily/manual/pre-update backups, recovery, saved retry requests,
desktop supervision, a Windows NSIS installer and LAN QR/shortcut setup.
M7 adds multiple-ingredient recipes with administrator and Pro-plan access checks,
concurrent-edit protection, and continued stock tracking after a downgrade.
M8 adds table QR menus, guest order requests, staff acceptance into a chosen bill
group, and rejection/status tracking. Basic can browse; Pro can order. Guest
phones do not count toward staff-device limits. This works over restaurant Wi-Fi;
public cloud ordering is still pending.

M9 adds dish descriptions and uploaded photos, quick sold-out controls, and
preparation updates tied to each guest's own items. Guests can order more while
tracking earlier requests, call a waiter, and request the bill. Staff mark
service requests handled from **Tables & orders**; these notifications never
create a bill or payment. New ordering and service calls require Pro.

M10 adds **Quick takeaway** for cashiers and administrators on Basic and Pro.
Checkout punches the cart, sends kitchen items, previews GST, and lets staff
issue the bill and record a received cash, UPI, or card payment, with cash change
and receipt options. Saved order references and queued steps recover interrupted
checkout; an existing unpaid bill reopens for payment. Waiters retain the ordinary
parcel workflow, and **New parcel** remains available alongside Quick takeaway.

Operations: [Quick takeaway billing](docs/operations/quick-takeaway.md),
[Table QR ordering](docs/operations/qr-ordering.md),
[Recipe editing](docs/operations/recipes.md),
[Inventory costing and profit](docs/operations/costing.md), and
[Windows installation, backups and recovery](docs/operations/backup-and-recovery.md).
M6 continuation: [M6 handoff](docs/agents/handoff/2026-09-29-002-m6-resilience.md).

Version 0.6.1 adds a light interface with red accents: responsive navigation,
live service totals, searchable menu cards, table status filters, a desktop order
panel and mobile cart shortcut. Login, checkout, kitchen and admin screens share
the same theme. [UI handoff](docs/agents/handoff/2026-09-29-003-light-red-ui.md).

Version 0.6.2 simplifies the interface: three dashboard totals, four shortcuts,
compact navigation and fewer descriptions. The dashboard fits without scrolling
at the tested desktop, tablet and phone sizes, down to 1024×600 and 360×640.
[Dashboard preview](docs/screenshots/dashboard-simple-desktop.png) ·
[Phone dashboard](docs/screenshots/dashboard-simple-mobile.png).

[Desktop preview](docs/screenshots/ui-red-desktop.png) ·
[Phone preview](docs/screenshots/ui-red-mobile.png) ·
[Login preview](docs/screenshots/ui-red-login.png)

## Develop

**Sales dashboard:** Admins and cashiers have automatic seven-day sales and payment
collection graphs with Cash/UPI/Card breakdowns. Date selection, detailed metrics,
daily reports and CSV exports are in **Reports**.
The existing Day-end/GST report remains available. See
[sales dashboard and reporting semantics](docs/operations/sales-dashboard.md).

**Captain App:** Waiters now open directly into a tablet/phone interface for tables,
orders, cooking notes and KOTs. Captain can be installed as a PWA at `/captain/`
using local HTTPS on restaurant Wi-Fi; no internet hosting is required. Its cached
interface and existing draft/retry storage help with disconnections, while new
orders and kitchen confirmations require the POS connection. See
[Captain setup, tablet trust and offline behavior](docs/operations/captain-app.md).

```bash
npm ci
npm test              # vitest across all workspaces
npm run typecheck
npm run dev           # server (:4100) + Vite UI (:5173) with hot reload
npm run dev:desktop   # the real thing: Electron window + server + built UI
npm run package:demo  # standalone sample-data demo installer
# Set FORKFLOW_LICENSE_PUBLIC_KEY before npm run package:commercial
```

To open the internal development build on Windows, double-click `Start ForkFlow.cmd`
in the project folder. Keep it in this folder so it can find Electron and the
build. Opening `build/desktop/app/main.js` directly uses Windows Script Host,
which reports a syntax error (`800A03EA`) because this file requires Electron.

Use Node.js 24+. The database lives in `./data/forkflow.db` (override with
`FORKFLOW_DATA_DIR`). Use a separate scratch data directory for testing.

On this Windows/npm 11 installation, npm tried `node-gyp rebuild` for
better-sqlite3 despite its bundled prebuild. `npm ci --ignore-scripts` installed
the dependencies successfully and the prebuilt SQLite binary passed all tests.
That fallback skips Electron's download; run `node node_modules/electron/install.js`
before using `dev:desktop`. The browser/server development path works without it.

The customer installer is written to `dist/commercial/ForkFlow-Setup-0.6.4.exe`.
`package:win` aliases `package:commercial`; both require the public verification
key. `package:dir` creates the same licensed app without an installer. Development
builds are for internal use and cannot pass the installer edition check.

Version 0.6.4 prepares Google Drive backups with saved preferences, a persistent
upload queue and a provider adapter. Account linking is deferred; settings show
Not configured and local backups continue normally. See the
[integration handoff](docs/operations/google-drive-backups.md) for the remaining work.

Version 0.6.3 includes kitchen acceptance for table billing. After sending a KOT,
billing stays disabled until the kitchen uses **Accept order** for every active
ticket. Billing can proceed after acceptance without waiting for **Done**.
Restaurants whose kitchen only receives printed KOTs can turn this off in
Settings with **Require kitchen acceptance before billing dine-in orders**; it is
on by default.
Install this update and restart ForkFlow to apply it to an installed 0.6.2 app.
Installed data is kept in the user's application-data folder, separate from the
development database. Open it from the tray menu. Closing the window keeps the
server running; use the tray's Quit action to stop all counters. The current
installer is unsigned; clean-machine firewall/autostart and hardware testing
remain rollout checks.

## Billing

**UPI QR payments:** Set the restaurant's UPI ID once in **Settings → Restaurant
profile**. New unpaid thermal and A4 bills include a locally generated QR with
the final payable amount. Quick takeaway can issue the QR bill before payment.
Staff verify receipt in their bank app before settling; see
[UPI payment setup and behavior](docs/operations/upi-payments.md).

In **Settings → Menu price tax mode**, choose **Add GST at checkout** (default)
or **Menu prices include GST**. Changing the setting affects new bills only.
The mode, restaurant details, item prices and GST rates are saved with each bill.

Dine-in cashier/admin flow: punch the cart → send kitchen items → **Preview bill** →
**Issue bill** → record cash, UPI and/or card amounts → **Settle bill**. Payment
amounts must equal the total; enter the cash applied to the bill, excluding change.
Discounts require a reason; cashiers have the existing 10% cap. Each table split
gets its own bill, and the table frees when all groups settle.

Pick a receipt printer at checkout, or use **View receipt → Print / save PDF**.
The selected printer is remembered on that browser. **Bills** provides unpaid
bills, paid history and reprints. **Reports** shows issued sales and GST by bill
date, plus payments received that date (which may cover older bills), using the
server's local timezone.

The redesigned [bill formats](docs/operations/bill-format.md) include compact
58/80 mm thermal receipts and an A4 layout with numbered items, GST details,
a prominent grand total, and paid/unpaid status. Use **View receipt → Print / save
PDF** for A4, or **Print receipt** for the configured thermal printer.

In **Reports**, select a business date and click **Export CSV** to download the
displayed day-end report for Excel or another spreadsheet. The export includes
sales, discounts, GST by rate, rounding, outstanding balances, cancellations and
cash/UPI/card collections. Amounts are numeric rupees with two decimal places;
the business date and server timezone accompany every row. Use **Refresh report**
before exporting when you need the latest totals. Export is available to admins
and cashiers once the report has loaded successfully.

Money is calculated in integer paise. Discounts are allocated proportionally
across GST rates; CGST/SGST round to paise and the payable rounds to the nearest
rupee. Inclusive GST is extracted from the discounted price; an odd tax paise is
assigned to CGST so the components still sum exactly to the inclusive amount.

Printer settings now discover installed Windows printers and offer separate
bill/KOT copy counts, feed lines and auto-cut settings. Print jobs persist in
SQLite, with uncertain interrupted copies held for staff review. See
[Printer setup and recovery](docs/operations/printer-settings.md).
Real thermal printer hardware, particularly USB/Bluetooth, still needs a hardware smoke test. Payment gateway
integration is not part of this milestone. Voids and refunds are covered by
[Refunds and voids](docs/operations/refunds-and-voids.md).

## Item import and export

Administrators can import and export the menu item database from **Catalog** using
CSV files compatible with Excel. Download a template, preview additions/updates,
then import items and variants together. See [Item import and export](docs/operations/item-import-export.md).

## Inventory

Admins manage **Inventory**; cashiers can view stock and movement history.
Create a stock item with its unit (`pcs`, `kg`, `g`, `L`, `ml`), opening balance
and optional warning threshold. Quantities support up to three decimal places.
Units are fixed after creation so historical quantities retain their meaning.

Open **Inventory → Recipes**, find the menu item, and add its ingredients.
Basic supports one ingredient; Pro administrators can edit multiple ingredients.
The development build also allows recipe editing. kg/L stock defaults to g/ml
entry with automatic conversion and inline precision checks. Missing ingredients
can be created inside the recipe picker without losing the draft. Saving keeps
the editor open, and the recipe applies to all product variants.
Products without a link or recipe do not affect stock.

Basic customers and cashiers can view existing recipes. A downgrade preserves
recipes and their stock deductions; Basic cannot change a multiple-ingredient
recipe. Recipe editing requires a connection to the local
server, but not the internet while the license permits offline operation.
See [Recipe editing](docs/operations/recipes.md) for the editing workflow and limits.

Kitchen items deduct stock when sent; items without a kitchen station deduct it
when the bill is issued. Punching, settlement and reprints never deduct again.
Recipe changes apply to pending items at their next deduction; they do not rewrite
earlier movements. Cancelling a sent item restores its original recorded deduction,
even after changing its recipe. Ordering remains allowed when stock runs below zero;
the order screen warns staff and Inventory highlights low balances. Low means
at or below the configured threshold, or zero when no threshold is set.

Use **Receive stock**, **Record wastage**, or **Physical stock count** with a
reason/reference. A physical count sets the reviewed balance to the counted
quantity; if another counter changes stock meanwhile, refresh and review before
saving again. Movement history records the change, balance after, staff, reason,
and order reference. Entries cannot be edited or deleted. Remove product links
before archiving a stock item; its history is retained.

Pro administrators can also see what dishes cost and what the restaurant earned.
Enter **Amount paid (₹, incl. GST)** when receiving stock, or **Set unit cost** on
an item, and ForkFlow keeps a weighted-average cost per ingredient. **Inventory →
Dish costing** shows recipe cost, cost % and margin per price, and **Reports →
Detailed reports → Food cost & profit** shows revenue, ingredient cost and gross
profit for a date range, with sales whose cost is unknown or that have no recipe
reported separately rather than as zero cost. Cashiers never see costs. See
[Inventory costing and profit](docs/operations/costing.md).

## Layout

```
packages/
  core/     PIN hashing (scrypt) · RBAC permission checks
  domain/   SQLite schema + migrations · roles · request schemas · uuidv7
apps/
  server/   Fastify: REST API · static UI hosting · the only SQLite writer
  ui/       React SPA served to the Electron window and LAN browsers
  desktop/  Thin Electron shell: supervises the server, opens the window
```
