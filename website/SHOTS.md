# Screenshots (Phase 2)

Captured 2026-11-06 from the real app with the demo sample restaurant (admin / demo1234), 1440x900 at 2x, via Playwright (Python, system Chrome). The Demo banner is cropped out. Files are in `public/shots/`.

| File | Shows | Backs which claim (doc) |
| --- | --- | --- |
| `tables.png` | Tables and orders: areas, live status, captain, running amount, QR requests, reservations, open takeaways | tables, reservations, QR (`tables-workspace.md`, `table-reservations.md`, `qr-ordering.md`) |
| `dashboard.png` | Sales dashboard: totals, hourly chart, payment split (right-hand Alerts card cropped out: it names Zomato and Swiggy) | `sales-dashboard.md` |
| `kitchen.png` | Kitchen display with KOTs, cooking note, Done | `demo-and-kitchen.md` |
| `inventory.png` | Stock balances with low-stock status | `README.md` Inventory, `costing.md` |
| `catalog.png` | Items with Non-AC / AC / takeaway prices, CSV import and export, combos | `service-pricing.md`, `item-import-export.md`, `combos.md` |
| `gst-dayend.png` | Day-end figures: bills, GST (CGST/SGST), payments split by cash, UPI, card | `README.md` Billing, `gst-returns.md` |
| `captain-phone.png` | Captain app at phone width (390px) | `captain-app.md` |

## Left out on purpose
- Marketplace, Orders board, and the Reports tab strip name Zomato or Swiggy. The brief says no aggregator names, so those shots were deleted.
- GST returns tab: empty in demo data ("Not registered for GST"). Needs a GSTIN set in the demo restaurant before it can be shot, and the tab strip must be cropped out.
- Sales tab: six of seven days are zero rows in demo data.

## Still to capture (pick up here)
1. **Order screen with items and the bill preview** (the hero shot). Open T01 or T03 "View order", then Preview bill. This is the most important missing image.
2. A printed or on-screen **receipt** (GST breakdown, UPI QR).
3. **Guest QR menu** on a phone (`/menu/#<table-token>`; get the token from "Table QR codes").
4. **Recipes** and **Dish costing** tabs (set a unit cost first so the numbers are not blank).
5. Optional: refund / credit note screen.

## How to re-run
The demo seed is compile-time, so a dev server does not seed it. A scratch launcher (outside the repo) sets `__MASALAPOS_DEMO__` and imports `apps/server/src/main.ts`; run it on :4200 with a scratch data dir, start Vite with `MASALAPOS_PORT=4200 npm run dev -w @masalapos/ui -- --port 5190 --strictPort`, then drive it with Playwright at `http://localhost:5190` (IPv6 only, not 127.0.0.1). Stop both by PID afterwards. See the project memory notes `website-project` and `dev-server-cleanup`.
