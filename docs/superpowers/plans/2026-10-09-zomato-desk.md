# Zomato Desk Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Zomato orders are punched in at the counter as a new `zomato` order type, priced at Zomato prices, sent to the kitchen as KOTs, moved through Preparing → Ready → Picked up, and closed automatically as a GST-free Zomato receivable that is reconciled against Zomato's payout sheet.

**Architecture:** Migration 027 rebuilds `orders` and `payments` to allow the new type, price tier and payment mode, and adds Zomato price columns. A new server module, `zomato-desk.ts`, owns the status route. It reuses bill issue and settle helpers that are first extracted from `billing.ts` without changing behaviour. The UI adds a Zomato section to the Tables & orders side panel, and moves reconciliation into Reports.

**Tech Stack:** TypeScript, Fastify, better-sqlite3, zod, React, vitest, Playwright MCP for e2e.

**Spec:** `docs/superpowers/specs/2026-10-09-zomato-desk-design.md`

## Global Constraints

- Order type values: `dine_in`, `parcel`, `zomato`. Price tiers: `non_ac`, `ac`, `takeaway`, `zomato`. Payment modes: `cash`, `upi`, `card`, `zomato`. Refund modes stay `cash`, `upi`, `card`.
- Zomato status values: `preparing`, `ready`, `picked_up`; NULL means new.
- Zomato order ID: trimmed, 1–40 characters, `/^[A-Za-z0-9-]+$/`, unique among `zomato` orders, cancelled ones included.
- Price fallback: Zomato price ?? Takeaway price ?? base price. A Zomato price of `0` is a real price, not "blank".
- Zomato bills: GST 0 whatever the `tax_inclusive` setting, no discount, never printed, no credit notes.
- Copy, used verbatim: "GST paid by Zomato (section 9(5))", "Zomato receivable (outstanding)", "Zomato handles refunds for Zomato orders", "Aggregator supplies — GST paid by Zomato (section 9(5))", header `Zomato #<id>`, KOT context `ZOMATO #<id>`, print label `KOT #n — Zomato #<id>`.
- Error codes: `zomato_duplicate`, `zomato_status`, `zomato_order` (all HTTP 409).
- Roles: admin and cashier only. Waiters, captains and kitchen staff never see Zomato controls.
- Run vitest from the repo root. Only the 2 known `captain-https` environment failures are allowed.
- **Commits:** the user commits only when asked. Each task ends with a checkpoint that lists the files; do not run `git commit` unless the user says so.
- **Learning mode:** steps marked **USER CONTRIBUTION** are left for the user, with a placeholder and a TODO. Prepare the surrounding code and tests, then hand over.

## Review Focus

1. **A Zomato order whose items have no KOT station** (for example cold drinks) never sends a KOT. New → Ready must be allowed when the order has items and nothing station-bound is pending. Test in Task 5.
2. **A double-tap or two counters pressing Picked up** must create exactly one bill and one payment. Test in Task 5.
3. **Zomato price `0`** must price the item at ₹0, not fall back to Takeaway. Test in Task 1.
4. **The `tax_inclusive` setting is on:** a Zomato bill must still total exactly the item value, with GST 0 and no tax backed out. Test in Task 1 (calculateBill) and Task 5 (route).
5. **Zomato turned off in the Marketplace while orders are open:** Ready and Picked up must still work, and only creating new orders is refused. Test in Task 5.

---

### Task 1: Domain types, pricing and operator tax mode

**Files:**
- Modify: `packages/domain/src/pricing.ts`, `packages/domain/src/billing.ts`, `packages/domain/src/order-schemas.ts`, `packages/domain/src/catalog-schemas.ts`, `packages/domain/src/catalog-csv.ts`, `packages/domain/src/operational-reports.ts`
- Test: `packages/domain/src/pricing.test.ts`, `packages/domain/src/billing.test.ts`, `packages/domain/src/order-schemas.test.ts`, `packages/domain/src/catalog-csv.test.ts` (create or extend, following the existing test files)

**Interfaces:**
- Produces:
  - `PriceTier = "non_ac" | "ac" | "takeaway" | "zomato"`; `PRICE_TIER_LABELS.zomato = "Zomato"`
  - Priced rows gain `zomatoPricePaise?: number | null`. `priceForTier(row, "zomato")` returns `zomatoPricePaise ?? takeawayPricePaise ?? pricePaise`
  - `calculateBill(items, discountPaise = 0, taxInclusive = false, taxMode: "restaurant" | "operator" = "restaurant"): BillTotals`
  - `PayMode = "cash" | "upi" | "card" | "zomato"`. `Bill.payments[].mode: PayMode`. `BillSettle` still accepts only cash/upi/card
  - `ReceiptSnapshot.orderType: "dine_in" | "parcel" | "zomato"`, plus optional `zomatoOrderId?: string` and `gstPaidBy?: "zomato"`
  - `OrderType = "dine_in" | "parcel" | "zomato"`. `OrderCreate` gains `zomatoOrderId?: string`
  - `ZOMATO_ORDER_ID = z.string().trim().min(1).max(40).regex(/^[A-Za-z0-9-]+$/)`, exported from `order-schemas.ts`
  - `ProductCreate`, `ProductUpdate`, `VariantCreate` and `VariantUpdate` gain `zomatoPricePaise: paise.nullable().optional()`
  - CSV columns `zomato_price` and `variant_zomato_price`
  - `AnalyticsOrderType` adds `"zomato"`

- [ ] **Step 1: Write failing tests**
  - `priceForTier({pricePaise:250, takeawayPricePaise:260, zomatoPricePaise:290}, "zomato") === 290`
  - When Zomato is null: 260. When Zomato and Takeaway are null: 250. **When `zomatoPricePaise: 0`: 0.**
  - `calculateBill([{pricePaise:29000, qty:2, gstRate:5}], 0, true, "operator")` gives `cgstPaise 0, sgstPaise 0, totalPaise 58000, taxes[0].taxablePaise 58000`. The same with `taxInclusive=false`.
  - `OrderCreate.parse({clientRef, type:"zomato", zomatoOrderId:" 5821 "}).zomatoOrderId === "5821"`.
  - Rejected: `zomato` without an ID; `zomato` with a `tableId`; `zomato` with a `captainId`; a `parcel` with a `zomatoOrderId`; ID `"58 21"`; a 41-character ID.
  - A catalog CSV without `zomato_price` imports with `zomatoPricePaise: null`. A row with `zomato_price` `290.00` round-trips.
- [ ] **Step 2: Run** `npx vitest run packages/domain`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement the interfaces above.** In operator mode every tax line has taxable = its share after discount and zero CGST/SGST, and rounding follows the existing rule.
- [ ] **Step 4: Run** `npx vitest run packages/domain && npm run typecheck`. Expected: PASS. Typecheck errors elsewhere from the widened unions are fixed in later tasks only if they block compilation now. Otherwise use the narrowest local fix and note it.
- [ ] **Step 5: Checkpoint.** List the changed files for the user's commit (`feat(domain): zomato order type, price tier and operator tax mode`).

### Task 2: Migration 027 — rebuild orders and payments

**Files:**
- Create: `packages/domain/src/migrations/027-zomato-desk.ts`, `packages/domain/src/migrations/027-zomato-desk.test.ts`
- Modify: `packages/domain/src/migrations/index.ts`

**Interfaces:**
- Produces:
  - `orders.zomato_order_id TEXT`, `orders.zomato_status TEXT`, and the widened `type` and `price_tier` CHECKs
  - table CHECK `(type = 'zomato') = (zomato_order_id IS NOT NULL)`
  - `CREATE UNIQUE INDEX orders_zomato_order_id ON orders(zomato_order_id) WHERE type = 'zomato'`
  - `payments.mode` CHECK adds `'zomato'`
  - `products.zomato_price_paise` and `variants.zomato_price_paise` (`INTEGER`, NULL or ≥ 0)

- [ ] **Step 1: Write failing tests** in `027-zomato-desk.test.ts`:
  - Migrate to v26. Seed one each of: dine-in order with items, KOT, bill, payment and credit note; a parcel; a merged order (`merged_into`); a reservation linked to an order; a guest request; a table transfer.
  - Migrate to 27. Assert: every row count is unchanged, `PRAGMA foreign_key_check` is empty, and every index name on `orders` and `payments` from before still exists.
  - Inserting a `zomato` order works. A second `zomato` order with the same ID fails. A `parcel` order with a `zomato_order_id` fails.
  - A payment with mode `zomato` inserts. Mode `wallet` fails.
- [ ] **Step 2: Run** `npx vitest run packages/domain/src/migrations/027-zomato-desk.test.ts`. Expected: FAIL (the migration doesn't exist).
- [ ] **Step 3: Implement `migration027: Migration` (`version: 27, name: "zomato-desk"`).**
  - Copy the `004-printer-kinds` rebuild pattern.
  - Before writing the CREATE statements, read the live column list, indexes and triggers for `orders` and `payments` from `sqlite_master` (run `.schema orders` on a migrated test database).
  - Copy rows with an explicit column list, not `SELECT *`.
  - Recreate every index. Finish with `foreign_key_check`, and throw if any rows come back.
  - Register the migration in `index.ts`.
- [ ] **Step 4: Run** `npx vitest run packages/domain apps/server`. Expected: PASS. The whole server suite runs on the migrated schema.
- [ ] **Step 5: Checkpoint** (`feat(db): migration 027 for zomato orders and payments`).

### Task 3: Server — create Zomato orders, Zomato prices in the catalog

**Files:**
- Modify: `apps/server/src/orders.ts:36-82`, `apps/server/src/mappers.ts`, `apps/server/src/pricing.ts`, `apps/server/src/catalog.ts`
- Test: `apps/server/src/zomato-desk.test.ts` (create), `apps/server/src/catalog.test.ts`

**Interfaces:**
- Consumes: Task 1 schemas; Task 2 columns; `enableIntegration(app, "zomato")` from `test-helpers.ts`.
- Produces:
  - `POST /api/orders` accepts `{clientRef, type:"zomato", zomatoOrderId}` and returns `{order}`, where `order.zomatoOrderId: string | null` and `order.zomatoStatus: "preparing" | "ready" | "picked_up" | null` (mapper fields on every order)
  - `rowPrice(row, "zomato")` follows the fallback
  - Products and variants JSON gain `zomatoPricePaise: number | null`

- [ ] **Step 1: Write failing tests:**
  - Zomato is on and an admin creates order `5821`: 201, `type "zomato"`, `priceTier "zomato"`, `zomatoStatus null`.
  - Same ID with a new `clientRef`: 409 `{code:"zomato_duplicate"}`, and the message includes the existing order's status.
  - Same `clientRef`: 200, the same order.
  - Zomato off: 409.
  - Waiter: 403.
  - Adding a product (Takeaway ₹260, Zomato ₹290) gives `pricePaise 29000`. A variant with no Zomato price uses its Takeaway price.
  - `PATCH /api/products/:id` with `zomatoPricePaise: null` clears it.
- [ ] **Step 2: Run** `npx vitest run apps/server/src/zomato-desk.test.ts apps/server/src/catalog.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - Duplicate check: SELECT by `zomato_order_id` before INSERT. Also catch the unique-index error and map it to the same 409.
  - Role check uses the quick-billing roles, the same rule as `canQuickBill` in `App.tsx`.
- [ ] **Step 4: Run** the same tests. Expected: PASS.
- [ ] **Step 5: Checkpoint** (`feat(server): create zomato orders with zomato prices`).

### Task 4: Extract bill issue and settle helpers (no behaviour change)

**Files:**
- Modify: `apps/server/src/billing.ts:71-165`

**Interfaces:**
- Produces (exported from `billing.ts`; each must be called inside an open `db.transaction`):
  - `issueBill(db: Database, orderId: string, opts: { discountPaise: number; discountNote: string | null; clientRef: string; requestJson: string; actorId: string; role: Role; taxMode?: "restaurant" | "operator"; receiptExtra?: Partial<ReceiptSnapshot> }): { billId: string; changedStockIds: string[] }`
  - `settleBill(db: Database, billId: string, opts: { payments: Array<{ mode: PayMode; amountPaise: number; refNote?: string | null }>; clientRef: string; requestJson: string; actorId: string }): string[]` (returns the linked table IDs)
- The routes keep their exact request/response contracts and call these helpers. Preview keeps its `previewKey` check in the route.

- [ ] **Step 1: Run** `npx vitest run apps/server/src/billing*.test.ts apps/server/src/credit-notes*.test.ts` and record the pass count.
- [ ] **Step 2: Move the code into the helpers.** Printing and broadcasting stay in the route handlers.
- [ ] **Step 3: Run** the same command. Expected: the same pass count, and no test edits.
- [ ] **Step 4: Checkpoint** (`refactor(billing): extract issueBill and settleBill`).

### Task 5: Zomato status route, Picked up close and billing guards

**Files:**
- Create: `apps/server/src/zomato-desk.ts`
- Modify: `apps/server/src/server.ts` (register it), `apps/server/src/billing.ts`, `apps/server/src/credit-notes.ts`
- Test: `apps/server/src/zomato-desk.test.ts`

**Interfaces:**
- Consumes: `issueBill` and `settleBill` (Task 4); `calculateBill` operator mode (Task 1).
- Produces:
  - `registerZomatoDesk(app: FastifyInstance): void`
  - `POST /api/orders/:id/zomato-status` with body `{status:"ready"|"picked_up", clientRef:string}`, returning `{order, bill?}`
  - `nextZomatoStatus(current: ZomatoStatus | null, target: "ready" | "picked_up", hasPendingStationItems: boolean, hasItems: boolean): boolean`, exported for unit tests

- [ ] **Step 1: Write failing tests:**
  - Ready from `preparing` with nothing pending → `ready`.
  - Ready with a pending station item → 409 `zomato_status`.
  - **Ready from NULL with only stationless items → `ready`.**
  - Ready from NULL with no items → 409.
  - Picked up from `preparing` → 409.
  - Picked up from `ready`:
    - exactly 1 bill with `cgstPaise 0` and total = item sum (also with `tax_inclusive = 1`);
    - receipt `orderType "zomato"`, `zomatoOrderId`, `gstPaidBy "zomato"`;
    - 1 payment with `mode "zomato"`;
    - order `settled` and `picked_up`;
    - no row in `print_jobs`.
  - **The same `clientRef` twice → the same bill. Two different `clientRef`s in a row → the second gets 409, and there is still 1 bill.**
  - **Zomato off in the Marketplace → Ready and Picked up still succeed.**
  - Guards:
    - `bill-preview`, `bill` and `settle` on a Zomato order → 409 `zomato_order`;
    - `POST /api/bills/:id/print` on a Zomato bill → 409;
    - a credit note on a Zomato bill → 409 "Zomato handles refunds for Zomato orders".
  - Waiter → 403.
- [ ] **Step 2: Run** `npx vitest run apps/server/src/zomato-desk.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - Picked up runs `issueBill(…, {taxMode:"operator", discountPaise:0, …})` and `settleBill(…, {payments:[{mode:"zomato", amountPaise: total}]})` in one `db.transaction`, then sets `zomato_status`.
  - Replay is keyed on `clientRef` through the bill's `client_ref`.
  - Broadcast `order.updated`.
- [ ] **Step 4: Run** `npx vitest run apps/server`. Expected: PASS (apart from the known `captain-https` failures).
- [ ] **Step 5: Checkpoint** (`feat(server): zomato status route and picked-up close`).

### Task 6: KOTs and the Kitchen Display for Zomato orders

**Files:**
- Modify: `apps/server/src/kots.ts:18-173,232-250`, `apps/server/src/print/templates.ts:8-40`, `apps/server/src/mappers.ts:76-89`
- Test: `apps/server/src/zomato-desk.test.ts`, `apps/server/src/print/templates.test.ts`

**Interfaces:**
- Produces:
  - The KOT JSON gains `zomatoOrderId: string | null`
  - The template `orderType` widens to include `"zomato"`, and `contextLine()` returns `ZOMATO #<id>`

- [ ] **Step 1: Write failing tests:**
  - Send on a NULL-status Zomato order → `preparing`. The print-job label is `KOT #1 — Zomato #5821`, and the slip text contains `ZOMATO #5821`.
  - Send on a `ready` order with new items → `preparing`.
  - With KDS on, Done on the only KOT → `ready`. With two KOTs, Done on one → still `preparing`.
  - `GET /api/kots` includes `zomatoOrderId`.
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement** the status update inside the existing send and done transactions.
- [ ] **Step 4: Run** `npx vitest run apps/server`. Expected: PASS.
- [ ] **Step 5: Checkpoint** (`feat(kot): zomato labels and kitchen-driven ready`).

### Task 7: Reconciliation from POS orders

**Files:**
- Modify: `apps/server/src/zomato.ts:138-165`
- Test: `apps/server/src/zomato.test.ts`

**Interfaces:**
- Produces: `GET /api/zomato/reconciliation` keeps its response shape. Rows come from POS Zomato orders first, then imported orders for IDs not in the POS.

- [ ] **Step 1: Write failing tests:**
  - A POS order `5821` (picked up, ₹580) plus a settlement with gross ₹580 → `matched`, and `orderTotalPaise 58000`.
  - A POS-cancelled order with a settlement → `review_cancellation`.
  - An imported order `4000` (no POS order) still appears.
  - An imported order with the same ID as a POS order is ignored in favour of the POS one.
  - A POS order with no settlement → `awaiting_statement`.
- [ ] **Step 2: Run** `npx vitest run apps/server/src/zomato.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - POS rows use the bill total, `placed_at = orders.opened_at`, and `orderStatus` = `cancelled` or `delivered` (picked up) from the order.
  - Union by order ID with the imported orders.
- [ ] **Step 4: Run** the same tests. Expected: PASS.
- [ ] **Step 5: Checkpoint** (`feat(zomato): reconcile POS zomato orders`).

### Task 8: Reports — analytics, the 9(5) table and the day-end receivable

**Files:**
- Modify: `apps/server/src/order-analytics.ts:12-64`, `apps/server/src/operational-reports.ts`, `apps/server/src/reports.ts:9-60`
- Test: the matching `*.test.ts` files

**Interfaces:**
- Produces:
  - analytics `type=zomato`, and the comparison array `["parcel","dine_in","zomato"]`
  - a sales report table titled "Aggregator supplies — GST paid by Zomato (section 9(5))" with columns bill no., Zomato order, date, value
  - day-end `zomatoReceivablePaise: number`; `netPayments` excludes `zomato`

- [ ] **Step 1: Write failing tests.**
  - One cash takeaway (₹300) and one picked-up Zomato order (₹580) on the same day:
    - day-end cash = 300 and `zomatoReceivablePaise = 58000`;
    - no `zomato` entry in `netPayments`;
    - the 9(5) table has 1 row worth 58000;
    - the sales GST column total equals the takeaway's GST only;
    - analytics `type=zomato` counts 1 order.
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run apps/server`. Expected: PASS.
- [ ] **Step 5: Checkpoint** (`feat(reports): zomato analytics, 9(5) table, day-end receivable`).

### Task 9: UI — Zomato section in the Tables & orders panel

**Files:**
- Create: `apps/ui/src/zomato-desk.ts`, `apps/ui/src/zomato-desk.test.ts`, `apps/ui/src/ZomatoPanel.tsx`, `apps/ui/src/NewZomatoOrderDialog.tsx`
- Modify: `apps/ui/src/screens/Tables.tsx:201-266`, `apps/ui/src/types.ts:124,156`, `apps/ui/src/zomato.css`

**Interfaces:**
- Consumes: the order JSON fields from Task 3; the status route from Task 5.
- Produces (`zomato-desk.ts`):
  - `zomatoCardAction(order: Order): { label: "Add items" | "Ready" | "Picked up"; status: "ready" | "picked_up" | null }`
  - `zomatoOrders(orders: Order[]): Order[]`: open or billed `zomato` orders, oldest first
  - `zomatoAgeTone(minutes: number): "ok" | "warn" | "late"`
  - `setZomatoStatus(orderId: string, status: "ready" | "picked_up"): Promise<Order>`: uses `apiFetch` with a fresh `uuid()` clientRef that is kept for retries of the same click

- [ ] **Step 1: Write failing tests** for `zomatoCardAction`:
  - NULL with no items → Add items/null
  - NULL with only stationless items → Ready
  - `preparing` → Ready
  - `ready` → Picked up
  - `zomatoOrders` ordering, and that parcels are excluded
- [ ] **Step 2: Run** `npx vitest run apps/ui/src/zomato-desk.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement `zomatoCardAction`, `zomatoOrders` and `setZomatoStatus`.**
- [ ] **Step 4: USER CONTRIBUTION — `zomatoAgeTone(minutes)`.**
  - Leave `return "ok"; // TODO(you)` with a doc comment.
  - The user decides when a card turns amber or red. This is an operations trade-off: Zomato tracks the restaurant's preparation time, but too many red cards stop meaning anything.
  - Add the tests for the user's chosen thresholds after they write it.
- [ ] **Step 5: Build `ZomatoPanel` and `NewZomatoOrderDialog` and mount them in `Tables.tsx`.**
  - Section heading "Zomato", the count, and **+ New** (hidden when Zomato is off).
  - Each card shows `#id`, the age in minutes, the item total, a status pill and the action button. Picked up asks `Close Zomato #<id>?` through `window.confirm`.
  - The dialog has one input, "Zomato order ID". It POSTs `/api/orders` and opens the order with `onOpenOrder`. On `zomato_duplicate` it shows the server message.
  - The narrow-screen pane switch gains `Zomato · n`.
  - Shown only to admin and cashier.
- [ ] **Step 6: Run** `npx vitest run apps/ui && npm run typecheck`. Expected: PASS.
- [ ] **Step 7: Checkpoint** (`feat(ui): zomato section in tables panel`).

### Task 10: UI — order screen, Kitchen Display and Bills

**Files:**
- Modify: `apps/ui/src/screens/OrderScreen.tsx`, `apps/ui/src/screens/BillingPanel.tsx`, `apps/ui/src/screens/Kitchen.tsx:104`, `apps/ui/src/screens/Bills.tsx:33-34`
- Test: existing UI model tests, if any logic moves into a `.ts` model

**Interfaces:**
- Consumes: `zomatoCardAction` and `setZomatoStatus` (Task 9).

- [ ] **Step 1: Order screen.**
  - The header reads `Zomato #<id>`.
  - For `zomato` orders, `BillingPanel` shows the status pill and the `zomatoCardAction` button instead of the discount, Bill and Pay controls.
  - Send KOT and Cancel order stay.
- [ ] **Step 2: Kitchen Display.** The context shows `Zomato #<id>` with class `kds-tag-zomato`.
- [ ] **Step 3: Bills.**
  - The context column shows `Zomato #<id>`, with a "GST paid by Zomato (section 9(5))" note in the bill view.
  - Print, Reprint and Credit note are hidden when `receipt.orderType === "zomato"`.
- [ ] **Step 4: Run** `npx vitest run apps/ui && npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Checkpoint** (`feat(ui): zomato order screen, KDS tag, bills`).

### Task 11: UI — Zomato prices in the catalog

**Files:**
- Modify: `apps/ui/src/screens/ProductEditor.tsx:20-30,85-116,146-168`, `apps/ui/src/screens/Catalog.tsx:178`, `apps/ui/src/screens/DishCosting.tsx:8`, `apps/server/src/costing.ts:7,85`

- [ ] **Step 1: Write a failing test for costing.** `PRICE_TIERS` includes `zomato`, and a dish with a Zomato price reports its margin at that price. Add it to the existing costing test.
- [ ] **Step 2: Implement.**
  - A Zomato price input after Takeaway, with the hint "blank = Takeaway price". Variants too.
  - `servicePrices()` sends `zomatoPricePaise` (an empty input sends `null`).
  - The Catalog column and the Dish Costing tier show only while `isEnabled("zomato")`.
- [ ] **Step 3: Run** `npx vitest run && npm run typecheck`. Expected: PASS.
- [ ] **Step 4: Checkpoint** (`feat(ui): zomato prices in catalog`).

### Task 12: UI — reconciliation in Reports, Marketplace settings, remove the Zomato page

**Files:**
- Create: `apps/ui/src/screens/ZomatoReconciliation.tsx` (moved from `screens/Zomato.tsx`: the reconciliation tab, `ZomatoImport` and the import history), `apps/ui/src/screens/ZomatoConnection.tsx` (moved `ZomatoConnection`)
- Modify: `apps/ui/src/screens/SalesReports.tsx` (new tab `"zomato"`, shown while Zomato is on), `apps/ui/src/NavBar.tsx` (remove the Zomato link; `reports.tab` adds `"zomato"`), `apps/ui/src/App.tsx:31,56-61,154` (remove `ZomatoRoute`), `apps/ui/src/screens/Marketplace.tsx` (Zomato card **Settings** opens `ZomatoConnection` in a dialog)
- Delete: `apps/ui/src/screens/Zomato.tsx`
- Modify: `tools/e2e/marketplace.js`, wherever it navigates to the Zomato page

- [ ] **Step 1: Move the components without changing their behaviour.** Keep the CSV export file name.
- [ ] **Step 2: Wire the tab, the Marketplace Settings dialog, and the removals.**
- [ ] **Step 3: Run** `npx vitest run && npm run typecheck`. Expected: PASS. `grep -rn "screens/Zomato\"" apps/ui/src` returns nothing.
- [ ] **Step 4: Checkpoint** (`feat(ui): zomato reconciliation in reports, settings in marketplace`).

### Task 13: Dashboard — Zomato card, third slot series, alerts from POS orders

**Files:**
- Modify: `apps/ui/src/useDashboard.ts:11,51-66`, `apps/ui/src/dashboard-data.ts:19-75`, `apps/ui/src/SlotChart.tsx`, `apps/ui/src/SalesDashboard.tsx:32-33`, `apps/ui/src/useAggregatorOrders.ts`, `apps/ui/src/dashboard-view.ts`
- Test: `apps/ui/src/dashboard-data.test.ts`, `apps/ui/src/dashboard-view.test.ts`

**Interfaces:**
- Produces:
  - `SlotBar` gains `zomatoPaise: number`
  - `slotBars(dineIn, takeaway, zomato?: OrderTypeAnalytics | null)`
  - `channelCards()` adds `card("zomato")` when Zomato data is present
  - `aggregatorAlerts(orders: Order[], now: number): AlertRow[]` (from POS orders)
  - `perBarLabelsFit` keeps its signature. `pitch` stays the centre-to-centre distance of neighbouring bars.

- [ ] **Step 1: Write failing tests.**
  - `slotBars` with Zomato data fills `zomatoPaise`.
  - `slotScale` includes Zomato values.
  - `aggregatorAlerts` lists open Zomato orders oldest first, with the status and age text "Preparing · 25m".
  - Existing two-series tests still pass when `zomato` is omitted.
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - `useDashboard` fetches `type=zomato` only while Zomato is on.
  - `SlotChart` draws a third bar per slot (colour token `--zomato`) when any `zomatoPaise` ≠ 0, and the legend gains Zomato.
  - `useAggregatorOrders` reads `GET /api/orders` and refreshes on `order.updated`.
- [ ] **Step 4: Run** `npx vitest run apps/ui`. Expected: PASS.
- [ ] **Step 5: Checkpoint** (`feat(dashboard): zomato channel`).

### Task 14: E2E gate and documentation

**Files:**
- Create: `tools/e2e/zomato-desk.js`, `docs/operations/zomato-desk.md`
- Modify: `tools/e2e/sales-dashboard-server.mts` (seed: Zomato on, a product with a Zomato price, one picked-up Zomato order today), `tools/e2e/README.md`

- [ ] **Step 1: Write the gate script**, following the style of `tools/e2e/marketplace.js`. Its result goes on `window.__zomatoDeskResult`. Checks:
  - the Zomato section is visible to admin and hidden from the waiter;
  - **+ New** with ID `E2E-1` opens `Zomato #E2E-1`, and the menu shows the Zomato price;
  - add an item → Send KOT → the card shows Preparing;
  - Ready, then Picked up → the card is gone;
  - the bill in Bills has no Print button and shows "GST paid by Zomato";
  - punching `E2E-1` again is refused;
  - the dashboard Zomato card is non-zero;
  - day-end shows "Zomato receivable (outstanding)";
  - Reports → Zomato reconciliation lists `E2E-1`.
- [ ] **Step 2: Run it through the Playwright MCP** against a fresh `sales-dashboard-server.mts` on port 4145. Expected: every check passes. Then re-run the sales-dashboard, Marketplace, kitchen-app and demo-kitchen gates.
- [ ] **Step 3: Write the docs.** The guide covers: punching in, statuses, only KOTs print, the GST 9(5) note (confirm with your accountant), reconciliation in Reports, and Settings in the Marketplace. Add the new gate to the README.
- [ ] **Step 4: Final gates.**
  - `npm run typecheck`: clean.
  - `npx vitest run`: only the 2 known `captain-https` failures.
- [ ] **Step 5: Checkpoint** (`docs: zomato desk guide and e2e gate`).
