# Per-item Packaging Charges Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Takeaway and delivery bills can charge packaging per item (product amount, variant override) on top of the flat per-bill amount, behind a Bill settings toggle; refunds let the cashier keep or refund that packaging.

**Architecture:** Per-item amounts are summed into the single existing `packaging` charge from Phase 4, so GST, printing and reports keep working. Each bill line stores its own packaging so refunds can credit it in parts. Charge credits become amount-based (`credit_note_charges.amount_paise`) instead of "whole charge once".

**Tech Stack:** TypeScript, SQLite (better-sqlite3), Fastify, zod, React, vitest.

**Spec:** `docs/superpowers/specs/2026-11-06-per-item-packaging-design.md`

## Global Constraints

- Migration version **61**, name `per_item_packaging`, file `packages/domain/src/migrations/per-item-packaging.ts`, appended to `MIGRATIONS` in `packages/domain/src/migrations/index.ts`.
- Item and variant packaging: integer paise, **0–100000** (₹0–₹1,000). Variant NULL = use the product's amount; variant 0 = no packaging.
- Toggle `settings.packaging_per_item` 0/1, default 0. API name `packagingPerItem: boolean`.
- Only `orders.type = 'parcel'` with `order_types.kind` in (`takeaway`, `delivery`) get packaging. Dine-in and Zomato never do.
- Combo children (`parent_item_id` not null) carry 0 packaging; the combo line uses the combo product's amount.
- Packaging is one charge line, `kind = 'packaging'`, label `settings.packaging_charge_label`, at `settings.gst_rate`. Discounts never reduce it.
- Refund request field `refundPackaging: boolean`, default `true`. Service charge credit rules are unchanged.
- Every task ends with `npm test` and `npm run typecheck` green (except where Task 4 notes otherwise).

## Review Focus

1. **Variant packaging set to 0** while the product has ₹10: the variant charges nothing (0 is not "blank"). Test in Task 3.
2. **Toggle on, dine-in order:** no packaging, even though items have amounts. Test in Task 3.
3. **Catalog amount changed between bill preview and issue:** the issue is refused as a changed bill, like any other total change. Test in Task 3.
4. **Refund that clears the bill with packaging kept, then another refund:** refused with "Nothing left to refund on this bill" (only a void can take the kept packaging), and a void then credits exactly the kept amount. Test in Task 5.
5. **Replay of a refund `clientRef` with a different `refundPackaging`:** refused as a reused reference, not issued twice. Test in Task 5.

---

### Task 1: Migration 61 and the toggle setting

**Files:**
- Create: `packages/domain/src/migrations/per-item-packaging.ts`, `packages/domain/src/migrations/per-item-packaging.test.ts`
- Modify: `packages/domain/src/migrations/index.ts`, `packages/domain/src/settings-schemas.ts:42-46`, `apps/server/src/settings.ts` (row type, SELECT, mapping, preview, UPDATE), `apps/server/src/gst-settings.ts:15-19`
- Test: `apps/server/src/settings.test.ts`

**Interfaces:**
- Produces: columns `settings.packaging_per_item` (NOT NULL DEFAULT 0, CHECK IN (0,1)), `products.packaging_paise` (NOT NULL DEFAULT 0, CHECK 0–100000), `variants.packaging_paise` (NULL or 0–100000), `bill_report_lines.packaging_paise` (NOT NULL DEFAULT 0), `credit_note_charges.amount_paise` (NOT NULL DEFAULT 0).
- Produces: `readBillingSettings(db)` gains `packagingPerItem: boolean`. Settings API GET/PUT carries `packagingPerItem: boolean` (schema `z.boolean().optional()`).

- [ ] **Step 1: Write the failing migration test** — `per-item-packaging.test.ts`, following `bill-charges.test.ts`:
  - `adds the packaging columns with their defaults`: after migrating, a new product has `packaging_paise = 0`, a new variant `NULL`, settings `packaging_per_item = 0`.
  - `rejects packaging outside 0-100000`: a product with `packaging_paise = 100001` or `-1` throws; a variant with `100001` throws.
  - `backfills credited charge amounts`: migrate to 60, insert a bill with a `bill_charges` packaging row `amount_paise = 2000` and a `credit_note_charges` row for it, migrate to 61 → that row's `amount_paise = 2000`.
- [ ] **Step 2: Run** `npx vitest run packages/domain/src/migrations/per-item-packaging.test.ts` — expect FAIL (module not found).
- [ ] **Step 3: Implement the migration.** `ALTER TABLE ... ADD COLUMN` for the five columns, then
  `UPDATE credit_note_charges SET amount_paise = (SELECT bc.amount_paise FROM bill_charges bc JOIN credit_notes c ON c.bill_id = bc.bill_id WHERE c.id = credit_note_charges.credit_note_id AND bc.kind = credit_note_charges.kind)`. Register it in `MIGRATIONS`.
- [ ] **Step 4: Run the migration test** — expect PASS.
- [ ] **Step 5: Write the failing settings test** in `settings.test.ts`: `PUT /api/settings` with `packagingPerItem: true` → GET returns `true`; `readBillingSettings(db).packagingPerItem === true`; a later PUT without it keeps `true`.
- [ ] **Step 6: Implement** the setting through `settings-schemas.ts`, `settings.ts` (`packaging_per_item = COALESCE(?, packaging_per_item)`, boolean ↔ 0/1) and `readBillingSettings`.
- [ ] **Step 7: Run** `npm test` and `npm run typecheck` — expect PASS.
- [ ] **Step 8: Commit** `feat(domain): per-item packaging migration 61 and setting`

### Task 2: Catalog amounts (API, CSV, transfer)

**Files:**
- Modify: `packages/domain/src/catalog-schemas.ts` (VariantCreate, VariantUpdate, ProductCreate, ProductUpdate), `apps/server/src/catalog.ts` (row types, product/variant mapping, product and variant INSERT/UPDATE, `/api/products` response ~L150), `packages/domain/src/catalog-csv.ts:5-10`, `apps/server/src/catalog-transfer.ts`
- Test: `apps/server/src/catalog.test.ts`, `apps/server/src/catalog-transfer.test.ts`, `packages/domain/src/catalog-csv.test.ts`

**Interfaces:**
- Consumes: Task 1 columns.
- Produces: `Product.packagingPaise: number`, `Variant.packagingPaise: number | null` in API JSON. `GET /api/products` returns `{ products, defaultGstRate, packagingPerItem: boolean }`. CSV columns `packaging` and `variant_packaging` (rupees) appended to the end of `CATALOG_CSV_COLUMNS`.

Follow `takeawayPricePaise` / `takeaway_price` everywhere: same parsing, `Paise` capped with `.max(100000)`, same "undefined keeps, null clears" rule for variants. On products `packagingPaise` is a number (not nullable), default 0; a blank `packaging` CSV cell keeps the existing value on update and is 0 on create.

- [ ] **Step 1: Write failing tests:**
  - catalog: create a product with `packagingPaise: 1000`, a variant with `packagingPaise: 500` and one without → GET shows `1000`, `500`, `null`; PATCH product `packagingPaise: 100001` → 400; PATCH variant `packagingPaise: null` → `null`; `/api/products` has `packagingPerItem: false`.
  - CSV: export of that catalog has `packaging = 10.00` on its rows and `variant_packaging` `5.00` / blank; importing the export back changes nothing (preview `updated: 0`); importing a blank `variant_packaging` on a variant with 500 sets NULL.
- [ ] **Step 2: Run** the three test files — expect FAIL.
- [ ] **Step 3: Implement** schemas, catalog routes, CSV columns and transfer export/import.
- [ ] **Step 4: Run** `npm test` and `npm run typecheck` — expect PASS.
- [ ] **Step 5: Commit** `feat: packaging amount on products and variants`

### Task 3: Per-item packaging on bills

**Files:**
- Create: `packages/domain/src/packaging.ts`, `packages/domain/src/packaging.test.ts`
- Modify: `packages/domain/src/index.ts` (export), `apps/server/src/billing.ts:79-83` (`priceOrder`), `packages/domain/src/report-lines.ts` (`saveReportLines` INSERT gains `packaging_paise`)
- Test: `apps/server/src/billing.test.ts`

**Interfaces:**
- Consumes: Task 1 columns and the `settings.packaging_per_item` column.
- Produces: `orderItemPackaging(db: Database, orderId: string): Map<string, number>` — order item id → line packaging (unit amount × qty) for every non-cancelled top-level item. Empty map when the toggle is off or the order is not a takeaway/delivery parcel. Unit amount = `COALESCE(v.packaging_paise, p.packaging_paise)`.
- Produces: `bill_report_lines.packaging_paise` filled for top-level lines (0 for combo children and lines absent from the map).

- [ ] **Step 1: Write failing domain tests** (`packaging.test.ts`, migrated in-memory db with a takeaway order type):
  - `sums unit amount times qty`: product ₹10 × 3 → `3000`.
  - `variant overrides product, blank falls back, zero is free`: variants 500 / NULL / 0 on a ₹10 product → 500, 1000, 0 (Review Focus 1).
  - `combo children add nothing`: combo product ₹15 holding two items at ₹10 each → only the combo line, `1500`.
  - `toggle off → empty map`; `dine-in order → empty map`; `cancelled items are skipped`.
- [ ] **Step 2: Run** `npx vitest run packages/domain/src/packaging.test.ts` — expect FAIL.
- [ ] **Step 3: Implement `orderItemPackaging`.** The order-type check uses the same join as `priceOrder`: `orders o LEFT JOIN order_types t ON t.id = COALESCE(o.order_type_id, o.type)`, requiring `o.type = 'parcel'` and `t.kind IN ('takeaway','delivery')`.
- [ ] **Step 4: Run** the domain test — expect PASS.
- [ ] **Step 5: Write failing server tests** (`billing.test.ts`, next to the Phase 4 charge tests):
  - takeaway order, flat ₹20, toggle on, 2 × item with ₹10 packaging → bill packaging charge `amountPaise 4000`, one `bill_charges` packaging row, that line's `bill_report_lines.packaging_paise = 2000`; a delivery order the same.
  - the same order with the toggle off → packaging `2000` (flat only), line `packaging_paise = 0`.
  - dine-in with toggle on → no packaging charge (Review Focus 2); Zomato → none.
  - flat 0 and item amounts 0 → no packaging row.
  - preview, change the product's `packagingPaise`, then issue with the old preview fingerprint → refused with the existing changed-bill error (Review Focus 3).
- [ ] **Step 6: Implement.** In `priceOrder`, packaging `amountPaise = settings.packagingChargePaise + Σ orderItemPackaging(db, orderId).values()`. In `saveReportLines`, read the same map for `bill.order_id` and write each line's value.
- [ ] **Step 7: Run** `npm test` and `npm run typecheck` — expect PASS.
- [ ] **Step 8: Commit** `feat: per-item packaging on takeaway and delivery bills`

### Task 4: Amount-based charge credits in the domain

**Files:**
- Modify: `packages/domain/src/credit-notes.ts`
- Test: `packages/domain/src/credit-notes.test.ts`

**Interfaces:**
- Produces:
  - `BillLine` gains `packagingPaise: number`.
  - `BillChargeCredit` gains `amountPaise: number` (on a bill charge: the billed amount; in a draft: the amount this note credits).
  - `type CreditedCharges = Partial<Record<ChargeKind, Money & { amountPaise: number }>>` (exported).
  - `packagingCredit(lines: BillLine[], credited: Record<string, Credited>, requested: Array<{ orderItemId: string; qty: number }>, charges: BillChargeCredit[], creditedCharges: CreditedCharges): number` — the packaging amount this refund credits when ticked, capped at what is uncredited.
  - `creditFor(lines, credited, requested, charges = [], creditedCharges: CreditedCharges = {}, opts: { refundPackaging?: boolean } = {})` — `refundPackaging` defaults to `true`.
  - `voidRemainder(lines, credited, charges = [], creditedCharges: CreditedCharges = {})`.

Algorithm (what the signatures don't fix):
- Line share for `q` refunded units with `before` already credited: `proportion(p, before + q, qty) − proportion(p, before, qty)`, `p = line.packagingPaise`.
- Flat part = `charge.amountPaise − Σ lines.packagingPaise`; added only when the refund clears every remaining item.
- `packagingCredit` = min(Σ line shares + flat part, `left`), where `left = charge.amountPaise − (credited.amountPaise ?? 0)`.
- A charge credit of amount `a`: when `a === left`, each money field = charge field − credited field; otherwise each field = `proportion(chargeField, a, charge.amountPaise)`; `totalPaise` = sum of the fields. Amount 0 → no charge row.
- Service charge: credits its `left` only when the refund clears every item, or on void; ignores `refundPackaging`.
- Void: every charge credits its `left`.
- Throws "Nothing left to refund on this bill" when there are no lines and no charge credit (as today).

- [ ] **Step 1: Update existing tests** to the `CreditedCharges` argument and `amountPaise` fields, then **write failing tests** (lines A: qty 2, packaging 2000; B: qty 1, packaging 0; packaging charge amount 2500, so flat 500):
  - `credits a refunded item's packaging`: refund 1 × A → packaging credit `amountPaise 1000`, money fields proportional.
  - `unticked credits no packaging`: same with `{ refundPackaging: false }` → `charges` empty.
  - `clearing refund adds the flat part`: refund everything → `amountPaise 2500`.
  - `partial credits and a void sum exactly to the bill`: under `exclusive` with odd paise (packaging amount 2333 at 5%), refund 1 × A, then void → Σ credited taxable/CGST/SGST/rounding/total equal the bill charge's.
  - `void after a kept-packaging refund credits the rest`: refund all items unticked, then `voidRemainder` → packaging `amountPaise 2500`, no item lines.
  - `service charge unchanged`: partial refund credits none; clearing refund credits all of it; `refundPackaging: false` doesn't change that.
  - `packagingCredit` returns 1000 for 1 × A and 0 once packaging is fully credited.
- [ ] **Step 2: Run** `npx vitest run packages/domain/src/credit-notes.test.ts` — expect FAIL.
- [ ] **Step 3: Implement** in `credit-notes.ts`.
- [ ] **Step 4: Run** the domain test — expect PASS. The server won't typecheck until Task 5; do Task 5 straight after and commit both together if the executor requires green typecheck per commit.
- [ ] **Step 5: Commit** `feat(domain): amount-based charge credits with per-item packaging`

### Task 5: Refunds, voids and reports on the server

**Files:**
- Modify: `packages/domain/src/credit-notes.ts:118-131` (schemas), `apps/server/src/credit-notes.ts` (`BillCredit`, `loadBillCredit`, `draftCredit`, preview route ~L338, refund route ~L351, `writeCreditNote`), `apps/server/src/operational-reports.ts:109`
- Test: `apps/server/src/credit-notes.test.ts`, `apps/server/src/operational-reports.test.ts`, `apps/server/src/gst-returns.test.ts`

**Interfaces:**
- Consumes: Task 4 functions and types; Task 3 `bill_report_lines.packaging_paise`.
- Produces: `CreditPreview` and `RefundBill` gain `refundPackaging: z.boolean().default(true)`. `BillCredit.creditedCharges: CreditedCharges`. The preview response gains `packagingPaise: number` = `packagingCredit(...)` for the requested lines (0 for void); the UI shows the tickbox from it.

- [ ] **Step 1: Write failing server tests** (takeaway bill, toggle on, flat ₹5, item A qty 2 with ₹10 packaging, item B none, paid by cash):
  - preview refund of 1 × A → `packagingPaise 1000`; preview of B only → `0`.
  - refund 1 × A with `refundPackaging: false` → no charge row, bill `partly_refunded`; refund the other A ticked → `credit_note_charges.amount_paise 1000`.
  - on a fresh bill: refund all items unticked → bill stays `partly_refunded`; another refund → 409 "Nothing left to refund on this bill"; void → credits exactly the kept packaging (Review Focus 4).
  - replay a refund's `clientRef` with `refundPackaging` flipped → refused as a reused reference (Review Focus 5).
  - operational report after a partial packaging credit counts the credited amount, not the whole bill charge; GSTR-1 totals equal bill taxes minus credit-note taxes.
- [ ] **Step 2: Run** the three server test files — expect FAIL.
- [ ] **Step 3: Implement:**
  - `loadBillCredit`: select `l.packaging_paise` into `BillLine.packagingPaise`; `amount_paise` from `bill_charges`; `creditedCharges` = per-kind `SUM`s of `amount_paise`, the money fields and total from `credit_note_charges`.
  - `draftCredit(db, billId, kind, requested, refundPackaging = true)`: the `chargesLeft` check becomes "some charge has `amountPaise > (creditedCharges[kind]?.amountPaise ?? 0)`"; pass `{ refundPackaging }` to `creditFor`. `refundPackaging` must be part of the `request_json` compared on replay.
  - `writeCreditNote`: insert `amount_paise`.
  - `operational-reports.ts:109`: `(SELECT SUM(cc.amount_paise) FROM credit_note_charges cc WHERE cc.credit_note_id = c.id)` — no join to `bill_charges`.
- [ ] **Step 4: Run** `npm test` and `npm run typecheck` — expect PASS.
- [ ] **Step 5: Commit** `feat(server): refund or keep per-item packaging on credit notes`

### Task 6: UI — toggle, product fields, refund tickbox, docs

**Files:**
- Modify: `apps/ui/src/screens/BillSettings.tsx` (~L110-121 and `CHARGES_HELP`), `apps/ui/src/charges-form.ts`, `apps/ui/src/screens/Catalog.tsx` (~L32-50, L115), `apps/ui/src/screens/ProductEditor.tsx`, `apps/ui/src/screens/CreditNoteDialog.tsx` (~L150-260), `apps/ui/src/credit-note-form.ts`, `docs/operations/bill-format.md`
- Test: `apps/ui/src/charges-form.test.ts`, `apps/ui/src/credit-note-form.test.ts`

**Interfaces:**
- Consumes: settings `packagingPerItem`; `/api/products` `packagingPerItem`; product/variant `packagingPaise`; preview `packagingPaise`; request `refundPackaging`.
- Produces: `ProductEditor` prop `packagingPerItem: boolean`. `creditPreviewBody(kind: "void" | "refund", lines: Array<{ orderItemId: string; qty: number }>, refundPackaging: boolean)` in `credit-note-form.ts`, returning `{ kind }` for void and `{ kind, lines, refundPackaging }` for refund.

Copy:
- Toggle: **"Charge packaging per item"**; hint: "Adds each item's packaging amount (set in the menu) to the packaging charge above."
- Product field: **"Packaging (₹)"**; variant placeholder: **"Same as item"**.
- Refund tickbox: **"Refund packaging (₹X)"**, X = the preview's `packagingPaise`.

- [ ] **Step 1: Write failing UI tests:**
  - `charges-form.test.ts`: the form round-trips `packagingPerItem` (loaded value → save body).
  - `credit-note-form.test.ts`: `creditPreviewBody("refund", lines, false)` → `{ kind: "refund", lines, refundPackaging: false }`; `creditPreviewBody("void", [], true)` → `{ kind: "void" }`.
- [ ] **Step 2: Run** `npx vitest run apps/ui/src/charges-form.test.ts apps/ui/src/credit-note-form.test.ts` — expect FAIL.
- [ ] **Step 3: Implement:**
  - Bill settings toggle under the packaging fields; mention per-item packaging in `CHARGES_HELP`.
  - `Catalog.tsx` keeps `packagingPerItem` from `/api/products` and passes it to `ProductEditor`, which shows the product and variant packaging inputs only when it is true, parsed like the takeaway price (blank variant → `null`, blank product → 0).
  - `CreditNoteDialog`: `refundPackaging` state default `true`, part of the preview key and the refund request (via `creditPreviewBody`); the tickbox shows for refunds when `preview.packagingPaise > 0`.
- [ ] **Step 4: Run** `npm test` and `npm run typecheck` — expect PASS.
- [ ] **Step 5: Update `docs/operations/bill-format.md`**: the toggle, product/variant amounts, and the refund tickbox with the spec's cancellation table.
- [ ] **Step 6: Dev-app check** (`npm run dev`, admin / demo1234): turn the toggle on, set an item ₹10 and a variant ₹5, bill a takeaway order; the thermal print job, A4 receipt and digital bill show one "Packaging" line = flat + items; refund one item ticked and another unticked, then void; check the day report and GSTR-1. Stop the dev server by PID.
- [ ] **Step 7: Commit** `feat(ui): per-item packaging toggle, menu amounts and refund choice`
