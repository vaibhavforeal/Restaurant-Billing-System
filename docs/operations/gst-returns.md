# GST returns

**Reports & Analytics > GST returns** turns a month's (or a quarter's) bills into the figures a restaurant files
with GST. It is always available, even without the Reports & analytics module, to anyone with the report permission.

Choose the **Month**, and **Quarter** if the restaurant files quarterly (QRMP). Quarters follow the financial year:
Apr-Jun, Jul-Sep, Oct-Dec, Jan-Mar. The screen opens on last month.

Use **Send to auditor** to review and share the selected period's CSV and, when available, GSTR-1 JSON. The CSV includes
the GSTIN and report warnings. **Share reports** opens the device's sharing menu where file sharing is supported.
Otherwise download each file, enter the auditor's email, and choose **Open email draft**. Attach the downloaded files
in the email app before sending; browser email links cannot add attachments automatically. No email is sent by the POS.

What the screen shows depends on **Settings > Restaurant profile**:

| Restaurant | Shown | Download |
| --- | --- | --- |
| GSTIN saved, **Prices include GST** | GSTR-3B Table 3.1 and the GSTR-1 tables | CSV and **GSTR-1 JSON** |
| GSTIN saved, **No GST charged** (composition) | CMP-08: turnover, credit notes and 2.5% CGST + 2.5% SGST, by month | CSV |
| No GSTIN | A note that no GST returns apply | None |

## GSTR-1 tables

- **Table 4A, B2B**: bills issued to a business with its GSTIN, one row per bill and rate.
- **Table 7, B2C (others)**: every other bill, per rate, less walk-in credit notes.
- **Table 8, nil rated**: items at 0%, split by registered and unregistered buyers.
- **Table 9B, credit notes to registered buyers**: voids and refunds of B2B bills.
- **Table 12, HSN/SAC summary**: per rate, split B2B and B2C, under the SAC code in Settings (996331, restaurant service).
- **Table 13, documents issued**: the bill-number range, how many were cancelled, and the credit-note range.
- **Table 14, supplies through Zomato**: Zomato orders, where Zomato pays the GST under section 9(5). Add **Zomato's
  GSTIN** in Settings (it is on Zomato's monthly statement); without it the table shows on screen but is left out of
  the JSON, with a warning.

GSTR-3B Table 3.1 shows 3.1(a) taxable supplies, 3.1(c) nil rated and 3.1.1(ii) Zomato supplies. Input tax credit,
reverse charge and amendments are not covered: the POS does not record purchases.

Every supply is intra-state (CGST and SGST, never IGST), because restaurant service is supplied where the restaurant
is (IGST Act section 12(4)). The place of supply on every bill is the restaurant's state.

## Dates, voids and refunds

- Bills count on the day they were issued; credit notes on the day they were issued.
- A bill **issued and voided in the same period** is a cancelled invoice: it has no value in any table and is counted
  as cancelled in Table 13.
- A bill **voided in a later period**, and every refund, is a credit note in its own period: B2B bills go to
  Table 9B, walk-in bills are subtracted from Table 7. A filed period never changes.
- If a period's walk-in credit notes are more than its sales at a rate, the Table 7 row is negative and the screen
  warns: ask the accountant to report it as an amendment (B2CSA).

Warnings also appear for bills issued without GST in a GST period, gaps in the bill numbers, and a restaurant GSTIN
that fails the GSTIN check character. The GSTR-1 JSON can't be downloaded until the GSTIN is fixed in Settings.

## GST invoices to a business

At checkout open **Bill options**, tick **GST invoice for a business (buyer's GSTIN)** and enter the buyer's GSTIN,
legal name and (optionally) address. The GSTIN is checked as it is typed, including its check character, so most
typing mistakes are caught. A customer saved with a **Business GSTIN** and **Business legal name** (Customers > Edit)
fills these in. The checkout then shows *GST invoice to …*.

The bill prints **Billed to**, the buyer's GSTIN and address, **Place of supply** and the SAC code. Its credit notes
print the buyer too. A bill's buyer can't be changed after it is issued: void it and bill again. The restaurant must
have its own GSTIN saved, and the buyer's GSTIN can't be the restaurant's.

## Filing with the JSON

**Download GSTR-1 JSON** saves `GSTR1_<GSTIN>_<MMYYYY>.json` in the GSTN "Save GSTR-1" format (amounts in rupees,
dates DD-MM-YYYY). Open it in the GST offline tool or upload it on the GST portal (Returns > GSTR-1 > Prepare offline),
check the totals against this screen, then file. MasalaPOS does not file returns itself: filing through GSTN's API
needs a licensed GST Suvidha Provider.

### Before relying on the JSON

The format was built from GSTN's published API specification and has not yet been through the offline tool. Before
the first real filing, import a month's file into the latest offline tool and confirm with a CA:

- the nil-rated codes `INTRAB2B` / `INTRAB2C`, and item numbers written as rate × 100 + 1 (501 for 5%);
- Table 12 rows for a service: UQC `NA`, quantity 0, description in `user_desc`;
- Table 14 (`supeco.paytx`), with tax worked out at 5% of the Zomato value;
- whether Zomato bills belong in the Table 13 count (they share the bill-number series);
- for composition restaurants, that CMP-08 turnover is the bills' value after discounts and credit notes.
