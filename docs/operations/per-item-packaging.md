# Per-item packaging charges

Takeaway and delivery bills can charge packaging per item, for example ₹10 for each biryani container and ₹5 for
each curry box, on top of the flat packaging amount per bill. Restaurants that never turn it on see no change.

> **Status (2026-11-06):** in progress on `feat/bill-settings`, not released. The billing side is built: the setting,
> the menu amounts, CSV columns and the charge on bills. Still to build: the setting and menu fields on screen, and
> the refund choice. Until those are built, refunds credit packaging only as a whole charge, as before. See
> [What is left](#what-is-left).

## Turning it on

**Settings → Bill settings → Service and packaging charges** gets a **Charge packaging per item** switch, under the
flat **Packaging charge (₹)** field. It is off by default.

- **On:** a bill's packaging = the flat amount + the packaging of every item on the bill.
- **Off:** item amounts stay saved in the menu but are ignored.

The flat amount, the **Packaging label** and the GST rate work as described in
[bill format](bill-format.md#service-and-packaging-charges).

## Setting the amounts

In **Catalog → Edit**, each item has a **Packaging (₹)** amount per unit, from ₹0 to ₹1,000. These fields show only
while the switch is on.

- **Variants (portions)** can have their own amount. Leave it blank (**Same as item**) to use the item's amount. A
  variant set to 0 charges nothing, even if the item has an amount.
- **Combos** use the combo's own amount. The items inside a combo add nothing.

## How the bill is worked out

Only **takeaway** and **delivery** parcel orders get packaging, including custom order types of those kinds.
Dine-in and Zomato bills never do.

Each line's packaging = the variant's amount (or the item's when the variant is blank) × quantity. Cancelled items
are left out.

Example: flat packaging ₹20, biryani with ₹10 packaging × 2, dal (Half portion, blank, item ₹5) × 1:

| | Packaging |
|---|---|
| Flat per bill | ₹20 |
| Biryani ₹10 × 2 | ₹20 |
| Dal ₹5 × 1 | ₹5 |
| **Packaging line on the bill** | **₹45** |

- The bill shows **one Packaging line** with the combined amount. There is no per-item breakdown on the receipt.
- GST, the restaurant's GST mode, round-off, day-end totals and GST returns treat it exactly like the flat packaging
  charge. Discounts never reduce it.
- A packaging total of ₹0 adds no line.
- Each bill line remembers its own packaging, so a refund can later credit it item by item.
- If an item's packaging amount changes after the bill preview, issuing that bill is refused with "Order changed;
  review a fresh bill preview", like any other change to the total.

## Item CSV import and export

The item CSV has two more columns at the end, in rupees:

| Column | On item rows | On variant rows |
|---|---|---|
| `packaging` | The item's amount. Blank keeps the saved amount (0 for a new item). | Repeats the item's amount. |
| `variant_packaging` | Blank. | The variant's amount. Blank means "same as item". |

Amounts above 1000.00 are refused with a row error. Older CSV files without these columns import as before. See
[item import and export](item-import-export.md).

## Refunds and voids (not built yet)

When refunding items from a takeaway or delivery bill, the refund screen will show a **Refund packaging (₹X)**
tickbox, ticked by default. Whether the packaging goes back depends on when the order was cancelled:

| Situation | What to do | Packaging |
|---|---|---|
| Customer cancels before preparation | Usually before billing: cancel the items on the open order. If already billed (prepaid): refund, box ticked | Not charged, or refunded |
| Cancels after preparation, before packing | Refund, box ticked | Refunded |
| Cancels after packing | Refund, box unticked | Kept |
| Cancels after dispatch | Refund; tick or untick by the restaurant's terms | Cashier's choice |
| Restaurant cancels | Void the bill, or refund with the box ticked | Refunded |
| Zomato order | Zomato bills never carry packaging | — |

- A ticked refund credits the packaging of the refunded items. The flat amount is credited only when the refund
  clears every remaining item.
- **Void** credits all packaging not yet credited, including packaging kept by an earlier refund.
- A bill whose items are all refunded but whose packaging was kept stays **Partly refunded**. The kept packaging stays
  in sales and GST. Only a void can credit it after that.
- The service charge is unchanged: credited whole, only by a refund that clears the bill or by a void.

## For developers

Spec: [`docs/superpowers/specs/2026-11-06-per-item-packaging-design.md`](../superpowers/specs/2026-11-06-per-item-packaging-design.md).
Plan: [`docs/superpowers/plans/2026-11-06-per-item-packaging.md`](../superpowers/plans/2026-11-06-per-item-packaging.md).

**Migration 61** (`per_item_packaging`, `packages/domain/src/migrations/per-item-packaging.ts`):

| Column | Rule |
|---|---|
| `settings.packaging_per_item` | 0/1, default 0. API `packagingPerItem: boolean` |
| `products.packaging_paise` | 0–100000, default 0. API `packagingPaise: number` |
| `variants.packaging_paise` | NULL or 0–100000; NULL = the product's. API `packagingPaise: number \| null` |
| `bill_report_lines.packaging_paise` | Each line's packaging, 0 for combo children and non-parcel bills |
| `credit_note_charges.amount_paise` | The charge amount a credit note credited; backfilled from `bill_charges` (earlier credits were whole charges) |

**Code:**

- `orderItemPackaging(db, orderId)` in `packages/domain/src/packaging.ts`: order item id → line packaging, for
  top-level, non-cancelled lines of takeaway/delivery parcels. Empty when the switch is off.
- `priceOrder` in `apps/server/src/billing.ts` adds the sum to the flat amount as the single `packaging` charge.
- `saveReportLines` in `packages/domain/src/report-lines.ts` stores each line's share.
- `GET /api/products` returns `packagingPerItem` so the catalog screen knows whether to show the fields.

### What is left

| Task | Scope | State |
|---|---|---|
| 1 | Migration 61 and the setting | Done, `6749339` |
| 2 | Catalog amounts, CSV, transfer | Done, `57b2ea5` |
| 3 | Per-item packaging on bills | Done, `95c3a81` |
| 4 | Amount-based charge credits in `packages/domain/src/credit-notes.ts` | To do, together with 5 |
| 5 | Refunds, voids and reports on the server (`refundPackaging`, `credit_note_charges.amount_paise`) | To do |
| 6 | UI: Bill settings switch, product/variant fields, refund tickbox, `bill-format.md`, dev-app check | To do |

A whole-branch review runs after Task 6. Until Tasks 4 and 5 land, new credit notes write `amount_paise = 0` and
refunds credit packaging only as a whole charge, so do not release the branch in between.
