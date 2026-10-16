# Restaurant receipt design QA - 2026-10-09

final result: passed

## Target and evidence

- Source visual: `Screenshots/Screenshot 2026-10-09 101725.png` (411 x 711 px).
- Implementation: production `receiptHtml` and `receiptSlip` outputs generated
  by `node --import tsx tools/preview-bills.ts`.
- Final browser screenshot: `docs/screenshots/restaurant-bill.png` (438 x 922 px,
  cropped from the white receipt area, without browser chrome).
- Full comparison: `.e2e-scratch/bill-design/comparison-final.png` (842 x 865 px).
  The receipt is normalized to the reference's 411 px width. Heights differ
  intentionally: the restaurant example has five dishes, rates, service/table
  metadata, two payments, and a thank-you footer; the source has two retail items.
- Initial comparison: `.e2e-scratch/bill-design/comparison-initial.png`.
- Desktop browser viewport: 800 x 900 CSS px; earlier baseline: 1280 x 720.
  Final viewport screenshot files are 800 x 875 bitmap pixels; top and bottom
  captures use observed scroll offsets 0 and 72 to assemble the whole receipt.
  No device-pixel-ratio multiplier was applied to the returned images.
- Narrow checks: 411 x 800 and 320 x 740 CSS px. Evidence:
  `receipt-411.png`, `receipt-320-top.png`, `receipt-large-320.png` in
  `.e2e-scratch/bill-design`.
- Printed evidence: `bill-a4.pdf`, `bill-a4-print.png`, `bill-long.pdf`, and
  `bill-long-print-1.png` through `bill-long-print-3.png` in that directory.
- Thermal-byte visualizations: `thermal-58.png` and `thermal-80.png` there.
- UPI layout: `receipt-upi-bottom.png` there.

## Comparison and fixes

1. Initial comparison found [P2] thin serif typography compared with the clear,
   block-like reference. Replaced Courier New with Lucida Console (system-font
   fallbacks retained), increased item text to 14 px, and reduced header padding.
2. Allocated more numeric-column space below 360 px and widened the totals
   amount column. A large-value example with a long catering description,
   quantity 100 and total Rs. 9,999,999.00 has no overflowing cells at 320 px.
3. Final combined comparison confirms the centered business header, simple
   bill title, left-aligned metadata, dotted rules, aligned numeric columns,
   compact tax lines, and emphasized total. No actionable P0/P1/P2 findings.

## Required visual surfaces

- Typography: stronger monospaced system font, readable headings and amounts,
  smaller supporting tax copy; names wrap without truncation.
- Spacing/layout: single vertical receipt, compact rows, deliberate gaps before
  the bill title and item table; all amounts remain visible at tested widths.
- Colors: black text on white paper with restrained dotted separators, matching
  the reference's monochrome treatment.
- Images/assets: no decorative image or logo is present in the source. The
  existing generated UPI QR remains a real scannable code, with clear margins.
- Copy: retail buyer/DR reference and sample goods replaced with restaurant
  service/table metadata and dishes. No invented cash-tendered or contact data.
  GST and payments use the saved bill data. Included GST is labeled explicitly.

The full-width comparison makes the header, item table, and total legible;
separate enlarged region crops were unnecessary. Narrow and UPI screenshots
provide additional focused evidence of wrapping and payment layout.

## Functional and print validation

- 85 tests passed across 12 printing test files, including UPI and credit notes.
- TypeScript checks passed for the server/domain and UI; `git diff --check` passed.
- Read-only code review found no actionable regressions and independently
  exercised long/unbroken names, control bytes, oversized quantities, and mixed
  inclusive GST in 32/48-character thermal output.
- Browser checked paid, unpaid, void, takeaway, mixed/inclusive GST, UPI, and
  large-value examples. No horizontal overflow on the checked HTML receipts.
- No browser console errors were recorded on the receipt preview.
- Ordinary A4 bill prints on one page. The 52-item bill prints on three pages;
  all 52 numbered sample lines survive, column headings repeat, bill number/page
  count are present, and the final total and payment state appear on page three.
  All three PDF pages were rendered with Poppler and visually inspected.
- Receipt documents are script-free, so there are no new interactive controls.
  Existing checkout print actions still call the same renderer entry points.

## Remaining limitations

Physical printer output was not tested. The byte visualizer approximates
printer fonts; each printer's firmware and paper profile determine its exact
glyphs and spacing. Existing ASCII fallback behavior is unchanged.

## Implementation checklist

- [x] Adapt the selected reference for restaurant receipts.
- [x] Preserve financial data, payment states, and UPI generation.
- [x] Check small screens, both thermal widths, and long A4 bills.
- [x] Fix the typography finding and compare the final render again.
- [x] Save preview, format documentation, and QA evidence.

## Tax-inclusive format follow-up - 2026-10-09

The user requested a second format with no CGST or SGST on the bill. Inclusive
bills now replace all taxable/CGST/SGST rows with **All prices include tax**.
Exclusive bills retain their breakdown; saved calculations and reports remain
unchanged. The current setting is not changed by this work. New inclusive bills
use Settings > Menu price tax mode > Menu prices include GST; reprints use the
bill's saved mode. Settings help text now explains the receipt behavior.

- Visual reference: the established `docs/screenshots/restaurant-bill.png`.
- Implementation: `docs/screenshots/restaurant-bill-inclusive.png` (438 x 837).
- Browser viewport: 615 x 468 CSS px; full-page capture 600 x 887 px, cropped to
  the white receipt area. No density rescaling was applied.
- Side-by-side comparison: `.e2e-scratch/bill-design/comparison-inclusive.png`
  (896 x 922). Both receipt crops are 438 px wide. The inclusive fixture adds a
  sixth item and is unpaid, so line count and payment metadata differ by design.
- Fonts, colors, item columns, header, separators, and total emphasis retain the
  established style. The shorter summary is the intended change. Full-view
  comparison is readable; additional enlarged crops were unnecessary.
- Browser verified no component tax rows and the inclusive total of 1140.00
  (subtotal 1190.00 minus discount 50.00). Both thermal previews show the same
  total/note without CGST, SGST, or taxable-value lines.
- Evidence: `receipt-inclusive.png`, `receipt-inclusive-58mm.png`,
  `receipt-inclusive-80mm.png`, `bill-inclusive.pdf`, and
  `bill-inclusive-print.png` under `.e2e-scratch/bill-design`. The PDF has one
  page and was rendered with Poppler and visually inspected.
- 97 printing/billing tests passed. Mixed-rate inclusive tests verify hidden
  components, preserved positive internal GST values, an unchanged Bill object,
  discount, payment status, and total. Historical-bill reprints remain inclusive
  after settings/catalog changes. Type checks passed.
- Follow-up read-only review found no actionable issues. Independent checks
  covered inclusive/exclusive, restaurant/Zomato, and all three bill statuses.

No P0/P1/P2 findings. Physical printer verification remains outstanding.
final result: passed

## Selectable bill styles - 2026-10-09

The user confirmed that additional designs should be selectable in the app.
Settings > Restaurant profile > Bill style now offers Classic, Modern, Heritage,
and Compact. The database defaults to Classic; every new bill snapshots the
selected style. Missing or invalid historical values resolve to Classic. Existing
UPI, tax mode, payment status, service details and financial calculations are
shared by all four styles. Logo upload/printing remains unsupported.

### Visual evidence

- Comparison: `docs/screenshots/restaurant-bill-styles.png` (1434 x 1020).
  Each unscaled white receipt crop is 438 px wide. Sources were captured at the
  normal browser viewport, 600 px image width: Modern 955 px tall, Heritage 941,
  Compact 668. All use the same six-item, unpaid, tax-inclusive fixture.
- Modern uses Arial/Helvetica with a left header, heavy top rule and bold total.
  Heritage uses Georgia/Times, centered headings and double rules. Compact uses
  Tahoma/Verdana/Arial, smaller type and reduced spacing. Fonts are local fallbacks;
  physical thermal fonts depend on firmware. No external assets are required.
- Phone-width review used 320 CSS px. An initial Qty heading wrap was fixed by
  allocating 10% of the item table to quantity at the smallest breakpoint.
  Final `style-*-narrow-final.png` captures in `.e2e-scratch/bill-design` include
  the complete right edge, all amounts and UPI quiet zones. Document scroll width
  equaled client width (305 px after the scrollbar). Earlier full-page captures
  clipped the right edge in the capture tool; explicit 320 px clip captures are
  the final evidence. Temporary viewport overrides were reset.
- Each ordinary inclusive A4 PDF is one page with the correct 1140.00 total,
  no component tax rows and an unpaid balance. The 52-item PDFs use three pages
  in Modern/Heritage and two in Compact. Poppler renders were inspected; all
  numbered rows 1–52 survive extraction, headings repeat on each page, totals
  remain together, and page numbers/bill references print correctly.
- Gallery `bill-styles.html` uses production HTML and ESC/POS renderers. Tax and
  format selectors switch all four previews and their Open bill links. Verified
  inclusive PDF, exclusive 80 mm and inclusive 58 mm. Frame height includes its
  border to prevent an unnecessary nested scrollbar. Separate links show UPI.
- The in-memory demo confirmed Heritage could be selected, saved, and retained
  after reloading and reopening Settings. Evidence: `settings-styles.png`.
  Demo used an isolated UI build and simulated printer, then was stopped.

### Verification and limitations

- 154 targeted printing, billing, settings and migration checks passed, including
  legacy fallback, invalid setting rejection, historical reprints, tax/platform
  behavior and independent QR decoding at both thermal widths for every style.
- Full suite: 987 tests passed; two existing Captain HTTPS tests failed before
  HTTPS initialization because Windows rejected `setup-captain-https.ps1` with
  `AuthorizationManager check failed`. No TLS/test-policy files were changed.
- Type checking, UI production build and whitespace checks passed. The UI build
  emitted its chunk-size advisory. No runtime desktop installation was replaced.
- Independent read-only review found no actionable issues and exercised 48
  style/tax/platform/status combinations at both thermal widths. Classic thermal
  snapshots remain unchanged from the previously reviewed receipt layout.
- Browser instrumentation emitted MutationObserver errors during iframe capture;
  the gallery does not use MutationObserver. Its actual controls were exercised.
- No physical printer check was performed. Desktop typefaces apply to preview/PDF;
  thermal variants use built-in fonts with changed alignment/rules/spacing.

No unresolved bill-style findings.
final result: passed


# Browser POS parity � 2026-10-13

final result: passed (dashboard spacing restoration; intentional differences below)

Reference: supplied October 12 desktop screenshots. Browser evidence: `docs/screenshots/browser-parity/`. Dashboard `comparison.png` places both views together. Desktop native title bar removed and 1910px-wide capture normalized to 1272 CSS px; browser settled capture is 1272 x 634. Initial capture after resizing was clipped; it was replaced before comparison.

Fixed: removed dashboard-only compact overrides that reduced card padding, added padding inside Alerts, stretched the chart, and introduced independent column scrollbars. Original 16px card padding, 34px channel icons, 236px chart plot, 360px side column, 16px card gaps and workspace scrolling are restored. Base fonts, palette, icons and all other module styles remain unchanged.

Verified: production build passed; browser loaded index-DY94hP2F.css after closing/reopening the old cached release. Navigated Dashboard, Tables, Reports, Inventory, Catalog, Users, Marketplace and Settings and captured rendered content. Comparison checked type, spacing, colors, supplied icons, and copy. No new imagery is required.

Expected differences: demo banner adds vertical height; KDS is enabled and adds a sidebar item (sidebar can scroll at this height); sample data differs from empty desktop screenshots; Users retains the separately requested compact colored roles and permissions; Marketplace has newer feature controls. Desktop chart focus outline only appears while focused. Capture rendering softness is not evidence of a different font. This is not a claim of identical pixels or exhaustive functional acceptance.

Operational finding: the offline worker deliberately holds active tabs on the old release, including across reloads. Close all tabs for that POS origin after saving, then reopen to activate the new release; never delete site data for visual refreshes.

# Hosted POS deployment — 2026-10-13

final result: passed (deployment/startup and current asset parity; restaurant setup remains)

The deployed root originally showed the separate owner portal. The user chose full restaurant POS on Azure. Root now serves the existing production POS after selected-owner cloud sign-in; owner tools are at /owner/. All existing POS styles/components are bundled unchanged by the hosting correction.

Authenticated HTTPS downloads of index-RdY3UVmu.js and index-D04BvqD0.css matched the local production artifacts exactly (SHA-256). Prior desktop/browser module comparison above establishes the visual baseline; hosted asset equality establishes that the same updated UI is delivered. This does not assert identical browser/native-title-bar pixels. Live setup screenshot: docs/screenshots/azure-full-pos-setup.png. Browser error/warning logs were empty. Fresh production setup was deliberately not filled with a made-up admin PIN or mock restaurant data.

A real POS container restart preserved outlet identity. Normal HTTPS login redirects and anonymous POS API denial were verified; 99 targeted cloud/auth/users/billing/runtime tests passed. Temporary owner QA session was revoked and its browser cookie removed. No viewport override or synthetic DOM changes were left in place.

Remaining acceptance: user completes restaurant/admin-PIN setup; real billing flow, local printers, and off-VM SQLite/PostgreSQL restore are verified before live use. Hosted writes need Internet access. Mock module data remains in the separate local demo, not the production database.
