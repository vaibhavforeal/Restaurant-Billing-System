# Offers and BOGO — design

Date: 2026-11-08 · Branch: `feat/offers` (from `origin/main` at `b6abaaa`) · Migration: 63

## Why

Billingko applies promotions automatically: buy-one-get-one, buy X get Y, a minimum bill amount, days of
the week, a date range and order types. MasalaPOS has manual discounts only, so a cashier works out every
deal by hand. See `docs/research/2026-11-07-billingko-comparison.md` (gap 2).

**Success:** an admin sets up an offer once ("Buy 1 Get 1 on pizzas", "20% off beverages",
"10% off above ₹500 on weekdays") and it applies to matching bills automatically. The cashier sees each
applied offer in the bill preview and can remove one. Item and category reports, refunds and GST rows
show each offer's money on the lines it came from, in whole paise.

**Split of work:** as with item add-ons, the backend (domain, server, printing) is built in this branch. All
web UI (Offers screen, billing panel, reports, day end) is handed to Codex, which builds against the API below.

## Decisions (agreed with the owner)

1. **Automatic, cashier can remove.** Matching offers apply by themselves in the bill preview. The
   cashier can remove an offer from this bill and restore it.
2. **Four kinds in v1:** Buy X get Y free, Buy X get Y at % off, % or ₹ off items or categories, and
   % or ₹ off the bill above a minimum.
3. **Conditions:** a date range, days of the week with a time window, and order types. All optional.
4. **Stacking:** item offers combine, but each item unit counts toward one item offer only. After them, at
   most one bill offer applies (the best). Manual, customer-type and points discounts still apply after
   offers.
5. **On the lines they came from.** An offer's discount goes on the lines that earned it, not spread over
   the whole bill.
6. **Single item set.** Buy X get Y draws buy and reward units from the same set. "Buy a pizza, get a Coke
   free" (a separate reward set) is out of v1.
7. **Marketplace module `offers`**, group `addon`, included in Basic and Pro by default.

## Offer definition

| Field | Meaning |
|---|---|
| `name` | Printed on the bill, e.g. "BOGO Pizza". 1–40 characters. |
| `active` | On/off switch. |
| `kind` | `buy_get`, `item_off` or `bill_off`. |
| `buyQty`, `getQty` | `buy_get` only: 1–20 each. |
| `sameItemOnly` | `buy_get` only: units must share product and variant. |
| `percentBp` | Basis points, 1–10000. `buy_get`: the reward units' discount (10000 = free). `item_off` / `bill_off`: the percent off, when `amountPaise` is not set. |
| `amountPaise` | `item_off`: ₹ off each unit. `bill_off`: ₹ off the bill. Exactly one of `percentBp` and `amountPaise` is set for these two kinds. |
| `minBillPaise` | `bill_off` only: the item total (after item offers) must be at least this. 0 means no minimum. |
| `maxDiscountPaise` | `bill_off` with a percent only: optional cap. |
| `targets` | `buy_get` and `item_off`: at least one category or product. A product covers all its variants. `bill_off` has none. |
| `validFrom`, `validUntil` | Optional local dates (`YYYY-MM-DD`), inclusive. `validFrom ≤ validUntil`. |
| `days` | Days of the week it runs (Mon–Sun). Default all seven. At least one. |
| `timeFrom`, `timeUntil` | Optional local minutes from midnight. Both set or both empty; not equal. `timeFrom > timeUntil` crosses midnight (22:00–02:00). The day and date checks use the day the window started, so 01:00 Saturday belongs to a Friday 22:00–02:00 window. |
| `orderTypeIds` | Optional list of the restaurant's order types. Empty means all. Aggregator (Zomato) types can't be picked. |

An offer that is on one or more bills can be switched off but not deleted. An unused offer can be deleted.
Editing an offer never changes issued bills: each bill freezes the offer's name and amounts.

## Matching (`packages/domain/src/offers.ts`)

`applyOffers(lines, offers, context)` is a pure function with no database access.

- **`lines`**: billed lines (combo contents excluded; a combo line counts as its own product; add-on lines
  are ordinary lines), each `{ id, productId, variantId, categoryId, pricePaise, qty }`, in order-item order.
- **`context`**: `{ localDate, weekday, minutes, orderTypeId, orderTypeKind, removedOfferIds }`.
- **Result**: `{ lines: Map<lineId, offerDiscountPaise>, applied: Array<{ offerId, name, discountPaise, perLine: Array<{ lineId, discountPaise }> }> }`.

Steps:

1. **Eligible offers.** An offer is eligible when it is active, not in `removedOfferIds`, within its dates,
   on an allowed day and time, and allowed for the order type. An `aggregator` order type gets no offers.
2. **Units.** Each line is split into `qty` units of `pricePaise`, ordered by price high to low and then by
   line order. A unit is **free** until an offer uses it.
3. **Item offers, greedy.** Work out every eligible `buy_get` and `item_off` offer on the free units in its
   item set. Apply the one with the largest saving and mark its used units. Repeat until no item offer
   saves anything. Ties go to the earlier-created offer.
   - **`buy_get`** on `n` free units in the set (per product and variant when `sameItemOnly` is on):
     `k = ⌊n / (buyQty + getQty)⌋`. The **reward units** are the `k × getQty` cheapest. The **buy units**
     are the next `k × buyQty` cheapest, which leaves the dearest units free for other offers. Saving =
     Σ reward unit price × `percentBp` / 10000, rounded half up per unit. Used = reward + buy units.
   - **`item_off`**: every free unit in the set. Per unit: percent → price × bp / 10000 rounded half up;
     amount → `min(amountPaise, price)`. Used = those units.
4. **Bill offer.** `remaining` = item subtotal − item-offer discounts. Each eligible `bill_off` offer with
   `remaining ≥ minBillPaise` saves: percent → `remaining × bp / 10000` rounded half up, capped by
   `maxDiscountPaise`; amount → `min(amountPaise, remaining)`. The largest saving applies (ties: earlier
   created). Its discount is spread over the lines by their value after item offers (`allocatePaise`).
5. **Per-line totals.** A line's `offerDiscountPaise` is the sum of its units' item-offer discounts plus
   its share of the bill offer. It never exceeds the line's amount.

### Worked example (the main test)

Lines: Margherita ₹299 × 2, Farmhouse ₹349 × 1, Coke ₹60 × 2. Offers: "BOGO Pizza" (`buy_get` 1+1,
100%, category Pizzas), "Cool Drinks" (`item_off` 20%, category Beverages), "Big Bill" (`bill_off` 10%,
min ₹500, cap ₹150).

- BOGO: pizza units 349, 299, 299 → k = 1 → reward 299 (Margherita), buy 299 (Margherita). Saving ₹299.00.
  The Farmhouse unit stays free.
- Cool Drinks: 2 × 20% of ₹60 = ₹24.00. BOGO is applied first (bigger saving), then Cool Drinks.
- Remaining = 1067.00 − 299.00 − 24.00 = ₹744.00 ≥ ₹500 → Big Bill ₹74.40 (under the cap), spread on
  299.00 / 349.00 / 96.00 → 29.90 / 34.90 / 9.60.
- Line offer discounts: Margherita ₹328.90, Farmhouse ₹34.90, Coke ₹33.60. Total offers ₹397.40.

## Bill maths

- `calculateBill` items gain an optional `offerDiscountPaise` (0 to the line amount). Each GST rate group
  is worked out on its amount less its lines' offer discounts. The `discountPaise` argument (manual + slab
  + points) is then spread over those reduced group amounts as it is today, and must not exceed
  subtotal − offer discounts ("The discounts are more than the bill").
- `BillTotals` gains `offerDiscountPaise`. **`discountPaise` becomes the total of all discounts**, offers
  included, so every report that reads `bills.discount_paise` keeps showing the full discount.
- The service charge stays a percent of subtotal − all discounts.
- `priceOrder` (server) loads the eligible offers (skipped when the `offers` module is off or the order is
  Zomato) and calls `applyOffers` first. The customer-type slab and points cap are then worked out on
  subtotal − offer discounts. The cashier's discount limit still covers only the manual discount, measured
  against the subtotal as now.
- `BillPreview` gains `removedOfferIds: string[]` (default `[]`, max 50). The preview fingerprint includes
  the applied offers, so an offer that starts or ends between preview and issue gives the usual "bill
  changed" error and the cashier reviews again.
- The preview response gains `offers: Array<{ offerId, name, discountPaise }>` (applied) and
  `removedOffers: Array<{ offerId, name }>` (eligible but removed by the cashier).

## Storage (migration 63)

- `offers` (id, name, active, kind, buy_qty, get_qty, same_item_only, percent_bp, amount_paise,
  min_bill_paise, max_discount_paise, valid_from, valid_until, days_mask, time_from, time_until,
  created_at, updated_at) with CHECK constraints matching the table above.
- `offer_targets` (offer_id, category_id or product_id; exactly one set).
- `offer_order_types` (offer_id, order_type_id).
- `bills.offer_discount_paise` INTEGER NOT NULL DEFAULT 0.
- `bill_offers` (bill_id, offer_id, name, discount_paise): one row per applied offer.
- `bill_offer_lines` (bill_id, order_item_id, offer_id, discount_paise): where each offer's money went.

## Report lines, refunds, GST

- `saveReportLines` puts each line's offer discount (from `bill_offer_lines`) on it first and spreads the
  rest of the rate group's discount by value after offers, as today. The checks that lines add up to the
  bill stay as they are.
- Credit notes already credit from stored lines, so refunding a free unit credits its share of the line
  (a BOGO line of 2 units with ₹299 off credits ₹149.50 per unit returned). No credit-note change beyond
  tests.
- GSTR-1, 3B and CMP-08 read `bill_taxes`, which already reflect offers. No change.
- Staff activity's "discounts given" must leave out `offer_discount_paise`, so offers are not counted as a
  staff member's choice. (The plan checks how it treats the customer-type and points parts today and
  matches that.)

## Receipt

`ReceiptSnapshot` gains optional `offers: Array<{ name, discountPaise }>`. Printed (thermal and PDF)
between Subtotal and Discount:

```
Subtotal                 1,067.00
Offer: BOGO Pizza         -299.00
Offer: Cool Drinks         -24.00
Offer: Big Bill            -74.40
Discount (Regular 5%)      -33.48
```

(The worked example's bill, with a Regular customer's 5% slab on the ₹669.60 left.)

The Discount line shows `discountPaise − offerDiscountPaise` and is hidden when that is 0. Bills from
before this have no `offers` and print as before.

## Screens

- **Settings → Menu → Offers** (`catalog.manage`, `offers` module on). The list shows each offer's on/off
  switch, a summary ("Buy 1 get 1 free · Pizzas · Mon–Thu 15:00–18:00 · Dine-in") and its bills in the last
  30 days. The form picks the kind first, then shows only that kind's fields, the item set picker
  (categories and products, as in add-on groups) and the conditions. Delete is offered only for unused
  offers.
- **Billing panel.** Applied offers are listed above the discount box ("BOGO Pizza −₹299.00 ✕"). ✕ moves
  the offer to a "Removed: tap to restore" row. The panel sends `removedOfferIds` with preview and create.
- **Sales reports → Offers.** For a date range: each offer's bills and total discount, from `bill_offers`
  (paid and unpaid bills; voided bills excluded).
- **Day end.** "Offer discounts" as its own row within the discounts total.
- **Not changed.** Captain app, QR guest ordering, KOTs.

## API

- `GET /offers`, `POST /offers`, `PUT /offers/:id`, `PATCH /offers/:id/active`, `DELETE /offers/:id`
  (409 when used). Writes need `catalog.manage`, GET needs `catalog.read`; all need the `offers` module.
- `GET /reports/offers?from&to` (`reports.read`, `reports` and `offers` modules).
- Bill preview and create accept `removedOfferIds`.

## Module

`MODULE_IDS` gains `offers` (group `addon`, no dependencies, Basic and Pro true). Licences issued before
this have no `offers` key and get the plan default, as with `dynamicReports`. When off: no offers apply,
the screen and report hide, the API answers 403, and offers already on issued bills still print.

## Testing

- **Domain `offers.test.ts`:** each kind; percent and amount; `sameItemOnly`; k = 0; reward ties between
  lines; greedy order and tie-break; one offer per unit; bill offer minimum and cap; best bill offer;
  dates, days, the cross-midnight window (the 01:00 Saturday case); order types and aggregator; removed
  offers; the worked example to the paisa.
- **Domain `billing.test.ts`:** offer discounts per GST rate; bill discount on top of offers; the error
  when discounts exceed the bill; exclusive and included modes; service charge after offers.
- **Domain report lines:** offer discounts land on their lines; lines add up to the bill.
- **Server:** preview and issue with offers; removal and restore; fingerprint change across a time
  boundary; module off; Zomato gets none; slab and points on the reduced amount; discount cap ignores
  offers; refund of a BOGO line; delete refused when used; offer CRUD validation.
- **Print:** receipt with offers in Classic and the other styles; an old bill without `offers`.
- **UI:** offer form rules (fields per kind, validation messages); billing panel remove and restore.

## Out of scope

Separate reward set (buy A get B), customer-type targeting, coupon codes, usage limits per customer or
per day, offers on Zomato orders, offers in the captain app or QR menu preview, and variant-level targets.
