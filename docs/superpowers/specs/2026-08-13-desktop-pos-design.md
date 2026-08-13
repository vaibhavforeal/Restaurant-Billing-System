# Desktop POS — Design Spec

**Date:** 2026-08-13
**Status:** Approved direction; supersedes the cloud/sync-first plan in `PROJECT_PLAN.md` for the current build.

## 1. What we're building

A **local-only desktop POS for restaurants**. One Windows PC runs the app and acts as the LAN server; the app is fully usable on that single machine. Optionally, extra billing counters, waiter phones/tablets, and a kitchen display connect as **browser clients** over LAN — zero install on those devices.

**Modules in this build:** Products (catalog), Inventory (simple stock now, recipe deduction as the final milestone), Billing (GST, ₹, thermal receipts), KOT/Table system.

**Explicitly out of this build:** cloud sync, multi-outlet, remote/owner dashboard, AI features, online-order integrations (Zomato/Swiggy), payment gateways, e-invoice API, add-ons/modifiers (variants cover portions), auto-update. The old Phase 0 sync architecture (outbox, HLC, dual-dialect schema) is retired; its `packages/core` (password hashing, RBAC) is kept.

**Market assumptions:** Indian restaurants. GST invoicing with CGST/SGST split, configurable rate per product, gapless bill numbering, FSSAI/GSTIN on receipts, payments recorded manually (cash/UPI/card, split allowed).

## 2. Architecture

```
┌─ Main PC (Windows) ─────────────────────────────┐
│  Electron shell (thin)                          │
│   ├─ starts/supervises the Node server          │
│   └─ opens window → http://localhost:4100      │
│                                                 │
│  Node server (Fastify, TypeScript)              │
│   ├─ SQLite (better-sqlite3, WAL) — the one DB  │
│   ├─ REST API (all reads/writes)                │
│   ├─ WebSocket (live orders/tables/KOT/stock)   │
│   ├─ Print service (ESC/POS queue → printers)   │
│   └─ serves the React SPA as static files       │
└─────────────────────────────────────────────────┘
          ▲                        ▲
          │ LAN (optional)         │
   Counter 2 / waiter phone      Kitchen display
   (browser, same SPA)           (browser, same SPA)
```

Principles:

- **One database, one writer process.** Only the server touches SQLite. Every client — including the main PC's own Electron window — uses the same REST/WS API. No special data paths.
- **Single-system first-class.** Install → open → bill on one PC with zero network configuration. LAN clients are additive; Settings shows the server's LAN URL (client PCs type/bookmark it once) plus a QR of the same URL for phones. Connecting is not authenticating — every device lands on the PIN screen.
- **Server-side printing.** Any client can print; the server renders and dispatches to printers. Browsers never need drivers.
- **Auth everywhere.** PIN login (fast on touchscreens); roles `admin` / `cashier` / `waiter` / `kitchen` enforced server-side on every endpoint. LAN peers are not trusted.

### Monorepo layout (pruned + new)

```
packages/
  core/      KEEP — password/PIN hashing, RBAC
  domain/    NEW — SQLite schema, migrations, business logic (tax, totals,
             stock, sequences), zod validation schemas shared with UI
  sync/      RETIRE (cloud-era)
  db/        RETIRE dual-dialect parts; salvage what domain needs
apps/
  server/    NEW — Fastify REST + WS + print service + static hosting
  ui/        NEW — React SPA (Vite): billing, tables, KOT display, admin
  desktop/   NEW — Electron shell (~200 lines): boot server, window,
             tray, autostart, watchdog
  terminal-demo/  RETIRE
```

## 3. Data model (SQLite)

Sixteen tables in four groups.

**Auth & setup**

- `users` — name, PIN hash, role, active flag
- `settings` — restaurant profile: name, address, GSTIN, FSSAI, receipt footer, etc.
- `printers` — name, connection (network IP or Windows printer name), paper width (80/58mm)
- `kot_stations` — e.g. Kitchen, Bar; each points at a printer. Default install creates one station so single-kitchen restaurants never see the concept.

**Catalog**

- `categories` — name, sort order
- `products` — category, name, price, GST rate, veg/non-veg, KOT station (nullable = no KOT), active
- `variants` — optional per-product portions (Half/Full) with their own price

**Tables, orders & KOT**

- `dining_tables` — name, area. Status (free/occupied/billed) is **derived from open orders, never stored**.
- `orders` — type (dine-in/parcel), table (nullable), status `open → billed → settled` or `cancelled`, opened-by, `client_ref` idempotency UUID
- `order_items` — product + variant + qty, with **name/price/GST-rate snapshotted** at punch time; per-item status (pending → sent → cancelled); note text
- `kots` — per-day KOT number, order, station, printed-at. "Send to kitchen" bundles that round's pending items into one KOT per station.

**Billing & inventory**

- `bills` — **gapless bill number** from a server-side sequence assigned only at billing time; subtotal, discount, per-rate CGST/SGST breakdown rows, rounding, total
- `payments` — one row per payment: mode (cash/UPI/card) + amount; split = multiple rows
- `stock_items` — unit (pcs/kg/L/g/ml), current qty, low-stock threshold
- `product_stock_links` — product → stock item(s) with qty-per-sale. **Recipe-ready:** simple mode = one link, qty 1; recipes later = many links with fractional quantities. Same table, no migration — the recipe milestone adds UI only.
- `stock_moves` — append-only ledger: delta, reason (sale/purchase/adjustment/wastage), reference, actor. Current qty updates in the same transaction; the ledger is the audit trail.

All sequences (bill no., per-day KOT no.) are plain server transactions — single writer makes them trivial and gapless.

## 4. Core flows

**Dine-in:** tap free table → order opens (table occupied everywhere instantly) → punch items (pending) → **Send to kitchen** creates a KOT per station, prints it, pushes to kitchen display → repeat rounds → **Bill** assigns bill number, freezes GST totals, prints receipt, table shows billed → **Settle** records payment(s), frees the table.

**Counter/parcel:** same minus the table — new parcel order → items → bill → settle on one screen. KOT still fires for items with a station.

**Stock timing:** deduct on KOT send (kitchen committed); items without a station deduct at billing. Cancelling a sent item (role-gated, reason required) prints a cancellation slip at the station and reverses the stock move.

**Live updates:** all clients hold a WebSocket; server broadcasts `order.updated`, `kot.created`, `table.changed`, `stock.low`. Kitchen display = a client subscribed to KOT events (new ticket appears; cook marks done; waiters see it). On WS reconnect the client refetches its current screen, so missed broadcasts cannot leave stale state.

**Resilience (standard behavior):**

- Pending (unsent) items live in client localStorage until server-acknowledged — a server blip mid-order loses nothing.
- Every mutation carries a client-generated UUID; retries can never double-fire a KOT or bill.
- Clients show a "reconnecting…" banner, keep the order editable, and queue send/bill actions until the server returns.
- Electron supervises the server process (relaunch with backoff); app autostarts with Windows. UPS on the server PC is the recommended operational guard for power cuts.

**Roles:** waiter = tables + ordering; kitchen = KOT board; cashier = + billing/settle; admin = + catalog, stock, users, settings, day-end report (sales, tax collected, payment-mode split, cancellations).

## 5. Printing

- Server-side print service renders **ESC/POS** bytes. Network thermal printers (TCP) are first-class; USB printers via their Windows driver / printer sharing. Cash-drawer kick pulse supported.
- Templates in 80mm + 58mm: **GST receipt** (GSTIN, FSSAI, bill no., per-rate tax table), **KOT** (large type, table, items + notes), **cancellation slip**. HTML bill render as browser/A4 fallback.
- **Print queue with retry:** failed jobs (paper out, printer offline) are visible with a retry button — never a silently lost KOT. Per-printer test-print in Settings.

## 6. Error handling & data safety

- Every mutation is one SQLite transaction; WAL mode for crash safety. zod schemas shared between UI and server validate at both edges.
- **Backups:** daily automatic `VACUUM INTO` snapshot to a local backups folder + one before every app update; optional second location (USB/synced folder). Retention policy on the folder.
- **Migrations:** versioned, run at server boot, always after the pre-update backup.
- Destructive actions (void bill, cancel sent item, price override) require role + reason and are recorded on the affected rows.

## 7. Testing

- **Domain (heaviest):** GST math, rounding, totals, stock deduction, sequences as pure functions in `packages/domain`, unit-tested hard.
- **API integration:** full flows (open order → KOT → bill → settle) against a real temp SQLite; invariants asserted (gapless bill numbers, ledger-consistent stock).
- **Printing:** fake ESC/POS sink, byte-snapshot tests per template.
- **UI:** one Playwright happy path; no heavy UI suite in v1.

## 8. Distribution

One installer: **`ForkFlow-Setup-x.x.x.exe`** (electron-builder/NSIS, ~100MB) bundling shell, server, UI, and SQLite engine — no prerequisites on the customer machine. First run creates the DB file and shows a setup screen (restaurant profile, admin PIN). The installer sets the firewall rule and autostart. Client devices install nothing (browser + QR). Updates = run the newer installer; backup + migrate on next boot.

Known platform limits accepted for v1: LAN clients run over plain `http://` (service workers/PWA install unavailable — "Add to Home Screen" shortcut works); a true PWA later requires a small vendor-hosted DNS+cert service (Plex pattern), deferred.

## 9. Milestones

1. **Foundation** — prune monorepo; `packages/domain` schema + migrations; Fastify skeleton; PIN auth + roles; Electron shell boots server + window.
2. **Catalog** — products/categories/variants CRUD; settings; users admin.
3. **Tables + KOT** — orders, WS live updates, kitchen display, KOT printing.
4. **Billing** — GST bills, payments/settle, receipt printing, day-end report.
5. **Inventory (simple)** — stock items, auto-deduction via links, adjustments, low-stock alerts.
6. **Resilience + packaging** — draft queue polish, backups, watchdog, Windows installer (firewall rule, autostart), LAN connect screen (URL for client PCs, QR of the URL for phones).
7. **Recipes** — multi-ingredient `product_stock_links` UI + units; schema already supports it.

## 10. Accepted trade-offs

- **Main PC is a single point of failure** — mitigated operationally (UPS, autostart, watchdog), not architecturally. Per-terminal offline authority was considered and rejected: it rebuilds the retired sync engine inside browsers whose storage is less durable than the server's SQLite, and shared workflow (KOT, billing, stock) still halts without the server.
- **No off-site backup or remote access** — local backups only; cloud is a future phase behind the existing REST boundary.
- **Restaurant WiFi quality bounds LAN client reliability**; static IP recommended at setup, QR reconnect provided.
- **Electron footprint** (~100MB installer) accepted for the all-TypeScript stack and thin-shell design.
