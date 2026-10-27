# Custom reports

Reports → **Custom reports** builds your own report from a few choices, saves it, and exports it to CSV. It is for the report you
keep asking for that none of the fixed reports quite match ("only these five columns", "sales by category, excluding void bills").

## Building a report

1. **Data source** — what each row is:
   - **Bills**: one row per bill issued (void and unpaid bills included; filter on *Status* to drop them).
   - **Bill items**: one row per item line on a bill, as saved at billing. Credit notes are *not* subtracted; use Detailed reports → Item / category sales for net figures.
   - **Payments**: one row per payment, by the date it was received. Zomato settlements are left out (Zomato owes that money; see Zomato reconciliation), so totals match Collections before refunds. Refunds paid out are not subtracted.
   - **Customers**: one row per customer, with their profile (email, tags, birthday, anniversary, opt-in, active). Visits, spend, average rating and points earned, redeemed, expired and reversed/adjusted count only the chosen dates (void bills excluded). Earned − redeemed − expired + reversed/adjusted is the change in balance over those dates; *Points balance now* is today's balance.
   - **Loyalty points**: one row per points entry (earned, redeemed, reversed, adjusted or expired) with its customer, bill, note and who recorded it.
   - **Feedback**: one row per rating, with its bill, customer, source (QR code or staff), comment and the overall, food, service and ambience ratings (averaged when grouped).
2. **Columns** — tick what you want, then reorder with ↑ ↓ and type a heading to rename a column.
3. **Group by** (optional) — combine rows that share a value, e.g. *Date* or *Category*. Amounts and quantities are summed per group; *Average bill* is averaged. On a grouped report every descriptive column is a group: grouping drops descriptive columns that are not grouped by, ticking one groups by it, and unticking one stops grouping by it. *Date and time* and *Added on* are unique per row, so they are only available on ungrouped reports.
4. **Filters** — up to 10. Money is typed in rupees. On a grouped report, a filter on a number column keeps or drops whole groups ("days with sales over ₹10,000").
5. **Sort** (ties keep the default order), then pick the dates and **Run report**. Export CSV downloads exactly what is on screen.

A report shows at most 5,000 rows. Past that, totals are left out and a note says so; narrow the dates or add filters.

## Saving

Everyone who can read reports (admins and cashiers) can open and run saved reports. Only admins create, edit, rename and delete them.
Names are unique, ignoring capitals. A saved report stores the design, not the data, so it always runs against the dates you choose.
If a later update renames or removes a column a saved report uses, opening it shows a message instead of running it; rebuild it and *Save changes*, or delete it.

## How it works (for developers)

- The catalogue of sources and fields lives in `packages/domain/src/custom-reports.ts`, shared by server and UI. The server maps each field id to SQL in `apps/server/src/custom-reports.ts`.
- Clients send only field ids and operators. Identifiers always come from the catalogue and filter values are bound parameters, so a saved definition can never inject SQL. A test runs every catalogue field in both detail and grouped form.
- Saved definitions are in `saved_reports` (migration 038). The `reports.manage` permission is admin-only.
- Endpoints: `GET /api/custom-reports`, `POST /api/custom-reports/run`, and `POST`/`PUT`/`DELETE /api/custom-reports[/:id]`.
- To add a field, add it to the catalogue and to the source's SQL map in the two files; the catalogue test fails if one side is missing.
- Not included yet: scheduled or emailed reports, Excel/PDF export, and Zomato, stock or KOT data sources.
