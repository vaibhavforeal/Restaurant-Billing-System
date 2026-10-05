# Item database CSV import and export

Administrators can open **Catalog** and use **Export CSV**, **Import CSV**, or
**Download template** above the products table. Export covers all categories,
including inactive items and variants. Prices are rupees, with two decimal places.

1. Download the template or export the current items.
2. Edit in Excel or another spreadsheet. Keep the header names and save as
   **CSV UTF-8 (comma delimited)**. Replace the template's sample item before use.
3. Choose **Import CSV**, select the file, and review the item actions and counts.
4. Click **Import … items** to save. A failed validation saves nothing and reports
   the row to fix. If the catalog changed at another counter, use **Preview again**.

The limit is 5 MB and 10,000 data rows. Quotes, commas, multiline descriptions and
Unicode names are supported. Export escapes spreadsheet formulas with a leading
apostrophe; importing the export removes this escape automatically.

| Column | Meaning |
| --- | --- |
| `item_id` | Keep the exported ID to update that item, including renaming or moving it. An unknown exported ID creates an item with that ID. Blank matches category and item name, ignoring case and surrounding spaces, or creates a new item. |
| `category` | Required category name. Missing categories are created active. Existing category settings remain unchanged. |
| `name` | Required item name. |
| `price` | Required non-negative rupees, at most two decimal places; no currency signs or thousands separators. |
| `gst_rate` | Required: 0, 5, 12, 18 or 28. |
| `is_veg`, `is_active`, `is_sold_out` | `true`/`false` (also accepts yes/no or 1/0). Missing or blank keeps existing values. New items default to true, true, false. |
| `description` | Up to 500 characters. Blank clears; omitted column preserves the existing description. |
| `kot_station` | Existing station name from Settings. Blank clears the link; omitted column preserves it. Create unfamiliar stations in Settings before importing. |
| `variant_id` | Keep an exported variant ID to update it. Blank matches the variant name within the item or creates it. |
| `variant_name`, `variant_price` | For each variant, add a row repeating identical item details and supply these fields. Variant prices are full rupee prices, not surcharges. |
| `variant_active` | true/false. Missing or blank preserves existing state; new variants default to active. |

Only `category`, `name`, `price` and `gst_rate` columns are required. Unrecognized
or duplicate headers are rejected. A product can have one base row and one row
per variant. Variant-only rows also work if the item details are repeated.
Duplicate base rows, duplicate variants, conflicting repeated item details,
ambiguous names and variant IDs belonging to another item are rejected.

Import adds or updates; it never deletes omitted items or variants. Exported IDs
take precedence over names. Keep them when changing names. Without IDs, changing
an item's name creates a new item. When moving a file to another installation,
configure matching KOT station names first. Duplicate category names must be
resolved before importing items in those categories.

CSV covers menu item details and variants. It does **not** transfer photos,
recipes, stock balances, category order/activation, or printer configuration.
Existing photos, stock links, recipes and historical orders/bills are preserved.
Use the backup feature for a complete restaurant database backup.

API: administrator-only `GET /api/catalog/export` returns `{filename, csv}`;
`POST /api/catalog/import/preview` accepts `{csv}` and returns counts, item actions
and a catalog `revision`. `POST /api/catalog/import` accepts `{csv, revision}`,
validates again and writes everything in one SQLite transaction. A changed
revision returns HTTP 409. Successful imports broadcast `catalog.changed`.
