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

Classic follows the counter-bill reference in
`Screenshots/Screenshot 2026-10-09 101725.png`: centered restaurant details,
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

There are three automatic receipt formats, using the bill's saved tax mode:

- **Tax-exclusive:** per-rate taxable value, CGST and SGST appear before the total.
- **Tax-inclusive:** **All prices include tax**, followed by the same per-rate
  rows marked as included (a tax invoice must show the rate and amount of GST).
  This applies to HTML/A4/PDF and both thermal widths, including reprints.
- **Composition scheme:** a composition restaurant may not collect GST, so the
  bill is headed **Bill of supply** with the declaration *Composition taxable
  person, not eligible to collect tax on supplies*. It shows no GST rows: only
  subtotal, discount (if any), rounding (if any), total and payment details. GST
  is stored as zero; the menu price less any discount is the bill amount.
  Select **Settings > Menu price tax mode > Composition scheme - no GST charged**.
  Zomato orders keep the "GST paid by Zomato" note.

For new inclusive bills select **Settings > Menu price tax mode > Menu prices
include GST**. This controls how menu prices are interpreted, so use it when the
menu rates already include tax. Calculated GST and taxable amounts remain stored
for reports and are not added again to inclusive prices. Historical bills use
their saved mode, irrespective of the current setting. Credit notes retain their
existing breakdown.

Configured UPI QR codes remain available on unpaid bills. Cash tendered, customer
details and phone numbers are not invented when absent from the saved bill.
No totals, payment records or historical bill data are changed by the layout.

Generate sample layouts with `node --import tsx tools/preview-bills.ts`. It writes
A4, unpaid, void, takeaway, inclusive/mixed-GST, UPI, large-value, long-bill,
and thermal previews under `.e2e-scratch/bill-design` using the production
renderers. The thermal HTML previews visualize the actual
ESC/POS bytes and do not replace a physical printer check. The existing thermal
text encoding supports ASCII; non-ASCII characters use the existing fallback.

The sample image is saved in `docs/screenshots/restaurant-bill.png`.
The inclusive example is `docs/screenshots/restaurant-bill-inclusive.png`;
generated previews are `bill-inclusive.html`, `bill-inclusive-58mm.html`, and
`bill-inclusive-80mm.html` under `.e2e-scratch/bill-design`.
Open `bill-styles.html` in that directory to compare all four styles. Its controls
switch the tax sample and preview/80 mm/58 mm format. Each style also links to an
unpaid bill with a sample UPI QR. The comparison image is
`docs/screenshots/restaurant-bill-styles.png`.
