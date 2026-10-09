# Zomato Desk — Design

**Date:** 9 October 2026
**Status:** Approved in conversation section by section; awaiting written-spec review
**Scope:** Part 1 of 3. Part 2 (accept/reject and the auto/manual accept setting) and part 3 (a live connection through an approved integration provider) get their own specs.

## 1. Goal

Zomato orders are handled at the counter, next to the open takeaways, instead of on a separate report-style page. A cashier punches each Zomato order into the POS using its Zomato order ID. The order uses Zomato prices, sends KOTs to the kitchen, moves through Preparing → Ready → Picked up, and closes on its own as money Zomato owes the restaurant. Reconciliation compares these POS orders with Zomato's payout sheet.

Everything works without Zomato API access. Zomato's direct POS onboarding requires 500 outlets or 50,000 orders a month, 99.999% uptime and a 24×7 on-call channel ([prerequisites](https://www.zomato.com/developer/integration/docs/getting-started/prerequisites)), so a single restaurant cannot connect directly. Prices, statuses and accept/reject are not sent to Zomato in this part.

Success means:

- The Tables & orders panel has a Zomato section listing every open Zomato order, with a **+ New** button and one next-step button per order.
- A Zomato order is created with a required, unique Zomato order ID, priced at Zomato prices, and prints KOTs labelled with that ID.
- **Picked up** creates and settles the bill in one step: no GST is charged, the payment is recorded as Zomato receivable, and nothing prints.
- The cash drawer, cash/UPI/card totals and GST payable are unaffected by Zomato orders.
- Reports → Zomato reconciliation matches POS Zomato orders against the imported payout sheet.

## 2. Decisions

| Topic | Decision |
| --- | --- |
| Order model | New order type `zomato` (approach B). The `orders` table is rebuilt so the `type` and `price_tier` CHECK constraints allow `zomato` |
| Zomato order ID | `orders.zomato_order_id TEXT`, required for `zomato` orders and NULL otherwise. A partial unique index rejects duplicates |
| Local status | `orders.zomato_status TEXT NULL CHECK IN ('preparing','ready','picked_up')`. NULL means new (no KOT yet). Local only; Zomato is not told |
| Payment | The `payments` table is rebuilt so `mode` allows `zomato`, meaning a receivable from Zomato. Only the Picked up close uses it; the cashier payment screen never offers it |
| GST | Zomato collects and pays GST on these supplies under section 9(5). Zomato bills charge no GST and are marked "GST paid by Zomato (section 9(5))". The accountant confirms this before going live |
| Prices | `products.zomato_price_paise` and `variants.zomato_price_paise`, nullable. Fallback: Zomato price → Takeaway price → base price |
| Printing | Only KOTs print. Zomato bills are never printed, automatically or on request; the server refuses `POST /api/bills/:id/print` for them |
| Closing | Picked up = bill + settle as `zomato` in one transaction, idempotent, no discount, no payment screen |
| Credit notes | Refused on Zomato bills; Zomato handles refunds |
| Cancellation | Uses the existing flows. Before any KOT, **Cancel order**. After a KOT, each sent item is cancelled with a reason (cancel slip to the kitchen, its stock returned), then **Cancel order** |
| Reconciliation | POS Zomato orders are the order side. Imported order history fills in only order IDs that are not in the POS. Moves to Reports |
| Old Zomato page | Removed, with its nav link. Connection settings move into the Marketplace Zomato card |
| Who | Cashiers and admins (the quick-billing roles). Waiters and captains do not see the Zomato section |
| Marketplace off | No new Zomato orders; open ones stay visible and can be closed |
| Out of scope | Accept/reject, auto-accept, pushing menu, prices or stock to Zomato, live order relay, customer and rider details, promised times, Swiggy |

## 3. Data model

### Migration 027 — `packages/domain/src/migrations/027-zomato-desk.ts`

Rebuild `orders` and `payments` using the `004-printer-kinds` pattern (`defer_foreign_keys = 1`, create `*_new`, copy, drop, rename), inside the runner's transaction.

- **orders**: all current columns, with:
  - `type CHECK (type IN ('dine_in','parcel','zomato'))`
  - `price_tier CHECK (price_tier IN ('non_ac','ac','takeaway','zomato'))`
  - new `zomato_order_id TEXT` and `zomato_status TEXT CHECK (zomato_status IN ('preparing','ready','picked_up'))`
  - a table CHECK: `zomato_order_id` is set only for `zomato` orders
  - `CREATE UNIQUE INDEX orders_zomato_order_id ON orders(zomato_order_id) WHERE type = 'zomato'`
- **payments**: all current columns, with `mode CHECK (mode IN ('cash','upi','card','zomato'))`.
- **products, variants**: `ALTER TABLE ... ADD COLUMN zomato_price_paise INTEGER CHECK (zomato_price_paise IS NULL OR zomato_price_paise >= 0)`.
- Recreate every index and trigger that existed on `orders` and `payments`. Read them from `sqlite_master` while writing the migration rather than from memory.
- Finish with `PRAGMA foreign_key_check`. Any row fails the migration.

Credit-note refund modes (`025-credit-notes`) stay `cash`/`upi`/`card`.

### Domain — `packages/domain`

- `order-schemas.ts`: `type` enum adds `zomato`. `OrderCreate` adds `zomatoOrderId`, required for `zomato` and refused otherwise. A `zomato` order cannot have a table or a captain. IDs are trimmed, 1–40 characters, letters, digits and `-` only.
- `pricing.ts`: `PriceTier` adds `zomato`, `PRICE_TIER_LABELS.zomato = "Zomato"`. `priceForTier(…, "zomato")` returns Zomato price ?? Takeaway price ?? base price.
- `billing.ts`: the payment `mode` enum used by settle stays `cash`/`upi`/`card`. A separate internal type allows `zomato` for the Picked up close. `calculateBill` takes a tax mode; `"operator"` returns taxable = item value after discount and zero CGST/SGST.
- `catalog-schemas.ts`: `zomatoPricePaise` (optional, nullable) on product and variant create and update.
- `catalog-csv.ts`: `zomato_price` and `variant_zomato_price` columns. Files without them still import.
- `operational-reports.ts` / analytics types: order type `zomato` alongside `parcel` and `dine_in`.

## 4. Server

### Orders — `apps/server/src/orders.ts`, `mappers.ts`

- `POST /api/orders` with `type: "zomato"`:
  - requires `integrationEnabled(db, "zomato")` and the quick-billing role (admin, cashier);
  - sets `price_tier = 'zomato'`;
  - a duplicate `zomato_order_id` returns `409 { code: "zomato_duplicate" }` naming the open or closed order;
  - a repeated `clientRef` still returns the existing order (unchanged).
- `GET /api/orders` already returns open and billed orders. The mapper adds `zomatoOrderId` and `zomatoStatus`.
- Adding items uses `rowPrice(variant ?? product, "zomato")`, so the fallback chain applies.

### Status — new `apps/server/src/zomato-desk.ts`

`POST /api/orders/:id/zomato-status` with body `{ status: "ready" | "picked_up", clientRef }`:

| From | To | Rule |
| --- | --- | --- |
| NULL | `preparing` | Set by the KOT send route when the first KOT goes out, not by this endpoint |
| `preparing` | `ready` | No pending (unsent) items |
| NULL | `ready` | The order has items and none of them needs a kitchen station (for example cold drinks only), so no KOT will ever be sent |
| `ready` | `preparing` | Set by the KOT send route when new items are sent |
| `ready` | `picked_up` | Creates and settles the bill (below) |

Anything else returns `409 { code: "zomato_status" }`. The same `clientRef` replays the earlier result.

**Picked up**, in one transaction:
1. Issue the bill through the existing bill function, with tax mode `"operator"`, no discount, and receipt snapshot `orderType: "zomato"`, `zomatoOrderId`, `gstPaidBy: "zomato"`.
2. Insert one payment: `mode = 'zomato'`, amount = bill total.
3. Mark the order settled and `zomato_status = 'picked_up'`.
4. Do not print or queue a receipt.
5. Broadcast `order.updated`, which the existing settle route already sends.

### KOTs — `apps/server/src/kots.ts`, `print/templates.ts`, `mappers.ts`

- On send for a `zomato` order:
  - NULL or `ready` becomes `preparing`;
  - the slip context line is `ZOMATO #<id>`;
  - the print-job label is `KOT #n — Zomato #<id>`.
- `kotWithContextJson` includes `zomatoOrderId` for the Kitchen Display.
- `POST /api/kots/:id/done`: when every KOT of a `zomato` order is done and nothing is pending, `preparing` becomes `ready`.

### Billing guards — `billing.ts`, `credit-notes.ts`

- Bill preview, bill, discount and settle routes refuse `zomato` orders (`409 { code: "zomato_order" }`). Zomato orders close only through Picked up.
- `POST /api/bills/:id/print` refuses Zomato bills.
- Credit notes on Zomato bills are refused with the message "Zomato handles refunds for Zomato orders".

### Reconciliation — `apps/server/src/zomato.ts`

`reconciliation()` builds the order side from:
1. POS `zomato` orders in the period, whether settled or cancelled. The value is the bill total; a cancelled order has value 0 and status `cancelled`.
2. Imported `zomato_orders` rows whose order ID has no POS order.

A POS-cancelled order with payout entries is `review_cancellation` (already a state). The other checks are unchanged. The order-history import stays available for older dates. The live-order and webhook routes stay untouched for part 3.

### Reports — `order-analytics.ts`, `operational-reports.ts`, day-end

- Analytics accepts `type=zomato`, and the comparison includes it.
- Sales reports keep their existing tables (Zomato bills carry GST 0). A new table, "Aggregator supplies — GST paid by Zomato (section 9(5))", lists Zomato bills and their values for the period.
- Day-end adds a "Zomato receivable (outstanding)" line from `zomato` payments. It is excluded from expected drawer cash and from the cash, UPI and card totals.
- Day-end keeps Zomato bills out of the GST breakdown and net taxable value, and shows their value on one line, "Supplies under section 9(5) (GST paid by Zomato)". The day-end CSV carries both lines. The sales report shows the Zomato receivable beside collections.

## 5. Frontend

### Tables & orders — `screens/Tables.tsx`, a new `ZomatoPanel.tsx`, `zomato-desk.ts` (model)

- The right-hand panel shows Open takeaways (parcels), then a **Zomato** section with a count and **+ New**. Shown to admins and cashiers when Zomato is on, or when any Zomato order is open.
- **+ New** opens a dialog asking for the Zomato order ID. On success the order screen opens. A duplicate ID shows the server message and a link to that order.
- Each card shows:
  - `#<zomato id>`
  - minutes since it was opened
  - the item total
  - a status pill
  - one action: **Add items** (new), **Ready** (preparing), or **Picked up** (ready, with a one-line confirm)
- Cards are ordered oldest first.
- The narrow-screen pane switch gains **Zomato · n**.
- The panel refreshes on the existing `order.updated` websocket event and the 30-second reload.

### Order screen — `screens/OrderScreen.tsx`, `BillingPanel.tsx`

- The header reads **Zomato #5821**. The menu shows Zomato prices (`priceForTier`).
- For `zomato` orders, the bill, discount and payment controls are replaced by the current status and the same next-step button as the card.
- Send KOT and Cancel order work as for takeaways.

### Kitchen Display — `screens/Kitchen.tsx`

The ticket context shows `Zomato #5821` with a Zomato colour tag instead of "Parcel".

### Bills — `screens/Bills.tsx`

Zomato bills show "Zomato #id" and "GST paid by Zomato". Print, Reprint and Credit note are hidden.

### Prices — `ProductEditor.tsx`, `Catalog.tsx`, `DishCosting.tsx`

- A Zomato price input after Takeaway, with the hint "blank = Takeaway price"; the same for variants.
- Catalog shows the Zomato price column, and Dish Costing a Zomato tier, while Zomato is on.

### Reports, dashboard, Marketplace

- **Reports → Zomato reconciliation:** the current reconciliation tab, payout import, order-history import and history, moved out of `screens/Zomato.tsx`.
- **Dashboard:**
  - a Zomato channel card next to Dine-in and Takeaway;
  - a third slot-chart series while Zomato is on (`slotBars`, `slotScale` and `perBarLabelsFit` take the extra bar);
  - the Alerts panel lists open POS Zomato orders by age (`useAggregatorOrders` reads `GET /api/orders`).
- **Marketplace:** the Zomato card gains **Settings**, which opens the existing connection form.
- `screens/Zomato.tsx`, its route in `App.tsx` and its `NavBar` link are removed.

## 6. Edge cases

- **Zomato turned off with orders open:** no new orders. The panel stays until they close, and status and Picked up still work.
- **Two counters press Picked up together:** the second gets the replayed result for the same `clientRef`, or `409 zomato_status`. Only one bill is created.
- **Items added after Ready:** they must be sent before Ready again. Sending moves the order back to Preparing.
- **Cancelled after KOT:** existing flow. **Cancel order** is hidden while sent items remain, so the cashier cancels each sent item with a reason (the kitchen gets a cancel slip and the stock is returned), then cancels the order. The order still appears in reconciliation, with value 0.
- **Zomato order ID typo:** cancel the order and punch it again. The cancelled ID stays reserved, so the new order needs the correct ID.
- **Licence downgrade or Marketplace off at day-end:** receivables from closed Zomato orders still show on day-end and in reconciliation.
- **Migration on a large database:** the copy is a single INSERT … SELECT per table. The test uses several thousand orders.

## 7. Testing and verification

### Domain
- `priceForTier` fallback for `zomato`.
- `calculateBill` operator mode gives zero GST, and discounts allocate correctly.
- `OrderCreate` refines (ID required, no table or captain, character set).
- CSV round trip with and without the Zomato columns.

### Migration (`027-zomato-desk.test.ts`)
- Build a v26 database with orders, items, KOTs, bills, payments, credit notes, reservations, transfers and guest requests. Migrate and check that every row, every index and `foreign_key_check` survive.
- Duplicate `zomato_order_id` is rejected, and a non-zomato order with an ID is rejected.

### Server (in-memory)
- Create, duplicate ID, Marketplace off and role checks.
- Zomato pricing on items.
- KOT send sets Preparing; KDS Done on all KOTs sets Ready; new items reset to Preparing.
- Picked up: one bill, GST 0, `zomato` payment, order settled, no print job, idempotent replay, concurrent second call.
- Guards: bill, settle and discount refused; print refused; credit note refused.
- Reconciliation with POS orders, imported history fallback and the cancelled-but-paid case.
- Day-end receivable line; cash/UPI/card totals unchanged.
- Analytics `type=zomato`.

### UI (vitest)
- `zomato-desk.ts`: card action per status, ordering, age label.
- Dashboard data with three series.

### Browser (`tools/e2e/zomato-desk.js`, through the Playwright MCP)
- Punch in → add items → Send KOT → Ready → Picked up.
- Duplicate ID refused.
- Zomato bill not printable.
- Dashboard card, day-end receivable and reconciliation row.

### Gates
`npm run typecheck`, vitest from the repo root (only the 2 known captain-https environment failures allowed), and the existing e2e gates: sales-dashboard, Marketplace, kitchen-app and demo-kitchen.

## 8. Documentation

- `docs/operations`: a "Zomato desk" guide covering punching in, statuses, the GST 9(5) note, reconciliation and Marketplace settings.
- `tools/e2e/README.md`: the new gate.
- The handoff note for parts 2 and 3: accept/reject, the auto/manual accept setting, and a live connection through an integration provider.
