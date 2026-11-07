# Bill settings Phase 3 — GST added on top: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A third GST mode, `exclusive` ("Prices exclude GST, added on the bill"), that adds CGST + SGST on top of the
discounted item value, and every screen, print, report and return that treats GST as charged.

**Architecture:** `GST_MODES` gains `exclusive`; migration 58 rebuilds `settings` to widen its CHECK. `calculateBill`
adds per-rate tax under `exclusive`. One domain helper, `billChargesGst(receipt)`, replaces the scattered
`gstMode === "included"` checks that really mean "this bill charged GST". Report lines stop deriving the discount from
tax-inclusive arithmetic. Credit notes and reports already work from stored line money, so they need only tests.

**Tech Stack:** TypeScript, zod, better-sqlite3, Fastify, React, vitest.

**Spec:** `docs/superpowers/specs/2026-11-05-bill-settings-design.md` (section "Phase 3 — GST added on top")

## Global Constraints

- Mode values: `included` = "Prices include GST", `exclusive` = "Prices exclude GST, added on the bill", `none` = "No GST charged".
- Exclusive per rate group: taxable = item amount − allocated discount (allocation unchanged); CGST = SGST = round-half-up(taxable × rate / 200); total before rounding = Σ taxable + Σ CGST + Σ SGST; then the round-off mode applies. Integer paise / BigInt only.
- Migration number is **58**; re-check `packages/domain/src/migrations/index.ts` before adding it.
- Zomato bills always pass `gstMode: "none"` with `gstPaidBy: "zomato"`; they never charge GST.
- An issued bill renders from its snapshot `gstMode`; changing the setting affects new bills only.
- The working tree has unrelated uncommitted UI edits from another session (`Settings.tsx`, `settings-sections*.ts`, CSS, AI screens). Stage only this plan's files, by path; never `git add -A`.

## Review Focus

1. **Exclusive without a GSTIN** — an unregistered restaurant must not add GST to bills. Settings `PUT` rejects `exclusive` when the merged GSTIN is blank (Task 1).
2. **Discount equal to the whole subtotal under exclusive** — taxable 0, tax 0, total 0, no negative report lines (Tasks 2, 3).
3. **Zomato order while the restaurant is `exclusive`** — total = subtotal − discount, no GST lines, GSTR-1 Table 14 (Task 4).
4. **Mode switched after issue** — an `included` bill reprinted after switching to `exclusive` still shows "Includes GST" (Task 4).
5. **0% item on an exclusive bill** — the 0% group adds nothing and the report line for it has discount ≥ 0 (Tasks 2, 3).

---

### Task 1: Mode, helper, migration 58, settings validation

**Files:**
- Modify: `packages/domain/src/gst.ts`, `packages/domain/src/index.ts`
- Create: `packages/domain/src/migrations/gst-exclusive.ts`, `packages/domain/src/migrations/gst-exclusive.test.ts`
- Modify: `packages/domain/src/migrations/index.ts`
- Modify: `apps/server/src/settings.ts`
- Test: `packages/domain/src/gst.test.ts`, `packages/domain/src/gst-schemas.test.ts:9`, `apps/server/src/settings.test.ts:196`

**Interfaces:**
- Produces: `GST_MODES = ["included", "exclusive", "none"]`; `billChargesGst(r: { gstMode: GstMode; gstPaidBy?: "zomato" | undefined }): boolean` (true when `gstPaidBy !== "zomato" && gstMode !== "none"`), exported from `@masalapos/domain` and `@masalapos/domain/gst`; migration `gstExclusive` (version 58, name `gst_exclusive`).

- [ ] **Step 1: Failing tests**
  - `gst.test.ts` "billChargesGst": `included` → true, `exclusive` → true, `none` → false, `{ gstMode: "included", gstPaidBy: "zomato" }` → false.
  - `gst-schemas.test.ts:9`: `gstMode: "exclusive"` now parses; `"inclusive"` (typo) is rejected.
  - `settings.test.ts:196`: drop `{ gstMode: "exclusive" }` from the invalid list; add "saves exclusive mode when a GSTIN is set" (round-trip `gstMode === "exclusive"`) and "rejects exclusive mode without a GSTIN" (400, message `Add your GSTIN before adding GST to bills`; also when the same request blanks the GSTIN).
  - `gst-exclusive.test.ts`: migrate to 57 (`MIGRATIONS.filter((m) => m.version <= 57)`), set `restaurant_name = 'Spice'`, `round_off = 'half'`, `invoice_prefix = 'MP'`; migrate fully; expect `user_version >= 58`, those values kept, `UPDATE settings SET gst_mode = 'exclusive'` succeeds, `gst_mode = 'bogus'` throws, and the rebuilt table still rejects `round_off = 'paise'` (CHECKs from earlier `ALTER TABLE`s survive).
- [ ] **Step 2: Run** `npx vitest run packages/domain/src/gst.test.ts packages/domain/src/gst-schemas.test.ts packages/domain/src/migrations/gst-exclusive.test.ts apps/server/src/settings.test.ts` — expect FAIL.
- [ ] **Step 3: Implement**
  - `gst.ts`: add `exclusive` to `GST_MODES` (update the doc comment for the three modes) and `billChargesGst`.
  - Migration: read `SELECT sql FROM sqlite_master WHERE type='table' AND name='settings'`; replace `CHECK (gst_mode IN ('included', 'none'))` with `CHECK (gst_mode IN ('included', 'exclusive', 'none'))` and `CREATE TABLE settings` with `CREATE TABLE settings_new`; throw if the CHECK text was not found; then `INSERT INTO settings_new SELECT * FROM settings; DROP TABLE settings; ALTER TABLE settings_new RENAME TO settings;`. Rebuilding from the stored SQL keeps every column other branches added. Register it after `invoiceNumbering`.
  - `settings.ts`: in the PUT handler, after merging with saved values, `if (gstMode === "exclusive" && !gstin.trim())` → `httpError(400, "Add your GSTIN before adding GST to bills")`.
- [ ] **Step 4: Run** the same command — expect PASS.
- [ ] **Step 5: Commit** `feat(domain): exclusive GST mode and migration 58`

### Task 2: `calculateBill` under `exclusive`

**Files:**
- Modify: `packages/domain/src/billing.ts:137-174`
- Test: `packages/domain/src/billing.test.ts`

**Interfaces:**
- Consumes: `GstMode` with `exclusive` (Task 1).
- Produces: `calculateBill(items, discountPaise, "exclusive", roundOff)` returning `BillTotals` where `subtotalPaise` is the pre-tax item total and `totalPaise = roundTotal(Σtaxable + cgst + sgst)`.

- [ ] **Step 1: Failing tests** (`describe("calculateBill exclusive")`)
  - Single rate: one item ₹100 @5% → taxes `[{ gstRate: 5, taxablePaise: 10000, cgstPaise: 250, sgstPaise: 250 }]`, total 10500, rounding 0.
  - Mixed with discount: ₹280 @5% + 2 × ₹90.13 @18%, discount ₹46.03 (4603). Assert each group's taxable = amount − its allocated discount (the same allocation the `included` call returns for `amount − (taxable+cgst+sgst)`), CGST = SGST = round-half-up(taxable × rate / 200) computed in the test with BigInt, and `totalPaise − roundingPaise` = Σtaxable + cgst + sgst.
  - Odd paisa: ₹1.01 @5% → taxable 101, cgst = sgst = 3 (101 × 5 / 200 = 2.525 → 3).
  - Round-off: ₹100.50 @5% (taxable 10050, cgst = sgst = 251, unrounded 10552): `rupee` → 10600 (+48), `half` → 10550 (−2), `off` → 10552 (0).
  - Full discount: ₹100 @5%, discount 10000 → taxable 0, cgst 0, total 0.
  - 0% group: ₹50 @0% + ₹100 @5% → 0% group has cgst 0, total 15500.
- [ ] **Step 2: Run** `npx vitest run packages/domain/src/billing.test.ts` — expect FAIL.
- [ ] **Step 3: Implement** in the `taxes` map: `if (mode === "exclusive")` → `half = Number((BigInt(gross) * BigInt(rate) + 100n) / 200n)`, return `{ taxablePaise: gross, cgstPaise: half, sgstPaise: half }`. Set `unrounded = subtotalPaise − discountPaise + (mode === "exclusive" ? cgstPaise + sgstPaise : 0)`; also check the total stays within the supported amount and throw `Bill exceeds supported amount` if not.
- [ ] **Step 4: Run** — expect PASS.
- [ ] **Step 5: Commit** `feat(domain): GST added on top in calculateBill`

### Task 3: Report lines and GST return facts

**Files:**
- Modify: `packages/domain/src/report-lines.ts:21-56`, `packages/domain/src/gst-returns/facts.ts:12-16`
- Test: the report-lines test (find with `grep -rl saveReportLines apps/server/src packages/domain/src --include=*.test.ts`), `packages/domain/src/gst-returns/gstr1.test.ts`

**Interfaces:**
- Consumes: `exclusive` totals from Task 2 (stored in `bill_taxes`).
- Produces: `billSupply({ gstMode: "exclusive", gstin })` → `"regular"`.

- [ ] **Step 1: Failing tests**
  - Report lines, exclusive bill with a discount and two rates: every line has `discount_paise >= 0`; Σ line discount = bill discount; Σ line total = bill total; per line `total = taxable + cgst + sgst + rounding`. Same assertions for an `included` and a `none` bill (regression).
  - `billSupply({ gstMode: "exclusive", gstin: "29ABCDE1234F1Z5" })` → `"regular"`; with `gstin: ""` → `"unregistered"`.
- [ ] **Step 2: Run** those test files — expect FAIL.
- [ ] **Step 3: Implement**
  - `saveReportLines`: read `json_extract(receipt_json, '$.gstMode')` with the bill; the group discount is `Σsubtotal − taxable` under `exclusive`, and `Σsubtotal − taxable − cgst − sgst` otherwise (a missing mode means `included`). The rest of the allocation is unchanged.
  - `billSupply`: `r.gstMode === "none" ? "composition" : "regular"`.
- [ ] **Step 4: Run** — expect PASS.
- [ ] **Step 5: Commit** `fix(domain): report lines and GST facts for GST added on top`

### Task 4: Server — snapshot, prints, costing, end-to-end tests

**Files:**
- Modify: `apps/server/src/billing.ts:110` (SAC code for both taxed modes: `mode !== "none"`)
- Modify: `apps/server/src/print/receipt.ts:52-60,147-165,208-240`
- Modify: `apps/server/src/print/credit-note.ts:46,79`
- Modify: `apps/server/src/costing.ts:54-58` (comment only: menu prices are pre-tax under `exclusive`; `taxInclusive = gstMode === "included"` is already right)
- Test: `apps/server/src/print/receipt.test.ts`, `apps/server/src/billing.test.ts`, `apps/server/src/credit-notes.test.ts`, `apps/server/src/gst-returns.test.ts`, `apps/server/src/costing.test.ts`, `apps/server/src/zomato-desk.test.ts`

**Interfaces:**
- Consumes: `billChargesGst` (Task 1), exclusive `calculateBill` (Task 2), fixed report lines (Task 3).

- [ ] **Step 1: Failing tests**
  - `receipt.test.ts`, exclusive bill (₹100 @5% + ₹200 @18%, discount ₹30): thermal and HTML say `TAX INVOICE`; show `CGST 2.5% on 95.00` / `SGST 2.5% on 95.00` style lines (rate and taxable value in the label, tax as the amount) **before** `Round off` and `TOTAL`; do not contain `Includes GST`. The item GST column/suffix shows when `billShow.itemGst` is on. An `included` snapshot still prints the `Includes GST` block after the total (Review Focus 4).
  - `billing.test.ts`: with GSTIN set and `gstMode: "exclusive"`, issue a bill → `totalPaise` = subtotal + tax (rounded), `receipt.gstMode === "exclusive"`, `receipt.sacCode === "996331"`; `GET /api/bills/:id` reprint returns the same totals after the setting is switched back to `included`; day report `cgstPaise`/`sgstPaise`/total match the bill.
  - `credit-notes.test.ts`: refund one of two units on an exclusive bill → credit total = half the bill's line total incl. tax; voiding the rest makes the credits sum to the bill total and `refundState === "refunded"`.
  - `gst-returns.test.ts`: an exclusive bill appears in GSTR-1 B2CS with its taxable and tax, and in GSTR-3B 3.1(a); not in CMP-08.
  - `zomato-desk.test.ts`: with the restaurant on `exclusive`, a Zomato order's bill has cgst 0, total = subtotal − discount (Review Focus 3).
  - `costing.test.ts`: under `exclusive` the dish's selling price is the menu price (nothing backed out).
- [ ] **Step 2: Run** `npx vitest run apps/server/src/print/receipt.test.ts apps/server/src/billing.test.ts apps/server/src/credit-notes.test.ts apps/server/src/gst-returns.test.ts apps/server/src/zomato-desk.test.ts apps/server/src/costing.test.ts` — expect FAIL on the new cases.
- [ ] **Step 3: Implement**
  - `receipt.ts`: `billHeading` → `TAX INVOICE` when `billChargesGst(r)`; `chargesGst` becomes `billChargesGst`; `includedGst` returns taxes only for `included`; a new `addedGst(bill)` returns taxes for `exclusive`. Thermal: after Discount, for each added rate `pair(\`CGST ${rate/2}% on ${money(taxable)}\`, money(cgst))` and the SGST line; HTML: the same as `<tr class="tax">` rows before Round off.
  - `credit-note.ts`: both checks become `billChargesGst(r)` (thermal tax lines) / `!billChargesGst(r)` (`supply`).
- [ ] **Step 4: Run** — expect PASS. Then `npm test --workspace apps/server` (or the repo's server test script) — expect all green.
- [ ] **Step 5: Commit** `feat(server): bills, prints and returns for GST added on top`

### Task 5: UI

**Files:**
- Modify: `apps/ui/src/screens/BillSettings.tsx:51-66` (third option, rate select shown for both taxed modes, InfoTip text)
- Modify: `apps/ui/src/zomato-desk.ts:36-45` (`gstNote`, `billTaxRates`)
- Modify: `apps/ui/src/screens/BillingPanel.tsx:32-50` (`BillSummary`)
- Modify: `apps/ui/src/screens/CreditNoteDialog.tsx:257`
- Modify: `apps/ui/src/dish-costing.ts:9-11`, `apps/ui/src/types.ts:95` (comment)
- Test: `apps/ui/src/zomato-desk.test.ts`, `apps/ui/src/bill-summary.test.ts`, `apps/ui/src/dish-costing.test.ts`

**Interfaces:**
- Consumes: `billChargesGst` from `@masalapos/domain/gst`.

- [ ] **Step 1: Failing tests**
  - `gstNote({ gstMode: "exclusive" })` → `"GST added on the bill"`; `billTaxRates(bill, { gstMode: "exclusive" })` returns `bill.taxes`.
  - `bill-summary.test.ts`: an exclusive summary lists `CGST` and `SGST` amounts in the totals between Discount and Round off and does not render `Includes GST`; an included summary still renders `Includes GST ₹x`.
  - `costingPriceNote("exclusive")` → `"each selling price before GST (GST is added on the bill)"`.
- [ ] **Step 2: Run** `npx vitest run apps/ui/src/zomato-desk.test.ts apps/ui/src/bill-summary.test.ts apps/ui/src/dish-costing.test.ts` — expect FAIL.
- [ ] **Step 3: Implement**
  - `BillSettings.tsx`: options in the Global Constraints order and labels; `onChange` maps the value through `GST_MODES` (fall back to `included`); show Default GST rate when `form.gstMode !== "none"`; InfoTip adds "With GST added on the bill, menu prices are before tax and CGST and SGST are added to each bill; this needs your GSTIN."
  - `billTaxRates` uses `billChargesGst`; `BillSummary` uses `!billChargesGst(gst)` for `noGst`, and under `exclusive` adds `<dt>CGST</dt><dd>…</dd><dt>SGST</dt><dd>…</dd>` to `amounts` and skips `includes`.
  - `CreditNoteDialog.tsx:257`: `!billChargesGst(bill.receipt)` instead of `gstMode !== "included"`.
- [ ] **Step 4: Run** — expect PASS; then `npm run typecheck` at the root — expect no errors.
- [ ] **Step 5: Commit** `feat(ui): GST added on the bill in Bill settings, billing and credit notes`

### Task 6: Docs, e2e script and full verification

**Files:**
- Modify: the operator doc that explains GST modes (find with `grep -rl "Prices include GST" docs`), `tools/e2e/m4-billing.js` (add an `exclusive` round: ₹100 @5% → total 10500, cgst 250, gstMode `exclusive`)
- Modify: `docs/superpowers/specs/2026-11-05-bill-settings-design.md` status line → "Phases 1–3 built"

- [ ] **Step 1:** Update the docs and e2e script as above.
- [ ] **Step 2:** `npm test` and root `npm run typecheck` — expect all green; note the counts.
- [ ] **Step 3:** Dev app (`npm run dev`, admin / demo1234): set a GSTIN, switch Bill settings to "Prices exclude GST, added on the bill", watch the live preview add CGST/SGST; issue a bill with a discount; check the thermal print job, the A4 receipt, the digital bill, a refund, and the GSTR-1 export. Stop the dev server by PID.
- [ ] **Step 4: Commit** `docs: GST added on the bill`
