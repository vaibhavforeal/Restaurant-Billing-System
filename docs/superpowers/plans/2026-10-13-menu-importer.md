# Menu Importer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An administrator uploads a menu photo or PDF on the Catalog screen, reviews the extracted items in an editable grid, and imports them through the existing CSV import pipeline, with no LLM.

**Architecture:** The server reads the file (PDF text layer through `pdfjs-dist`, or OCR through `tesseract.js`) into words with boxes. Pure parser functions in `packages/domain` turn words into candidate rows. The UI grid edits the rows, serialises them with `catalogCsv()`, and sends them to the existing `/api/catalog/import/preview` and `/api/catalog/import`. The extract endpoint is stateless: no tables, no migrations, no stored uploads.

**Tech Stack:** TypeScript, Fastify 5, vitest, React 19, `pdfjs-dist` 6.x, `tesseract.js` 7.x, `@tesseract.js-data/eng`, `node:zlib`.

**Spec:** `docs/superpowers/specs/2026-10-13-menu-importer-design.md`

## Global Constraints

- English OCR only (`eng`); the language is a parameter of `ocrImage`, not hard-coded in the parser.
- Limits: 10 MB per file, 10 pages, whole extraction capped at 60 seconds.
- Accepted types: JPEG, PNG, WebP, PDF. Type is decided by magic bytes, never by filename or declared content type.
- Endpoint `POST /api/menu-import/extract`, permission `catalog.manage`, writes nothing to the database.
- Prices are integer paise inside the domain parser and server. The CSV `price` and `variant_price` columns are rupees with two decimals (the existing importer's rule).
- Never guess a price: an unreadable price stays `null`. The Import button stays disabled until no row is missing a price or duplicated.
- Description maximum 500 characters (the importer's limit).
- The importer leaves `gst_rate` blank (restaurant default) unless the admin picks one rate in the grid.
- Included for every administrator: no licence flag, no Marketplace entry, no migration.
- Commit messages end with the attribution line the harness reminder specifies. Run vitest from the repo root.
- The working tree already holds unrelated uncommitted changes (including `apps/server/src/catalog.ts`). Execute in a fresh worktree and stage only the files each task names.

## Review Focus

Failure modes the spec implies but no obvious task test covers; each has a pinned test in the owning task.

1. A photo or PDF with no price-like text returns zero rows and a page warning, not a 500 (Task 6).
2. Two extractions at once: the second is refused with 429 instead of both running OCR (Task 6).
3. Item names beginning with `=`, `+`, `-` or `@` survive grid, CSV and import unchanged (Task 7).
4. Two grid rows with the same category and name are flagged and block import (Task 7).
5. An HTML or SVG file renamed `menu.pdf` or sent with `image/png` is rejected by magic-byte check (Task 4, Task 6).

---

## File Structure

Create:
- `packages/domain/src/menu-types.ts`: shared types and `LOW_CONFIDENCE`.
- `packages/domain/src/menu-price.ts`: `parsePrice`.
- `packages/domain/src/menu-layout.ts`: `groupLines`, `splitColumns`.
- `packages/domain/src/menu-parse.ts`: `parseMenu`.
- `apps/server/src/menu-file.ts`: `sniffMenuFile`, `imageSize`, `encodePng`.
- `apps/server/src/menu-pdf.ts`: `readPdf`.
- `apps/server/src/menu-ocr.ts`: `ocrImage`.
- `apps/server/src/menu-import.ts`: `registerMenuImport`.
- `apps/server/src/menu-test-pdf.ts`: test-only PDF builders.
- `apps/ui/src/menu-review.ts`: grid logic (status, merge, CSV).
- `apps/ui/src/screens/MenuImport.tsx`, `apps/ui/src/menu-import.css`.
- `tools/fixtures/menu-sample.html`, `tools/fixtures/menu-sample.png`, `tools/e2e/menu-import.js`, `docs/operations/menu-import.md`.
- A `.test.ts` next to each logic file above.

Modify: `packages/domain/package.json` (exports), `apps/server/package.json` (dependencies), `apps/server/src/catalog.ts:87` (register route), `apps/ui/src/screens/Catalog.tsx:166` (mount), `electron-builder*.yml` (asarUnpack), `tools/e2e/README.md`.

---

### Task 1: Price tokens and layout geometry

**Files:**
- Create: `packages/domain/src/menu-types.ts`, `menu-price.ts`, `menu-layout.ts`, `menu-price.test.ts`, `menu-layout.test.ts`
- Modify: `packages/domain/package.json` (add exports `./menu-types`, `./menu-price`, `./menu-layout`, `./menu-parse`)

**Interfaces:**
- Produces (`menu-types.ts`):
  ```ts
  export interface MenuWord { text: string; x: number; y: number; w: number; h: number; confidence: number } // y grows downward; confidence 0-100
  export interface MenuPage { page: number; width: number; height: number; source: "pdf-text" | "ocr"; words: MenuWord[] }
  export interface MenuVariant { name: string; pricePaise: number | null }
  export type MenuFlag = "price-corrected" | "missing-price" | "ambiguous-price";
  export interface MenuCandidateRow {
    category: string; name: string; pricePaise: number | null; variants: MenuVariant[]; description: string;
    isVeg: boolean | null; page: number; sourceText: string;
    box: { x: number; y: number; w: number; h: number }; // normalised 0-1 of the page
    confidence: number; flags: MenuFlag[];
  }
  export interface MenuWarning { page: number; text: string; reason: string }
  export interface MenuParseResult { rows: MenuCandidateRow[]; warnings: MenuWarning[] }
  export const LOW_CONFIDENCE = 0.7;
  ```
- Produces: `parsePrice(token: string): { paise: number; corrected: boolean } | null`
- Produces: `interface MenuLine { words: MenuWord[]; x: number; y: number; w: number; h: number; text: string }`, `groupLines(words: MenuWord[]): MenuLine[]`, `splitColumns(page: MenuPage): MenuWord[][]`

- [ ] **Step 1: Write failing `menu-price.test.ts`.** `parsePrice` expectations: `"80"` → `{paise: 8000, corrected: false}`; `"₹80"`, `"Rs.80"`, `"Rs 80/-"`, `"80/-"` → 8000; `"120.50"` → 12050; `"80.5"` → 8050; `"1,250"` → 125000; `"8O"` → `{paise: 800, corrected: true}`; `"l20"` → `{paise: 12000, corrected: true}`; `null` for `"0"`, `"12.345"`, `"9876543210"`, `"2024-01-01"`, `"Dosa"`, `""`.
- [ ] **Step 2: Run** `npx vitest run packages/domain/src/menu-price.test.ts`. Expected: FAIL (module not found).
- [ ] **Step 3: Implement `parsePrice`** in `menu-price.ts`. Strip a leading `₹`/`Rs`/`Rs.`/`INR` and a trailing `/-`; remove thousands commas; replace `O`/`o` with 0 and `l`/`I` with 1 only when the remaining token has at least one real digit (set `corrected`); accept up to 5 integer digits and at most 2 decimals; reject zero.
- [ ] **Step 4: Run the test again.** Expected: PASS.
- [ ] **Step 5: Write failing `menu-layout.test.ts`.** Build words with a small helper `w(text, x, y, width = 40, height = 10)`. Cases:
  - `groupLines`: words whose vertical centres differ by less than 40% of the taller height share a line; lines are ordered top to bottom and words left to right; `line.text` joins with single spaces.
  - `splitColumns`: a page with names and prices at the far right of every line stays one column; a page whose lines have text on both sides of an empty gap of at least 6% of page width (right side containing a word of 2 or more letters on at least 3 lines) returns two word groups ordered left to right.
- [ ] **Step 6: Run to verify FAIL.**
- [ ] **Step 7: Implement `groupLines` and `splitColumns`** in `menu-layout.ts`. A column gap is a free x-interval between the leftmost and rightmost words, at least 6% of `page.width`, with a letter-bearing word (2 or more letters) on its right side on at least 3 lines. Price-only text on the right never forms a column.
- [ ] **Step 8: Run both test files; all PASS.** Commit: `git add packages/domain && git commit -m "feat(domain): menu price tokens and line/column layout"`

---

### Task 2: Core menu parser (categories, items, rejects, confidence)

**Files:**
- Create: `packages/domain/src/menu-parse.ts`, `menu-parse.test.ts`

**Interfaces:**
- Consumes: Task 1 types, `parsePrice`, `groupLines`, `splitColumns`.
- Produces: `parseMenu(pages: MenuPage[]): MenuParseResult`

- [ ] **Step 1: Write failing `menu-parse.test.ts`** with a helper that builds a `MenuPage` from `[text, y]` rows (each token laid out left to right at 12px height, price words at the right edge). Cases:
  - Heading `STARTERS` then `Paneer Tikka ..... 260` → one row `{category: "STARTERS", name: "Paneer Tikka", pricePaise: 26000, variants: [], flags: []}`.
  - Dot leaders and dashes between name and price are dropped from the name (`Masala Dosa ........ 80`).
  - Items before any heading get category `Uncategorised`.
  - A heading is also detected by a taller box (height at least 1.3 times the median line height) when not in capitals.
  - The current category carries over to the next page.
  - A priceless 1-to-6-word line at item height, not matching a reject, becomes a row with `pricePaise: null`, flag `missing-price`, `confidence` at most 0.4.
  - Rejects produce warnings and no rows: `Call 9876543210`, `GST No. 27ABCDE1234F1Z5`, `FSSAI 12345678901234`, `Thank you, visit again`, `www.example.com`.
  - A longer priceless line (more than 6 words) that is not a description becomes a warning, never an item.
  - `1O0` as a price gives 10000, flag `price-corrected`, confidence multiplied by 0.8.
  - OCR page: row confidence is the minimum word confidence of the name and price words divided by 100; PDF-text pages use 1.
  - `box` is the line bounding box divided by page width and height; `sourceText` is the line text.
  - Two-column page parses each column independently, left column first.
- [ ] **Step 2: Run** `npx vitest run packages/domain/src/menu-parse.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement `parseMenu`** in `menu-parse.ts`: per page, `splitColumns`, `groupLines`, then classify each line in order: reject patterns (phone of 7 or more digits, `GST`, `FSSAI`, `www.`, `@`, `thank`, `visit`, `address`), price-bearing item, heading, missing-price item, else warning. Strip leader characters (`.`, `-`, `_`, `…`, `·`) between name and price.
- [ ] **Step 4: Run to PASS.** Commit: `git add packages/domain && git commit -m "feat(domain): menu parser for categories, items and rejects"`

---

### Task 3: Parser variants, descriptions, veg markers

**Files:**
- Modify: `packages/domain/src/menu-parse.ts`, `menu-parse.test.ts`

**Interfaces:**
- Consumes/Produces: the same `parseMenu`; the row fields `variants`, `description`, `isVeg`, flag `ambiguous-price` are now populated.

- [ ] **Step 1: Add failing tests.**
  - `Chicken Biryani Half 180 Full 320` → name `Chicken Biryani`, variants `[{Half, 18000}, {Full, 32000}]`, `pricePaise: 18000` (lowest variant price).
  - `Tea Small 10 / Large 20` handles a `/` separator the same way.
  - A size header line `HALF   FULL` (priceless, only size words) then `Paneer Tikka 150 280` assigns each price to the header word with the nearest x-centre; a `S  M  L` header works with three prices.
  - Several unlabeled prices and no header (`Tea 10 20`) → `pricePaise: null`, flags `["ambiguous-price"]`, a warning, never a guessed pick.
  - A smaller-height, non-capitals priceless line directly under an item (`Served with mint chutney`) becomes that item's `description` (cut at 500 characters) and is not a row.
  - `Paneer Tikka (V) 260` → `isVeg: true`, `(V)` removed from the name; `(NV)`, `Veg`, `Non-veg` markers likewise (`false` for non-veg); no marker → `isVeg: null`.
- [ ] **Step 2: Run to verify FAIL.**
- [ ] **Step 3: Implement** in `menu-parse.ts`: label-before-price pattern for variants, size-header detection (a line of only size words `half full small medium large regular s m l`), description attachment, veg marker stripping before name cleanup.
- [ ] **Step 4: Run all domain menu tests** `npx vitest run packages/domain/src/menu-` Expected: PASS. Commit: `git add packages/domain && git commit -m "feat(domain): menu variants, descriptions and veg markers"`

---

### Task 4: File sniffing, image size, PNG encoder

**Files:**
- Create: `apps/server/src/menu-file.ts`, `menu-file.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type MenuFileKind = "jpeg" | "png" | "webp" | "pdf";
  export function sniffMenuFile(bytes: Uint8Array): MenuFileKind | null; // magic bytes only
  export function imageSize(bytes: Uint8Array, kind: "jpeg" | "png" | "webp"): { width: number; height: number } | null;
  export interface RawImage { width: number; height: number; data: Uint8Array } // RGBA, 4 bytes per pixel
  export function encodePng(image: RawImage): Buffer;
  ```

- [ ] **Step 1: Write failing tests.** `sniffMenuFile` returns `"pdf"` for `%PDF-1.7`, `"png"` for the 8-byte PNG signature, `"jpeg"` for `FF D8 FF`, `"webp"` for `RIFF....WEBP`, and `null` for `<html>`, `<svg`, an empty array and random bytes. `encodePng` of a 2x2 image: signature present, IHDR width/height 2/2, and inflating the IDAT stream gives 2 rows of `filter byte 0` plus 8 bytes. `imageSize` reads width and height back from `encodePng` output and from a hard-coded minimal JPEG SOF0 header (include 3 test bytes for WebP VP8X as well).
- [ ] **Step 2: Run** `npx vitest run apps/server/src/menu-file.test.ts` Expected: FAIL.
- [ ] **Step 3: Implement** the three functions. `encodePng` writes IHDR, one IDAT (`deflateSync` from `node:zlib`, filter 0 per row) and IEND with the CRC32 as in `tools/build-desktop.mjs`. `imageSize` reads PNG IHDR, JPEG SOF0 to SOF3 and SOF5 to SOF15 markers, and the WebP VP8, VP8L and VP8X chunks.
- [ ] **Step 4: Run to PASS.** Commit: `git add apps/server/src/menu-file.ts apps/server/src/menu-file.test.ts && git commit -m "feat(server): menu file sniffing and image helpers"`

---

### Task 5: PDF reader (text layer, scanned-page image)

**Files:**
- Create: `apps/server/src/menu-pdf.ts`, `menu-test-pdf.ts`, `menu-pdf.test.ts`
- Modify: `apps/server/package.json` (add dependency `pdfjs-dist`)

**Interfaces:**
- Consumes: `MenuWord` (domain), `RawImage` (Task 4), `httpError` from `./http-error.js`.
- Produces:
  ```ts
  export interface PdfPageResult { page: number; width: number; height: number; words: MenuWord[]; image: RawImage | null }
  export async function readPdf(bytes: Uint8Array, maxPages: number): Promise<PdfPageResult[]>
  // throws httpError(400, ...) for encrypted, corrupt, or more than maxPages pages
  ```
- Test helpers (`menu-test-pdf.ts`): `makeTextPdf(lines: { text: string; x: number; y: number; size: number }[]): Buffer` and `makeImagePdf(width: number, height: number, rgb: Uint8Array): Buffer` (hand-written PDF with Helvetica text, or one uncompressed DeviceRGB image drawn across the page, with a valid xref table).

- [ ] **Step 1: Install.** `npm install --ignore-scripts -w @forkflow/server pdfjs-dist` (install scripts are blocked in this environment). Expected: `pdfjs-dist` appears in `apps/server/package.json`; engines `>=22.13` is satisfied by Node 24.
- [ ] **Step 2: Write failing `menu-pdf.test.ts`.**
  - `makeTextPdf` with `Masala Dosa` at (50, 700) and `80` at (400, 700): result has one page; words include `Masala`, `Dosa`, `80`; `confidence` is 100 for all; `y` grows downward (the first line has a smaller `y` than a line placed lower on the page); `image` is `null`.
  - `makeImagePdf(4, 4, rgb)` has 0 text words, so `readPdf` returns `image` with width 4, height 4, and RGBA data length 64.
  - A PDF with 3 pages and `maxPages = 2` rejects with status 400 and a message naming the limit.
  - Garbage bytes starting with `%PDF-` reject with status 400.
- [ ] **Step 2b: Run to verify FAIL.**
- [ ] **Step 3: Implement `readPdf`** using `pdfjs-dist/legacy/build/pdf.mjs` with `disableWorker` behaviour (Node fake worker), `isEvalSupported: false`. Split each text item on whitespace and place each word by its share of the item width; convert PDF y-up to top-down. A page with fewer than 5 words extracts its largest embedded image from `getOperatorList()` (`paintImageXObject` / `paintInlineImageXObject`), converting pdf.js image kinds 1, 2, 3 to RGBA.
- [ ] **Step 4: Run to PASS.** Commit: `git add apps/server/package.json package-lock.json apps/server/src/menu-pdf.ts apps/server/src/menu-test-pdf.ts apps/server/src/menu-pdf.test.ts && git commit -m "feat(server): menu PDF reader"`

---

### Task 6: OCR wrapper and the extract endpoint

**Files:**
- Create: `apps/server/src/menu-ocr.ts`, `menu-ocr.test.ts`, `menu-import.ts`, `menu-import.test.ts`, `tools/fixtures/menu-sample.html`, `tools/fixtures/menu-sample.png`
- Modify: `apps/server/package.json`, `apps/server/src/catalog.ts:87`

**Interfaces:**
- Consumes: Tasks 1 to 5.
- Produces:
  ```ts
  export async function ocrImage(bytes: Uint8Array, size: { width: number; height: number }, options?: { language?: string }): Promise<MenuWord[]>
  export interface MenuImportDeps { ocr?: typeof ocrImage; timeoutMs?: number }
  export function registerMenuImport(app: FastifyInstance, deps?: MenuImportDeps): void
  // POST /api/menu-import/extract  body { data: string /* base64 */ }  ->  { pages: { page: number; width: number; height: number; source: "pdf-text" | "ocr" }[]; rows: MenuCandidateRow[]; warnings: MenuWarning[] }
  ```

- [ ] **Step 1: Install and fixture.** `npm install --ignore-scripts -w @forkflow/server tesseract.js @tesseract.js-data/eng`. Write `tools/fixtures/menu-sample.html` (large clean sans-serif, white background: heading `STARTERS`, lines `Masala Dosa ........ 80` and `Paneer Tikka ........ 260`) and screenshot it with the Playwright browser to `tools/fixtures/menu-sample.png`. Locate `eng.traineddata(.gz)` inside the installed `@tesseract.js-data/eng` package and note the exact directory for `langPath`.
- [ ] **Step 2: Write failing `menu-ocr.test.ts`** (timeout 60 s): `ocrImage(fixture, imageSize(...))` returns words whose text includes `Masala`, `Dosa` and `80`, each with a positive box inside the image size and confidence 0-100; `parseMenu` over a page built from those words returns a row named like `Masala Dosa` priced 8000.
- [ ] **Step 3: Run to verify FAIL.**
- [ ] **Step 4: Implement `ocrImage`**: create a `tesseract.js` worker with `langPath` pointing at the bundled `eng` data, `gzip` matching the file found in Step 1, `cacheMethod: "none"` (never a download), request word boxes in the recognise output (tesseract.js 6 and later need `{ blocks: true }`), map each word bbox to `MenuWord`, and terminate the worker in `finally`.
- [ ] **Step 5: Run `menu-ocr.test.ts` to PASS.**
- [ ] **Step 6: Write failing `menu-import.test.ts`** using `freshApp()`/`setupAdmin()`/`createUser()` from `./test-helpers.js` and `registerMenuImport` dependency injection for a fake `ocr`:
  - A `makeTextPdf` menu extracts rows with correct category, name and `pricePaise`.
  - Non-admin (for example a cashier) gets 403; unauthenticated gets 401.
  - Over 10 MB decoded, bad base64, an unsupported type, and **an HTML file sent as `menu.pdf` bytes** (magic mismatch) get 400 with plain messages.
  - A page with no price-like text returns `rows: []` and a page warning, status 200.
  - Two simultaneous requests (the first blocked on a fake `ocr` promise): the second returns 429 "Another menu is being read" and the first still succeeds.
  - A fake `ocr` that never resolves with `timeoutMs: 50` returns 504 with a timeout message.
  - The database row counts for `products`, `categories` and `variants` are unchanged after every request.
- [ ] **Step 7: Run to verify FAIL.**
- [ ] **Step 8: Implement `registerMenuImport`** in `menu-import.ts` (preHandler `app.requirePermission("catalog.manage")`, route `bodyLimit` of 14 MB). Flow: validate base64, size, `sniffMenuFile`; for `pdf` call `readPdf(bytes, 10)` and OCR any page where `image` is set (convert with `encodePng`); for images call `ocrImage` using `imageSize`; build `MenuPage[]`, call `parseMenu`. A module-level in-flight flag per app gives the 429. The deadline races each OCR call and returns 504. Register it in `catalog.ts` next to `registerCatalogTransfer(app)`.
- [ ] **Step 9: Run** `npx vitest run apps/server/src/menu-` Expected: PASS. Commit: `git add apps/server/package.json package-lock.json apps/server/src/menu-ocr.ts apps/server/src/menu-ocr.test.ts apps/server/src/menu-import.ts apps/server/src/menu-import.test.ts apps/server/src/catalog.ts tools/fixtures && git commit -m "feat(server): menu OCR and extract endpoint"` (stage only your own hunk of `catalog.ts`, for example with `git add -p`).

---

### Task 7: Review grid logic (pure UI module)

**Files:**
- Create: `apps/ui/src/menu-review.ts`, `apps/ui/src/menu-review.test.ts`

**Interfaces:**
- Consumes: `MenuCandidateRow`, `LOW_CONFIDENCE` from `@forkflow/domain/menu-types`; `catalogCsv`, `CATALOG_CSV_COLUMNS`, `parseCatalogCsv` from `@forkflow/domain/catalog-csv`.
- Produces:
  ```ts
  export interface ReviewRow extends MenuCandidateRow { id: string }
  export type RowStatus = "ok" | "check-price" | "missing-price" | "duplicate";
  export function toReviewRows(rows: MenuCandidateRow[]): ReviewRow[]   // adds a stable id
  export function rowStatus(row: ReviewRow, all: ReviewRow[]): RowStatus
  export function canImport(rows: ReviewRow[]): boolean
  export function mergeRows(rows: ReviewRow[], index: number): ReviewRow[] // merges rows[index + 1] into rows[index]
  export function parseRupees(text: string): number | null                  // "12.5" -> 1250; null when invalid
  export function rowsToCsv(rows: ReviewRow[], gstRate: "" | 0 | 5 | 12 | 18 | 28): string
  ```

- [ ] **Step 1: Write failing `menu-review.test.ts`.**
  - `rowStatus`: `missing-price` when the base price is null with no variants, or any variant price is null, or the name or category is blank; `duplicate` when another row has the same trimmed, lower-cased category and name; `check-price` when confidence is below `LOW_CONFIDENCE` or a flag is `price-corrected` or `ambiguous-price`; otherwise `ok`. Precedence: missing-price, duplicate, check-price.
  - `canImport` is false for an empty list and for any `missing-price` or `duplicate` row; true when only `check-price` rows remain.
  - `mergeRows`: name joined with a single space, first row's price kept (second's if the first is null), variants concatenated, second row removed; out-of-range index returns the list unchanged.
  - `parseRupees`: `"12.5"` → 1250, `"80"` → 8000, `""`, `"-1"`, `"1.234"`, `"₹80"` → null.
  - `rowsToCsv` header is `category,name,price,gst_rate,is_veg,description,variant_name,variant_price`; a variant item emits a base row with blank variant fields plus one row per variant repeating identical item details, with `price` equal to the lowest variant price; `gstRate: ""` leaves the column blank; `isVeg: null` leaves `is_veg` blank.
  - **Round-trip:** `parseCatalogCsv(rowsToCsv(rows, 5))` returns the original names exactly for names such as `=SUM(1)`, `+91 Special`, `-Tea`, `@Home`, `"Quoted", Name` and `पेय`.
- [ ] **Step 2: Run** `npx vitest run apps/ui/src/menu-review.test.ts` Expected: FAIL.
- [ ] **Step 3: Implement** the module. Serialise with `catalogCsv` so formula escaping stays identical to the export.
- [ ] **Step 4: Run to PASS.** Commit: `git add apps/ui/src/menu-review.ts apps/ui/src/menu-review.test.ts && git commit -m "feat(ui): menu review grid logic"`

---

### Task 8: Import-from-menu screen

**Files:**
- Create: `apps/ui/src/screens/MenuImport.tsx`, `apps/ui/src/menu-import.css`, `apps/ui/src/menu-import.test.ts`
- Modify: `apps/ui/src/screens/Catalog.tsx:166` (render beside `CatalogTransfer`)

**Interfaces:**
- Consumes: Task 7, `apiFetch` from `../api`, `CatalogImportPreview` from `@forkflow/domain/catalog-csv`, `paiseToRupees` from `../money`. Same `busy`, `run`, `onImported` props as `CatalogTransfer`.
- Produces: `export function MenuImport(props: { busy: boolean; run: (action: () => Promise<unknown>, key?: string) => Promise<void>; onImported: (message: string) => void }): JSX.Element`

- [ ] **Step 1: Write failing `menu-import.test.ts`** (`renderToStaticMarkup`, like `choice-tiles.test.ts`): the closed state renders an **Import from menu** button and a hidden file input with `aria-label="Choose menu file"` and `accept="image/jpeg,image/png,image/webp,application/pdf"`; `busy` disables the button.
- [ ] **Step 2: Run to verify FAIL.**
- [ ] **Step 3: Implement `MenuImport.tsx`.** Choose a file (reject over 10 MB client-side), base64 it, `POST /api/menu-import/extract`, then show the panel: left, the photo preview (`URL.createObjectURL`) with the selected row's `box` highlighted, or the row's `sourceText` for PDFs and scans; right, the editable grid (Category, Name, Price in rupees via `parseRupees`, Variants, Description, status chip). Actions: delete row, add row, merge with next, a "Set GST for all" select (restaurant default, 0, 5, 12, 18, 28). **Preview import** runs `rowsToCsv` through `/api/catalog/import/preview` and shows Add/Update counts in the existing table style; **Import N items** is disabled until `canImport(rows)` and a preview exists, then calls `/api/catalog/import` with the preview `revision` and reports through `onImported`. Page warnings from the server show above the grid. Mount it in `Catalog.tsx` after `CatalogTransfer`.
- [ ] **Step 4: Run** `npx vitest run apps/ui/src/menu-import.test.ts` Expected: PASS. Then `npm run typecheck`. Expected: clean.
- [ ] **Step 5: Commit** `git add apps/ui/src/screens/MenuImport.tsx apps/ui/src/menu-import.css apps/ui/src/menu-import.test.ts apps/ui/src/screens/Catalog.tsx && git commit -m "feat(ui): import items from a menu photo or PDF"` (stage only your hunk of `Catalog.tsx`).

---

### Task 9: End-to-end check, packaging, docs

**Files:**
- Create: `tools/e2e/menu-import.js`, `docs/operations/menu-import.md`
- Modify: every `electron-builder*.yml` that lists `node_modules/better-sqlite3/**/*` under `asarUnpack`, and `tools/e2e/README.md`

- [ ] **Step 1: Unpack OCR files.** Add `node_modules/tesseract.js/**/*`, `node_modules/tesseract.js-core/**/*` and `node_modules/@tesseract.js-data/**/*` to `asarUnpack` in each builder config (`build-desktop.mjs` already stages everything in `apps/server/package.json` dependencies). Run `npm run test:packaging`. Expected: PASS.
- [ ] **Step 2: Write `tools/e2e/menu-import.js`** in the style of `catalog-transfer.js` (admin signed in, disposable port-4125 server): upload `menu-sample.png` through the **Choose menu file** input; expect the grid to list `Masala Dosa` 80.00 and `Paneer Tikka` 260.00; edit a price; confirm **Import N items** is disabled while a row is missing a price or duplicated; **Preview import** shows Add counts; **Import** adds the items to the Catalog table. Record the check count in the README entry.
- [ ] **Step 3: Run the e2e script** through the Playwright browser against the fixture server; require a passed result.
- [ ] **Step 4: Write `docs/operations/menu-import.md`** (how to use it, what it reads well, what needs fixing, limits) and link it beside `item-import-export.md`'s topic in the README entry.
- [ ] **Step 5: Verify in a packaged build (manual, needs a desktop session).** `npm run build:demo`, then `npx electron-builder --config electron-builder.demo.yml --win --x64 --dir`, start the unpacked demo app, sign in as admin, upload `tools/fixtures/menu-sample.png` through Catalog. Expected: the grid fills with Masala Dosa and Paneer Tikka. If the OCR worker fails to start from the archive, fix `asarUnpack` and repeat.
- [ ] **Step 6: Full gate.** `npm run typecheck` and `npx vitest run` from the repo root. Expected: typecheck clean; all tests pass except the 2 known `captain-https` environment failures. Commit: `git add tools docs electron-builder*.yml && git commit -m "feat: menu importer e2e, packaging and docs"`
