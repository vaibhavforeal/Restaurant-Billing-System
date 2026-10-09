# Bill formats

Choose **Settings > Restaurant profile > Bill style**, then **Save**:

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
Zero rounding is omitted. Dine-in bills identify the table and group; takeaway
bills show Parcel. Zomato bills identify the platform order and display the
platform-paid GST note. Paid, unpaid and void bills have distinct wording.

The HTML preview uses the same compact vertical layout, with a restaurant header,
bill/date/service metadata, item table, subtotal and quantity, discount, per-rate
GST where applicable, total, and recorded payments. It adapts to smaller screens and prints as a
centered 110 mm-wide bill on A4. Long item lists continue onto additional pages
with repeating column headings. Printed page footers include the bill number
and page count. Credit-note layouts keep their existing A4 format.

Set **Restaurant name**, **Address**, **GSTIN**, **FSSAI licence no.**, and
**Receipt footer** in Settings. These details are saved when a bill is issued;
reprints retain that saved information. When the saved footer is blank, the
design displays a short thank-you message.

## GST settings and item rates

Choose **Settings > Restaurant profile > GST**, then **Save**:

- **Prices include GST** - menu prices already contain the tax. Pick the
  **Default GST rate** (5%, 12% or 18%); items without a rate of their own use it.
- **No GST charged** - bills show no tax at all (for example a composition
  restaurant, or one that is not registered for GST).

The setting applies to new bills only. Each bill keeps the mode it was issued
under, including on reprints and credit notes, so changing the setting never
alters an old bill. Menu prices are never increased by GST: the tax shown is the
part of the price that is GST.

An item can override the default in **Catalog > Edit > GST rate**. Leave it on
**Restaurant default** to follow the setting (changing the default later changes
future bills for those items), or choose 0%, 5%, 12%, 18% or 28% for that item.
The rate is recorded when the item is punched, so items already on an open order
keep their rate when the default changes. In the item CSV, a blank `gst_rate`
means "restaurant default" and exports and imports back unchanged.

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
