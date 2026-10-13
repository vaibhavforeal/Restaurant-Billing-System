# Menu importer (photo / PDF to item database) design

Date: 2026-10-13. Status: draft, awaiting review.

## Goal

An administrator uploads a menu (digital PDF, scanned PDF, or phone photo) on the Catalog screen. The app extracts
categories, item names, prices and size variants **without an LLM**, shows them in an editable review grid, and
imports the approved rows through the existing CSV import pipeline.

Success: a typical printed menu of 50-150 items is imported in a few minutes, and a price is never silently wrong.

## Decisions (agreed 2026-10-13)

- Version 1 covers digital PDFs, scanned PDFs and photos. All three use the same review grid and import path.
- English only. The OCR language is a parameter so other scripts can be added later without touching the parser.
- Included for every administrator. No licence feature flag and no Marketplace entry.
- Extraction runs in the local server (Node/Fastify), not in the UI. Offline, no API key, no per-use cost; menu
  images stay on the machine.
- No LLM. Rules over OCR/PDF word boxes; the human review step covers what rules cannot read.
- No staging tables, no stored uploads, no migrations. The extract step is stateless.

## Architecture

```
Catalog screen -> "Import from menu" -> upload file
  -> POST /api/menu-import/extract            (catalog.manage, writes nothing)
       reader:  PDF text layer (pdfjs-dist)  |  scanned page / photo -> clean-up -> tesseract.js (eng)
                both produce: words with box + confidence, per page
       parser:  pure functions in packages/domain -> candidate rows + warnings
  -> review grid (UI)  -> rows serialised with catalogCsv()
  -> POST /api/catalog/import/preview  -> POST /api/catalog/import   (existing, unchanged)
```

### Reader (server)

- Accepts JPEG, PNG, WebP and PDF. Limits: 10 MB, 10 pages. Password-protected or corrupt files are rejected up front.
- PDF: `pdfjs-dist` returns words with coordinates. A page with almost no embedded text is treated as scanned: it is
  rendered to an image and sent to OCR.
- Image: grayscale, upscale and contrast clean-up, then `tesseract.js` with the `eng` language data bundled in the
  installer (about 10 MB).
- Output of both paths is the same: `{ page, words: { text, x, y, w, h, confidence }[] }[]`.
- A page with no text or no price-like numbers yields a page warning ("couldn't read this page, try a clearer
  photo") and the other pages continue. The whole request is capped at about 60 seconds.

### Parser (`packages/domain`, pure, unit-testable)

Input: words with boxes. Output: `{ rows, warnings }`. Each row has category, name, base price (paise or `null`),
variants, description, veg flag, source page, source text, and a confidence from 0 to 1.

1. Lines: words whose vertical centres overlap form a line; lines are ordered top to bottom.
2. Columns: cluster by horizontal position. If a vertical gap runs through most of the page it is a multi-column
   menu and each column is parsed left to right.
3. Prices: `₹`, `Rs`, `Rs.`, or a bare number (`80`, `120.50`, `120/-`). Common OCR confusions inside numbers
   are corrected (`O` to 0, `l`/`I` to 1); a corrected price lowers the row's confidence.
4. Item line: text followed by a price at the right end. Dot leaders and dashes between them are dropped.
5. Category heading: a priceless line in capitals, or with a larger box height than item lines, followed by item
   lines. Items before the first heading go to `Uncategorised`.
6. Descriptions: a priceless line directly under an item, smaller or not in capitals, attaches to that item
   (maximum 500 characters) and is not turned into an item.
7. Variants: several prices on one line (`Small 120 / Large 240`) become variants of one item. A size header such as
   `Half | Full` or `S M L` above a column names the prices on the lines below it.
8. Veg: only an explicit `(V)`, `(NV)`, `Veg` or `Non-veg` marker is used. Otherwise the importer default applies
   (veg) with no warning.
9. Rejected: phone numbers, addresses, GST numbers, dates and footer phrases. Lines matching no rule become
   warnings and are never turned into guessed items.

Never guessed: an item with no readable price keeps `null` and is highlighted.

### Review grid (UI)

- A full-width panel over the Catalog screen, styled like `CatalogTransfer`, using its `busy` / `run` pattern.
- Left: page preview, highlighting the source line of the selected row. Right: the editable grid with Category,
  Name, Price, Variants, Description and a status chip (OK, Check price, Missing price, Possible duplicate).
- Actions: delete row, add row, merge two rows, and "set GST for all" (one control; the CSV `gst_rate` column is
  left blank otherwise, which the importer treats as the restaurant default).
- Add or Update labels for each row come from the existing import preview. Matching is by category and name, as
  today.
- "Import N items" stays disabled until no row has a missing or invalid price.

### Commit

Reviewed rows are serialised with `catalogCsv()` using `CATALOG_CSV_COLUMNS` and sent to the existing
`/api/catalog/import/preview` and `/api/catalog/import`. Existing behaviour is unchanged: add-or-update, category
creation, duplicate and ambiguity checks, the revision check (HTTP 409 if the catalog changed), a single SQLite
transaction, and the `catalog.changed` broadcast.

- The CSV `price` column is the Non-AC price. For an item with variants, the base `price` is the lowest variant
  price, and each variant row repeats the identical item details plus `variant_name` and `variant_price` (a full
  price, not a surcharge).
- Service prices (`ac_price`, `takeaway_price`, Zomato) are not set by the importer.
- Names are passed through `catalogCsv()` so spreadsheet-formula escaping stays consistent with export.

## Errors

- Unsupported type, over-size or too many pages: rejected with a plain message before any work.
- Unreadable page: reported per page; other pages continue.
- Timeout: a clear message and nothing partial is returned.
- A failed commit shows the existing row-level import error and saves nothing.

## Testing

- Parser unit tests on saved word-and-box fixtures (no images): single column, two columns, dot leaders, size
  headers, multi-price lines, OCR digit fixes, footers to ignore, unreadable prices.
- A generated digital PDF with known content, run through the real PDF reader, checks that path end to end.
- Server tests for the endpoint: administrator only (403 otherwise), file limits, and no database writes.
- A browser script for the grid and the commit, in the style of the other `tools/e2e` scripts.
- Real phone photos cannot be asserted reliably in CI; 3-5 real menus are used for manual accuracy checks while the
  parser is tuned.

## Packaging

- New dependencies: `pdfjs-dist`, `tesseract.js`, plus the bundled `eng` traineddata. Neither needs an install
  script (npm install scripts are blocked in this environment).
- The OCR worker and WASM files must be unpacked outside the asar archive in electron-builder; verify in a
  packaged build.

## Out of scope

Other scripts, handwriting, photo and logo import, recipes and stock, background jobs, stored import history,
Excel `.xlsx`, and any LLM fallback.

## Open items

- Collect 3-5 real menus (photo and PDF) from target restaurants to tune thresholds before release.
- Confirm Electron packaging of the OCR worker in a packaged build.
