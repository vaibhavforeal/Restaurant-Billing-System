# Simple GST Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the four tax modes and per-item rates with two GST modes (`included` / `none`), a restaurant default rate, and optional per-item overrides.

**Architecture:** A small domain module (`gst.ts`) owns the vocabulary and the receipt's GST mode. `calculateBill` keeps one per-rate path for `included` and one zero-GST path for `none`; Zomato uses `none`. Migration 031 reshapes settings and the product rate column. The server resolves each item's rate at punch through one helper; receipts, reports, costing and the UI read the bill's recorded `gstMode`.

**Tech Stack:** TypeScript, Node, Fastify, better-sqlite3 (SQLite 3.53), zod, React, vitest, Playwright MCP for browser gates.

**Spec:** `docs/superpowers/specs/2026-10-09-simple-gst-design.md`

## Global Constraints

- GST modes: `"included" | "none"` exactly. Settings column `gst_mode TEXT NOT NULL DEFAULT 'included' CHECK (gst_mode IN ('included','none'))`.
- Default rate: `gst_rate INTEGER NOT NULL DEFAULT 5 CHECK (gst_rate IN (5, 12, 18))`.
- Item override rates: `0, 5, 12, 18, 28` (`GST_RATES`, unchanged); `null` = restaurant default.
- Thermal headings: `TAX INVOICE`, `BILL OF SUPPLY`, `RESTAURANT BILL`. HTML `<h2>`: `Tax invoice`, `Bill of supply`, `Restaurant bill`.
- Declaration (verbatim): `Composition taxable person, not eligible to collect tax on supplies`.
- GST block heading: `Includes GST:` (thermal) / `Includes GST` (HTML); rows `Taxable @ {r}%`, `CGST {r/2}%`, `SGST {r/2}%`.
- Zomato note (verbatim, unchanged): `GST paid by Zomato (section 9(5))`.
- Day-end line label: `Sales without GST`. QR menu copy: `No tax is added to menu prices.`
- Thermal lines stay within 32 (58 mm) / 48 (80 mm) characters.
- Run vitest from the repo root. The two `captain-https` failures are a known environment issue, not regressions.
- Commit after every task with the `Co-Authored-By` trailer from the session.
- Tasks 1-2 change domain types that the server and UI use; repo-wide `npm run typecheck` is expected to fail until Task 7 is done. Each task runs its own test files; Task 7 restores the full typecheck and suite.

## Review Focus

- **Default changed during an open order:** items already punched keep their recorded rate; items punched afterwards use the new default. Test in Task 4.
- **Mixed 5% + 18% bill with a discount:** each rate gets its own GST block and taxable + CGST + SGST across blocks equals the total before round-off. Tests in Tasks 1 and 5.
- **No-GST restaurant with and without a GSTIN:** Bill of supply + declaration vs plain Restaurant bill; neither shows GST lines. Test in Task 5.
- **GST mode switched while a bill preview is open:** issuing with the old preview key is refused (409), because the preview key covers the receipt snapshot. Test in Task 5.
- **CSV export then re-import:** items on the default export a blank `gst_rate` and import back as default, not as 5%. Test in Task 3.

---

### Task 1: Domain GST vocabulary and calculation

**Files:**
- Create: `packages/domain/src/gst.ts`, `packages/domain/src/gst.test.ts`
- Modify: `packages/domain/src/billing.ts`, `packages/domain/src/report-lines.ts`, `packages/domain/src/index.ts`
- Test: `packages/domain/src/billing.test.ts` (rewrite the inclusive/exclusive/operator/composition suites)

**Interfaces:**
- Produces (in `gst.ts`, exported from the package root):
  - `GST_MODES = ["included", "none"] as const`, `type GstMode`
  - `DEFAULT_GST_RATES = [5, 12, 18] as const`, `type DefaultGstRate`
  - `effectiveGstRate(itemRate: number | null, defaultRate: number): number`
  - `receiptGstMode(receipt: Pick<ReceiptSnapshot, "gstMode" | "gstPaidBy" | "gstScheme" | "taxInclusive">): GstMode`
- Produces (in `billing.ts`): `calculateBill(items, discountPaise = 0, mode: GstMode = "included"): BillTotals`; `BillTotals` without `taxInclusive`; `ReceiptSnapshot.gstMode: GstMode` (required), with legacy optional `taxInclusive?: boolean` and `gstScheme?: "composition"` kept only for reading old bills (doc comment says so). `TaxMode` is deleted.

- [ ] **Step 1: Write the failing tests**

`gst.test.ts`:
- `effectiveGstRate(null, 5) === 5`, `effectiveGstRate(18, 5) === 18`, `effectiveGstRate(0, 12) === 0` (a 0% override is not "no override").
- `receiptGstMode({ gstMode: "none" }) === "none"`, `({ gstMode: "included" }) === "included"`; legacy: `({ gstScheme: "composition" })`, `({ gstPaidBy: "zomato", taxInclusive: false })` → `"none"`; `({ taxInclusive: false })` and `({ taxInclusive: true })` → `"included"`.

`billing.test.ts` (replace the old mode suites):
- `"included: one rate"`: `calculateBill([{ pricePaise: 10500, qty: 1, gstRate: 5 }])` → `{ subtotalPaise: 10500, cgstPaise: 250, sgstPaise: 250, totalPaise: 10500, roundingPaise: 0 }`, `taxes = [{ gstRate: 5, taxablePaise: 10000, cgstPaise: 250, sgstPaise: 250 }]`.
- `"included: mixed rates share the discount"`: items `[{20000,1,5},{10000,1,18}]`, discount 3000 → taxes `[{5, 17143, 429, 428}, {18, 7627, 687, 686}]`, `totalPaise: 27000`, and the sum of taxable + CGST + SGST over taxes is `27000`.
- `"none: no GST, menu price less discount"`: same items and discount with `"none"` → CGST/SGST 0 everywhere, taxable per rate `[18000, 9000]`, `totalPaise: 27000`.
- `"rounds to the rupee"`: `[{ pricePaise: 10050, qty: 1, gstRate: 5 }]` with `"none"` → `totalPaise: 10100`, `roundingPaise: 50`.
- `"a full discount gives a zero bill"`: `[{10000,1,5}]`, discount 10000 → `totalPaise: 0`, taxes `[{5, 0, 0, 0}]`.
- Keep the existing validation tests (invalid rate, empty bill, discount over subtotal, amount cap).

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run packages/domain/src/gst.test.ts packages/domain/src/billing.test.ts`
Expected: FAIL (`gst.js` missing; `calculateBill` still takes the old arguments).

- [ ] **Step 3: USER CONTRIBUTION — `effectiveGstRate`**

Create `gst.ts` with the constants, `receiptGstMode`, and `effectiveGstRate` whose body is `throw new Error("TODO: effectiveGstRate")` under a comment explaining the decision (override wins; `0` is a real override; `null` means the restaurant default). Stop and ask the user to write the body (learning mode). Continue once they have.

- [ ] **Step 4: Implement the rest**

- `receiptGstMode`: `gstMode` when present; otherwise `"none"` for `gstScheme === "composition"` or `gstPaidBy === "zomato"`; otherwise `"included"`.
- `calculateBill`: keep grouping, discount allocation and validation as they are; for `included` use the existing inclusive per-rate maths; for `none` use the existing zero-GST path; total = Σ (group gross) rounded with the existing rule. Delete the exclusive branch.
- `report-lines.ts`: the discount per rate group is `subtotal − taxable − CGST − SGST` unless the snapshot has `taxInclusive === false` (legacy exclusive bills backfilled by migration 017), where it stays `subtotal − taxable`.
- Export the new names from `index.ts`; remove `TaxMode`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run packages/domain/src/gst.test.ts packages/domain/src/billing.test.ts packages/domain/src/report-lines.test.ts`
Expected: PASS (the last file may not exist; ignore that).

- [ ] **Step 6: Commit** — `feat(domain): two GST modes, default rate and effective item rate`

---

### Task 2: Migration 031 and the settings/catalog schemas

**Files:**
- Create: `packages/domain/src/migrations/031-simple-gst.ts`, `packages/domain/src/migrations/031-simple-gst.test.ts`
- Modify: `packages/domain/src/migrations/index.ts`, `packages/domain/src/settings-schemas.ts`, `packages/domain/src/catalog-schemas.ts`, `packages/domain/src/guest-ordering.ts`, `packages/domain/src/index.ts`
- Modify tests: `packages/domain/src/migrations/015-upi-payments.test.ts`, `029-receipt-styles.test.ts`, `030-gst-scheme.test.ts`, `005-billing-snapshots.test.ts`, `027-zomato-desk.test.ts` — each migrates only up to its own version (`MIGRATIONS.filter((m) => m.version <= N)`) wherever it compares whole settings rows or reads `tax_inclusive`.

**Interfaces:**
- Consumes: `GST_MODES`, `DEFAULT_GST_RATES` (Task 1).
- Produces: `SettingsUpdate` with `gstMode: z.enum(GST_MODES).optional()` and `gstRate: DefaultGstRate optional` (validated against `DEFAULT_GST_RATES`); `taxInclusive`, `gstScheme`, `GST_SCHEMES`, `GstScheme` removed. `ProductCreate.gstRate: GstRate.nullable().default(null)`, `ProductUpdate.gstRate: GstRate.nullable().optional()`. `GuestMenu` and `GuestReceipt` lose `taxInclusive`.

- [ ] **Step 1: Write the failing migration test**

`031-simple-gst.test.ts`, `"maps settings, keeps rate overrides, and is safe to rerun"`:
- Migrate to 30; set `gst_scheme = 'composition'`; insert a category and three products at 5, 18 and 0.
- Migrate fully. Settings row has `gst_mode: "none"`, `gst_rate: 5`, and no `tax_inclusive` / `gst_scheme` keys. Products' `gst_rate` are `null`, `18`, `0`.
- A second fresh database with `gst_scheme = 'regular'` gets `gst_mode: "included"`.
- `UPDATE settings SET gst_rate = 28` throws; `UPDATE products SET gst_rate = 7` throws; `UPDATE products SET gst_rate = NULL` succeeds.
- `guest_requests` has no `tax_inclusive` column (`PRAGMA table_info`).
- Running `migrate` again changes nothing.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run packages/domain/src/migrations/031-simple-gst.test.ts`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement migration 031 (`version: 31, name: "simple-gst"`)**

In this order: add `gst_mode` and `gst_rate` to settings (constraints from Global Constraints); set `gst_mode` from `gst_scheme`; drop `settings.tax_inclusive` and `settings.gst_scheme`; add `products.gst_rate_new REAL CHECK (gst_rate_new IS NULL OR gst_rate_new IN (0, 5, 12, 18, 28))`; copy `gst_rate` into it where `gst_rate <> 5`; drop `products.gst_rate`; rename `gst_rate_new` to `gst_rate`; drop `guest_requests.tax_inclusive`. Register it in `migrations/index.ts`.

- [ ] **Step 4: Update the schemas and the older migration tests as listed under Files**

- [ ] **Step 5: Run the domain suite**

Run: `npx vitest run packages/domain`
Expected: PASS.

- [ ] **Step 6: Commit** — `feat(domain): migration 031 for GST mode, default rate and optional item rates`

---

### Task 3: Server settings, catalog and CSV

**Files:**
- Modify: `apps/server/src/settings.ts`, `apps/server/src/catalog.ts`, `apps/server/src/catalog-transfer.ts`, `packages/domain/src/catalog-csv.ts`, `apps/server/src/demo-seed.ts`
- Test: `apps/server/src/settings.test.ts`, the catalog route tests (`catalog*.test.ts`), `apps/server/src/catalog-transfer.test.ts`, `packages/domain/src/catalog-csv.test.ts`

**Interfaces:**
- Consumes: `SettingsUpdate`, `ProductCreate` / `ProductUpdate` (Task 2).
- Produces: `GET /api/settings` → `settings.gstMode: GstMode`, `settings.gstRate: number` (no `taxInclusive` / `gstScheme`). `GET /api/products` adds `defaultGstRate: number` at the top level of its response. Product JSON `gstRate: number | null`.

- [ ] **Step 1: Write the failing tests**

- settings: the seeded profile equals `{ ..., gstMode: "included", gstRate: 5, ... }`; a `gstMode` + `gstRate` round trip; both preserved when omitted; `gstRate: 28`, `gstMode: "exclusive"` and `gstMode: null` → 400. Replace the old `gstScheme` test.
- catalog: a product created without `gstRate` returns `gstRate: null`; `PATCH { gstRate: 18 }` then `PATCH { gstRate: null }` round-trips; `GET /api/products` has `defaultGstRate: 5`, and `18` after `PUT /api/settings { gstRate: 18 }`.
- CSV: a header without `gst_rate` is accepted; a blank `gst_rate` imports as `null` (new items, and resets existing ones); `7` fails with `gst_rate must be blank, 0, 5, 12, 18 or 28.`; export writes a blank cell for `null` and `18` for an override; **export then import leaves every rate unchanged** (Review Focus).

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run apps/server/src/settings.test.ts apps/server/src/catalog-transfer.test.ts packages/domain/src/catalog-csv.test.ts apps/server/src/catalog.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

`settings.ts` reads and writes `gst_mode` / `gst_rate` with `COALESCE(?, column)`. `catalog.ts` stores `null` and returns `defaultGstRate` from settings. In `catalog-csv.ts` `gst_rate` leaves the required-column list; `catalog-transfer.ts` validates blank or `GST_RATES`, and keeps an existing item's rate when the column is absent. Demo seed omits `gstRate`.

- [ ] **Step 4: Run the tests to verify they pass** (same command)

- [ ] **Step 5: Commit** — `feat(server): GST mode and default rate settings, optional item rates in catalog and CSV`

---

### Task 4: Rate at punch, and the QR menu

**Files:**
- Create: `apps/server/src/gst-settings.ts`
- Modify: `apps/server/src/orders.ts` (around line 212, `gstRate: product.gst_rate`), `apps/server/src/guest-ordering.ts` (menu query near line 101, snapshot near 110, stale check near 227)
- Test: `apps/server/src/orders.test.ts`, `apps/server/src/guest-ordering.test.ts`, `apps/server/src/menu-experience.test.ts`

**Interfaces:**
- Consumes: `effectiveGstRate` (Task 1).
- Produces: `readGstSettings(db: Database): { gstMode: GstMode; gstRate: number }` in `gst-settings.ts`. Tasks 5 and 6 use it.

- [ ] **Step 1: Write the failing tests**

- orders, `"records the item override, else the default, at punch"`: a product with `gstRate: null` and one with `18`; punch both → snapshots 5 and 18. `PUT /api/settings { gstRate: 12 }`; punch the default item again → the new line is 12; **the first line is still 5** (Review Focus).
- guest ordering: the menu has no `taxInclusive` key (update the exact-keys assertions); `products[].gstRate` is the effective rate (5 for a default item); an accepted request's order item records the effective rate; changing the default rate changes `menuVersion`.

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run apps/server/src/orders.test.ts apps/server/src/guest-ordering.test.ts apps/server/src/menu-experience.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

`readGstSettings` selects `gst_mode, gst_rate` from settings. `orders.ts` and the guest menu query resolve rates with `effectiveGstRate(product.gst_rate, settings.gstRate)`. Remove `taxInclusive` from the guest menu, the guest receipt mapping, the `guest_requests` insert and the stale check (the menu version already covers rates).

- [ ] **Step 4: Run the tests to verify they pass** (same command)

- [ ] **Step 5: Commit** — `feat(server): resolve item GST rate at punch from override or restaurant default`

---

### Task 5: Billing, Zomato, receipts and credit notes

**Files:**
- Modify: `apps/server/src/billing.ts` (`priceOrder`, `issueBill` options), `apps/server/src/zomato-desk.ts` (line ~83), `apps/server/src/print/receipt.ts`, `apps/server/src/print/credit-note.ts`, `apps/server/src/print/restaurant-receipt-style.ts` (rules for the new GST block), `tools/preview-bills.ts`
- Test: `apps/server/src/billing.test.ts`, `apps/server/src/print/receipt.test.ts` (+ snapshot), `apps/server/src/print/upi.test.ts`, `apps/server/src/print/credit-note.test.ts`, `apps/server/src/zomato-desk.test.ts`, `apps/server/src/quick-takeaway.test.ts`, `apps/server/src/credit-notes.test.ts`

**Interfaces:**
- Consumes: `calculateBill(items, discount, mode)`, `receiptGstMode` (Task 1); `readGstSettings` (Task 4).
- Produces: `issueBill(db, orderId, { ..., gstMode?: GstMode, receiptExtra? })`. Zomato passes `gstMode: "none"`; other callers use the restaurant setting. The receipt snapshot always carries `gstMode`.

- [ ] **Step 1: Write the failing tests**

- billing: issuing in `included` mode stores `receipt.gstMode: "included"` and inclusive totals; in `none` mode `cgstPaise: 0` and `receipt.gstMode: "none"`; **a preview taken before `PUT /api/settings { gstMode: "none" }` is refused with 409 on issue** (Review Focus). Replace the old inclusive/exclusive/composition tests.
- receipts (all four styles × 58/80 mm and HTML):
  - `included` → `TAX INVOICE` / `<h2>Tax invoice</h2>`, then `Includes GST` **after** `TOTAL`, with `Taxable @ 5%`, `CGST 2.5%`, `SGST 2.5%`;
  - a mixed 5% + 18% bill shows both rate blocks (Review Focus);
  - `none` with a GSTIN → `BILL OF SUPPLY` + the declaration, no `CGST|SGST|Taxable|Includes GST`;
  - `none` with an empty GSTIN → `RESTAURANT BILL`, no declaration, no GST lines (Review Focus);
  - Zomato unchanged (`GST paid by Zomato (section 9(5))`, `RESTAURANT BILL`);
  - nowhere does `All prices include tax|GST added to menu prices|(included)` appear;
  - every thermal line fits 32/48 characters.
  Update the snapshot deliberately (`-u`) once the assertions pass and the snapshot diff has been read.
- credit notes: GST rows only when `receiptGstMode(bill.receipt) === "included"` (the composition test becomes a `gstMode: "none"` test).
- zomato-desk / quick-takeaway: replace `taxMode` / `taxInclusive` expectations with `gstMode`.

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run apps/server/src/billing.test.ts apps/server/src/print apps/server/src/zomato-desk.test.ts apps/server/src/quick-takeaway.test.ts apps/server/src/credit-notes.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

`priceOrder` takes the mode from `opts.gstMode ?? readGstSettings(db).gstMode`. `receipt.ts` picks the heading from `receiptGstMode` + GSTIN + `gstPaidBy`, moves the per-rate block after the total under `Includes GST`, and drops the old wording and the `inclusiveTaxNote` / `compositionNote` branches that no longer apply (the declaration constant stays). `credit-note.ts` uses `receiptGstMode`. Update `tools/preview-bills.ts` samples to the new modes (mixed-rate GST, no-GST with and without GSTIN, Zomato) and run it to confirm it still writes its files.

- [ ] **Step 4: Run the tests to verify they pass** (same command)

- [ ] **Step 5: Commit** — `feat(bills): tax invoice with an Includes GST block, bill of supply and plain no-GST bills`

---

### Task 6: Day-end report and dish costing

**Files:**
- Modify: `apps/server/src/reports.ts`, `apps/server/src/costing.ts`
- Test: the day-end tests in `apps/server/src/billing.test.ts` (or `reports.test.ts` if present), `apps/server/src/costing.test.ts`, `apps/server/src/operational-reports.test.ts`, `apps/server/src/order-analytics.test.ts`

**Interfaces:**
- Consumes: `readGstSettings` (Task 4), `receipt_json.gstMode` (Task 5).
- Produces: the day-end report adds `noGstSalesPaise: number`; `GET /api/costing/dishes` returns `gstMode: GstMode` instead of `taxInclusive`.

- [ ] **Step 1: Write the failing tests**

- day-end: issue one GST bill and one bill after switching to `none`; `taxes` lists only the GST bill's taxable value; `noGstSalesPaise` equals the no-GST bill total; `net.taxablePaise` excludes it; a refund on the no-GST bill reduces `creditNotes.totalPaise` but not `creditNotes.taxablePaise` or the credit tax rows; the Zomato figures are unchanged.
- costing: in `included` mode with default 5%, `preGstPaise` of a ₹105 item is ₹100; an 18% override item backs out 18%; in `none` mode `preGstPaise === pricePaise`; Zomato tier unchanged; the response has `gstMode`.

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run apps/server/src/billing.test.ts apps/server/src/costing.test.ts apps/server/src/operational-reports.test.ts apps/server/src/order-analytics.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

A bill is no-GST when `json_extract(b.receipt_json, '$.gstMode') = 'none'` and the order is not Zomato. Exclude such bills from `taxes`, add the `noGstSalesPaise` sum, and compute credited taxable / CGST / SGST and `creditTaxes` only for credit notes whose bill is not no-GST (join `credit_notes` to `bills`). Costing uses `effectiveGstRate` and `gstMode`.

- [ ] **Step 4: Run the tests to verify they pass** (same command)

- [ ] **Step 5: Commit** — `feat(reports): sales without GST on day-end, costing by effective rate`

---

### Task 7: UI

**Files:**
- Modify: `apps/ui/src/types.ts`, `apps/ui/src/screens/Settings.tsx`, `apps/ui/src/screens/ProductEditor.tsx`, `apps/ui/src/screens/Catalog.tsx`, `apps/ui/src/zomato-desk.ts`, `apps/ui/src/screens/BillingPanel.tsx`, `apps/ui/src/screens/CreditNoteDialog.tsx`, `apps/ui/src/screens/GuestMenu.tsx`, `apps/ui/src/screens/QrRequests.tsx`, `apps/ui/src/report-export.ts`, `apps/ui/src/screens/DayEnd.tsx`, `apps/ui/src/screens/DishCosting.tsx`
- Test: `apps/ui/src/zomato-desk.test.ts`, `apps/ui/src/report-export.test.ts`, `apps/ui/src/dish-costing.test.ts`

**Interfaces:**
- Consumes: the settings, products, bill, day-end and costing shapes from Tasks 3-6.
- Produces: `gstNote(receipt): string` and `billTaxRates(bill, receipt)` in `zomato-desk.ts` (replacing `taxModeNote`); `NO_GST_SALES_LABEL = "Sales without GST"` in `report-export.ts`.

- [ ] **Step 1: Write the failing tests**

- `gstNote`: Zomato → `GST paid by Zomato (section 9(5))`; `gstMode: "none"` → `No GST charged`; `included` → `Includes GST`. `billTaxRates` returns `[]` for Zomato and `none`, and the taxes otherwise.
- `dayEndCsv` contains a `Sales without GST` row with the report's `noGstSalesPaise`.
- Update the dish-costing helpers for `gstMode`.

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run apps/ui`
Expected: FAIL.

- [ ] **Step 3: Implement**

- Settings: a **GST** select (`Prices include GST` / `No GST charged`), plus **Default GST rate** (`5%`, `12%`, `18%`) shown only for `included`. Remove the old tax-mode select and the composition text.
- ProductEditor: GST options `Restaurant default ({defaultGstRate}%)` (value `""` → `null`), then `0%`…`28%`.
- Catalog list: `Default` or `{rate}%`.
- BillSummary: Subtotal, Discount, Round off, Payable, then `Includes GST ₹x` with per-rate rows under Tax details; nothing GST-related for `none` / Zomato.
- CreditNoteDialog: `Item value` when the bill is not `included`.
- GuestMenu: always `No tax is added to menu prices.`; QrRequests: `Menu subtotal`. DayEnd: the `Sales without GST` line next to the Zomato line. DishCosting: wording from `gstMode`.

- [ ] **Step 4: Run tests and the repo-wide checks**

Run: `npx vitest run apps/ui`, then `npm run typecheck`, then `npx vitest run`
Expected: UI tests pass; typecheck clean; full suite passes except the 2 known `captain-https` tests.

- [ ] **Step 5: Commit** — `feat(ui): GST settings, default item rate, Includes GST summaries, sales without GST`

---

### Task 8: Browser gates, docs and screenshots

**Files:**
- Modify: `tools/e2e/m4-billing.js`, `tools/e2e/m10-takeaway.js` (any other e2e script that sends `taxInclusive` or checks old bill wording — find them with `grep -rn "taxInclusive\|All prices include tax\|Prices include GST\|GST added" tools/e2e`), `docs/operations/bill-format.md`, `docs/operations/qr-ordering.md`, `docs/operations/rollout-checklist.md`, `docs/screenshots/restaurant-bill*.png`

**Interfaces:**
- Consumes: everything above.

- [ ] **Step 1: Update the e2e scripts**

`m4-billing`: switch between `gstMode: "included"` and `"none"` instead of inclusive/exclusive; check `Tax invoice` and `Includes GST` in the receipt frame, then `Restaurant bill` with no GST for `none` (the test restaurant has no GSTIN); an old bill keeps its mode after the switch. `m10-takeaway`: replace `taxInclusive: false` with the included mode and recompute the expected preview totals.

- [ ] **Step 2: Run the gates through the Playwright MCP**

Run `m4-billing`, `m10-takeaway`, `zomato-desk`, `report-export` and `catalog-transfer` against a scratch demo on port 4112.
Expected: every check passes.

- [ ] **Step 3: Update the docs and screenshots**

`bill-format.md`: replace the three-format section with the four bill types from spec §5, describe Settings > Tax and item overrides, and list the regenerated samples. `qr-ordering.md` and `rollout-checklist.md`: replace the tax-mode wording. Regenerate `restaurant-bill.png` (GST, mixed rates), `restaurant-bill-composition.png` (no GST with a GSTIN), `restaurant-bill-inclusive.png` → rename to `restaurant-bill-no-gst.png` (no GST, no GSTIN), and `restaurant-bill-styles.png`, from `tools/preview-bills.ts` output.

- [ ] **Step 4: Commit** — `test(e2e), docs: simple GST gates, guides and sample bills`
