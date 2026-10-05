# Refunds and Voids — Design

**Date:** 5 October 2026
**Status:** Approved in conversation; awaiting written-spec review

## 1. Goal

A restaurant can cancel a wrong bill or return money after payment, safely, with records that stay correct for GST filing and the cash drawer.

Success means:

- A whole bill (paid or unpaid) can be voided, and chosen items on a paid bill can be refunded.
- Every void or refund is a dated, numbered **credit note** recorded on the day it happens; the original bill and closed days never change.
- Day-end, GST, collections and item reports show credit notes as deductions on their own date, so the cash drawer balances and filed GST matches the app.
- Cashiers can start a void or refund only with an administrator's PIN approval; both names are recorded.

## 2. Decisions

| Topic | Decision |
| --- | --- |
| Situations covered | Void a wrong bill (whole bill, paid or unpaid); refund money after payment |
| Accounting | Separate numbered credit notes (CN-1, CN-2…) dated when they happen; original bills never edited; reports subtract credit notes on their own date |
| Approval | Cashier initiates; an active admin approves by entering their PIN on the same screen; an admin performing it approves themselves |
| Partial refunds | By item and quantity, valued from the bill's stored per-item lines (after discount, with GST and round-off) |
| Refund money | Staff choose method(s) and amounts (cash, UPI, card), defaulting to how the guest paid; never more than was paid by each method |
| Stock | No change — voided/refunded food was already prepared |
| Storage | New append-only credit-note tables; the stored bill status only uses the existing `void`; "partly refunded"/"refunded" are derived from credit notes |
| Out of scope | Correcting a payment's method; reopening a bill to edit the order; free-amount goodwill refunds; restocking |

## 3. Data model (migration 025)

### `credit_notes` (append-only)

| Column | Type | Notes |
| --- | --- | --- |
| `id` | TEXT PK | uuidv7 |
| `cn_no` | INTEGER NOT NULL UNIQUE | from sequence `credit_note_no`; shown as `CN-<n>` |
| `bill_id` | TEXT NOT NULL | FK `bills(id)` |
| `kind` | TEXT NOT NULL | `CHECK (kind IN ('void','refund'))` |
| `reason` | TEXT NOT NULL | 1–200 chars |
| `taxable_paise`, `cgst_paise`, `sgst_paise`, `rounding_paise`, `total_paise` | INTEGER NOT NULL | credited amounts |
| `requested_by` | TEXT NOT NULL | FK `users(id)` |
| `approved_by` | TEXT NOT NULL | FK `users(id)`, an admin |
| `created_at` | INTEGER NOT NULL | the credit note's date for all reporting |
| `client_ref` | TEXT NOT NULL UNIQUE | retry reference |
| `request_json` | TEXT NOT NULL | retry fingerprint |

### `credit_note_lines` (append-only)

`credit_note_id` FK, `order_item_id` FK, `name`, `category_id`, `category_name`, `gst_rate` (REAL), `qty` (INTEGER > 0), `taxable_paise`, `cgst_paise`, `sgst_paise`, `rounding_paise`, `total_paise`. PK `(credit_note_id, order_item_id)`.

### `credit_note_taxes` (append-only)

`credit_note_id` FK, `gst_rate`, `taxable_paise`, `cgst_paise`, `sgst_paise`. PK `(credit_note_id, gst_rate)`.

### `refund_payments` (append-only)

`id` PK, `credit_note_id` FK, `mode` `CHECK (mode IN ('cash','upi','card'))`, `amount_paise` (> 0), `ref_note` NULL, `created_at`.

All four tables get update/delete triggers raising `ABORT` with a message containing `append-only`.

### Bill status

The stored `bills.status` keeps its existing values (`unpaid`, `paid`, `void`); a void credit note sets `void`. The bill's money columns are never edited. Bill JSON adds a derived `refundState`: `none`, `partly_refunded` (credit notes total > 0 and < bill total) or `refunded` (credit notes total = bill total), computed from `credit_notes`. This avoids rebuilding the `bills` table.

## 4. Money rules

### Credit amounts come from stored bill lines

Each bill already has `bill_report_lines` per order item (`qty`, `taxable_paise`, `cgst_paise`, `sgst_paise`, `rounding_paise`, `total_paise`, with discount allocated). The GST rate comes from the order item's `gst_rate_snapshot`.

For refunding `q` of a line's `n` units, where `r` units were already credited:

- If `r + q === n` (the last units): credit = the line's stored value minus everything already credited for that line (exact remainder, per field).
- Otherwise: credit = `round(field × q / n)` per field (half away from zero).

So every line's credit notes sum exactly to the line, and every bill's credit notes sum exactly to the bill (`total_paise`), to the paisa. Credit-note totals are the sums of its lines; `credit_note_taxes` groups lines by `gst_rate`.

### Void

- Allowed on `unpaid` and `paid` bills (including partly refunded ones); credits every remaining unit of every line (the full remainder). Refused on `void` bills and on fully refunded bills (nothing remains).
- **Unpaid:** no refund payments; the order becomes `cancelled` (closed now) and its table and any linked tables free up. Kitchen tickets are untouched.
- **Paid / partly refunded:** refund payments must total exactly the money still held = paid − already refunded.
- Final bill status: `void`.

### Refund

- Allowed only on `paid` bills that still have unrefunded quantity.
- Each requested quantity ≤ that line's unrefunded quantity; at least one line with qty > 0.
- Refund payments must total exactly the credit note's `total_paise`.
- Per method: refund amount ≤ paid by that method − already refunded by that method.
- Stored status stays `paid`; derived `refundState` becomes `refunded` when the bill is fully credited, else `partly_refunded`.

### Approval

- Requester needs permission `bills.refund` (admin `*`; cashier via `bills.*`).
- If the requester is an admin, `approved_by` = requester.
- Otherwise the body must include `approverPin`; the server matches it against active admins' PINs (PINs are unique). Wrong PINs count toward the same per-IP throttle as login (`429` during cooldown). Message: `"Admin PIN is incorrect"`.

### Bills without stored lines

Bills issued before report lines existed (none in `bill_report_lines`) can be **voided** (credit = bill totals, taxes from `bill_taxes`, no lines) but not partly refunded: `409 "This older bill can only be voided"`.

## 5. Server API

| Route | Body | Response |
| --- | --- | --- |
| `POST /api/bills/:id/credit-preview` | `{ kind: "void" \| "refund", lines?: [{ orderItemId, qty }] }` | `{ preview: { totals, taxes, lines, refundable: { cash, upi, card, total } } }` — no writes |
| `POST /api/bills/:id/void` | `{ clientRef, reason, refunds: [{ mode, amountPaise, refNote? }], approverPin? }` | `201 { bill, creditNote, order }`; identical retry `200`; reused reference with different body `409` |
| `POST /api/bills/:id/refund` | `{ clientRef, reason, lines: [{ orderItemId, qty }], refunds: [...], approverPin? }` | same |
| `GET /api/bills/:id` | — | bill JSON gains `creditNotes` (with lines, taxes, refunds, requester/approver names) and per-item `refundedQty` |
| `GET /api/credit-notes/:id/receipt` | — | HTML credit-note slip (A4/browser) |
| `POST /api/credit-notes/:id/print` | `{ printerId }` | queue thermal credit-note slip (print kind `"credit_note"`) |

Each write runs in one transaction (approval → limits → credit note + lines + taxes + refund payments → bill status → order/table for unpaid void). Concurrent changes surface as `409 "This bill changed — review again"`. After commit broadcast `order.updated` and `table.changed` (including linked tables).

## 6. Reports

Every report that currently excludes `status = 'void'` bills changes to: **all issued bills by issue date, minus credit notes by credit-note date**.

| Report | Change |
| --- | --- |
| Day-end / GST | Adds a credit-notes block (count; taxable, CGST, SGST per rate; total). Net sales and net GST per rate = bills − credit notes. Collections per method subtract refund payments dated that day; expected cash reflects them. |
| Sales (daily) / dashboard | Gross sales, credit notes, net sales per day |
| Collections | Refund payments subtract per method on their date |
| Item / category sales | Credit-note lines subtract quantities and amounts on their date |
| Cashier collections | Refunds count against the requesting cashier |
| Hourly sales, order analytics | Net of credit notes |
| Food cost & profit | Revenue net of credit-note taxable value; ingredient cost unchanged |
| **Credit notes** (new detailed report) | Every credit note in range: CN no., date, bill no., kind, reason, requested by, approved by, refund methods, taxable, GST, total; CSV export |

A day's figures change only if a credit note is dated that day.

## 7. User interface

- **Bills screen** (bill view): **Void bill** and **Refund items** buttons for admins and cashiers (Refund only on paid/partly refunded bills). Hidden from captains and kitchen.
- **Refund items dialog:** item list (billed, refundable, quantity stepper, "All remaining"); reason (required; quick picks Wrong item, Quality complaint, Long wait, Guest changed mind, Other + text); live server preview of the credit; refund-method rows defaulting to the guest's payment methods (proportional for split payments), editable, validated live (total must match; per-method limits); "Admin approval" PIN field for cashiers; confirm button "Refund ₹<total> as credit note"; result offers **Print credit note**.
- **Void bill dialog:** same without the item picker; unpaid bills show "This cancels the bill and frees the table" and no refund rows.
- **Bill view after:** status badge (Paid / Partly refunded / Refunded / VOID), credit-note list (number, date, kind, amount, reason, requested/approved by, reprint), per-item "n billed · m refunded". The original receipt reprints unchanged.
- **Credit-note slip:** restaurant header and GSTIN, **CREDIT NOTE CN-n**, original **Bill #** and date, items/quantities, GST per rate, total refunded, refund methods, reason, approver.
- **Reports:** "Credit notes" in Detailed reports; day-end credit-note block.

## 8. Migration safety

Migration 025 only creates new tables, indexes and triggers; no existing table is rebuilt or edited, and existing bills are untouched. The existing pre-migration backup protects upgrades.

## 9. Edge cases

- ₹0 bills can be voided; no refund rows.
- Partial refunds then a void: the void credits only what remains and refunds only money still held.
- Settle on a void/refunded bill stays blocked.
- Concurrency: limits re-checked inside the transaction; stale previews get 409 and refresh.
- Approver must be an active admin at approval time.
- Available on Basic and Pro.
- Backups/restore: all data in SQLite.

## 10. Testing

- **Domain:** proportional crediting incl. multiple partials summing exactly, discounted bills, mixed GST rates, round-off; derived refund state; migration 025 creates the tables and append-only triggers without touching existing bills.
- **Server:** void unpaid (order cancelled, table and linked tables freed) and paid; partial refunds incl. over-refund, per-method limits, multi-method; void after partials; cashier without PIN refused, wrong PIN throttled, admin self-approval; retries/conflicts; reports (day-end, GST, collections, item sales, profit) — a credit note today leaves yesterday unchanged; older bill void-only; credit-note receipt and print job.
- **UI unit tests:** default refund-method split, live total/limit validation, quantity limits.
- **Browser check (scratch database):** refund one item in cash with admin approval; void a paid UPI bill; void an unpaid table bill and confirm the table frees; check day-end, the Credit notes report and the slip.

## 11. Out of scope

Correcting payment methods; reopening bills for editing; goodwill amount-only refunds; returning stock; e-invoicing/IRN credit notes.
