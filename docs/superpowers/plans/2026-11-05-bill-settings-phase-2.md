# Bill settings Phase 2: invoice numbering and round-off. Implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Number bills `PREFIX/YY-YY/NNNN` and credit notes `CN/YY-YY/NNN` per financial year, and let the restaurant round bill totals to ₹1, ₹0.50 or not at all.

**Architecture:** Pure helpers in a new domain module (`invoice-numbers.ts`, `round-off.ts`) do the formatting, financial-year and rounding maths. The per-year counters use the existing `sequences` table (`invoice:<FY>`, `credit_note:<FY>`) through `nextSequence`, inside the issuing transaction. Migration 57 adds two settings columns and the stored number on `bills` and `credit_notes`. The internal integers `bill_no` and `cn_no` stay for paging, print-job labels and ordering. Every user-facing surface shows the stored string.

**Tech Stack:** TypeScript, zod, better-sqlite3 (`packages/domain`), Fastify (`apps/server`), React (`apps/ui`), vitest.

**Spec:** `docs/superpowers/specs/2026-11-05-bill-settings-design.md` (section "Phase 2"). **One change from the spec, approved 2026-11-05:** credit notes are `CN/25-26/001`, **without** the restaurant prefix, because `ABCD/CN/25-26/001` is 17 characters and GST allows 16. Because of this, the invoice prefix `CN` is rejected.

## Global Constraints

- Branch `feat/bill-settings`. **Migration number 57.** Re-check `packages/domain/src/migrations/index.ts` first, because other sessions add migrations too.
- Invoice number: `PREFIX/YY-YY/NNNN`, or `YY-YY/NNNN` with no prefix. Prefix: optional, up to 4 characters `[A-Z0-9]`, stored upper-case, never `CN`. The counter is zero-padded to 4 digits and grows to 5 when needed. Above 99,999 in one year it throws.
- Credit note: `CN/YY-YY/NNN`, zero-padded to 3 digits and growing as needed, with the same 99,999 limit.
- Financial year: 1 April – 31 March in **local time**. Sequence keys `invoice:2025-26` and `credit_note:2025-26`. A prefix change mid-year keeps the same counter.
- Round-off: `rupee` (default, nearest ₹1, half up), `half` (nearest ₹0.50, half up), `off` (no rounding). Column `round_off TEXT NOT NULL DEFAULT 'rupee' CHECK (round_off IN ('rupee','half','off'))`.
- Credit notes keep using each bill's stored rounding. Do not change `credit-notes.ts` money maths.
- Integer paise throughout. `bill_no` / `cn_no` stay as they are and are still written.
- Bills and credit notes from before migration 57 have NULL strings. They display as `String(bill_no)` and `` `CN-${cn_no}` `` (today's labels).
- **Working tree:** `BillingPanel.tsx`, `Settings.tsx`, `OrderScreen.tsx`, `types.ts` and several CSS files carry uncommitted changes from another session. Before Task 1, ask the user whether to commit or stash them. Never `git add` a file whose unrelated hunks are not yours.
- Out of scope (they keep the integer): custom report "Bill no." columns, staff-activity references, customer's-usual "from bill #N", print-job labels (`Bill #N`, `CN-N`), the Bills list `before=` paging cursor.

## Review Focus

1. **Typed prefix `"mp "` or `"cn"`.** Expect `"mp "` to save as `MP` and `"cn"` to be rejected with a clear message, because trim and upper-case run before the checks (Task 3 test).
2. **A bill attempt that fails or is replayed.** Expect no invoice number to be used up: a 409 preview-key mismatch, or a replay of the same `clientRef`, must not leave a gap in the series (Task 4 test).
3. **Bills issued before migration 57 (NULL `invoice_no`).** Expect them to keep loading, printing and appearing in GSTR-1 Table 13 as their own range next to the new series (Task 4 and Task 6 tests).
4. **Saving or sharing a digital bill.** The `/` in `MP/25-26/0001` is not allowed in file names, so the file must be named `Bill-MP-25-26-0001.html` (Task 2 test for `invoiceFileName`).
5. **A "No rounding" bill paid with paise, for example ₹123.45.** Expect it to settle exactly and to show no "Round off" line (Task 4 test).

---

### Task 1: Round-off modes in `calculateBill`

**Files:**
- Create: `packages/domain/src/round-off.ts`
- Modify: `packages/domain/src/billing.ts:130-167` (`calculateBill`), `packages/domain/src/index.ts` (export)
- Test: `packages/domain/src/billing.test.ts` (add a `describe("round-off")`)

**Interfaces:**
- Produces: `export const ROUND_OFF_MODES = ["rupee", "half", "off"] as const; export type RoundOff = (typeof ROUND_OFF_MODES)[number];` and `roundTotal(paise: number, mode: RoundOff): number`, plus `calculateBill(items, discountPaise = 0, mode: GstMode = "included", roundOff: RoundOff = "rupee"): BillTotals`.

- [ ] **Step 1: Write the failing tests.** Use one item `{ pricePaise: X, qty: 1, gstRate: 5 }` with `mode "none"` and assert `totalPaise` / `roundingPaise`:

```ts
it.each([
  [12325, "rupee", 12300, -25], [12350, "rupee", 12400, 50], [12375, "rupee", 12400, 25],
  [12325, "half", 12350, 25],   [12350, "half", 12350, 0],   [12375, "half", 12400, 25], [12310, "half", 12300, -10],
  [12345, "off", 12345, 0],
])("%i paise with %s rounds to %i (rounding %i)", (price, mode, total, rounding) => {
  const t = calculateBill([{ pricePaise: price, qty: 1, gstRate: 5 }], 0, "none", mode as RoundOff);
  expect(t.totalPaise).toBe(total); expect(t.roundingPaise).toBe(rounding);
});
it("defaults to nearest rupee", () => expect(calculateBill([{ pricePaise: 12350, qty: 1, gstRate: 5 }]).totalPaise).toBe(12400));
```

- [ ] **Step 2: Run** `npx vitest run packages/domain/src/billing.test.ts`. Expected: FAIL (`half` / `off` still round to ₹1).
- [ ] **Step 3: Implement** `roundTotal` in `round-off.ts`: `rupee` → `Math.floor((p + 50) / 100) * 100`, `half` → `Math.floor((p + 25) / 50) * 50`, `off` → `p`. Make `calculateBill` use it for `totalPaise`. Export the module from `index.ts`.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(domain): round-off modes for bill totals`.

### Task 2: Invoice and credit-note numbers (domain)

**Files:**
- Create: `packages/domain/src/invoice-numbers.ts`, `packages/domain/src/invoice-numbers.test.ts`
- Modify: `packages/domain/src/index.ts`, `packages/domain/package.json` (add `"./invoice-numbers": "./src/invoice-numbers.ts"` to `exports`)

**Interfaces:**
- Consumes: `nextSequence(db, name)` from `sequences.ts`.
- Produces:
  - `financialYear(ms: number): { key: string; short: string }`, for example `{ key: "2025-26", short: "25-26" }`. Local time; April (month index 3) or later starts a new year.
  - `formatInvoiceNo(prefix: string, fyShort: string, n: number): string`
  - `formatCreditNoteNo(fyShort: string, n: number): string`
  - `nextInvoiceNo(db: Database, prefix: string, ms: number): string`, which calls `nextSequence(db, \`invoice:${key}\`)`
  - `nextCreditNoteNo(db: Database, ms: number): string`, which calls `nextSequence(db, \`credit_note:${key}\`)`
  - `invoiceSeries(no: string): { series: string; n: number }`. It splits at the last `/`: `"MP/25-26/0007"` → `{ series: "MP/25-26", n: 7 }`, and a legacy `"12"` → `{ series: "", n: 12 }`.
  - `invoiceFileName(no: string): string`, for example `"MP/25-26/0001"` → `"Bill-MP-25-26-0001.html"`
  - `InvoicePrefix` (zod): `z.string().trim().toUpperCase().regex(/^[A-Z0-9]{0,4}$/, "Use up to 4 letters or digits").refine((v) => v !== "CN", "CN is kept for credit notes; choose another prefix")`
  - `INVOICE_COUNTER_MAX = 99_999`

- [ ] **Step 1: Write the failing tests:**
  - `formatInvoiceNo("MP", "25-26", 1)` → `"MP/25-26/0001"`; `formatInvoiceNo("", "25-26", 1)` → `"25-26/0001"`; `formatInvoiceNo("MP", "25-26", 12345)` → `"MP/25-26/12345"`.
  - `formatInvoiceNo("ABCD", "25-26", 99_999)` has `.length` 16; `formatInvoiceNo("MP", "25-26", 100_000)` throws.
  - `formatCreditNoteNo("25-26", 1)` → `"CN/25-26/001"`; with `1234` → `"CN/25-26/1234"`; with `100_000` it throws.
  - `financialYear(new Date(2026, 2, 31, 23, 59, 59, 999).getTime())` → `{ key: "2025-26", short: "25-26" }`; `new Date(2026, 3, 1, 0, 0)` → `{ key: "2026-27", short: "26-27" }`; `new Date(2026, 0, 15)` → `2025-26`; `new Date(2099, 11, 1)` → `{ key: "2099-00", short: "99-00" }`.
  - With `openDb(":memory:")` + `migrate(db, MIGRATIONS)`, two bills on 31 Mar 2026 (`MP`) give `MP/25-26/0001` and `MP/25-26/0002`. A bill on 1 Apr 2026 gives `MP/26-27/0001`. Changing the prefix to `"X1"` in the same year continues the counter: `X1/26-27/0002`. `nextCreditNoteNo` gives `CN/26-27/001` and is independent of the invoice counter.
  - `invoiceSeries` for both examples above; `invoiceFileName("MP/25-26/0001")` → `"Bill-MP-25-26-0001.html"`.
  - `InvoicePrefix.parse(" mp ")` → `"MP"`; `safeParse("cn")`, `safeParse("ABCDE")` and `safeParse("M-1")` fail; `parse("")` → `""`.
- [ ] **Step 2: Run** `npx vitest run packages/domain/src/invoice-numbers.test.ts`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement** the module per the interfaces. Pad with `padStart(4|3, "0")`; padding never truncates, so the counter grows on its own.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(domain): financial-year invoice and credit note numbers`.

### Task 3: Migration 57 and the settings round-trip

**Files:**
- Create: `packages/domain/src/migrations/invoice-numbering.ts`, `packages/domain/src/migrations/invoice-numbering.test.ts`
- Modify: `packages/domain/src/migrations/index.ts` (append `invoiceNumbering`), `packages/domain/src/settings-schemas.ts`, `apps/server/src/settings.ts` (SELECT, row mapping, UPDATE), `apps/ui/src/types.ts` (`SettingsData`)
- Test: `apps/server/src/settings.test.ts`

**Interfaces:**
- Consumes: `InvoicePrefix` (Task 2), `ROUND_OFF_MODES` / `RoundOff` (Task 1).
- Produces: settings columns `invoice_prefix`, `round_off`; `bills.invoice_no`; `credit_notes.credit_note_ref`; and the `SettingsUpdate` fields `invoicePrefix?: string` and `roundOff?: RoundOff`. `GET /api/settings` returns `invoicePrefix` and `roundOff`. `SettingsData` gains `invoicePrefix: string; roundOff: RoundOff`.

- [ ] **Step 1: Write the failing migration test**, following `bill-settings.test.ts`. Assert that `user_version >= 57` and that the settings row has `invoice_prefix: ""` and `round_off: "rupee"`. Assert that `UPDATE settings SET round_off = 'paise'` throws. Insert two bills (or two credit notes) with the same non-null `invoice_no` (or `credit_note_ref`) and assert the second insert throws. Two NULLs are allowed.
- [ ] **Step 2: Write the failing settings tests** in `settings.test.ts`:
  - PUT with `invoicePrefix: " mp "` and `roundOff: "half"`, then GET, returns `invoicePrefix "MP"` and `roundOff "half"`.
  - A PUT that omits both fields keeps the saved values (COALESCE, like the other optional fields).
  - `invoicePrefix: "cn"` returns 400, and the message contains "credit notes"; `"ABCDE"` returns 400; `roundOff: "paise"` returns 400.
- [ ] **Step 3: Run** `npx vitest run packages/domain/src/migrations/invoice-numbering.test.ts apps/server/src/settings.test.ts`. Expected: FAIL.
- [ ] **Step 4: Implement.** Migration `version: 57, name: "invoice_numbering"`:

```sql
ALTER TABLE settings ADD COLUMN invoice_prefix TEXT NOT NULL DEFAULT '' CHECK (length(invoice_prefix) <= 4);
ALTER TABLE settings ADD COLUMN round_off TEXT NOT NULL DEFAULT 'rupee' CHECK (round_off IN ('rupee','half','off'));
ALTER TABLE bills ADD COLUMN invoice_no TEXT;
CREATE UNIQUE INDEX bills_invoice_no ON bills(invoice_no);
ALTER TABLE credit_notes ADD COLUMN credit_note_ref TEXT;
CREATE UNIQUE INDEX credit_notes_ref ON credit_notes(credit_note_ref);
```

  (SQLite cannot `ADD COLUMN … UNIQUE`, so a unique index enforces it instead.) Then add `invoicePrefix: InvoicePrefix.optional()` and `roundOff: z.enum(ROUND_OFF_MODES).optional()` to `SettingsUpdate`. In `settings.ts`, add `invoice_prefix = COALESCE(?, invoice_prefix), round_off = COALESCE(?, round_off)` to the UPDATE and to the GET mapping.
- [ ] **Step 5: Run** the same command. Then run `npx vitest run packages/domain/src/migrations` to confirm that the other migration tests still pass. Expected: PASS.
- [ ] **Step 6: Commit** `feat(domain): migration 57, invoice prefix and round-off settings`.

### Task 4: Issue bills with invoice numbers and the round-off setting

**Files:**
- Modify: `packages/domain/src/billing.ts` (`Bill` gets `invoiceNo: string`), `apps/server/src/billing.ts` (`priceOrder`, `issueBill`, `loadBill`, `BillRow`, `/api/bills/:id/upi-qr` payload adds `invoiceNo`), `apps/server/src/print/bill-preview.ts` (`sampleBill`)
- Test: `apps/server/src/billing.test.ts`, plus the bill-preview test that already exists for `sampleBill` / `POST /api/settings/bill-preview` (find it with `grep -rl "bill-preview" apps/server/src/*.test.ts`)

**Interfaces:**
- Consumes: `nextInvoiceNo`, `financialYear`, `formatInvoiceNo` (Task 2); `calculateBill(…, roundOff)` (Task 1); the columns from Task 3.
- Produces: `Bill.invoiceNo` (`r.invoice_no ?? String(r.bill_no)`) on every bill the API returns. The UPI QR payload gains `invoiceNo: string`.

- [ ] **Step 1: Write the failing tests** in `billing.test.ts`. Use `vi.useFakeTimers({ toFake: ["Date"] })` + `vi.setSystemTime(...)` as `credit-notes.test.ts:282` does, and restore with `vi.useRealTimers()` in `afterEach`.
  - Bill at `new Date(2026, 2, 31, 22, 0)` → `invoiceNo "25-26/0001"`; next bill the same day → `"25-26/0002"`. Bill at `new Date(2026, 3, 1, 0, 5)` → `"26-27/0001"`.
  - Set the prefix to `MP` through PUT `/api/settings`. The next bill (still 26-27) → `"MP/26-27/0002"`.
  - Replay the last bill's request (same `clientRef`) → 200 with the same `invoiceNo`. A bill request with a stale `previewKey` → 409. The following real bill gets the next number, with no gap.
  - Set `roundOff: "off"`. An item priced 12345 paise bills `totalPaise 12345` and `roundingPaise 0`. Settling it with `[{ mode: "cash", amountPaise: 12345 }]` → 200, `status "paid"`, and `GET /api/bills/:id/receipt` contains no `Round off`.
  - Set `roundOff: "half"`. An item at 12375 → total 12400. The preview `previewKey` changes after switching `roundOff` from `rupee` to `half` on the same order, and an item at 12325 shows the difference: 12300 vs 12350.
  - Legacy fallback: `UPDATE bills SET invoice_no = NULL WHERE id = ?`, then `GET /api/bills/:id` → `invoiceNo === String(billNo)`.
  - Bill preview: `POST /api/settings/bill-preview` with `invoicePrefix: "MP"` returns HTML containing `MP/26-27/0001` (the sample date is 1 April 2026).
- [ ] **Step 2: Run** `npx vitest run apps/server/src/billing.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - `priceOrder` reads `round_off` from settings and passes it to `calculateBill`.
  - `issueBill` takes `now` before inserting. It computes `nextInvoiceNo(db, invoice_prefix, now)` in the same transaction and writes `invoice_no`. `bill_no` is still written.
  - `loadBill` sets `invoiceNo`.
  - `sampleBill` uses `s.roundOff ?? "rupee"` and `invoiceNo: formatInvoiceNo(s.invoicePrefix ?? "", financialYear(createdAt).short, 1)`.
  - Zomato bills (`zomato-desk.ts`) need no change: they go through `issueBill` and follow the setting.
- [ ] **Step 4: Run** the command again, then the whole server suite `npx vitest run apps/server`. Expected: PASS. Existing tests that compare whole bills can need `invoiceNo` added.
- [ ] **Step 5: Commit** `feat(server): issue bills with financial-year invoice numbers and the round-off setting`.

### Task 5: Credit-note numbers and every server-side print and share surface

**Files:**
- Modify: `packages/domain/src/billing.ts` (`BillCreditNote` gets `creditNoteRef: string`), `apps/server/src/credit-notes.ts` (`writeCreditNote` writes `credit_note_ref = nextCreditNoteNo(db, note.now)`; `loadBillCreditNotes` selects `COALESCE(c.credit_note_ref, 'CN-' || c.cn_no) AS creditNoteRef`), `apps/server/src/print/receipt.ts` (thermal `pair` at :123 and UPI line at :182, HTML `<title>`, `@page` footer and "Bill no." cell at :212-221 — all show `bill.invoiceNo`, with no `#`), `apps/server/src/print/upi.ts` (`tn: \`Bill ${bill.invoiceNo}\``), `apps/server/src/print/credit-note.ts` (`cnLabel` → `note.creditNoteRef`; "Against bill" → `bill.invoiceNo`), `apps/server/src/operational-reports.ts:122-129` (credit-notes table: `COALESCE(c.credit_note_ref, 'CN-' || c.cn_no)` and `COALESCE(b.invoice_no, b.bill_no)`), `apps/server/src/feedback.ts` (visit and feedback list add `invoiceNo`), `apps/server/src/customers.ts:123-127` (bills, ledger and feedback rows add `invoiceNo` via `COALESCE(b.invoice_no, CAST(b.bill_no AS TEXT))`)
- Test: `apps/server/src/credit-notes.test.ts`, `apps/server/src/print/receipt.test.ts`, `apps/server/src/credit-note-reports.test.ts`

**Interfaces:**
- Consumes: `nextCreditNoteNo` (Task 2), `Bill.invoiceNo` (Task 4).
- Produces: `BillCreditNote.creditNoteRef`; `invoiceNo: string` on the customer-profile bills, ledger and feedback rows and on the feedback visit payload (Task 7 reads these).

- [ ] **Step 1: Write the failing tests.**
  - `credit-notes.test.ts`: at a fixed date in 2026-27, the first refund is `creditNoteRef "CN/26-27/001"` and a void on another bill is `"CN/26-27/002"`. After `setSystemTime(new Date(2027, 3, 1, 9))`, the next one is `"CN/27-28/001"`. Issuing credit notes does not move the invoice counter.
  - `receipt.test.ts`: for a bill with `invoiceNo "MP/25-26/0007"`, `receiptHtml` contains `MP/25-26/0007` in `<title>` and in the bill-meta cell, and the thermal text (decode as the existing tests do) contains it. A `billUpiPayment(bill).uri` contains `tn=Bill%20MP%2F25-26%2F0007`.
  - `credit-note-reports.test.ts`: the operational "Credit notes" table row shows the `CN/…` reference and the bill's invoice number.
- [ ] **Step 2: Run** `npx vitest run apps/server/src/credit-notes.test.ts apps/server/src/print/receipt.test.ts apps/server/src/credit-note-reports.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the edits listed under Files. Print-job labels (`Bill #${billNo}`, `CN-${cnNo}`) stay unchanged.
- [ ] **Step 4: Run** `npx vitest run apps/server`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(server): credit note numbers per financial year; invoice numbers on prints and share text`.

### Task 6: GSTR-1 uses invoice numbers; Table 13 shows one range per series

**Files:**
- Modify: `packages/domain/src/gst-returns/facts.ts` (`GstBillFact.invoiceNo: string`, `GstCreditNoteFact.creditNoteRef: string` + `invoiceNo: string`), `packages/domain/src/gst-returns/gstr1.ts` (`DocRange`, `range`, `B2bInvoice`, `CreditNoteEntry`, docs), `packages/domain/src/gst-returns/gstr1-json.ts:38,43,51-53`, `packages/domain/src/gst-returns/report.ts:45-72`, `apps/server/src/gst-returns.ts:27-45` (select the two strings with the same COALESCE fallbacks)
- Test: `packages/domain/src/gst-returns/gstr1.test.ts`, `apps/server/src/gst-returns.test.ts`

**Interfaces:**
- Consumes: `invoiceSeries` (Task 2).
- Produces: `DocRange = { from: string; to: string; total: number; cancelled: number }` and `Gstr1Summary.docs: { invoices: DocRange[]; creditNotes: DocRange[] }`. `B2bInvoice` gains `invoiceNo`, and `CreditNoteEntry` gains `creditNoteRef` and `invoiceNo`.

- [ ] **Step 1: Write the failing domain tests** (`gstr1.test.ts`). Build facts directly:
  - Bills `MP/25-26/0001..0003` (0002 cancelled in period) and `X1/25-26/0004`. `docs.invoices` is `[{ from: "MP/25-26/0001", to: "MP/25-26/0003", total: 3, cancelled: 1 }, { from: "X1/25-26/0004", to: "X1/25-26/0004", total: 1, cancelled: 0 }]`, sorted by `from`.
  - A legacy bill `"12"` alongside them forms its own range `{ from: "12", to: "12", … }`.
  - The gap warning fires per series: `MP/25-26/0001` and `MP/25-26/0004` with nothing between produce a warning that names `MP/25-26/0001` and `MP/25-26/0004`.
  - Credit notes `CN/25-26/001..002` give one range.
  - `gstr1Json` uses `inv[].inum === "MP/25-26/0001"` and `nt[].nt_num === "CN/25-26/001"`. `doc_issue.doc_det` has `doc_num 1` with two `docs` entries numbered `num: 1, 2`. The Table 13 report rows show the full strings.
- [ ] **Step 2: Write the failing server test** (`gst-returns.test.ts`). Issue two bills with prefix `MP`, change the prefix to `X1`, issue one more, and refund one. The GSTR-1 report shows two invoice ranges and one credit-note range with the stored strings.
- [ ] **Step 3: Run** `npx vitest run packages/domain/src/gst-returns apps/server/src/gst-returns.test.ts`. Expected: FAIL.
- [ ] **Step 4: Implement.** Group the bills by `invoiceSeries(invoiceNo).series`. Within a group, `from` / `to` are the invoice strings with the smallest and largest `n`, `total` is the count, and `cancelled` is the count in `cancelledInPeriod`. Run the gap check per group (`maxN - minN + 1 !== total`). Remove the old `prefix` argument of `doc()` in `report.ts`.
- [ ] **Step 5: Run** the same command. Expected: PASS.
- [ ] **Step 6: Commit** `feat(gst): GSTR-1 invoice numbers and per-series documents issued`.

### Task 7: UI: Numbering & rounding settings and the invoice number on every screen

**Files:**
- Modify: `apps/ui/src/screens/BillSettings.tsx`. Add a `<fieldset className="bill-settings-group"><legend>Numbering &amp; rounding</legend>` between Tax and Printed bill.
- Modify, to show `invoiceNo` / `creditNoteRef` instead of `#billNo` / `CN-cnNo`: `apps/ui/src/screens/Bills.tsx:35` (paging at :40 keeps `billNo`), `BillingPanel.tsx:215,319,346,430`, `DigitalBillDialog.tsx:32-51` (file name via `invoiceFileName`), `UpiQrPreview.tsx:8,43,46`, `CreditNoteDialog.tsx:27-213` (the `Pick` adds `creditNoteRef`), `CustomerProfile.tsx:10-90,171`, `CustomerFeedback.tsx:7,49`, `FeedbackPage.tsx:4,44`
- Test: the UI test for Bill settings if one exists (`grep -rl "BillSettings" apps/ui/src --include=*.test.tsx`), otherwise the Playwright check in Step 5

**Interfaces:**
- Consumes: `SettingsData.invoicePrefix` / `roundOff` (Task 3); `Bill.invoiceNo`, `BillCreditNote.creditNoteRef`, and the payloads from Task 5; `financialYear`, `formatInvoiceNo`, `invoiceFileName` from `@masalapos/domain/invoice-numbers`.

- [ ] **Step 1: Build the Numbering & rounding group.** It has these controls:
  - **Invoice prefix**: `<input maxLength={4} autoCapitalize="characters" spellCheck={false}>`. On change, store `e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "")`. Hint (InfoTip): "Optional, up to 4 letters or digits. Bills are numbered {example} and start again at 0001 every 1 April." `{example}` is `formatInvoiceNo(form.invoicePrefix, financialYear(Date.now()).short, 1)`. A second hint line reads: "Credit notes are numbered CN/{fy}/001."
  - **Round off total**: `<select>` with `rupee` "To the nearest ₹1", `half` "To the nearest 50 paise", `off` "No rounding (exact paise)". Hint: "Applies to new bills. Refunds use each bill's own rounding."
  - Server errors for `invoicePrefix` show next to the field, the way the header and footer errors do (follow commit 2d38f5b).
- [ ] **Step 2: Replace the labels** in the files listed above, using `` `Bill ${invoiceNo}` `` and `creditNoteRef`. Aria labels and titles follow, for example `` `Receipt for bill ${bill.invoiceNo}` ``.
- [ ] **Step 3: Run** `npm run typecheck` (root) and `npx vitest run apps/ui`. Expected: PASS.
- [ ] **Step 4: Check in the dev app** (`npm run dev`, admin / demo1234):
  1. In Bill settings, set the prefix to `mp` (the field shows `MP`) and Round off to "No rounding", then save.
  2. Confirm that the preview shows `MP/<fy>/0001`.
  3. Issue a dine-in bill. The billing panel, Bills list, thermal print job text, A4 receipt and digital bill (download name `Bill-MP-…html`) all show `MP/<fy>/000N`.
  4. Refund one item. The credit note shows `CN/<fy>/001` and "Against bill MP/…".
  5. Export GSTR-1 JSON for the month. Confirm `inum` and `doc_issue`.
  6. Stop the dev server by PID.
- [ ] **Step 5: Commit** `feat(ui): invoice prefix and round-off settings; show invoice and credit note numbers`.

### Task 8: Docs and full verification

**Files:**
- Modify: `docs/operations/bill-format.md` (a section on invoice numbering, the credit-note format with the 16-character reason, and the round-off modes; update line 32's rounding note), `docs/superpowers/specs/2026-11-05-bill-settings-design.md` (credit-note format `CN/YY-YY/NNN`, prefix `CN` blocked, Phase 2 status: built)

- [ ] **Step 1: Update the two docs.**
- [ ] **Step 2: Run** `npm test` and `npm run typecheck` from the root. Expected: all green. Note the test counts in the commit body.
- [ ] **Step 3: Commit** `docs: invoice numbering and round-off`.
- [ ] **Step 4: Update the memory note** `bill-settings.md`: Phase 2 is built (migration 57); Phase 3 next is migration 58.
