# Per-item packaging charges — design

Date: 2026-11-06. Branch: `feat/bill-settings`. Migration: 61.

Follows Phase 4 of `2026-11-05-bill-settings-design.md`, which built a flat packaging charge per takeaway/delivery bill
and listed per-item packaging as out of scope.

## Goal

Restaurants can charge packaging per item on takeaway and delivery bills (for example ₹10 per biryani container, ₹5
per curry box), on top of or instead of the flat per-bill amount. The person refunding a bill decides whether the
packaging of refunded items is refunded, because that depends on when the order was cancelled.

## Decisions (agreed with the user, 2026-11-06)

- **Adds to the flat charge, behind a toggle.** Bill settings gets "Charge packaging per item". When on, a bill's
  packaging = flat per-bill amount + the sum of item packaging. When off, item amounts are kept in the catalog but
  ignored. Restaurants that never turn it on see no change.
- **Set on the product, with a variant override.** A variant with no amount uses its product's amount.
- **One "Packaging" line on the bill**, with the combined amount. No per-item breakdown on receipts.
- **Combos** use the combo's own amount; the items inside a combo add nothing.
- **Refunds: the cashier chooses**, with a "Refund packaging" tickbox that is ticked by default.

### Cancellation situations

| Situation | In MasalaPOS | Packaging |
|---|---|---|
| Customer cancels before preparation | Usually before billing: the cashier cancels the items on the open order, so they are never billed. If already billed (prepaid takeaway): refund, box ticked | Not charged, or refunded |
| Cancels after preparation, before packing | Refund, box ticked | Refunded |
| Cancels after packing | Refund, box unticked | Kept |
| Cancels after dispatch | Refund; the cashier ticks or unticks by the restaurant's terms | Cashier's choice |
| Restaurant cancels | Void the bill (credits every charge), or refund with the box ticked | Refunded |
| Zomato order | Zomato bills never carry packaging | — |

## Settings

| Setting | Column | Rule |
|---|---|---|
| Charge packaging per item | `settings.packaging_per_item INTEGER NOT NULL DEFAULT 0 CHECK (packaging_per_item IN (0, 1))` | Off by default |

The existing `packaging_charge_paise` (flat per bill) and `packaging_charge_label` are unchanged. The toggle sits under
the flat packaging field in Bill settings.

## Catalog

| Column | Rule |
|---|---|
| `products.packaging_paise INTEGER NOT NULL DEFAULT 0 CHECK (packaging_paise BETWEEN 0 AND 100000)` | ₹0–₹1,000 per unit |
| `variants.packaging_paise INTEGER CHECK (packaging_paise IS NULL OR packaging_paise BETWEEN 0 AND 100000)` | NULL = use the product's amount |

- Product editor: a "Packaging ₹" field on the product (combos included) and an optional one on each variant
  ("Same as item" when blank). The fields show only while the toggle is on.
- Catalog schemas (`packages/domain/src/catalog-schemas.ts`) validate the amounts.
- Catalog CSV export/import (`packages/domain/src/catalog-csv.ts`) and catalog transfer
  (`apps/server/src/catalog-transfer.ts`) carry a `packaging` column for product and variant rows. A blank variant cell
  means NULL.

## Calculation

In `priceOrder` (`apps/server/src/billing.ts`), read at bill time like the flat amount:

- Only takeaway and delivery parcel orders get packaging, as in Phase 4. Dine-in and Zomato never do.
- With the toggle on, each top-level line (no `parent_item_id`) has
  `linePackaging = (variant.packaging_paise ?? product.packaging_paise) × qty`. With it off, every line is 0.
- Bill packaging amount = `packaging_charge_paise` + Σ `linePackaging`. It is passed to `calculateBill` as the single
  existing `{ kind: "packaging", amountPaise }` charge, so GST mode, default GST rate, rounding, tax groups,
  `bills.charges_paise` and the preview fingerprint all work as in Phase 4. Discounts never reduce packaging.
- A charge of 0 is handled as today (no charge line).
- Each line's `linePackaging` is stored on the bill line (`bill_report_lines.packaging_paise`, 0 for combo children and
  dine-in). The flat part of a bill = the charge amount − Σ line packaging.

## Refunds and voids

### Refund dialog

`apps/ui/src/screens/CreditNoteDialog.tsx` gets a **"Refund packaging"** tickbox, ticked by default. It shows only when
the selected items carry packaging, or when the refund clears the bill and flat packaging is still uncredited. The
preview updates when it changes. The request schema gains `refundPackaging: boolean`, default `true`.

### Credit math

In `packages/domain/src/credit-notes.ts`:

- `BillLine` gains `packagingPaise` (the stored line packaging).
- Packaging credit amount:
  - ticked: Σ over refunded lines of the cumulative difference
    `proportion(line.packagingPaise, before + q, line.qty) − proportion(line.packagingPaise, before, line.qty)`, where
    `before` is the units of that line already credited. The shares of a line's units always sum to its packaging, with
    no per-line credit history to store. Plus the flat part when the refund clears every remaining item;
  - unticked: 0.
- The credit amount is capped at the packaging still uncredited. Its taxable value, CGST, SGST and rounding are the
  packaging line's values in proportion to the amount. The credit that brings the uncredited amount to 0 takes the
  exact remainder of each field, so a bill's credits always sum to the bill.
- A packaging credit of 0 adds no charge row.
- **Void** (`voidRemainder`) credits all uncredited packaging, whether or not earlier refunds kept it.
- **Service charge is unchanged:** credited whole, only by a refund that clears the bill or by a void.
- `creditedKinds: ChargeKind[]` is replaced by credited amount per kind (`Partial<Record<ChargeKind, Money & { amountPaise }>>`),
  read from `credit_note_charges`.
- A bill whose items are all refunded but whose packaging was kept stays "Partly refunded", and the kept packaging
  stays in sales and GST.

### Storage

- `credit_note_charges.amount_paise INTEGER NOT NULL DEFAULT 0`: the charge amount (before GST under `exclusive`) this
  note credited. Migration 61 backfills existing rows from `bill_charges.amount_paise` (all were whole-charge credits).
- `apps/server/src/operational-reports.ts:109` reads `cc.amount_paise` instead of joining `bill_charges.amount_paise`.
- Sales, day-end and GST reports sum `credit_note_charges` totals and `credit_note_taxes`, so partial credits flow
  through unchanged. The credit-note print and the bill's credit-note list already show `charges[]` with the credited
  total.

## Migration 61

One migration (`per_item_packaging`):

- `settings.packaging_per_item`
- `products.packaging_paise`, `variants.packaging_paise`
- `bill_report_lines.packaging_paise INTEGER NOT NULL DEFAULT 0`
- `credit_note_charges.amount_paise` with the backfill

## Tests

- **Domain:** per-item + flat sum under `included`, `exclusive` and `none`; a variant overrides its product and a blank
  variant falls back; combo children add nothing; toggle off ignores item amounts; partial refund ticked credits that
  item's packaging; unticked credits none; several partial credits plus a void sum exactly to the bill's packaging line
  (taxable, CGST, SGST, rounding); void after an unticked refund credits the rest; service charge unchanged.
- **Server:** takeaway and delivery bills include item packaging and dine-in/Zomato don't; `bill_report_lines` stores
  line packaging; refund with `refundPackaging: false` keeps it; migration backfill; CSV export/import round-trip with
  variant blanks; operational report and GSTR-1 totals after a partial packaging credit.
- **UI:** the tickbox shows and hides correctly and changes the preview; the Product editor packaging fields show only
  when the toggle is on.

## Verification

- `npm test` (domain, server, UI vitest) and root typecheck green.
- Dev app (`npm run dev`, admin / demo1234): turn the toggle on, set item and variant amounts, bill a takeaway order,
  check the thermal print job, the A4 receipt and the digital bill; refund one item with the box ticked and another
  with it unticked, then void; check the day report and GSTR-1. Stop the dev server by PID afterwards.

## Out of scope

- A per-item breakdown of packaging on the receipt.
- Packaging amounts by category.
- Different packaging amounts for takeaway and delivery.
- Packaging on Zomato bills, and on dine-in.
- A refund of only the remaining packaging, with no items (a void covers it).
