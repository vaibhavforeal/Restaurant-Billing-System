# ForkFlow

A local-only desktop POS for restaurants. One Windows PC runs everything —
an Electron shell, a Fastify server, and a SQLite database. Extra billing
counters, waiter phones, and the kitchen display are just browsers pointed
at the server's LAN address. No cloud.

Spec: [`docs/superpowers/specs/2026-08-13-desktop-pos-design.md`](./docs/superpowers/specs/2026-08-13-desktop-pos-design.md)

## Status — Milestone 6 (Resilience and Windows packaging)

Implemented: PIN roles, catalog and variants, tables with separate group orders,
KOT/kitchen display, printer settings and queue, GST billing, cash/UPI/card split
settlement, receipts and day-end reporting, plus stock items, product stock links,
automatic deductions, cancellation reversals, adjustments and low-stock warnings.
M6 adds verified daily/manual/pre-update backups, recovery, saved retry requests,
desktop supervision, a Windows NSIS installer and LAN QR/shortcut setup.
Recipe configuration is next (M7).

Operations: [Windows installation, backups and recovery](docs/operations/backup-and-recovery.md).
Latest continuation: [M6 handoff](docs/agents/handoff/2026-09-29-002-m6-resilience.md).

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

```bash
npm ci
npm test              # vitest across all workspaces
npm run typecheck
npm run dev           # server (:4100) + Vite UI (:5173) with hot reload
npm run dev:desktop   # the real thing: Electron window + server + built UI
npm run package:win   # self-contained Windows x64 NSIS installer
```

Use Node.js 24+. The database lives in `./data/forkflow.db` (override with
`FORKFLOW_DATA_DIR`). Use a separate scratch data directory for testing.

On this Windows/npm 11 installation, npm tried `node-gyp rebuild` for
better-sqlite3 despite its bundled prebuild. `npm ci --ignore-scripts` installed
the dependencies successfully and the prebuilt SQLite binary passed all tests.
That fallback skips Electron's download; run `node node_modules/electron/install.js`
before using `dev:desktop`. The browser/server development path works without it.

The installer is written to `dist/installer/ForkFlow-Setup-0.6.2.exe`.
Installed data is kept in the user's application-data folder, separate from the
development database. Open it from the tray menu. Closing the window keeps the
server running; use the tray's Quit action to stop all counters. The current
installer is unsigned; clean-machine firewall/autostart and hardware testing
remain rollout checks.

## Billing

In **Settings → Menu price tax mode**, choose **Add GST at checkout** (default)
or **Menu prices include GST**. Changing the setting affects new bills only.
The mode, restaurant details, item prices and GST rates are saved with each bill.

Cashier/admin flow: punch the cart → send kitchen items → **Preview bill** →
**Issue bill** → record cash, UPI and/or card amounts → **Settle bill**. Payment
amounts must equal the total; enter the cash applied to the bill, excluding change.
Discounts require a reason; cashiers have the existing 10% cap. Each table split
gets its own bill, and the table frees when all groups settle.

Pick a receipt printer at checkout, or use **View receipt → Print / save PDF**.
The selected printer is remembered on that browser. **Bills** provides unpaid
bills, paid history and reprints. **Reports** shows issued sales and GST by bill
date, plus payments received that date (which may cover older bills), using the
server's local timezone.

Money is calculated in integer paise. Discounts are allocated proportionally
across GST rates; CGST/SGST round to paise and the payable rounds to the nearest
rupee. Inclusive GST is extracted from the discounted price; an odd tax paise is
assigned to CGST so the components still sum exactly to the inclusive amount.

Print jobs remain in memory until server restart. Real thermal printer hardware,
particularly USB/Bluetooth, still needs a hardware smoke test. Voids/refunds and
payment gateway integration are not part of this milestone.

## Inventory

Admins manage **Inventory**; cashiers can view stock and movement history.
Create a stock item with its unit (`pcs`, `kg`, `g`, `L`, `ml`), opening balance
and optional warning threshold. Quantities support up to three decimal places.
Units are fixed after creation so historical quantities retain their meaning.

In **Product stock link**, choose the stock item and amount consumed by one menu
item. This simple mapping applies to all of that product's variants. Products
without a link do not affect stock. Multiple-ingredient recipe editing comes
later; the simple editor refuses to overwrite an existing multi-link recipe.

Kitchen items deduct stock when sent; items without a kitchen station deduct it
when the bill is issued. Punching, settlement and reprints never deduct again.
Cancelling a sent item restores its original recorded deduction, even after
changing its product link. Ordering remains allowed when stock runs below zero;
the order screen warns staff and Inventory highlights low balances. Low means
at or below the configured threshold, or zero when no threshold is set.

Use **Receive stock**, **Record wastage**, or **Physical stock count** with a
reason/reference. A physical count sets the reviewed balance to the counted
quantity; if another counter changes stock meanwhile, refresh and review before
saving again. Movement history records the change, balance after, staff, reason,
and order reference. Entries cannot be edited or deleted. Remove product links
before archiving a stock item; its history is retained.

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
