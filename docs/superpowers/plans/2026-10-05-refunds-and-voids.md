# Refunds and Voids Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let staff void a whole bill or refund chosen items after payment, recorded as dated, numbered credit notes that reports subtract on their own date, with admin-PIN approval for cashiers.

**Architecture:** New append-only tables (`credit_notes`, `credit_note_lines`, `credit_note_taxes`, `refund_payments`) hold every void/refund; bills are never edited except a void setting the existing `void` status. Pure domain functions compute exact credits from each bill's stored `bill_report_lines`. A server module serves preview/void/refund/receipt routes; every report switches to "bills by issue date minus credit notes by their date"; the bill view gains Void/Refund dialogs.

**Tech Stack:** TypeScript (strict), better-sqlite3, Zod 4, Fastify 5, React 19, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-05-refunds-and-voids-design.md`

## Global Constraints

- Migration number: **025**; it only creates tables/indexes/triggers — never rebuilds or edits existing tables.
- Stored `bills.status` stays `unpaid | paid | void`; a void sets `void`. Bill JSON adds derived `refundState: "none" | "partly_refunded" | "refunded"`.
- Credit note number from sequence `credit_note_no`, displayed `CN-<n>`.
- Credit math: refunding `q` of `n` units → `round(field × q / n)` half away from zero per field, except the last units of a line take the exact remainder; a bill's credit notes always sum exactly to its `total_paise`.
- Permission `bills.refund` (admin via `*`, cashier via `bills.*`). Cashier requests need `approverPin` of an active admin; admins approve themselves. Wrong PIN → `401 "Admin PIN is incorrect"`, counted by the same per-IP throttle as login (`429` in cooldown).
- Exact errors: `"This older bill can only be voided"`, `"This bill changed — review again"`, `"Refund amounts must equal the credit note total"`, `"Refund by <mode> cannot exceed what was paid by <mode>"`, `"Nothing left to refund on this bill"`.
- Reports: all issued bills by issue date (void bills included) minus credit notes by `credit_notes.created_at`; refunds subtract from collections by refund date and method.
- No stock changes on void or refund.
- Git: never stage `output/`, `.codex/`, `.superdesign/`, the file `({text`, or the `.claude/settings.json` deletion; stage only task files.

## Review Focus

1. **Three partial refunds of a discounted, multi-rate bill must add up exactly to the bill total** (no paisa lost or gained). Test in Task 1.
2. **Voiding yesterday's bill today must not change yesterday's day-end, GST or collections** — only today's. Test in Task 5.
3. **Refunding by a method the guest didn't pay with** (cash refund of a UPI bill) must be refused with the per-method message. Test in Task 4.
4. **Double-tap on Confirm** (same clientRef twice) must create one credit note, one CN number. Test in Task 3.
5. **Cashier guessing admin PINs** — after 5 wrong PINs the next attempt is throttled (429) even with the right PIN until cooldown. Test in Task 2.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `packages/domain/src/migrations/025-credit-notes.ts` (+ test) | Tables, indexes, append-only triggers, sequence row |
| `packages/domain/src/credit-notes.ts` (+ test) | Pure credit math, refund state, per-method limits, request schemas, types |
| `apps/server/src/pin-throttle.ts` | Per-IP PIN throttle shared by login and approval (extracted from auth.ts) |
| `apps/server/src/credit-notes.ts` (+ test) | Approval, preview/void/refund routes, bill credit JSON |
| `apps/server/src/billing.ts` | `getBill` adds `creditNotes`, `refundState`, per-item `refundedQty` |
| `apps/server/src/reports.ts`, `sales-reports.ts`, `operational-reports.ts`, `order-analytics.ts`, `costing.ts` (+ tests) | Net-of-credit-notes reporting; new `credit-notes` operational report |
| `apps/server/src/print/credit-note.ts` (+ test) | Credit-note HTML and thermal slip |
| `apps/ui/src/credit-note-form.ts` (+ test), `apps/ui/src/screens/CreditNoteDialog.tsx`, `apps/ui/src/screens/BillingPanel.tsx` | Dialog logic, dialog, bill-view wiring |
| `docs/operations/refunds-and-voids.md`, `APPLICATION_OVERVIEW.md` | Docs |

---

### Task 1: Migration 025 and credit math

**Files:**
- Create: `packages/domain/src/migrations/025-credit-notes.ts` (+ `.test.ts`), `packages/domain/src/credit-notes.ts` (+ `.test.ts`)
- Modify: `packages/domain/src/migrations/index.ts`, `packages/domain/src/index.ts`, `packages/domain/src/migrations/001-initial.test.ts` (table list), `packages/domain/src/roles.ts` (comment: `bills.refund`)

**Interfaces:**
- Produces tables per spec §3 (`credit_notes` with `cn_no UNIQUE`, `kind CHECK ('void','refund')`, `client_ref NOT NULL UNIQUE`, `request_json NOT NULL`; `credit_note_lines` PK `(credit_note_id, order_item_id)`, `qty > 0`; `credit_note_taxes` PK `(credit_note_id, gst_rate)`; `refund_payments` `mode CHECK ('cash','upi','card')`, `amount_paise > 0`); indexes on `credit_notes(bill_id)`, `credit_notes(created_at)`, `refund_payments(credit_note_id)`; update/delete triggers with message containing `append-only`; `INSERT INTO sequences (name, value) VALUES ('credit_note_no', 0)`.
- Produces (`credit-notes.ts`):
  - `type Money = { taxablePaise: number; cgstPaise: number; sgstPaise: number; roundingPaise: number; totalPaise: number }`
  - `interface BillLine extends Money { orderItemId: string; qty: number; name: string; categoryId: string | null; categoryName: string; gstRate: number }`
  - `interface Credited extends Money { qty: number }` (already credited per order item)
  - `interface CreditDraft { lines: Array<BillLine>; taxes: Array<{ gstRate: number; taxablePaise: number; cgstPaise: number; sgstPaise: number }>; totals: Money }` (draft lines carry the credited qty and money)
  - `creditFor(lines: BillLine[], credited: Record<string, Credited>, requested: Array<{ orderItemId: string; qty: number }>): CreditDraft` — throws `"Nothing left to refund on this bill"` when the result is empty, and an Error naming the item when a qty exceeds what remains or the item isn't on the bill.
  - `voidRemainder(lines: BillLine[], credited: Record<string, Credited>): CreditDraft` (all remaining units).
  - `refundState(billTotalPaise: number, creditedTotalPaise: number): "none" | "partly_refunded" | "refunded"`.
  - `refundableByMode(paid: Array<{ mode: PayMode; amountPaise: number }>, refunded: Array<{ mode: PayMode; amountPaise: number }>): Record<PayMode, number>` where `PayMode = "cash" | "upi" | "card"`.
  - Schemas: `CreditPreview = { kind: "void" | "refund"; lines?: [{ orderItemId, qty: int ≥ 1 }] }`; `VoidBill = { clientRef (8–64), reason (trim 1–200), refunds: [{ mode, amountPaise: int > 0, refNote?: ≤ 100 }] (default []), approverPin?: 4–6 digits }`; `RefundBill = VoidBill & { lines: [{ orderItemId, qty }] (≥ 1) }`. All `.strict()`.

- [ ] **Step 1: Write failing tests**
  - Migration: tables exist; triggers block update/delete (`/append-only/`); duplicate `cn_no` and `client_ref` rejected; `kind: 'swap'` and `amount_paise: 0` rejected; `credit_note_no` sequence row exists; existing bills untouched.
  - `"credits proportional shares and gives the last units the remainder"`: line `{ qty: 3, taxable 30001, cgst 750, sgst 750, rounding -1, total 31500 }` refunded 1 → `{ taxable 10000, cgst 250, sgst 250, rounding 0, total 10500 }`; then 1 more → same; then the last 1 → `{ taxable 10001, cgst 250, sgst 250, rounding -1, total 10500 }`; the three sum to the line exactly.
  - `"keeps a discounted multi-rate bill exact across three partial refunds"` (Review Focus 1): build lines at GST 5 and 18 with an allocated discount and rounding; refund in three steps; sums of all credit fields equal the bill line sums and the bill total.
  - `"groups credit taxes by GST rate"`.
  - `"voids only what remains after partial refunds"`.
  - `"refuses over-refund, unknown items and empty refunds"` with the messages above.
  - `refundState(10000, 0) === "none"`, `(10000, 4000) === "partly_refunded"`, `(10000, 10000) === "refunded"`.
  - `refundableByMode([{cash:6000},{upi:4000}], [{cash:1000}])` → `{ cash: 5000, upi: 4000, card: 0 }`.
- [ ] **Step 2: Run** `npx vitest run packages/domain/src/credit-notes.test.ts packages/domain/src/migrations/025-credit-notes.test.ts` → FAIL.
- [ ] **Step 3: Implement** the migration (register after `migration024`) and `credit-notes.ts`; export from `packages/domain/src/index.ts`. Use integer math with `BigInt` for `field × q / n` and half-away-from-zero rounding.
- [ ] **Step 4: Run** `npx vitest run packages/domain` and `npx tsc --noEmit -p .` → PASS.
- [ ] **Step 5: Commit** — `feat(domain): credit notes schema and credit math`.

---

### Task 2: Approval, preview and bill credit data

**Files:**
- Create: `apps/server/src/pin-throttle.ts`, `apps/server/src/credit-notes.ts` (`registerCreditNotes(app)`), `apps/server/src/credit-notes.test.ts`
- Modify: `apps/server/src/auth.ts` (use the shared throttle; behaviour unchanged), `apps/server/src/billing.ts` (`getBill`), `apps/server/src/server.ts` (register after `registerBilling`), `packages/domain/src/billing.ts` (`Bill` type)

**Interfaces:**
- Consumes: Task 1 functions and schemas.
- Produces:
  - `pin-throttle.ts`: `pinCooldown(ip: string): boolean`, `recordPinFailure(ip: string): void`, `clearPinFailures(ip: string): void` — the existing login constants (5 failures, 2 s doubling to 60 s), one shared Map per server instance (create it in a factory `createPinThrottle()` decorated as `app.pinThrottle`, so tests stay isolated).
  - `resolveApprover(app, req, approverPin?: string): { id: string; name: string }` in `credit-notes.ts` — admin requester → self; else requires `approverPin`, checks cooldown (429 `"too many attempts"`), verifies against active admins' `pin_hash` with `verifyPassword`, records failure → 401 `"Admin PIN is incorrect"`, missing PIN → 403 `"Admin approval is required"`.
  - `loadBillCredit(db, billId): { lines: BillLine[]; credited: Record<string, Credited>; paid: Array<{mode, amountPaise}>; refunded: Array<{mode, amountPaise}>; creditedTotalPaise: number }`.
  - `POST /api/bills/:id/credit-preview` (`bills.refund`) body `CreditPreview` → `{ preview: { lines, taxes, totals, refundable: { cash, upi, card, total } } }`; for a bill without report lines and `kind: "refund"` → 409 `"This older bill can only be voided"`; for `kind: "void"` on such a bill the credit equals the bill totals with taxes from `bill_taxes`.
  - `Bill` JSON (domain type + `getBill`) gains `refundState`, `creditNotes: Array<{ id; cnNo; kind; reason; createdAt; totalPaise; taxablePaise; cgstPaise; sgstPaise; requestedByName; approvedByName; refunds: Array<{ mode; amountPaise; refNote }>; lines: Array<{ orderItemId; name; qty; totalPaise }> }>`, and `refundedQty: Record<string, number>` keyed by order item id.

- [ ] **Step 1: Write failing tests:** preview of a partial refund on a paid bill returns the exact credit and `refundable`; preview on an older bill without report lines (delete its `bill_report_lines` in setup is blocked by triggers — instead create the bill row directly in SQL without lines) → 409 for refund, success for void; cashier without PIN → 403; wrong PIN → 401; **5 wrong PINs then the right one → 429** (Review Focus 5); right PIN → approver is the admin; admin needs no PIN; login throttle still works (existing auth tests pass unchanged); a paid bill's JSON has `refundState: "none"`, `creditNotes: []`, `refundedQty: {}`.
- [ ] **Step 2: Run** `npx vitest run apps/server/src/credit-notes.test.ts` → FAIL. **Step 3: Implement.** **Step 4: Run** `npx vitest run apps/server` and `npx tsc --noEmit -p .` → PASS.
- [ ] **Step 5: Commit** — `feat(server): credit preview, admin approval and bill credit data`.

---

### Task 3: Void route

**Files:** Modify `apps/server/src/credit-notes.ts`, `apps/server/src/credit-notes.test.ts`

**Interfaces:**
- Consumes: Task 2 helpers; `nextSequence(db, "credit_note_no")`; `activeLinkedTableNames`/link query from `apps/server/src/table-label.ts` for broadcasting linked tables.
- Produces: `POST /api/bills/:id/void` (`bills.refund`) body `VoidBill` → `201 { bill, creditNote, order }`; identical retry `200` (same body); reused `clientRef` with a different body → 409 `"Credit note reference already used for a different request"`. One transaction: idempotency → approval → bill must be `unpaid` or `paid` with remaining credit (else 409 `"Nothing left to refund on this bill"`; `void` → 409 `"This bill is already void"`) → draft via `voidRemainder` → refunds: unpaid bill requires `refunds: []`; paid bill requires sum = money still held and per-method limits → insert credit note, lines, taxes, refund payments → `bills.status = 'void'` → unpaid bill: order `status='cancelled', closed_at=now, cancel_reason=reason` → after commit broadcast `order.updated`, `table.changed` for the order's table and active linked tables (captured before commit).

- [ ] **Step 1: Write failing tests:** void unpaid table bill → credit note `CN-1`, no refunds, bill `void`, order cancelled, table free; void paid bill with UPI refund → credit total = bill total, refund rows match; void after a partial refund (insert via the refund route in Task 4 — for now insert a prior credit note directly in SQL) credits only the remainder; **same clientRef twice → one credit note, cn_no unchanged** (Review Focus 4); different body same ref → 409; voiding a void bill → 409; voided bill can't be settled (existing settle check); no `stock_moves` rows added.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** `npx vitest run apps/server` → PASS.
- [ ] **Step 5: Commit** — `feat(server): void bills as credit notes`.

---

### Task 4: Refund route

**Files:** Modify `apps/server/src/credit-notes.ts`, `apps/server/src/credit-notes.test.ts`

**Interfaces:**
- Produces: `POST /api/bills/:id/refund` (`bills.refund`) body `RefundBill` → same response/idempotency contract as void. Rules: bill `status === 'paid'` with remaining credit; draft via `creditFor`; `sum(refunds) === draft.totals.totalPaise` else 400 `"Refund amounts must equal the credit note total"`; each mode ≤ `refundableByMode` else 400 `"Refund by <mode> cannot exceed what was paid by <mode>"`; stored status stays `paid`; derived `refundState` updates. Concurrent change between preview and submit surfaces as 409 `"This bill changed — review again"` when a requested qty no longer fits.

- [ ] **Step 1: Write failing tests:** refund 1 of 2 items (cash) → `partly_refunded`, `refundedQty` updated; refund the rest → `refunded`; over-refund → 400/409 with message; **cash refund on an all-UPI bill → 400 per-method message** (Review Focus 3); split refund cash+UPI within limits succeeds; amounts not matching total → 400; refund on unpaid bill → 409; refund on void bill → 409; older bill → 409 `"This older bill can only be voided"`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** — `feat(server): partial refunds as credit notes`.

---

### Task 5: Reports net of credit notes

**Files:** Modify `apps/server/src/reports.ts`, `apps/server/src/sales-reports.ts`, `apps/server/src/operational-reports.ts`, `apps/server/src/order-analytics.ts`, `apps/server/src/costing.ts`, `packages/domain/src/operational-reports.ts` (+ their tests)

**Interfaces:**
- Day-end (`/api/reports/day-end`) response gains `creditNotes: { count: number; taxablePaise; cgstPaise; sgstPaise; totalPaise; taxes: Array<{ gstRate; taxablePaise; cgstPaise; sgstPaise }> }` and `refunds: Array<{ mode; amountPaise }>`; existing `sales`/`taxes` stay gross (now including void bills by issue date); add `net: { totalPaise; taxablePaise; cgstPaise; sgstPaise }` and per-mode `payments` become net of refunds dated that day (field `netPayments`). Keep existing fields so the UI keeps working; the day-end UI shows the new block (Task 7).
- Sales report per day: add `creditNotePaise` and `netTotalPaise`; collections per day subtract refunds by method.
- Operational items/categories subtract `credit_note_lines` by credit-note date; cashiers subtract refunds against `requested_by`; hourly uses net; remove `status != 'void'` filters everywhere.
- New operational kind `"credit-notes"` (`{ id: "credit-notes", title: "Credit notes" }` in `OPERATIONAL_REPORTS`; add to the server `z.enum`): one row per credit note with columns `cnNo` ("CN"), `date` (time), `billNo` ("Bill"), `kind`, `reason`, `requestedBy`, `approvedBy`, `refundModes`, `taxable` (money), `gst` (money), `total` (money); totals row.
- Order analytics and Food cost & profit: revenue net of credit-note lines dated in range; costing cost unchanged.

- [ ] **Step 1: Write failing tests:** **void a bill issued yesterday, today → yesterday's day-end/GST/collections unchanged; today's show the credit note and net figures** (Review Focus 2; set bill `created_at` to yesterday via SQL); item report net quantity after a partial refund; cashier report subtracts the requester's refund; credit-notes report lists the note with both names; profit revenue drops by the credit taxable.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** `npx vitest run` and `npx tsc --noEmit -p .` and `npm run typecheck -w @forkflow/ui` → PASS.
- [ ] **Step 5: Commit** — `feat(server): reports net of credit notes`.

---

### Task 6: Credit-note slip

**Files:** Create `apps/server/src/print/credit-note.ts` (+ test); modify `apps/server/src/credit-notes.ts`, `apps/server/src/print/queue.ts` (`PrintJobJson.kind` adds `"credit_note"`), `apps/ui/src/types.ts` (`PrintJob.kind`)

**Interfaces:**
- Produces: `creditNoteHtml(note: CreditNoteView, bill: Bill): string` and `creditNoteSlip(note: CreditNoteView, bill: Bill, paperWidth: 58 | 80, profile?): Buffer` — header from the bill's receipt snapshot (name, address, GSTIN), `CREDIT NOTE CN-<n>`, `Against Bill #<billNo>` and its date, item lines with qty and amount, GST per rate, `TOTAL REFUNDED ₹…` (or `BILL VOIDED` for an unpaid void), refund methods, reason, `Approved by <name>`. HTML escapes all text like `receiptHtml`.
- Routes: `GET /api/credit-notes/:id/receipt` (`bills.read`) HTML with the same headers as the bill receipt route; `POST /api/credit-notes/:id/print` (`bills.print`) `{ printerId }` → 202 `{ job }`, kind `"credit_note"`, receipt profile.

- [ ] **Step 1: Write failing tests:** slip bytes contain `CREDIT NOTE CN-1`, `Bill #`, the item, `TOTAL REFUNDED`; HTML escapes a reason containing `<script>`; print route queues a `"credit_note"` job.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** — `feat(server): credit note receipts and printing`.

---

### Task 7: Bill view dialogs and day-end display

**Files:** Create `apps/ui/src/credit-note-form.ts` (+ test), `apps/ui/src/screens/CreditNoteDialog.tsx`; modify `apps/ui/src/screens/BillingPanel.tsx`, `apps/ui/src/screens/DayEnd.tsx`, `apps/ui/src/report-export.ts` (+ test), `apps/ui/src/types.ts` if needed

**Interfaces:**
- Produces (`credit-note-form.ts`):
  - `defaultRefundRows(paid: Array<{ mode; amountPaise }>, refundable: Record<PayMode, number>, totalPaise: number): Array<{ mode; amountPaise }>` — proportional to what each method still holds; remainder to the largest; omits zero rows.
  - `refundRowsError(rows, totalPaise, refundable): string | null` — returns the server's exact messages for total mismatch / per-method excess; `null` when valid.
  - `REFUND_REASONS = ["Wrong item", "Quality complaint", "Long wait", "Guest changed mind", "Other"]`.
- UI: in the bill view (BillingPanel, when a bill exists and the user is admin or cashier) buttons **Void bill** (unpaid or paid with remaining credit) and **Refund items** (paid with remaining credit). `CreditNoteDialog` per spec §7: item steppers (refund only) bounded by billed − refunded with "All remaining"; reason picker + text; server preview; refund rows from `defaultRefundRows`, live `refundRowsError`; "Admin approval" PIN input only for cashiers; confirm `"Refund ₹<total> as credit note"` / `"Void bill"`; own `clientRef` and in-flight guard; on success show `CN-<n>` with **Print credit note** (printer select) and **View** (opens `/api/credit-notes/:id/receipt`). Unpaid void text: `"This cancels the bill and frees the table"`.
- Bill view shows status badge from `status`/`refundState` (Paid / Partly refunded / Refunded / VOID), a credit-note list (number, date, kind, amount, reason, requested/approved by, reprint), and per-line `"n billed · m refunded"`.
- Day-end screen shows the credit-notes block and net figures; `dayEndCsv` includes credit-note rows.

- [ ] **Step 1: Write failing tests** for `defaultRefundRows` (single method; split proportional; respects refundable caps), `refundRowsError` (exact messages), and `dayEndCsv` credit-note rows.
- [ ] **Step 2: Run** `npx vitest run apps/ui` → FAIL. **Step 3: Implement.** **Step 4: Run** `npx vitest run apps/ui`, `npm run typecheck -w @forkflow/ui`, `npm run build -w @forkflow/ui` → PASS.
- [ ] **Step 5: Commit** — `feat(ui): void and refund bills with credit notes`.

---

### Task 8: Docs and end-to-end check

**Files:** Create `docs/operations/refunds-and-voids.md`; modify `APPLICATION_OVERVIEW.md` (migrations 001–025; Billing row adds credit-note tables; API table adds the routes; section 6 Billing bullets; section 13 Payments row: refunds/voids implemented, payment-method correction not), `docs/operations/rollout-checklist.md` (section 7 adds a refund and a void check)

- [ ] **Step 1: Write the guide:** when to void vs refund; credit notes and dates (closed days never change); admin PIN approval; choosing refund methods; reading day-end and the Credit notes report; printing credit notes; older bills void-only; no stock change.
- [ ] **Step 2: Update** overview and rollout checklist.
- [ ] **Step 3: Full checks:** `npx tsc --noEmit -p .`, `npm run typecheck -w @forkflow/ui`, `npx vitest run`, `npm run build -w @forkflow/ui`, `npm run test:packaging`.
- [ ] **Step 4: Browser check** on `.e2e-scratch/refunds` (server source with tsconfig paths, built UI, port 4100): pay a bill and refund one item in cash as a cashier with admin PIN; void a paid UPI bill; void an unpaid table bill and confirm the table frees; check day-end net figures, the Credit notes report and a printed/viewed credit note. Record results; stop servers; delete the scratch dir.
- [ ] **Step 5: Commit** — `docs: refunds and voids guide`.
