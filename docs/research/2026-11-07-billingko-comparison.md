# Billingko vs MasalaPOS (2026-11-07)

Billingko is a competing restaurant POS (Electron + Express + MongoDB, version 1.0.195, 7-day trial build).
This comparison comes from reading the installed server and client bundles: routes, models and screen
routes. Billingko was installed on the dev VM, then closed. Its data is still in `C:\BillingkoData`.

## Both have

Dine-in, takeaway and delivery billing; tables with transfer; hold orders; kitchen tickets (KOTs) and a
kitchen display; a quick-billing mode; a UPI QR on bills; GST on bills; thermal bill templates; split or
mixed payments; combos; customer records; sales analytics; Excel/CSV menu import and export; Google Drive
backups; staff roles; trial and licence handling.

## Where Billingko is ahead (our gaps)

| Feature | Billingko | MasalaPOS |
|---|---|---|
| Item add-ons and modifiers | Add-ons with their own price and tax, attached to items, can be grouped on the bill (`clubAddons`) | None; only combo choices |
| Offers and automatic promotions | BOGO and buy-X-get-Y (`freeCheapest`, `applyOnSameItem`), minimum bill amount, days of the week, date range, limited to chosen order types, variant and add-on targeting | Manual discounts only |
| Token / "order ready" screen | Customer-facing screen: call, call-next, recall, reset; doorbell sound | None |
| Suppliers and purchase invoices | Supplier list, purchase invoices with tax, purchase report, stock batches with an active batch | Receive stock with a reference only |
| Customer credit (khata) | `credit` payment method, credit ledger per customer, settle credit later | Unpaid bills; no ledger per customer |
| Staff attendance | Clock in and out, shop hours, monthly report | Not built; our shifts are cash-drawer shifts |
| AI menu import from a photo | Photo of a menu → products (Gemini 2.5 Flash; the restaurant can supply its own key) | None |
| Setup with a demo menu | Onboarding steps that can load a sample menu | Separate demo app only |
| Alcohol VAT | Alcohol items can carry a VAT rate | None |
| Swiggy | Swiggy is an order type | Zomato only |
| Access from outside the restaurant | Cloudflare tunnel to `<name>.billingko.in` | LAN, plus the licensing service and remote support |
| Activity log and staff access log | General system log, staff access logs, device location tracking | Event tables for specific areas only |

## Where MasalaPOS is ahead

- GST returns (GSTR-1, 3B, CMP-08), B2B bills with the customer's GSTIN, credit notes for voids and
  refunds, money stored in whole paise with exact CGST/SGST splits.
- Recipes with stock deduction, wastage, physical stock counts, a stock history that cannot be edited,
  weighted-average cost, dish margin, food-cost and profit report.
- CRM: loyalty points and tiers, customer types and price slabs, segments, feedback collected through the
  receipt.
- Table QR ordering, Android captain app, reservations, table move/merge/split, offline action queue.
- Cash-drawer shifts, day close, discount limits per role with an admin PIN, permission overrides per
  person.
- AC, Non-AC, takeaway and Zomato prices; per-item packaging charges.
- Zomato reconciliation, print jobs that survive restarts, custom dashboards and reports, a sales assistant
  in Reports, the MasalaPOS Portal.
- One SQLite file, compared with about 400 MB of install plus a 1.2 GB MongoDB folder.

## Don't copy

- Endpoints that delete bills by date range and erase all data. Deleting issued bills is a GST liability;
  keep using credit notes.
- Billingko's security choices: a hardcoded fallback sign-in (JWT) secret, `/api/user/signup` that needs no
  sign-in and lets the caller choose their own role, 365-day sign-ins, the API reachable through the
  internet tunnel, and a GitHub personal access token in plain text in the client's `app-update.yml`.

## Suggested priority

1. Item add-ons and modifiers
2. Offers and BOGO
3. Customer credit (khata)
4. Suppliers and purchase invoices

Each needs its own spec. Next in line: token screen, attendance, AI menu import from a photo, alcohol VAT.
