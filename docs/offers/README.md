# Offers and BOGO

Offers are deals the till applies by itself: buy one get one free, 20% off beverages, 10% off a bill above ₹500. An
admin sets an offer up once; every matching bill gets it. The cashier sees each applied offer in the bill preview and can
remove one for that bill. An offer's money is recorded on the bill lines it came from, so item and category reports,
refunds and GST rows stay right to the paisa.

This README is for developers. For how admins and cashiers use the feature, see
[docs/operations/offers.md](../operations/offers.md).

| | |
|---|---|
| Built | 2026-11-08, as gap 2 from the [Billingko comparison](../research/2026-11-07-billingko-comparison.md) |
| Branch / PR | `feat/offers` (no PR yet; the final whole-branch review comes first) |
| Spec | [docs/superpowers/specs/2026-11-08-offers-design.md](../superpowers/specs/2026-11-08-offers-design.md) |
| Plan | [docs/superpowers/plans/2026-11-08-offers.md](../superpowers/plans/2026-11-08-offers.md) |
| Migration | 63 `offers` (the next free number is 64) |
| Module | `offers` (Marketplace add-on, group `addon`), included in Basic and Pro, **off until an admin turns it on** |
| Who built what | Backend (domain, server, printing): Claude. UI phase 1 (Catalog offers list and editor): **Codex**, completed 2026-11-09 on `codex/offers-ui`. Billing controls and reports remain. |

## How it works

Three offer kinds. "Free" is a 100% discount.

| `kind` | Meaning | Fields it uses |
|---|---|---|
| `buy_get` | Buy `buyQty`, get `getQty` more at `percentBp` off (10000 = free), from one item set | `buyQty`, `getQty`, `percentBp`, `sameItemOnly`, item set |
| `item_off` | Percent or amount off every unit of an item set | `percentBp` **or** `amountPaise`, item set |
| `bill_off` | Percent or amount off the whole bill, once item offers are taken | `percentBp` **or** `amountPaise`, `minBillPaise`, `maxDiscountPaise` (percent only) |

Every kind also takes the conditions: `validFrom`/`validUntil` (local dates, inclusive), `days` (0 = Monday to 6 =
Sunday, default all seven), `timeFrom`/`timeUntil` (minutes from midnight, 0 to 1439, both or neither; `timeFrom >
timeUntil` crosses midnight, and 01:00 Saturday belongs to a Friday 22:00 to 02:00 window), and `orderTypeIds` (empty =
every order type; Zomato types can't be picked and Zomato orders never get offers).

**Stacking.** Item offers (`buy_get`, `item_off`) are applied greedily, biggest saving first, ties to the earlier-created
offer. Each unit of an item counts toward one item offer only. Then at most one `bill_off` applies (the best), worked out
on what the items leave. The customer-type slab, loyalty points and the cashier's manual discount come after offers.
`buy_get` discounts the cheapest units; the units bought are the next cheapest, so the dearest stay free for other offers.

### Worked example (the main test)

Margherita ₹299 × 2, Farmhouse ₹349, Coke ₹60 × 2 = ₹1,067.00. Offers: **BOGO Pizza** (`buy_get` 1 + 1, 100%,
category Pizzas), **Cool Drinks** (`item_off` 20%, category Beverages), **Big Bill** (`bill_off` 10%, minimum ₹500, cap ₹150).

| Offer | Discount | Why |
|---|---|---|
| BOGO Pizza | ₹299.00 | Pizza units 349, 299, 299: one Margherita is the reward, the other is the one bought; Farmhouse is left for other offers |
| Cool Drinks | ₹24.00 | 2 × 20% of ₹60 |
| Big Bill | ₹74.40 | 10% of ₹744.00 (under the ₹150 cap), spread over the lines by value left |

Lines carry Margherita ₹328.90, Farmhouse ₹34.90, Coke ₹33.60 (₹397.40 in all). The bill is ₹669.60, rounded to ₹670.00.

## Data model (migration 63)

| Table / column | Purpose |
|---|---|
| `offers` | One row per offer; CHECKs mirror the `OfferInput` rules. `days_mask` bit i = weekday i (0 = Monday) |
| `offer_targets` | The item set: one category **or** one product per row (a product covers all its variants) |
| `offer_order_types` | The order types an offer is limited to; no rows = all |
| `bills.offer_discount_paise` | The part of the bill's discount that came from offers |
| `bill_offers` | One row per applied offer: its name and discount frozen at issue |
| `bill_offer_lines` | Where each offer's money went, by `order_items` line |

`bill_offers` and `bill_offer_lines` are insert-only (triggers refuse UPDATE and DELETE). Editing an offer never changes an
issued bill. Deleting an offer that is on a bill is refused.

## API

All money is integer paise; percents are basis points (1 to 10000). Errors are `{ error, code }`, where `error` is the
message to show; validation failures are `400 { error: "validation", issues: [{ path, message }] }` (the app's
`apiFetch` already shows the first issue's message).

### Offers (`catalog.read` to list, `catalog.manage` to change; all need the `offers` module)

| Endpoint | Body / result |
|---|---|
| `GET /api/offers` | `{ offers: [offer + { bills30d, used }] }`, oldest first, switched-off offers included |
| `POST /api/offers` | An offer without `id` → `201 { offer }` |
| `PUT /api/offers/:id` | **Replaces the whole offer** → `{ offer }`; 404 `offer not found` |
| `PATCH /api/offers/:id/active` | `{ active: boolean }` → `{ offer }` |
| `DELETE /api/offers/:id` | `204`; `409 offer_used` when it is on any bill |

```http
POST /api/offers
{ "name": "BOGO Pizza", "kind": "buy_get", "buyQty": 1, "getQty": 1, "percentBp": 10000, "categoryIds": ["<pizzas>"] }

201 { "offer": { "id": "…", "createdAt": 1762600000000, "name": "BOGO Pizza", "active": true, "kind": "buy_get",
  "buyQty": 1, "getQty": 1, "sameItemOnly": false, "percentBp": 10000, "amountPaise": null,
  "minBillPaise": 0, "maxDiscountPaise": null, "categoryIds": ["<pizzas>"], "productIds": [],
  "validFrom": null, "validUntil": null, "days": [0,1,2,3,4,5,6], "timeFrom": null, "timeUntil": null, "orderTypeIds": [] } }
```

A fuller one (Mon to Thu, 15:00 to 18:00, dine-in, 29 Nov at the latest): `"days": [0,1,2,3], "timeFrom": 900,
"timeUntil": 1080, "orderTypeIds": ["dine_in"], "validUntil": "2026-11-29"`. A bill offer:
`{ "name": "Big Bill", "kind": "bill_off", "percentBp": 1000, "minBillPaise": 50000, "maxDiscountPaise": 15000 }`.

- **Send the whole offer on PUT, `active` included.** Omitted fields fall back to their defaults and `active` defaults to
  `true`, so a form that leaves it out turns a switched-off offer back on.
- `bills30d` counts the offer's bills from the last 30 days, void bills left out. `used` is true when **any** bill, void
  ones included, has it; that is what blocks delete. Show Delete only when `used` is false.
- 400 messages: `Pick categories and items from the menu` (unknown category or item), `Pick order types from the list`
  (unknown order type), `Zomato orders can't have offers` (an aggregator order type). The kind rules (a minimum on an item
  offer, no item set on a bill offer, both a percent and an amount, and so on) come back as `validation` issues with
  plain-English messages, and the `path` names the field.
- **Module off:** the restaurant switching Offers off gives **409** `module_off` on every offers route; a licence that
  leaves Offers out gives **403** `module_off`. A cashier can read offers but not change them; the kitchen role gets 403.
- There is **no `catalog.changed` broadcast** on offer edits. Pricing reads offers on the server at each preview and
  issue, so other counters need nothing; the Offers screen reloads after its own writes.

### Billing

`POST /api/orders/:id/bill-preview` and `POST /api/orders/:id/bill` both accept `removedOfferIds: string[]` (default `[]`,
at most 50): the offers the cashier switched off for this bill. Ids that aren't running on the bill are ignored.

```http
POST /api/orders/:id/bill-preview
{ "discountPaise": 0, "removedOfferIds": ["<bogo>"] }

200 { "preview": { "subtotalPaise": 106700, "offerDiscountPaise": 12830, "discountPaise": 12830, "previewKey": "…", "receipt": { … },
  "offers": [ { "offerId": "<drinks>", "name": "Cool Drinks", "discountPaise": 2400 },
              { "offerId": "<bigBill>", "name": "Big Bill", "discountPaise": 10430 } ],
  "removedOffers": [ { "offerId": "<bogo>", "name": "BOGO Pizza" } ] } }
```

- `offers` lists what applied (item offers by size of saving, then the bill offer). `removedOffers` lists offers that were
  running on the bill but the cashier removed, even one that would have saved nothing. Both are `[]` when none, or when the
  module is off or the order is Zomato.
- **The preview key covers the applied offers.** A create whose offers differ from the preview's (the cashier's removals
  changed, an offer was switched off, a time window closed) is refused with the usual
  `409 Order changed; review a fresh bill preview`. The cashier reviews a fresh preview.
- `discountPaise` (on the preview, the bill, `BillTotals`) is now **the total of all discounts, offers included**.
  `offerDiscountPaise` is the offers' part and is present **only when it is above 0**. The request's `discountPaise` is
  still the cashier's own manual discount, so do not feed the preview's `discountPaise` back into the discount box.
- The cashier's discount limit covers the manual discount only; offers never need an approver PIN. A manual discount
  above what the offers leave gives 400 `The discounts are more than the bill`.
- The slab and loyalty points are worked out on the subtotal less offers.
- Receipt: `bill.receipt.offers` is `[{ name, discountPaise }]`, absent when none. It prints between Subtotal and Discount
  as `Offer: BOGO Pizza  -299.00` (thermal and A4); the Discount line shows only the discount offers don't account for and
  is hidden when that is 0. Bills from before Offers print as they did.

### Reports

| Endpoint | Result |
|---|---|
| `GET /api/reports/offers?from&to` (`reports.read`; `reports` and `offers` modules; same range rules as the sales report, 7 days by default) | `{ rows: [{ offerId, name, bills, discountPaise }] }`, biggest discount first. Paid and unpaid bills; **void bills left out**. The name is the offer's current one |
| `GET /api/reports/day-end?date=` | `sales.offerDiscountPaise`, inside `sales.discountPaise` |
| `GET /api/reports/sales?from&to` | `sales.offerDiscountPaise` and the same on each `daily[].sales` |

Day end and the sales report are gross (void bills included), the Offers report leaves void bills out, so on a day with a
voided bill that had an offer, "Offer discounts" at day end and that day's Offers report won't match. That is expected.
Day-close snapshots saved before this change have no `offerDiscountPaise`, so treat it as optional when reading one.
Staff activity's "discounts given" leaves offers out (they are the owner's choice, not the staff member's).

## UI work for Codex

**Phase 1 is complete:** Catalog → Offers supports create, edit, on/off and deletion of unused offers.
Sections (b)–(d) remain for later sessions. The domain module is importable as `@masalapos/domain/offers`
(`OfferInput`, `Offer`, `OfferInputValue`): run the form through `OfferInput.safeParse` to get the server's exact messages
and field paths without copying the rules.

**Hide all of it when the module is off:** `useIntegrations().isEnabled("offers")` (`apps/ui/src/integrations.tsx`).
Exception worth keeping: show the day-end row whenever its figure is above 0, since past bills' offers stay part of that
day's discount; hide it only when it is 0.

### (a) Offers list and form — complete

They live beside **Add-on groups** on the Catalog screen (`apps/ui/src/screens/Catalog.tsx`, which is already
`catalog.manage` only). The spec says "Settings → Menu → Offers", but Settings has no Menu section; the Catalog page is
where the menu is managed. The owner guide says "Catalog, then Offers"; change it if you put the screen elsewhere.

- **List:** each offer's on/off switch (`PATCH …/active`), a summary, and `bills30d` ("12 bills in 30 days"). Delete only
  when `used` is false; otherwise say "Switch it off instead". Summary format:
  `Buy 1 get 1 free · Pizzas · Mon–Thu 15:00–18:00 · Dine-in` (kind and amount, item set, days and times, order types; leave
  out what is "all"; `Buy 2 get 1 at 50% off`, `20% off · Beverages`, `10% off bills over ₹500, up to ₹150`).
- **Form:** pick the kind first, then show only that kind's fields. Send `null`, `0` or `false` for the fields the chosen kind
  doesn't use: the API rejects a value left over from another kind with a 400 (`buyQty` and `getQty` `null`, `sameItemOnly`
  `false`, `minBillPaise` `0` and `maxDiscountPaise` `null` unless the kind uses them; a form that keeps its state when the
  admin switches kind must reset these on save).
  - `buy_get`: buy qty, get qty (1 to 20), the discount on the free items (percent, default 100% = free), "Same item only".
  - `item_off` and `bill_off`: a percent **or** a ₹ amount, never both. `bill_off` adds Minimum bill (₹, blank = none) and,
    for a percent, Maximum discount (₹).
  - Item set (`buy_get` and `item_off`, at least one; `bill_off` has none): categories and products, reusing the picker in
    `AddonGroupsManager.tsx`. Products only, no variants.
  - Conditions, all optional: date range, days (Monday is `0`), a time window (both times or neither; show "ends next
    morning" when from is after until), order types. Take the order type list from `GET /api/order-types` and leave out
    `kind: "aggregator"`.
  - Name 1 to 40 characters. Percent fields take up to two decimals and are sent as basis points (12.5% = 1250).
  - Save with the **full object** (`POST` or `PUT`), `active` included. Show the API message on a 400.

### (b) Billing panel

In `apps/ui/src/screens/BillingPanel.tsx`: extend the local `Preview` type (about line 29) with
`offers: Array<{ offerId: string; name: string; discountPaise: number }>`, `removedOffers: Array<{ offerId: string; name: string }>`
and the already-typed `offerDiscountPaise?`.

- List the applied offers above the discount box: `BOGO Pizza −₹299.00 ✕`. ✕ puts the offer in a **Removed: tap to
  restore** row; tapping a name there restores it.
- Keep the removed ids in state and send them as `removedOfferIds` on **both** the preview call (about line 210) and the
  create body (about line 216, where `removedOfferIds: []` is a placeholder from the typecheck; replace it). The create
  body is the object the retry queue saves, so a bill issued offline replays with its removals.
- Removing or restoring changes the total, so fetch a fresh preview straight away. The panel clears the preview on any input
  change (the effect at about line 152), so keep the names for the removed row until the new response arrives. `getPreview`
  also saves a takeaway and prompts about held dishes; don't repeat those steps for this re-fetch.
- Reset the removed list when the order changes. A removed id that stops running is ignored by the server.
- `BillSummary`'s Discount row keeps showing `discountPaise` (offers included). Zomato bills close from the Zomato desk
  with no preview, so they show no offers.

### (c) Sales reports → Offers

A tab beside Sales, Collections and Bills in `SalesReports.tsx` (the `presets` list, about line 77), shown when the `offers`
and `reports` modules are on. For a date range: a table of offer, bills and total discount from `GET /api/reports/offers`,
plus a CSV export like the others. Say in the caption that void bills are left out.

### (d) Day end and the sales totals

Add `offerDiscountPaise?: number` to the UI's `Sales` types (`apps/ui/src/report-export.ts` for `DayEndReport.sales`,
`apps/ui/src/sales-report.ts` for `SalesTotals`). In `DayEnd.tsx` show **Offer discounts** as its own row under Discounts
(the Discounts figure already includes it, so label it "of which offers" or list it indented). Add it to the day-end CSV and
the sales exports too. Day-close snapshots from before this change lack the key.

### UI tests (Vitest, as the other screens)

- **Offer form rules:** the fields shown per kind; each validation message and its field; percent to basis points;
  `active` kept on a save; Delete hidden when `used`; no aggregator order types in the picker; the summary text for each
  kind and for the cross-midnight window.
- **Billing panel:** an applied offer appears; ✕ moves it to the Removed row and re-previews with `removedOfferIds`; restoring
  puts it back; the create body carries `removedOfferIds`; nothing shows when `offers` is empty or the module is off.
- Reports: the Offers table, and the day-end row (present above 0, hidden at 0 with the module off).

## Phase 1 handoff (2026-11-09)

- Implemented in `OffersManager.tsx`, `OfferForm.tsx`, `offer-form.ts` and scoped `offers.css`; Catalog mounts the
  manager only while Offers is enabled. Existing inactive selections remain visible and removable.
- The form uses the shared schema, preserves `active` on PUT, and clears incompatible fields from the saved payload.
  A successful save closes the editor even when refreshing fails; Retry loading offers only repeats the read.
- Validation: 232 focused Vitest tests (including the new form/presentation tests), repository typecheck, UI build and
  CSS-isolation check passed. Playwright with installed Edge checked an in-memory restaurant at desktop 1440×1000,
  tablet 820×1180 and mobile 390×844, including light/dark layouts, CRUD, overnight help, failed-save recovery,
  refresh-only retry, used-offer deletion protection, live module gating, duplicate submissions and dirty/busy guards.
  No uncaught application errors; console errors were limited to intentionally injected HTTP failures. Vite retains
  its large-chunk warning. Real tablet hardware and other browser engines were not tested.
- **Next session: section (b), Billing panel.** Add applied/removed offers and re-preview/issue payload handling.
  Sections (c) and (d), reporting and exports, are still pending. No backend or migration changes were needed here.

Focused UI checks: `npx vitest run apps/ui/src/offer-form.test.ts apps/ui/src/offers-ui.test.ts`.

## Code map

| Area | Files |
|---|---|
| Rules and matching (pure) | `packages/domain/src/offers.ts`: `OfferInput`, `offerRuns`, `offerClock`, `applyOffers` |
| Migration | `packages/domain/src/migrations/offers.ts` |
| Bill maths | `packages/domain/src/billing.ts` (`calculateBill` per-line `offerDiscountPaise`, `BillPreview.removedOfferIds`), `report-lines.ts` |
| Offers API | `apps/server/src/offers.ts`: `loadOffers`, `registerOffers` |
| Pricing, preview, issue | `apps/server/src/billing.ts`: `priceOrder`, `orderOffers`, `preview`, `issueBill` |
| Receipt | `apps/server/src/print/receipt.ts` |
| Reports | `apps/server/src/reports.ts` (day end), `sales-reports.ts` (`offersReport`, `GET /api/reports/offers`), `staff-activity.ts` |
| Module | `packages/domain/src/modules.ts`, `integrations.ts` (`offers`) |
| UI phase 1 | `apps/ui/src/screens/OffersManager.tsx`, `OfferForm.tsx`, `Catalog.tsx`, `apps/ui/src/offer-form.ts`, `offers.css`, `offer-form.test.ts`, `offers-ui.test.ts` |
| UI remaining | `apps/ui/src/screens/BillingPanel.tsx`, `SalesReports.tsx`, `DayEnd.tsx`, `sales-report.ts`, `report-export.ts` |

## Tests

```bash
npx vitest run packages/domain/src/offers.test.ts packages/domain/src/migrations/offers.test.ts \
  apps/server/src/offers.test.ts apps/server/src/sales-reports.test.ts
npm test            # 2,382 tests at the last run
npm run typecheck
```

| File | Covers |
|---|---|
| `packages/domain/src/offers.test.ts` | Input rules, clock and eligibility, each kind, overlapping offers and tie-breaks, bill offer minimum and cap, order types, removal, the worked example to the paisa |
| `packages/domain/src/migrations/offers.test.ts` | Columns, CHECKs, calendar dates, immutable bill rows |
| `packages/domain/src/billing.test.ts`, `report-lines.test.ts` | Per-line offer discounts per GST rate, manual discount on top, discounts over the bill, report lines that add up to the bill, a fully free line |
| `apps/server/src/offers.test.ts` | CRUD, validation, permissions, module off and licence off, delete rules, `bills30d` and `used` |
| `apps/server/src/billing.test.ts` (`offers`) | Preview and issue (worked example), remove and restore, stale preview, slab on the reduced amount, discount limit, Zomato, module off, time window, staff activity, day end |
| `apps/server/src/credit-notes.test.ts` (`offers on credit notes`) | Refunding one unit of a BOGO line (₹149.50 of ₹299.00), a full refund of the worked example |
| `apps/server/src/print/receipt.test.ts` (`offer lines`) | Offer lines in thermal and A4, Discount line rule, a bill without offers, long names |
| `apps/server/src/sales-reports.test.ts` (`offers report`) | Counts and sums, void bills out, current name, range rules, access and modules |

## Decisions made while building

These go beyond the spec or adjust it. Each is cheap to change.

1. **`applyOffers` returns `{ lineDiscounts, applied, removed }`** (the spec said `lines`). `offerRuns` also checks `active`.
2. **`removedOffers` lists every running offer the cashier removed**, even one that would have saved nothing on this bill.
3. **A field the kind doesn't use is rejected, not ignored** (a minimum bill, a maximum discount, `sameItemOnly` or a
   buy/get quantity on the wrong kind). Duplicate ids are rejected; at most 200 categories, 200 items and 20 order types.
4. **Module off is 409, licence off is 403** (the spec said 403 for both); both carry `code: "module_off"`.
5. **`bills30d` leaves out void bills; `used` doesn't.** A bill row is kept for good, so any bill blocks delete.
6. **Day end counts void bills' offers; the Offers report doesn't** (see Reports above).
7. **Staff activity leaves out offers;** the customer slab and points are counted as before.
8. **The Offers report shows the offer's current name** with the discount each bill froze; the receipt keeps the name as issued.

## Known limits (out of scope)

- Buy A get B (a separate reward set), customer-type targeting, coupon codes, usage limits, offers on Zomato orders, offers
  in the captain app or QR menu preview, and variant-level targets.
- Issuing a bill prices the order a second time inside the same transaction. A time window that closes in the milliseconds
  between the key check and the write could give a bill slightly different offers from the preview. The customer slab has
  the same pattern; it is very unlikely.
- The captain app, QR guest ordering and KOTs are unchanged.
- Catalog offer management has browser coverage (see phase 1 handoff). Billing removal controls and offers reporting UI
  do not exist yet; real tablet hardware has not been tested.
