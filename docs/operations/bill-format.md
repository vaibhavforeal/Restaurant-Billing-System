# Bill formats

Choose **Settings > Bill settings > Bill style**, then **Save**:

| Style | Preview / PDF | Thermal receipt |
| --- | --- | --- |
| Classic | Familiar monospace receipt with dotted rules | Centered heading and dotted rules |
| Modern | Bold sans serif, strong dividers and prominent total | Left-aligned heading and solid rules |
| Heritage | Serif typography, centered heading and double rules | Centered heading and equals-sign rules |
| Compact | Smaller sans serif and tighter spacing | Normal-height heading and fewer blank lines |

The style is saved when the bill is issued. Changing Settings affects new bills;
reprints keep their saved style. Bills issued before style selection use Classic.
Thermal printers use their built-in font; PDF typefaces do not carry over to
ESC/POS output. Logo upload and logo printing are not currently supported.

The bill design is available in both existing print paths:

- **58 mm / 80 mm thermal:** choose a receipt printer in checkout and use
  **Print receipt**. The printer's paper width in Settings controls the format.
- **A4 / PDF:** open **View receipt**, then **Print / save PDF**. Choose A4 paper
  and disable the browser's own headers/footers in its print dialog.

Classic follows a conventional counter bill: centered restaurant details,
compact rows, dotted separators, and a bold total. Restaurant-specific details
include FSSAI, service type, table/group, GST breakdown, and payment status.

The 80 mm thermal receipt uses Item / Qty / Rate / Amount columns. On 58 mm
paper it uses Item / Qty / Amount, with the unit rate below each item. Long names
wrap within their column; unusually large numeric values use separate lines
without truncation. All thermal text remains within 32/48 characters respectively.
Zero rounding is omitted (see Numbering and rounding below). Dine-in bills identify the table and group; takeaway
bills show Parcel. Zomato bills identify the platform order and display the
platform-paid GST note. Paid, unpaid and void bills have distinct wording.

The HTML preview uses the same compact vertical layout, with a restaurant header,
bill/date/service metadata, item table, subtotal and quantity, discount, per-rate
GST where applicable, total, and recorded payments. It adapts to smaller screens and prints as a
centered 110 mm-wide bill on A4. Long item lists continue onto additional pages
with repeating column headings. Printed page footers include the bill number
and page count. Credit-note layouts keep their existing A4 format.

Set **Restaurant name**, **Address**, **GSTIN** and **FSSAI licence no.** in
**Settings > Restaurant profile**, and the header and footer lines in
**Settings > Bill settings > Printed bill**. These details are saved when a bill
is issued; reprints retain that saved information. When the saved footer is blank, the
design displays a short thank-you message.

## GST settings and item rates

Choose **Settings > Bill settings > GST**, then **Save**:

- **Prices include GST** - menu prices already contain the tax. Pick the
  **Default GST rate** (5%, 12% or 18%); items without a rate of their own use it.
- **Prices exclude GST, added on the bill** - menu prices are before tax. CGST
  and SGST are worked out on each rate's item value after any discount and added
  to the bill, so the customer pays the menu price plus GST. Pick the **Default
  GST rate** as above. This needs the restaurant's **GSTIN**; the setting cannot
  be saved without it.
- **No GST charged** - bills show no tax at all (for example a composition
  restaurant, or one that is not registered for GST).

The setting applies to new bills only. Each bill keeps the mode it was issued
under, including on reprints and credit notes, so changing the setting never
alters an old bill.

How the tax appears on the bill:

- **Prices include GST**: the total is the menu prices less any discount. An
  **Includes GST** block after the total shows the taxable value, CGST and SGST
  for each rate: the part of the price that is GST.
- **GST added on the bill**: lines such as `CGST 2.5% on 90.00` and
  `SGST 2.5% on 90.00` (the rate, and the taxable value it is charged on) are
  added after the discount and before **Round off** and the **TOTAL**.

Example, a ₹100 thali at 5% with a ₹10 discount and rounding to the nearest ₹1:

| | Prices include GST | GST added on the bill |
| --- | --- | --- |
| Subtotal | ₹100.00 | ₹100.00 |
| Discount | -₹10.00 | -₹10.00 |
| CGST 2.5% | (inside the price) ₹2.14 | ₹2.25 |
| SGST 2.5% | (inside the price) ₹2.14 | ₹2.25 |
| Total | ₹90.00 | ₹94.50 → ₹95.00 (round off +₹0.50) |

Zomato orders never charge GST on the bill, whichever mode is chosen: Zomato
pays it under section 9(5). Dish costing compares recipe cost with the price
before GST: under **Prices include GST** the GST is taken out of the menu price;
under the other two modes the menu price is used as it is.

An item can override the default in **Catalog > Edit > GST rate**. Leave it on
**Restaurant default** to follow the setting (changing the default later changes
future bills for those items), or choose 0%, 5%, 12%, 18% or 28% for that item.
The rate is recorded when the item is punched, so items already on an open order
keep their rate when the default changes. In the item CSV, a blank `gst_rate`
means "restaurant default" and exports and imports back unchanged.

## Bill settings

**Settings > Bill settings** holds the tax and printed-bill options, with a live
preview beside the form. Printed bill options:

- **Header lines** - up to 3 lines, 48 characters each, printed under the
  restaurant name. Blank lines are dropped.
- **Footer lines** - up to 3 lines, 48 characters each, replacing the default
  thank-you message when any are set.
- **Show FSSAI number** (on by default), **Show customer name and phone** (on),
  **Show table** (on), **Show 'Served by'** (off) and **Show each item's GST
  rate** (off). The GSTIN is always shown.
- **Bill copies** stay on each printer's bill profile (Settings > Printers); Bill
  settings only links there.

These options are saved on each bill when it is issued, so they apply to **new
bills only**. Reprints and older bills keep the layout they were issued with;
bills issued before these options existed print exactly as they did.

The item GST rate column or line appears only on bills that charge GST
themselves: Prices include GST or GST added on the bill, and not a Zomato-paid order. No-GST bills, bills
of supply and Zomato bills never show it, even when the option is on.

## Service and packaging charges

Choose **Settings > Bill settings > Charges**, then **Save**:

- **Service charge (%)** - 0 to 20, in steps of 0.01. Leave it at 0 for no service charge. It is added to **dine-in**
  bills only, on the subtotal after any discount.
- **Packaging charge (₹)** - 0 to 1000. A flat amount added once to each **takeaway** or **delivery** bill. Leave it at
  0 for none.
- **Service charge label** and **Packaging label** - the words printed on the bill. A blank label saves as "Service
  charge" or "Packaging".

Zomato orders get neither charge. Both apply to new bills only; old bills and reprints keep what they were issued with.

Each charge is taxed at the **Default GST rate** and follows the GST setting: with **Prices include GST** the charge
already contains its GST, with **Prices exclude GST, added on the bill** the GST is added on top, and with **No GST
charged** there is no tax. The GST on a charge is reported in the same rate group as the menu items, so GSTR-1 and
GSTR-3B include it.

Service charge is never compulsory. On a dine-in bill the cashier can untick **Service charge** in the billing panel.
No reason or approval is needed. The bill records that it was removed.

On the bill, each charge is one line after Discount, for example `Service charge 10%` and `Packaging`. Day-end and
Sales reports show a **Charges** total.

Refunds: a refund that returns every item on the bill also returns the charges, and the bill becomes **Refunded**. A
part refund leaves the charges. Voiding a bill returns its charges too. Credit notes list each charge they return.

Example, a ₹100 item at 5% with a 10% service charge:

| | Prices include GST | GST added on the bill |
| --- | --- | --- |
| Subtotal | ₹100.00 | ₹100.00 |
| Service charge 10% | ₹10.00 | ₹10.00 |
| CGST 2.5% | (inside the price) ₹2.62 | ₹2.75 |
| SGST 2.5% | (inside the price) ₹2.62 | ₹2.75 |
| Total | ₹110.00 | ₹115.50 → ₹116.00 (round off +₹0.50) |

## Numbering and rounding

Choose **Settings > Bill settings > Numbering & rounding**, then **Save**:

- **Invoice prefix** - optional, up to 4 letters or digits, saved in capitals.
  "CN" is not allowed because credit notes use it.
- **Round off total** - **To the nearest ₹1** (default), **To the nearest 50
  paise**, or **No rounding (exact paise)**.

Both apply to new bills only. Refunds and credit notes use the rounding each bill
was issued with.

Bills are numbered `PREFIX/YY-YY/NNNN`, or `YY-YY/NNNN` with no prefix, for example
`MP/25-26/0001`. The financial year runs 1 April to 31 March (local time). The
counter restarts at 0001 for the first bill on or after 1 April and grows to 5
digits after 9999. Changing the prefix mid-year continues the same counter. A
number is at most 16 characters, the GST limit.

Credit notes are `CN/YY-YY/NNN`, for example `CN/25-26/001`, with their own yearly
counter. They carry no restaurant prefix: a 4-letter prefix would make the number
17 characters, and GST allows 16.

Bills and credit notes issued before this change keep their old numbers (the plain
number, and `CN-<n>`).

The number shows on thermal and A4 receipts, the digital bill and its file name
(`Bill-MP-25-26-0001.html`), the UPI payment note, credit-note prints, the Bills
list, the billing panel, customer profiles and feedback. GSTR-1 uses it for the
invoice and credit-note numbers, and Table 13 lists one range per series, so a
prefix change mid-year shows as two ranges. Print-job labels, custom-report
"Bill no." columns, staff-activity references and a customer's usual stay on the
internal bill number.

## The four bill types

The receipt format follows the bill's saved GST mode. It applies to the HTML /
A4 / PDF bill and both thermal widths, in all four styles, including reprints.

| Bill | Heading | After the total |
| --- | --- | --- |
| GST (prices include GST) | **Tax invoice** | **Includes GST** with, for each rate, Taxable @ r%, CGST r/2% and SGST r/2%. A mixed 5% and 18% bill has one block per rate. |
| No GST, GSTIN saved | **Bill of supply** with *Composition taxable person, not eligible to collect tax on supplies* | Nothing: only subtotal, discount, rounding, total and payments. |
| No GST, no GSTIN | **Restaurant bill** | Nothing. |
| Zomato | **Restaurant bill** | *GST paid by Zomato (section 9(5))* before the total; no GST lines. |

The older "All prices include tax", "GST added to menu prices" and "(included)"
wordings are gone: the **Includes GST** heading says it once. GST is stored as
zero on no-GST bills, so the menu price less any discount is the bill amount. A
credit note against a no-GST bill shows the item value with no GST rows. On the
billing screen the summary reads Subtotal, Discount, Round off, Payable, then
**Includes GST** with the per-rate detail under **Tax details**. The QR menu
always tells guests *No tax is added to menu prices.*

A tax invoice from a restaurant with a GSTIN also prints the **SAC** code (Settings, 996331 by default). A bill
issued to a business (Bill options > **GST invoice for a business**) prints **Billed to**, the buyer's GSTIN and
address and **Place of supply**; its credit notes do too. See [GST returns](gst-returns.md).

Reports follow the same split: Day-end / GST lists GST bills only and shows no-GST
bills as one **Sales without GST** line (also in the CSV), next to the Zomato
section 9(5) line.

Configured UPI QR codes remain available on unpaid bills. Cash tendered, customer
details and phone numbers are not invented when absent from the saved bill.
No totals, payment records or historical bill data are changed by the layout.

Generate sample layouts with `node --import tsx tools/preview-bills.ts`. It writes
A4, unpaid, void, takeaway, mixed-rate GST, bill of supply, plain restaurant bill,
Zomato, UPI, large-value, long-bill, and thermal previews under
`.e2e-scratch/bill-design` using the production
renderers. The thermal HTML previews visualize the actual
ESC/POS bytes and do not replace a physical printer check. The existing thermal
text encoding supports ASCII; non-ASCII characters use the existing fallback.

The sample images are saved in `docs/screenshots`:

- `restaurant-bill.png` - tax invoice with mixed 5% and 18% items and a discount
  (`bill-a4.html`, `bill-58mm.html`, `bill-80mm.html`).
- `restaurant-bill-composition.png` - no GST with a GSTIN, the bill of supply with
  its declaration (`bill-supply.html`, `bill-supply-58mm.html`, `bill-supply-80mm.html`).
- `restaurant-bill-no-gst.png` - no GST and no GSTIN, the plain restaurant bill
  (`bill-plain.html`, `bill-plain-58mm.html`, `bill-plain-80mm.html`).
- `restaurant-bill-styles.png` - the four styles side by side.

Open `bill-styles.html` in that directory to compare all four styles. Its controls
switch the bill sample (tax invoice, bill of supply, restaurant bill) and
preview/80 mm/58 mm format. Each style also links to an
unpaid bill with a sample UPI QR.
