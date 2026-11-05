# Bill settings — design

Date: 2026-11-05 · Branch: `feat/bill-settings` · Status: approved in brainstorm; Phases 1–3 built

## Why

Bill-related settings are scattered. Bill style, footer, GST mode and rate, SAC code, Zomato's GSTIN and the UPI ID sit
inside **Restaurant profile** (`apps/ui/src/screens/Settings.tsx`), mixed with kitchen and suggestion toggles, and bill
copies live on each printer. The billing engine also lacks rules most Indian restaurant counters expect:

- round-off is hard-coded to the nearest ₹1 (`packages/domain/src/billing.ts` `calculateBill`);
- bill numbers are one bare integer with no prefix and no financial-year reset (GST expects a consecutive invoice
  series of at most 16 characters, unique per financial year);
- GST can only be included in prices or not charged — not added on top;
- there is no service charge or packaging charge.

This adds a dedicated **Bill settings** section that gathers the existing fields and adds those rules. MasalaPOS is
not live with any restaurant yet, so there is no upgrade path to protect, but every phase still ships a forward
migration (54 and 55 are taken by order summary and item transfers, so the next number is 56).

## Delivery

Four phases, each with its own implementation plan, session and commit, built in this order:

| # | Phase | Money logic | Migration |
|---|---|---|---|
| 1 | Cards + print content + live preview | None | 56 |
| 2 | Invoice numbering + round-off (built) | Rounding only | 57 |
| 3 | GST added on top | Core calculation | 58 |
| 4 | Service + packaging charges | New bill lines | 59 |

GST on top comes before charges so the charges are designed once against all three GST modes.

## Settings cards

The Settings grid (`apps/ui/src/settings-sections.ts`) changes as follows:

- **Restaurant profile** keeps only: restaurant name, street address, city, state, PIN code, phone, GSTIN, FSSAI number.
- **Bill settings** (new card, after Restaurant profile). A form on the left in five groups, and a live bill preview
  on the right (stacked below the form on narrow screens):
  - *Tax* — GST mode, default GST rate, SAC code, Zomato's GSTIN (SAC and Zomato's GSTIN only when a GSTIN is set,
    as today).
  - *Numbering & rounding* — Phase 2.
  - *Charges* — Phase 4.
  - *Printed bill* — bill style, header lines, footer lines, show/hide toggles, UPI ID, link to printer copies.
  - *Order handling* — kitchen slip when a sent item is changed (`kotEditPrint`), hold orders.
- **AI suggestions** (new card): show popular items (+ match the time of day), suggest dishes ordered together, suggest
  a customer's usual.

Each card saves through the existing settings `PUT` with the full-replace `SettingsUpdate` shape; the card sends the
current values of fields it does not show, exactly as the profile form does today. Groups for later phases are not
rendered until that phase ships.

The section-ids test (`apps/ui/src/settings-sections.test.ts`) is updated for the new ids; the titles the Marketplace
and e2e checks rely on ("Backups & connections", "Plan & devices") stay.

## Phase 1 — cards, print content, live preview

### Printed bill options

| Setting | Column | Rule |
|---|---|---|
| Header lines | `receipt_header TEXT NOT NULL DEFAULT ''` | Up to 3 lines, each ≤ 48 chars; printed under the restaurant name |
| Footer lines | existing `receipt_footer` | Now up to 3 lines, each ≤ 48 chars; empty keeps today's "Thank you for visiting…" |
| Show FSSAI number | `bill_show_fssai INTEGER NOT NULL DEFAULT 1 CHECK (0/1)` | Only matters when FSSAI is set |
| Show customer name and phone | `bill_show_customer` default 1 | Customer and loyalty lines |
| Show table | `bill_show_table` default 1 | Dine-in table / split label |
| Show "Served by" | `bill_show_served_by` default 0 | Display name of the order's `opened_by` user |
| Show item GST rate | `bill_show_item_gst` default 0 | Rate beside each item line |

GSTIN has no hide toggle: it must appear on a tax invoice. Bill copies stay on each printer's bill profile
(`printers.receipt_profile.copies`); the Printed bill group shows a "Bill copies are set per printer" link that opens
the Printers card.

### Frozen on the bill

Header lines and the five toggles are copied into `ReceiptSnapshot` when the bill is issued
(`apps/server/src/billing.ts` snapshot build), next to `receiptStyle` and `receiptFooter`, together with the new
`servedBy` name. Reprints and digital bills render from the snapshot, so changing a setting affects new bills only.
Snapshots without the new fields render with today's behaviour (header empty, FSSAI/customer/table shown, served-by and
item GST hidden).

### Rendering

`receiptSlip` (thermal) and `receiptHtml` (A4 / browser / digital bill) in `apps/server/src/print/receipt.ts` honour the
header lines, footer lines and toggles. Item GST rate prints as a short suffix on the item line (`5%`) on thermal and as
a column on A4.

### Live preview

`POST /api/settings/bill-preview` (admin, same permission as saving settings) takes the unsaved Bill settings form,
validates it with the same schema as `PUT`, builds a fixed sample snapshot (restaurant details from saved settings, two
items at different GST rates, a table, a customer, a served-by name) and returns `receiptHtml`. The UI debounces form
changes (~300 ms) and shows the HTML in a sandboxed iframe, as `BillingPanel.tsx` does for real bills. Invalid form
values show the field error and keep the last good preview.

### Phase 1 tests

- Domain: schema accepts ≤ 3 lines of ≤ 48 chars for header/footer and rejects more.
- Server: settings round-trip for the new columns; snapshot carries the new fields; `receiptSlip` / `receiptHtml` honour
  each toggle and header/footer lines; an old snapshot without the fields renders as today; bill-preview endpoint
  returns HTML for a valid form, 400 for an invalid one, 403 for a non-admin.
- UI: settings-sections test; Playwright check that the three cards render, Bill settings saves, and the preview updates.

## Phase 2 — invoice numbering and round-off

### Invoice number

- Format `PREFIX/YY-YY/NNNN`, e.g. `MP/25-26/0001`. Without a prefix: `25-26/0001`.
- Prefix: optional, up to 4 characters `[A-Z0-9]` (stored upper-case). With a 4-character prefix and a 5-digit counter
  the number is exactly 16 characters, the GST limit; the counter is zero-padded to 4 digits and grows to 5 when needed.
  The schema rejects a counter that would exceed 99,999 in one year (not reachable in practice).
- Financial year runs 1 April – 31 March in the restaurant's local time; the counter restarts at 1 for the first bill
  issued on or after 1 April. Counter rows live in `sequences` keyed by `invoice:<FY>` (e.g. `invoice:2025-26`), so a
  year's series is independent of a prefix change mid-year.
- Changing the prefix applies to the next bill. Within one FY a prefix change starts a new series string but continues
  the same counter.
- `bills.invoice_no TEXT UNIQUE` stores the formatted number at issue. The internal integer `bill_no` stays for paging,
  print-job labels and lookups.

### Credit notes

`CN/YY-YY/NNN`, e.g. `CN/25-26/001`, with their own per-FY counter (`sequences` key `credit_note:<FY>`) and 3-digit
padding. They carry no restaurant prefix: `ABCD/CN/25-26/001` would be 17 characters and GST allows 16 (changed from
the original `MP/CN/25-26/001` during build). The invoice prefix `CN` is rejected so the two series cannot collide.
Stored in `credit_notes.credit_note_ref TEXT UNIQUE`.

### Where the invoice number appears

Receipts (thermal + A4), credit-note prints, digital bill share text, UPI payment note, Bills list and billing panel,
customer profile bill history, feedback views. GSTR-1 JSON `inum` uses `invoice_no`, and Table 13 (documents issued)
reports one range per series string (from/to/total/cancelled) instead of one numeric range.

### Round-off

| Setting value | Behaviour |
|---|---|
| `rupee` (default) | Nearest ₹1, half up — today's behaviour |
| `half` | Nearest ₹0.50, half up |
| `off` | No rounding; total in paise |

Column `round_off TEXT NOT NULL DEFAULT 'rupee' CHECK (round_off IN ('rupee','half','off'))`. `calculateBill` takes the
mode; `rounding_paise` is already stored per bill, so existing bills and reports are unaffected. Credit notes keep
using each bill's stored rounding.

### Phase 2 tests

- Domain: invoice formatter (with/without prefix, padding growth, 16-char limit); FY of a timestamp around 31 March /
  1 April midnight local; round-off for each mode on boundary amounts (x.25, x.50, x.75).
- Server: first bill after 1 April gets `/0001`; prefix change mid-year continues the counter; credit-note numbering;
  GSTR-1 `inum` and Table 13 ranges per series.

## Phase 3 — GST added on top

### Modes

| Value | Label | Meaning |
|---|---|---|
| `included` | Prices include GST | Today's behaviour |
| `exclusive` | Prices exclude GST, added on the bill | New |
| `none` | No GST charged | Today's behaviour |

Migration 58 rebuilds the `settings` table to widen the `gst_mode` CHECK (SQLite cannot alter a CHECK in place). The
bill snapshot already records `gstMode`.

### Calculation (`calculateBill`, exclusive)

Per rate group: taxable = item amount − allocated discount (discount allocation unchanged); CGST = SGST =
round-half-up(taxable × rate / 200). Bill total before rounding = Σ taxable + Σ CGST + Σ SGST; then the round-off mode
applies. Integer paise / BigInt throughout, as today.

### Places that treat "not included" as "no GST"

All change to handle `exclusive` as a taxed mode:

- Receipt: heading "TAX INVOICE"; CGST and SGST lines per rate printed as additions between Subtotal/Discount and
  Round off, replacing the "Includes GST" block (`apps/server/src/print/receipt.ts`).
- On-screen `BillSummary` (`apps/ui/src/screens/BillingPanel.tsx`), `CreditNoteDialog.tsx`, `apps/ui/src/zomato-desk.ts`
  (Zomato orders still pass `none`).
- SAC code is added to the snapshot for both taxed modes (`apps/server/src/billing.ts`).
- GST returns: `billSupply` in `packages/domain/src/gst-returns/facts.ts` treats `exclusive` bills as normal taxable
  supplies, not composition.
- Costing: `apps/server/src/costing.ts` and `apps/ui/src/dish-costing.ts` treat menu prices as tax-exclusive under
  `exclusive`.
- Report lines (`packages/domain/src/report-lines.ts`): store each line's allocated discount instead of deriving it as
  subtotal − taxable − CGST − SGST (which goes negative when tax is added on top).
- Day, sales and operational reports already sum stored columns; verify their "no GST" checks compare to `'none'` only.

### Phase 3 tests

- Domain: exclusive splits for single and mixed rates, with discount, odd-paisa cases, each round-off mode; report
  lines never negative in any mode; GST facts classify exclusive as taxable.
- Server: issue + reprint an exclusive bill; credit note on an exclusive bill; day report and GSTR-1/3B totals match.

## Phase 4 — service and packaging charges

### Settings

| Setting | Column | Rule |
|---|---|---|
| Service charge % | `service_charge_bp INTEGER NOT NULL DEFAULT 0 CHECK (0–2000)` | Basis points (0–20.00 %), 0 = off. Dine-in only |
| Packaging charge | `packaging_charge_paise INTEGER NOT NULL DEFAULT 0 CHECK (0–100000)` | Flat per bill, 0 = off. Takeaway and delivery only |
| Charge label (optional) | `service_charge_label`, `packaging_charge_label` | Default "Service charge" / "Packaging" |

Order scope comes from the order's type: dine-in = `orders.type = 'dine_in'`; takeaway/delivery = a `parcel` order
whose `order_types.kind` is `takeaway` or `delivery`. Zomato (aggregator) orders never get either charge. The kind is
saved on the bill snapshot as `orderTypeKind`.

### Calculation

- Service charge = round-half-up(subtotal after discount × bp / 10,000). Under `exclusive`, "subtotal after discount"
  is the pre-tax value; under `included` and `none` it is the item amount after discount.
- Each charge is taxed at the restaurant's default GST rate and follows the GST mode: added on top under `exclusive`,
  contained in the charge under `included`, untaxed under `none`. Charges join the per-rate tax groups, so
  `bill_taxes` and CGST/SGST totals include them.
- The cashier can untick the service charge on any bill in the billing panel (consumer guidelines: service charge must
  not be compulsory). No reason or approval is needed; the untick is recorded on the bill.

### Storage

- `bill_charges(bill_id, kind 'service'|'packaging', label, amount_paise, gst_rate, taxable_paise, cgst_paise,
  sgst_paise)`.
- Charges get their own report lines (no order item; marked as a charge) so day, sales, operational and GST reports
  include them; item-level reports (menu engineering, popular items, costing) exclude charge lines.
- Charges are part of `totals`, so the bill-preview fingerprint (`apps/server/src/billing.ts`) covers them.
- Receipt: one line per charge after the item subtotal/discount; under `exclusive` the charge's GST is included in the
  CGST/SGST lines.

### Credit notes

- A credit note that credits every remaining item on the bill also credits all charges, so the bill reaches "refunded".
- A partial refund leaves the charges on the bill.
- Voiding a bill credits the charges explicitly as charge lines, not into rounding.

### Phase 4 tests

- Domain: service % on discounted subtotal in each GST mode; packaging tax in each mode; charge joins the right rate
  group; full credit includes charges, partial does not; void credits charges.
- Server: dine-in gets service charge, takeaway/delivery get packaging, Zomato gets neither; untick removes service
  charge and the preview fingerprint changes; day report and GSTR-1 include charge tax.

## Verification for every phase

- `npm test` (domain, server, UI vitest) and root typecheck green.
- Dev app (`npm run dev`, admin / demo1234): change the phase's settings, issue a bill, check the thermal print job, the
  A4 receipt, the digital bill and (Phases 2–4) the GSTR-1 export. Stop the dev server by PID afterwards.

## Out of scope

- Per-item packaging charges, delivery charges, tips.
- Multiple invoice series per order type or per counter.
- Changing bill copies (stays per printer).
- Logo images on the bill.
