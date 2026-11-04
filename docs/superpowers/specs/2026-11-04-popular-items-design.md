# Popular items per category (first "smart menu" feature) + roadmap

## Context
The owner wants an AI-style feature: the menu should point out the item each category sells most, so waiters and guests find best-sellers quickly. It should be the first of several "smart" features. MasalaPOS works offline on the restaurant's own network, so this is worked out from the restaurant's own sales on the hub, with no cloud model, no internet and no per-use cost.

Agreed so far:
- The top item in each category gets a **"Popular" badge** and **moves to the front** of that category's items. The rest keep their current A–Z order.
- The ranking uses quantity sold over the **last 30 days, all day** (it does not change with the time of day).
- It shows on the **waiter (Captain) screen and the QR guest menu**. The cashier POS and Quick Takeaway use the same screen as Captain, so they show it too at no extra cost. A settings toggle can turn it off.

## Ranking rules (one shared function)
New `packages/domain/src/menu-insights.ts`, exporting `popularProductIds(db, now, opts?)`. It returns `string[]` with at most one product per category.

- **Source:** reuse the `lineEntries` pattern from `apps/server/src/order-analytics.ts:24-30`.
  - Billed quantity comes from `bill_report_lines`, joined to `bills` and filtered on `b.created_at`, which is indexed.
  - Lines inside combos are left out (`parent_order_item_id IS NULL`).
  - Credit-note lines subtract.
  - Cancelled items never reach report lines, so they are already excluded.
- **Grouping:** by `product_id`, with variants added together.
- **Category:** the product's **current** category, via a join to `products` (not the category name stored on the line). Moving a dish to another category takes its popularity with it.
- **Eligibility:** the product and its category are active, and the product is not sold out. If the top item is sold out, the next one gets the badge.
- **Minimum:** at least **3** sold in the window, so a new restaurant doesn't see random badges. Categories with fewer than 2 active items get no badge, because there is nothing to choose between.
- **Ties:** higher net revenue first, then name, then id, so the result is the same every time.
- **Window:** `now - 30 days`, using the epoch-ms bounds like `reportRange`. Settings for days, per-category count and minimum quantity are constants with defaults, so they can be changed later without a schema change.

## Server
- **Staff endpoint:** new `apps/server/src/menu-insights.ts` adds `GET /api/menu/insights`.
  - Permission: `orders.read`, the same as `/api/order-settings`. Response is sent with `no-store`.
  - Returns `{ popularProductIds: string[] }`, or an empty list when the toggle is off.
  - The response is an object so later signals (pairings, time-of-day) can be added as new fields.
  - Registered next to the other routes in `server.ts` (around :131).
- **No cache:** the guest menu loads once per visit and the query is small and indexed; a cache would also have to be cleared whenever an item goes sold out.
- **Guest menu:** `menu()` in `apps/server/src/guest-ordering.ts:104-126` adds `popularProductIds` at the top level of the response.
  - The ids are kept **out of `pricing`** and so out of `menuVersion`. A change in popularity must not trigger the guest's "menu changed, review and resubmit" message.
  - Add the field to the `GuestMenu` type in the domain package.
- **Toggle:** follows the hold-orders pattern step by step.
  - New migration `packages/domain/src/migrations/popular-items.ts` (version 46; 44 is taken on `feat/dynamic-reports`) adds `settings.popular_items_enabled INTEGER NOT NULL DEFAULT 1 CHECK (... IN (0,1))`, and is listed in `migrations/index.ts`.
  - `settings-schemas.ts`: `popularItemsEnabled`.
  - `apps/server/src/settings.ts`: the SELECT, the mapping and the `COALESCE` update.
  - Helper `popularItemsEnabled(db)`.

## UI
- **Shared ordering logic:** new `apps/ui/src/popular-items.ts` with the pure function `withPopularFirst(products, popularIds)`.
  - It is a stable partition: popular products first, the rest in their existing order.
  - It is used for both one category and "All items". In "All items", each category's best-seller ends up at the front.
- **Staff screen, `apps/ui/src/screens/OrderScreen.tsx`:**
  - Fetch `/api/menu/insights` in `reload()` (:199-225), separately from the existing `Promise.all`, so a failure here never breaks loading the order. On failure the list is empty.
  - Keep the last list in its own offline copy (`saveMenuInsightsCopy` / `readMenuInsightsCopy` in `offline-cache.ts`), so the offline view keeps its badges.
  - Apply `withPopularFirst` to `activeProducts` (:643).
  - In `.menu-card-top` (:756), next to the VEG/Sold-out labels, show a "Popular" badge on every variant card of a popular product.
  - Refetch on the existing `catalog.changed` WebSocket event (:252).
- **Badge style:** `apps/ui/src/order-screen.css`, using the existing label tokens and colours. No new palette.
- **Guest menu, `apps/ui/src/screens/GuestMenu.tsx`:** read `popularProductIds` from `/api/guest/menu` (:127), apply the same `withPopularFirst` to the filtered list (:316) and render the same badge. The guest menu CSS may need its own badge rule.
- **Settings, `apps/ui/src/screens/Settings.tsx`:** add a "Show popular items on the menu" checkbox with an `InfoTip`, placed like Hold orders (:309-313). Add the default (:21) and the type in `types.ts`.

## Tests (TDD, written before the code)
- **Domain, `menu-insights.test.ts`** (`openDb(":memory:")` + `migrate`):
  - the top product per category is chosen;
  - variants are added together;
  - credit notes subtract;
  - combo child lines are ignored;
  - bills older than 30 days are ignored;
  - the minimum of 3 is enforced;
  - a sold-out or inactive top item is skipped, and the next one gets the badge;
  - categories with one item get no badge;
  - ties break by revenue, then name;
  - a moved product counts in its new category.
- **Migration test:** `popular-items.test.ts` (the default is 1).
- **Server, `menu-insights.test.ts`** (`freshApp`, `app.inject`):
  - the endpoint needs `orders.read`, and the toggle off returns an empty list;
  - the guest menu includes `popularProductIds`;
  - `menuVersion` stays the same when only popularity changes;
  - the setting saves and reads back.
- **UI, `popular-items.test.ts`:** the stable partition and "All items" behaviour.
- **E2E:**
  - `tools/e2e/popular-items-server.mts` (own port, e.g. 4155) seeds billed sales, starting from `order-analytics-server.mts`.
  - `popular-items.js` checks the badge and front position on the Captain order screen and on the QR guest menu.
  - Document the new check in `tools/e2e/README.md`.

## Branch
Create `feat/popular-items` from the current `feat/hold-order-and-table-view`, because it needs migration 45 (hold orders) to come before 46. If this branch is later rebased onto main, migration numbers will need checking at that point.

## Verification
1. `npm test`: all vitest suites pass, including the new domain, server and UI tests.
2. Root typecheck.
3. Build the UI (`apps/ui/dist`), then run the popular-items e2e fixture plus the browser script. The result should be `passed`.
4. Manual check with `npm run dev` (admin PIN 1234):
   - Bill a few orders, then open a new order. The best-seller in each category shows "Popular" at the front.
   - Open a table's QR menu: same result.
   - Turn the setting off: the badges disappear on both.
   - Afterwards, stop the dev server by PID (:4100 and Vite).

## Roadmap: more smart features on the same base
Each one is a new field on `/api/menu/insights` (and on the guest menu where it makes sense), worked out locally from `bill_report_lines`:
1. **Time-of-day popular:** rank by sales in the current meal period (breakfast, lunch, snacks, dinner) over the last 30 days. This uses the same function with an hour filter.
2. **"Often ordered together":** when a dish is added to the cart, suggest 1–2 dishes that appear on the same bills. This is pair counts over `bill_id` and is the strongest upsell feature for both waiters and guests.
3. **Customer's usual:** when a phone number is entered on an order, offer their last or most frequent items.
4. **Menu engineering report:** sorts items into four groups by quantity and margin: Stars (sell well, good margin), Plowhorses (sell well, low margin), Puzzles (good margin, sell little) and Dogs (low margin, sell little). This points to items to remove, re-price or promote.
5. **Prep forecast:** expected quantity per item for tomorrow, from a day-of-week moving average, as a kitchen prep list.
6. **Unusual activity alerts:** spikes in cancellations, voids or discounts by a staff member.
7. **Optional cloud AI add-on (later, needs internet and an API key):** ask questions about sales in plain English, an end-of-day summary written for the owner, and menu descriptions written for the QR menu. It would be built as an add-on module like Dynamic Reports, so offline restaurants are not affected.

## Built next: Ordered together (roadmap item 2)
Approved in chat on 2026-11-04.
- **Ranking:** `orderedTogether(db, now)` in `packages/domain/src/menu-insights.ts`.
  - For each dish, it lists up to 5 dishes from **other categories** that share at least **3 bills** in the last 30 days. Each bill counts once per pair, and items inside combos don't count.
  - Partners must be active, in stock, in an active category, and not combos.
  - A partner with sizes is suggested in its most-ordered active size.
  - Credit notes are ignored: a refunded dish was still ordered with the rest.
- **Server:** `/api/menu/insights` and the guest menu add `pairs` (kept out of `menuVersion`). Setting `ordered_together_enabled` is migration 47, on by default; "Suggest dishes ordered together" in Settings.
- **UI:** `apps/ui/src/ordered-together.ts`, function `suggestTogether`.
  - It shows up to 3 dishes, at most one per category.
  - It skips dishes already in the cart and categories already in the cart.
  - Ranking: suggested by more of the cart first, then the better-ranked dish, then partners of the dish added last.
  - Staff screen: a "Goes well with this order" row at the top of the cart footer (one-tap Add).
  - Guest screen: a "Goes well with your order" list above the request's subtotal.
- **E2E:** `tools/e2e/ordered-together.js` on the same fixture as the popular-items check.

## Built next: Popular by time of day (roadmap item 1)
Approved in plan mode on 2026-11-04.
- **Ranking:** `popularProductIds(db, now, { aroundHour: 2 })`.
  - Each category ranks only bills issued within 2 hours either side of now's hour, on the hub's local clock (the same `strftime(..., 'localtime')` hour the reports use).
  - The window wraps past midnight.
  - A category with nothing qualifying in that band falls back to its all-day best-seller.
- **Setting:** "Match the time of day", indented under "Show popular items" and disabled while Popular is off. It is `popular_by_time_enabled`, migration 48, on by default.
- **Server:** `menuPopularIds` applies the setting for both the staff endpoint and the QR menu.
- **Staff screen:** an open order screen re-reads the menu hints every 15 minutes.
- **QR menu:** works out the badge when the guest opens it.
- **E2E:** `tools/e2e/popular-by-time.js` on the same fixture.

## Built next: Customer's usual (roadmap item 3)
Approved in chat on 2026-11-04.
- **Ranking:** `customerUsual(db, customerId, now)` in `packages/domain/src/customer-usual.ts`.
  - It lists dishes on at least 2 of the customer's non-void bills in the last 183 days. Items inside combos don't count.
  - Ranking: most bills first, then the most recent.
  - Only active, in-stock dishes in active categories. Combos are kept.
  - Each dish comes in the customer's most-ordered active size.
- **Last order:** `customerLastOrder(db, customerId)` returns the latest non-void bill's top-level dishes. The same dish and size are added together, in the order first billed.
- **Server:** `GET /api/customers/:id/usual` uses the profile's `customers.read` + CRM guards and is sent `no-store`.
  - It returns `{ dishes, lastOrder }`, or empty while the setting `customer_usual_enabled` (migration 51) is off.
  - The checkbox is "Suggest a customer's usual" in Settings.
- **UI:** `CustomerUsual` under the customer line on the cashier and Quick Takeaway screens. It needs CRM, `customers.read` and an open order.
  - "Usual for Priya" shows up to 4 dishes not already on the order (`usualChips`). Tapping a combo opens the combo chooser.
  - "Repeat last order" uses `repeatPlan` in `apps/ui/src/customer-usual.ts`.
    - It adds the last bill's dishes at today's prices.
    - It names what it skipped: off the menu, sold out, a size gone, a combo whose items must be chosen, or a dish that now has sizes.
  - The order screen's cart-add function has a batch version, `addRowsToDraft`, which Repeat uses.
- **E2E:** `tools/e2e/customer-usual-server.mts` (port 4156) and `customer-usual.js`.
