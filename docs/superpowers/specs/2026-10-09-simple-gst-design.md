# Simple GST — Design

**Date:** 9 October 2026
**Status:** Approved in conversation section by section; awaiting written-spec review
**Replaces:** the tax-exclusive mode, the tax-inclusive flag, and the composition setting added in `3b04f62`

## 1. Goal

The owner sets tax up with two settings: whether the restaurant charges GST, and its default rate. Behind the scenes the app keeps only two calculation paths instead of four. Most items follow the default rate; only the few exceptions (for example an 18% item) carry their own rate.

No restaurant uses the app yet, so nothing has to stay compatible with existing bills or settings. The development and demo databases are upgraded by the new migration.

Success means:

- Settings > Tax asks only **GST** (Prices include GST / No GST charged) and **Default GST rate** (5%, 12% or 18%, hidden when no GST is charged).
- An item's GST rate defaults to the restaurant rate; an override is only set for exceptions.
- A GST bill prints as a **Tax invoice**, with the total followed by an "Includes GST" block per rate.
- A no-GST bill prints as a **Bill of supply** with the composition declaration when a GSTIN is entered, otherwise as a plain **Restaurant bill**; neither shows GST lines.
- Zomato bills behave exactly as today.
- The "GST added on top" mode, the composition setting and the per-item rate requirement no longer exist.

## 2. Decisions

| Topic | Decision |
| --- | --- |
| Restaurants supported | GST-registered with menu prices including GST; composition; not registered. "GST on top of the menu price" is removed |
| GST mode setting | `settings.gst_mode TEXT NOT NULL DEFAULT 'included' CHECK IN ('included','none')`. Replaces `tax_inclusive` and `gst_scheme` |
| Default rate | `settings.gst_rate INTEGER NOT NULL DEFAULT 5 CHECK IN (5, 12, 18)` |
| Item rate | `products.gst_rate` becomes nullable; NULL means "restaurant default". Allowed overrides: 0, 5, 12, 18, 28 |
| When the rate is fixed | At punch, as today: `order_items.gst_rate_snapshot` = the item's override, otherwise the default at that moment. Changing the default never changes punched items or issued bills |
| Composition vs not registered | Both use `gst_mode = 'none'`. The bill is a Bill of supply with the declaration when the saved GSTIN is non-empty, a plain Restaurant bill when it is empty |
| Bill heading (GST) | "TAX INVOICE" (thermal) / "Tax invoice" (HTML). The accountant confirms this and the declaration wording before go-live |
| GST block position | After the total, headed "Includes GST", one Taxable / CGST / SGST group per rate |
| Zomato | Unchanged behaviour (section 9(5) note, no GST, Zomato receivable). Internally it uses the no-GST calculation |
| Rounding | Unchanged: total rounded to the nearest rupee, 50 paise rounds up; "Round off" printed only when non-zero |

## 3. Settings and items

**Settings > Tax** replaces "Menu price tax mode":

- **GST**: `Prices include GST` or `No GST charged`.
- **Default GST rate**: `5%` (default), `12%`, `18%`. Shown only when GST is charged.
- Help text: new bills use these settings; issued bills keep theirs.

`PUT /api/settings` accepts `gstMode` and `gstRate` (both optional, kept when omitted); `taxInclusive` and `gstScheme` are removed from the API, the UI types and the schema.

**Items.** The product editor's GST field offers `Restaurant default (5%)` (showing the current default) plus `0%`, `5%`, `12%`, `18%`, `28%`. `gstRate` in the product API is `number | null`; `null` is the default. Variants have no rate of their own and use their product's rate, as today. The catalog list shows `Default` or the override (for example `18%`).

**Catalog CSV.** `gst_rate` becomes an optional column. Blank means the default; any value must be 0, 5, 12, 18 or 28. Export writes blank for items on the default.

**Punching.** Every path that writes `order_items.gst_rate_snapshot` (POS punch in `orders.ts`, QR guest requests in `guest-ordering.ts`, Zomato orders) resolves the effective rate the same way, through one shared helper: the product's override, otherwise `settings.gst_rate`.

## 4. Calculation

`calculateBill(items, discountPaise, mode)` with `mode: "included" | "none"` replaces the `taxInclusive` flag and the `restaurant` / `operator` / `composition` tax modes.

**Included:**

1. Group items by their snapshot rate.
2. Share the discount across the groups in proportion to their value, with largest-remainder rounding (unchanged).
3. For each group: gross = value − discount share; taxable = round(gross × 100 / (100 + rate)); GST = gross − taxable; CGST = GST / 2 rounded up; SGST = the rest.
4. Total = the sum of the groups' gross values, rounded to the rupee.

**None:** each group's taxable = gross, CGST = SGST = 0; total = subtotal − discount, rounded.

`BillTotals.taxInclusive` is removed. The bill's GST mode is recorded on the receipt snapshot as `gstMode: "included" | "none"`, replacing `gstScheme`. Zomato bills record `gstMode: "none"` and keep `gstPaidBy: "zomato"`. The `bill_taxes` table keeps one row per rate (rows with 0 GST for no-GST bills, as today).

## 5. Printed bill and billing screen

| Bill | Heading | After the total |
| --- | --- | --- |
| GST (`included`) | TAX INVOICE | "Includes GST:" then Taxable @ r%, CGST r/2%, SGST r/2% for each rate |
| No GST, GSTIN set | BILL OF SUPPLY + "Composition taxable person, not eligible to collect tax on supplies" | nothing |
| No GST, no GSTIN | RESTAURANT BILL | nothing |
| Zomato | RESTAURANT BILL | "GST paid by Zomato (section 9(5))" before the total, as today |

This applies to the 58 mm and 80 mm thermal slips and the HTML/PDF bill in all four styles. Everything else on the bill (items, subtotal and quantity, discount, round-off, payments, UPI QR, footer) is unchanged. The "All prices include tax", "GST added to menu prices" and "(included)" wording is removed: the "Includes GST" heading says it once.

**Billing screen:** Subtotal, Discount, Round off, Payable, then "Includes GST ₹x" with the per-rate details under "Tax details". No GST lines for no-GST or Zomato bills.

## 6. Everything else

- **Day-end report:** the GST table lists GST bills only. No-GST bills are reported as one line, "Sales without GST" (value of no-GST bills issued that day), alongside the existing Zomato section 9(5) line; they are kept out of net taxable value. Credit notes against no-GST bills likewise stay out of the credited GST figures. The CSV export gets the same line. Item and category reports are unchanged.
- **Credit notes:** maths unchanged. Printed and on-screen credit notes show GST rows only when the original bill's `gstMode` is `included` (generalising today's composition check).
- **QR menu:** guests always see "No tax is added to menu prices". `taxInclusive` is removed from the guest menu, guest requests and the QR requests screen; `guest_requests.tax_inclusive` is dropped.
- **Dish costing:** the price before GST uses the item's effective rate in included mode; in no-GST mode, and for Zomato prices, the whole price counts. The `taxInclusive` field of the costing response is replaced by `gstMode`.
- **Demo seed:** dishes are created with no rate override.

## 7. Migration 031

1. Add `settings.gst_mode` and `settings.gst_rate`. Set `gst_mode = 'none'` where `gst_scheme = 'composition'`, otherwise `'included'`; `gst_rate = 5`.
2. Drop `settings.tax_inclusive` and `settings.gst_scheme`.
3. Products: add a nullable `gst_rate_new` with the override CHECK, copy `gst_rate` where it is not 5, drop `gst_rate`, rename `gst_rate_new` to `gst_rate`.
4. Drop `guest_requests.tax_inclusive`.

Issued bills are not rewritten. Their receipt JSON may still carry `taxInclusive` / `gstScheme`. The renderer treats a snapshot without `gstMode` as `included`, unless it has `gstScheme: "composition"` or `gstPaidBy: "zomato"`, which are treated as `none`. That is the only legacy handling.

## 8. Removed

- The "GST added on top" calculation, its bill wording and its settings option.
- `settings.tax_inclusive`, `settings.gst_scheme`, the `GST_SCHEMES` and `TaxMode` types, `BillTotals.taxInclusive`, `ReceiptSnapshot.taxInclusive` / `gstScheme`.
- The guest-facing tax flag.
- The requirement to choose a GST rate for every item.

## 9. Testing

- **Domain:** two-path calculation tests, including a mixed 5% + 18% bill with a discount, rounding, and the no-GST total; migration 031 test (settings mapping, product override copy, re-run safety).
- **Server:** settings (`gstMode`, `gstRate` round trip and validation); product create/edit with a `null` rate; CSV import/export with blank and explicit rates; punch snapshot uses override, then default, and survives a later default change; guest request and Zomato snapshots; bill issue in both modes; receipt slips and HTML for the four bill types in all four styles (line widths within 32/48 characters); credit-note printing; day-end "Sales without GST"; costing.
- **UI:** billing summary helpers; settings form mapping.
- **Browser (Playwright MCP):** update the e2e scripts that choose "Add GST at checkout" or check the old wording (`m4-billing`, `m10-takeaway`, `m9-menu`, `m9-guest-flow`, `report-export`, `catalog-transfer`, and others found by search).
- **Docs:** `docs/operations/bill-format.md`, the settings and catalog guides, and the sample screenshots.
