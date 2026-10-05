# Bill formats

The bill design is available in both existing print paths:

- **58 mm / 80 mm thermal:** choose a receipt printer in checkout and use
  **Print receipt**. The printer's paper width in Settings controls the format.
- **A4 / PDF:** open **View receipt**, then **Print / save PDF**. Choose A4 paper
  and disable the browser's own headers/footers in its print dialog.

The thermal receipt has a prominent restaurant name and grand total, numbered
items, quantities and rates, GST breakdown, discounts, rounding, and payment
details. Long names and addresses wrap within 32 characters on 58 mm paper and
48 characters on 80 mm paper. Dine-in bills identify the table and group;
takeaway bills show Parcel. Paid, unpaid and void bills have distinct wording.

The A4 bill uses a restaurant header, bill number/status, service details, an
item table, GST breakdown beside the totals, and payment details. Long item
lists continue onto additional pages with repeating item-table headings.
Printed page footers include the bill number and page count.
The receipt preview also adapts to smaller screens.

Set **Restaurant name**, **Address**, **GSTIN**, **FSSAI licence no.**, and
**Receipt footer** in Settings. These details are saved when a bill is issued;
reprints retain that saved information. When the saved footer is blank, the
design displays a short thank-you message. Tax-inclusive bills clearly label
the included GST. No totals, payment records or historical bill data are changed
by the new layout.

Generate sample layouts with `node --import tsx tools/preview-bills.ts`. It writes
A4, unpaid, long-bill, and thermal previews under `.e2e-scratch/bill-design` using
the production renderers. The thermal HTML previews visualize the actual
ESC/POS bytes and do not replace a physical printer check. The existing thermal
text encoding supports ASCII; non-ASCII characters use the existing fallback.
