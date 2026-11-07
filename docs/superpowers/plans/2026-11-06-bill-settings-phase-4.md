# Bill settings Phase 4 — service and packaging charges: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A percentage service charge on dine-in bills (the cashier can remove it) and a flat packaging charge on
takeaway and delivery bills. Both are taxed at the default GST rate under the restaurant's GST mode, credited by a
full refund or a void, and counted in the bill-level and GST reports.

**Architecture:** `calculateBill` takes a list of charges and returns them as `charges` on `BillTotals`. Each charge
is taxed on its own and its tax joins that rate's group in `taxes`. Charges are stored in a new `bill_charges` table,
credited through a new `credit_note_charges` table, and summed into a new `bills.charges_paise` column. Item report
lines take the charges out of the rate groups before allocating, so item-level reports never see them.

**Deviation from the spec (approve before building):** the spec says charges get "their own report lines (no order
item)". `bill_report_lines` and `credit_note_lines` both require an order item (`NOT NULL REFERENCES order_items`,
part of the primary key) and are read by about 12 item-level queries that would all need a "not a charge" filter.
`bill_charges` / `credit_note_charges` carry the same money columns and serve the same purpose. Bill-level reports
(day end, sales, GST returns) read `bills`, `bill_taxes` and `credit_note_taxes`, which include the charges, so the
reports still cover them.

**Tech Stack:** TypeScript, zod, better-sqlite3, Fastify, React, vitest.

**Spec:** `docs/superpowers/specs/2026-11-05-bill-settings-design.md` (section "Phase 4 — service and packaging charges")

## Global Constraints

- Migration number is **59**, name `bill_charges`; re-check `packages/domain/src/migrations/index.ts` first (other sessions add migrations).
- Settings: `service_charge_bp INTEGER NOT NULL DEFAULT 0 CHECK (service_charge_bp BETWEEN 0 AND 2000)`, `packaging_charge_paise INTEGER NOT NULL DEFAULT 0 CHECK (packaging_charge_paise BETWEEN 0 AND 100000)`, `service_charge_label TEXT NOT NULL DEFAULT 'Service charge'`, `packaging_charge_label TEXT NOT NULL DEFAULT 'Packaging'`. Labels are 1–24 characters after trimming; a blank label saves the default.
- Service charge = round-half-up((subtotal − discount) × bp / 10,000) and applies to dine-in orders only (`orders.type = 'dine_in'`). Packaging applies to `parcel` orders whose order type kind (`order_types.kind` of `COALESCE(orders.order_type_id, orders.type)`) is `takeaway` or `delivery`. Zomato orders get neither charge.
- Each charge's GST rate is the restaurant's default rate (`settings.gst_rate`). `exclusive`: taxable = amount, CGST = SGST = round-half-up(amount × rate / 200), added on top. `included`: the amount contains the tax, split the same way as an item group. `none`: untaxed. A charge whose amount is 0 is left off the bill.
- The cashier can remove the service charge on any bill, with no reason or approval: `BillPreview.serviceCharge: boolean` (default `true`). A removed charge is recorded on the snapshot as `serviceChargeRemoved: true`.
- Integer paise / BigInt only. Bill identity: `total = subtotal − discount + Σ charge.amountPaise + (exclusive ? cgst + sgst : 0) + rounding`.
- Rounding stays on item report lines; charges carry none. Σ item report-line totals + Σ charge totals (`taxable + cgst + sgst`) = bill total.
- The working tree has unrelated uncommitted UI edits from another session (`Settings.tsx`, `settings-sections*.ts`, CSS, AI and catalog screens). Stage only this plan's files, by path; never `git add -A`. If a file this plan changes already has someone else's edits (`SalesReports.tsx`), stage only the hunks for this plan (`git add -p`) or ask first.

## Review Focus

1. **Discount equal to the subtotal on a takeaway bill**: service is 0 but packaging still applies; the total equals the packaging amount (plus its tax under `exclusive`) and no report line goes negative (Tasks 2 and 3).
2. **Refunding the last items in two partial refunds**: the first credit leaves the charges on the bill; the second includes them and the bill reaches `refunded`. A void after a partial refund credits the remaining items plus the charges (Task 4).
3. **Settings or order type changed between preview and issue**: the preview fingerprint changes and issuing returns 409 "Order changed" (Task 3).
4. **A rate group that holds only a charge** (items at 5%, default rate 18%): `bill_taxes` has an 18% row, report lines skip it, and GSTR-1 reports it (Tasks 3 and 5).
5. **A reprint after the settings change**: an issued bill keeps its stored charges and labels (Task 3).

---

### Task 1: Settings columns, migration 59, settings API

**Files:**
- Create: `packages/domain/src/migrations/bill-charges.ts`, `packages/domain/src/migrations/bill-charges.test.ts`
- Modify: `packages/domain/src/migrations/index.ts`, `packages/domain/src/settings-schemas.ts`, `apps/server/src/settings.ts`, `apps/server/src/gst-settings.ts`
- Test: `apps/server/src/settings.test.ts`, the settings-schema test (`grep -l SettingsUpdate packages/domain/src/*.test.ts`)

**Interfaces:**
- Produces: `SettingsUpdate` fields `serviceChargeBp?: number` (int 0–2000), `packagingChargePaise?: number` (int 0–100000), `serviceChargeLabel?: string`, `packagingChargeLabel?: string`; `readSettings` returns all four. `readBillingSettings(db)` additionally returns `{ gstRate, serviceChargeBp, packagingChargePaise, serviceChargeLabel, packagingChargeLabel }`.
- Produces tables: `bill_charges(bill_id TEXT NOT NULL REFERENCES bills(id), kind TEXT NOT NULL CHECK (kind IN ('service','packaging')), label TEXT NOT NULL, percent_bp INTEGER, gst_rate INTEGER NOT NULL, amount_paise INTEGER NOT NULL, taxable_paise INTEGER NOT NULL, cgst_paise INTEGER NOT NULL, sgst_paise INTEGER NOT NULL, PRIMARY KEY (bill_id, kind))`; `credit_note_charges(credit_note_id TEXT NOT NULL REFERENCES credit_notes(id), kind …same CHECK, label, gst_rate, taxable_paise, cgst_paise, sgst_paise, total_paise, PRIMARY KEY (credit_note_id, kind))`; column `bills.charges_paise INTEGER NOT NULL DEFAULT 0`. Both new tables get `_no_update` / `_no_delete` triggers in the baseline's style (`RAISE(ABORT, 'bill charges are immutable')`).

- [ ] **Step 1: Failing tests**
  - `bill-charges.test.ts`: migrate to 58, migrate fully; `user_version >= 59`; the settings defaults are 0 / 0 / `Service charge` / `Packaging`; `service_charge_bp = 2001` and `packaging_charge_paise = -1` throw; inserting then updating a `bill_charges` row throws `bill charges are immutable`.
  - Schema: `serviceChargeBp: 2000` parses, `2001` and `12.5` fail; `packagingChargePaise: 100001` fails; a 25-character label fails.
  - `settings.test.ts`: round-trip `{ serviceChargeBp: 1000, packagingChargePaise: 2000, serviceChargeLabel: "Service", packagingChargeLabel: "Box" }`; an unrelated save that omits the four keeps them; `serviceChargeLabel: "  "` saves `Service charge`.
- [ ] **Step 2: Run** `npx vitest run packages/domain/src/migrations/bill-charges.test.ts apps/server/src/settings.test.ts` plus the schema test. Expected: FAIL.
- [ ] **Step 3: Implement.** Add the migration (`ALTER TABLE settings ADD COLUMN …` with the CHECKs, `ALTER TABLE bills ADD COLUMN charges_paise …`, the two tables and their triggers) and register it after `gstExclusive`. Add the schema fields: a label is `z.string().trim().max(24)`, and the server maps `""` to the default. The settings `UPDATE` uses `COALESCE(?, column)` for the four values, as it does for `round_off`.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(domain): service and packaging charge settings and migration 59`

### Task 2: `calculateBill` with charges

**Files:**
- Modify: `packages/domain/src/billing.ts`
- Test: `packages/domain/src/billing.test.ts`

**Interfaces:**
- Produces: `type ChargeKind = "service" | "packaging"`; `type ChargeInput = { kind: "service"; label: string; gstRate: number; bp: number } | { kind: "packaging"; label: string; gstRate: number; amountPaise: number }`; `interface ChargeLine { kind: ChargeKind; label: string; percentBp?: number; gstRate: number; amountPaise: number; taxablePaise: number; cgstPaise: number; sgstPaise: number }` (`percentBp` is set for service, for printing); `BillTotals.charges?: ChargeLine[]` (always set by `calculateBill`; optional so older payloads and fixtures still type-check); `calculateBill(items, discountPaise, mode, roundOff, charges: ChargeInput[] = [])`. All are exported from `@masalapos/domain`.

- [ ] **Step 1: Failing tests** (`describe("calculateBill charges")`)
  - Service under `included`: ₹1,000 @5%, discount ₹100, service 1000 bp → service amount 9000 with `percentBp: 1000`; the 5% tax group is items + charge (taxable + cgst + sgst = 90000 + 9000); total 99000.
  - Service under `exclusive`: same → service amount 9000, charge cgst = sgst = 225; total = 90000 + 9000 + Σ tax (items 2250 + 2250, charge 225 + 225), then rounded.
  - Service under `none`: total 99000 and every tax is 0.
  - Packaging 2000 at 18% under `exclusive`, items at 5% → `taxes` has a 5% and an 18% row; the 18% row is exactly the charge (taxable 2000, cgst = sgst = 180).
  - Odd paisa: service 1250 bp on a ₹10.01 base → amount = round-half-up(1001 × 1250 / 10000) = 125.
  - Full discount: service amount 0 → no service in `charges`; packaging 2000 → total 2000 (`included`).
  - Each round-off mode applies after the charges (`rupee` on an unrounded x.50).
- [ ] **Step 2: Run** `npx vitest run packages/domain/src/billing.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Price each charge (the service base is `subtotal − discount`) and tax it like a single-item group with the same three-mode code. Pull that code into a `taxGroup(gross, rate, mode)` helper used by both items and charges. Merge charge tax into `taxes` by rate (rows stay sorted by rate), add the charge amounts to `unrounded`, and keep the supported-amount check after them.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(domain): service and packaging charges in calculateBill`

### Task 3: Issuing bills with charges; report lines

**Files:**
- Modify: `apps/server/src/billing.ts` (`priceOrder`, `issueBill`, `loadBill`, `preview`), `packages/domain/src/billing.ts` (`BillPreview.serviceCharge`, `ReceiptSnapshot.orderTypeKind?: "dine_in" | "takeaway" | "delivery" | "aggregator"`, `ReceiptSnapshot.serviceChargeRemoved?: true`), `packages/domain/src/report-lines.ts`
- Test: `apps/server/src/billing.test.ts`, `apps/server/src/zomato-desk.test.ts`, the report-lines test (`grep -rl saveReportLines --include=*.test.ts apps packages`)

**Interfaces:**
- Consumes: `calculateBill(..., charges)` and `ChargeLine` (Task 2); `readBillingSettings` charge fields (Task 1).
- Produces: `Bill.charges: ChargeLine[]` read from `bill_charges` (kind order: service, packaging); `issueBill` opts `serviceCharge?: boolean` (default true); `bills.charges_paise = Σ charge.amountPaise`.

- [ ] **Step 1: Failing tests**
  - `billing.test.ts`, with service 1000 bp and packaging 2000: a dine-in bill has a `service` charge and no packaging. A built-in takeaway (`parcel`) bill and a parcel bill on a custom `delivery` order type have `packaging` only. `receipt.orderTypeKind` is set in each case.
  - Preview with `serviceCharge: false` → no service charge, a different `previewKey`, and the issued bill has `receipt.serviceChargeRemoved === true`. Issuing with the old key → 409.
  - Changing `serviceChargeBp` between preview and issue → 409 "Order changed; review a fresh bill preview" (Review Focus 3).
  - Reprint after setting the charges back to 0 → the same charges and labels (Review Focus 5).
  - Day report: `cgstPaise` / `sgstPaise` / `totalPaise` include the charge tax (an `exclusive` bill).
  - `zomato-desk.test.ts`: with both charges set, a Zomato bill has `charges: []`.
  - Report lines (for `included`, `exclusive` and `none`; service + packaging; a discount; items at 5% with an 18% default rate): every line has `discount_paise >= 0`; Σ line discount = bill discount; Σ line total + Σ charge (taxable + cgst + sgst) = bill total; there is no line for a charge (Review Focus 1, 4).
- [ ] **Step 2: Run** `npx vitest run apps/server/src/billing.test.ts apps/server/src/zomato-desk.test.ts` plus the report-lines test. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - In `priceOrder`, take a new `serviceCharge` argument. Read the order kind with one query (`SELECT o.type, t.kind FROM orders o LEFT JOIN order_types t ON t.id = COALESCE(o.order_type_id, o.type) WHERE o.id = ?`). Build the `ChargeInput[]` from the Global Constraints rules and pass it to `calculateBill`. Put `orderTypeKind` (and `serviceChargeRemoved` when a service charge was due but removed) on the receipt.
  - The fingerprint already hashes `totals`; also hash `serviceCharge`.
  - `issueBill` inserts the `bill_charges` rows and `charges_paise` before `saveReportLines`.
  - `saveReportLines` reads `bill_charges` and subtracts each charge's taxable / cgst / sgst from its rate's `bill_taxes` row before computing the group discount. A group with no item lines is skipped.
- [ ] **Step 4: Run.** Expected: PASS. Then `npm test --workspace apps/server`. Expected: all green.
- [ ] **Step 5: Commit** `feat(server): service and packaging charges on bills`

### Task 4: Credit notes with charges

**Files:**
- Modify: `packages/domain/src/credit-notes.ts`, `apps/server/src/credit-notes.ts`, `packages/domain/src/billing.ts` (`BillCreditNote.charges`)
- Test: `packages/domain/src/credit-notes.test.ts`, `apps/server/src/credit-notes.test.ts`

**Interfaces:**
- Consumes: `Bill.charges` / `bill_charges` (Task 3).
- Produces: `interface BillChargeCredit extends Money { kind: ChargeKind; label: string; gstRate: number }` (rounding is always 0); `CreditDraft.charges: BillChargeCredit[]`; `creditFor(lines, credited, requested, charges: BillChargeCredit[] = [], creditedKinds: ChargeKind[] = [])` and `voidRemainder(lines, credited, charges = [], creditedKinds = [])`; `BillCredit.charges` / `BillCredit.creditedCharges`; `BillCreditNote.charges: Array<{ kind: ChargeKind; label: string; totalPaise: number }>`.

- [ ] **Step 1: Failing tests**
  - Domain: a partial refund → `draft.charges` is empty. Refunding all remaining units → it includes every charge not yet credited, `taxes` includes the charge tax at its rate, and `totals.totalPaise` = items + charges. A void after a partial refund → remaining items + charges. A charge in `creditedKinds` is never credited twice.
  - Server, dine-in `exclusive` bill with a service charge: refund 1 of 2 units → no charge credited and `partly_refunded`. Refund the other unit → the note has `charges[0].kind === "service"`, credits sum to the bill total, and the bill is `refunded`. A second bill: refund 1 unit, then void → the void credits the remaining unit plus the charge, and `credit_note_taxes` sum to `bill_taxes` (Review Focus 2).
  - `credit-preview` returns `charges` in its preview.
- [ ] **Step 2: Run** `npx vitest run packages/domain/src/credit-notes.test.ts apps/server/src/credit-notes.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** After building `out`, if every line's credited qty plus this note's qty equals its billed qty, append the charges whose kind is not in `creditedKinds`. `taxes = groupTaxes([...out, ...charges])` and `totals = sumMoney([...out, ...charges])`. On the server, `loadBillCredit` reads `bill_charges` (total = taxable + cgst + sgst) and the kinds already in `credit_note_charges`; `writeCreditNote` inserts the draft's charges; `loadBillCreditNotes` returns each note's charges. "Nothing left to refund" now also requires that no charge is left.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat: credit service and packaging charges on full refunds and voids`

### Task 5: Prints, settings preview, day-end and sales reports

**Files:**
- Modify: `apps/server/src/print/receipt.ts` (thermal ~149-156, HTML ~238-243), `apps/server/src/print/credit-note.ts` (thermal ~39-51, HTML ~93-103), `apps/server/src/print/bill-preview.ts` (`sampleBill` passes the form's charges; the sample is dine-in, so it shows the service charge), `apps/server/src/settings.ts` (the preview handler fills the charge fields from saved settings, like the toggles), `apps/server/src/reports.ts:36-41`, `apps/server/src/sales-reports.ts:9,13,52-56`
- Test: `apps/server/src/print/receipt.test.ts`, `apps/server/src/print/credit-note.test.ts`, `apps/server/src/print/bill-preview.test.ts`, `apps/server/src/reports.test.ts`, `apps/server/src/sales-reports.test.ts`, `apps/server/src/gst-returns.test.ts`

**Interfaces:**
- Consumes: `Bill.charges` (with `percentBp`), `BillCreditNote.charges`.
- Produces: `chargesPaise` on the day-end `sales` object and on each `Sales` row (`SUM(charges_paise)`).

- [ ] **Step 1: Failing tests**
  - Receipt, thermal and HTML: an `exclusive` bill with a service charge prints `Service charge 10%` with `money(amount)` after Discount and before the CGST lines, and the CGST line for that rate includes the charge's taxable value. A packaging charge prints its label with no percentage. An `included` bill prints the charge line before Round off, and its Includes GST block includes the charge tax. A bill without charges prints exactly as before.
  - Credit note: a note with a charge lists it as a line (`Service charge` and its total) after the items.
  - `sampleBill({ ..., serviceChargeBp: 1000 })` HTML contains `Service charge 10%`; with 0 it does not.
  - Day-end and sales reports: `chargesPaise` = the bills' charge amounts.
  - GSTR-1: a takeaway bill with an 18% packaging charge on 5% items has an 18% B2CS row (Review Focus 4).
- [ ] **Step 2: Run** those test files. Expected: FAIL.
- [ ] **Step 3: Implement.** A charge's printed label is `label`, plus ` ${percentBp / 100}%` when `percentBp` is set.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(server): print and report service and packaging charges`

### Task 6: UI

**Files:**
- Modify: `apps/ui/src/screens/BillSettings.tsx` (new `Charges` fieldset between "Numbering & rounding" and "Printed bill"), `apps/ui/src/types.ts` (`SettingsData` fields), `apps/ui/src/screens/BillingPanel.tsx` (`BillSummary` charge rows; a "Service charge" checkbox), `apps/ui/src/screens/CreditNoteDialog.tsx:256` (charge lines in the preview), `apps/ui/src/screens/DayEnd.tsx`, `apps/ui/src/sales-report.ts`, `apps/ui/src/report-export.ts`, `apps/ui/src/screens/SalesReports.tsx` (Charges column / row)
- Test: `apps/ui/src/bill-summary.test.ts`, `apps/ui/src/sales-report.test.ts` (if present; otherwise the nearest report-export test)

**Interfaces:**
- Consumes: `ChargeLine`, `BillTotals.charges`, `BillPreview.serviceCharge`, `chargesPaise`.

- [ ] **Step 1: Failing tests.** `BillSummary` with charges lists each charge (`Service charge 10%` ₹90.00) between Discount and CGST/Round off; without charges it renders as before. The sales-report rows and export include a Charges column.
- [ ] **Step 2: Run** `npx vitest run apps/ui/src/bill-summary.test.ts` plus the report test. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - Charges group:
    - "Service charge (%)" is a number input, step 0.01, 0–20, shown as `bp / 100` and saved as `Math.round(value × 100)`.
    - "Service charge label" and "Packaging label" are text inputs, max 24, placeholder the default label.
    - "Packaging charge (₹)" is a number input, 0–1000, saved in paise.
    - The InfoTip reads: "Service charge is added to dine-in bills only; staff can remove it on any bill. Packaging is added to takeaway and delivery bills. Both are taxed at your default GST rate and follow your GST setting. Zomato orders get neither."
  - The billing panel shows a "Service charge" checkbox (checked by default, reset per order) when the order is dine-in and either the preview has a service charge or the cashier has unticked it. The checkbox sends `serviceCharge` in the preview and create bodies.
- [ ] **Step 4: Run** the tests, then the root `npm run typecheck`. Expected: PASS and no type errors.
- [ ] **Step 5: Commit** `feat(ui): service and packaging charges in Bill settings, billing and reports`

### Task 7: Docs, e2e script, full verification

**Files:**
- Modify: `docs/operations/bill-format.md` (charges section), `docs/operations/gst-returns.md` (charges are taxable supplies at the default rate), `tools/e2e/bill-settings.js` or `tools/e2e/m4-billing.js` (a dine-in bill with 10% service: ₹100 @5% `included` → total 11000; a takeaway with ₹20 packaging), the spec status line → "Phases 1–4 built" with a note on the `bill_charges` deviation.

- [ ] **Step 1:** Update the docs and the e2e script as above.
- [ ] **Step 2:** Run `npm test` and the root `npm run typecheck`. Expected: all green; note the counts.
- [ ] **Step 3:** In the dev app (`npm run dev`, admin / demo1234):
  - Set 10% service and ₹20 packaging, and watch the live preview.
  - Issue a dine-in bill, then untick the service charge on a second one.
  - Issue a takeaway bill.
  - Check the thermal print job, the A4 receipt, the digital bill, a full refund and the GSTR-1 export.
  - Stop the dev server by PID.
- [ ] **Step 4: Commit** `docs: service and packaging charges`
