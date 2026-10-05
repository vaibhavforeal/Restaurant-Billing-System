# BillTouch printer review

Implementation follow-up: the first phase is now implemented. See
[Printer setup and recovery](printer-settings.md) for the delivered scope and
operating instructions. The review below records the comparison before changes.

Reviewed 30 September 2026 against the local BillTouch Cloud installation at
`C:/Users/AR/Downloads/BillTouch_Cloud` and the current ForkFlow source.

## Recommendation

Implement BillTouch-style printer discovery and configurable bill/KOT profiles
on top of ForkFlow's existing printing service. The existing network, Windows
spooler and Bluetooth COM transports, kitchen routing, receipt rendering and
queue can be extended. BillTouch is a packaged Python application with a web UI;
its bundled module is not a drop-in component for our TypeScript/Electron app.

## Evidence and limits

Signed into the local demo and inspected **Tools > CustomerOptions**. The Sales
Printer screen exposes installed Windows printer choices, DOS/Windows printer
fields, invoice options, port/USB controls, IP address and port, Bluetooth name,
copy count, feed lines, auto-cut, Ask Print and Payment Qrcode. The Report Printer
screen has its own printer, column count, copies, feed and cutter settings. The
Header Footer screen exposes multiple editable header/footer lines.

Screenshots: [Sales printer](../../output/billtouch-printer-review/sales-printer.png)
and [Report printer](../../output/billtouch-printer-review/report-printer.png).

Additional capabilities below were found in bundled configuration/UI code, not
verified through their advanced settings screens:

- `.../_internal/pandas/api/static/default/salesprintersetting.txt`: three sales
  profiles, including 42/48-column and Windows profiles; individual fields carry
  text, size, length, width, font, alignment, next-line and print flags.
- `.../default/kotprintersetting.txt`: seven KOT profiles with normal/bold and
  Windows variants, including Citizen/Epson/TVS/NGX/Real POS and Posiflex labels.
- `.../static/9006.ac0d0298e8901c82.js`: field editor, printer discovery via
  `getprinter`, settings loaded by system name, separate bill/KOT settings and
  test-print actions, cash drawer, language-print options, group/department/mode
  printing controls. Brand labels do not establish hardware compatibility.

No physical print was sent, no BillTouch settings were saved, and no ForkFlow
application code was changed. This is a capability and implementation review,
not a hardware certification or a claim that every bundled option is enabled
in this demo.

## Comparison

| Capability | BillTouch evidence | ForkFlow today | Suggested work |
|---|---|---|---|
| Installed printer picker | Live dropdown lists installed Windows printers | Manually typed Windows printer name | Add host printer discovery and a refreshable picker |
| Connection methods | Live DOS/Windows and USB/IP/BT fields | TCP network, Windows RAW spooler, Bluetooth COM | Keep transports; validate addresses and explain host-local connections |
| Separate bill/KOT profiles | Bundled templates and advanced UI | Separate fixed renderers; one printer per kitchen station | Add reusable receipt/KOT profiles |
| Copies | Live sales/report controls; KOT setting in bundle | One job per print request | Bounded copy counts per document profile; track each copy |
| Feed and cutter | Live Gapline and Auto Cut | Renderers use fixed feed and cut commands | Configurable feed and cutter capability |
| Character columns and fonts | 42/48-column presets and per-field editor in bundle; report columns live | Fixed 32 columns for 58 mm, 48 for 80 mm; fixed styles | Add calibrated columns and compact/large-text presets |
| Header/footer and field visibility | Multiple lines live; field flags in bundle | Restaurant details and receipt footer configurable; field layout fixed | Add curated visibility and style controls |
| Default printer per counter | Settings keyed by system name in bundle | Receipt choice remembered in each browser | Server-managed defaults per registered counter with local override |
| Kitchen routing | Department/group options in bundle | Product-to-station routing already implemented | Preserve existing routing; add profile/copy settings per station |
| Ask before printing | Live Ask Print | Save & print / Pay & print when a printer is selected, plus manual reprint | Add explicit automatic/ask/manual behavior |
| Cash drawer | Advanced setting in bundle | ESC/POS drawer command exists but is not called by payment flow | Connect to confirmed cash payment with permission and duplicate protection |
| Payment QR | Live option | No payment QR in receipt renderer | Add configured UPI QR; scanning must not mark a bill paid |
| Windows graphics / language output | Windows font rendering and language controls in bundle | Windows path sends RAW ESC/POS; thermal text replaces non-ASCII with `?` | Add a separate rendered output path for Unicode/logo/QR support |
| Report printing | Separate live settings | Reporting and CSV export, without a dedicated thermal report profile | Add day-end thermal report using report permissions |

## Implementation order

1. **Reliable printer setup.** Discover printers on the POS host, distinguish
   receipt-capable RAW devices from graphics/document printers, validate network
   ports and COM names, and fix Windows transport handling. Add durable jobs and
   explicit recovery before expanding automatic printing.
2. **Bill and KOT profiles.** Add printer/profile settings for width, columns,
   copies, feed lines, cutter and text preset. Keep today's appearance as the
   migration default. Add server-managed counter defaults and automatic/ask/manual
   receipt preferences. Provide a sample preview and explicit test-print action.
3. **Layout and output options.** Add selected fields, headers/footers, larger
   kitchen text, duplicate-copy labels, UPI QR and Unicode/graphics output.
   Add drawer handling and thermal reports as independent features.

The profile system should separate the destination from the document format:
one device may print both a customer receipt and a KOT with different layouts.
Snapshot the chosen format and payload on each job so retries reproduce the
original output. Retain saved bill amounts and restaurant details on reprints.

## Existing implementation issues to address

- `apps/server/src/print/queue.ts` stores jobs only in memory. A restart loses
  queued/failed jobs. Persist jobs transactionally with the business action;
  do not automatically resend jobs whose physical outcome is uncertain.
- `apps/server/src/print/sinks.ts` interpolates the printer name into generated
  PowerShell source. Pass names as data, use terminating error behavior and
  check full byte writes. The current comment acknowledges unsupported quote
  and dollar characters; this needs a code fix, not just a UI restriction.
- Network write/spooler acceptance is not proof that paper physically printed.
  Show submitted/failed/unknown accurately and make ambiguous retries deliberate.
- Our Windows transport is RAW ESC/POS. Merely detecting a laser printer or
  Microsoft Print to PDF must not imply that it can print these bytes correctly.
- Bluetooth currently writes to a Windows COM device. It is not direct browser
  Bluetooth discovery or a general Android Bluetooth implementation.

## Code touchpoints and validation

Extend `packages/domain/src/printer-schemas.ts` with validated profile schemas and
a database migration; `apps/server/src/printers.ts` for discovery/settings;
`apps/ui/src/screens/Settings.tsx` for setup; and
`apps/ui/src/screens/BillingPanel.tsx` for default and print behavior.

The output path is in `apps/server/src/print/{sinks,queue,escpos,templates,receipt}.ts`.
Receipt dispatch is in `apps/server/src/billing.ts`; kitchen dispatch is in
`apps/server/src/kots.ts` and cancellation handling in `apps/server/src/orders.ts`.

When implementing, verify 58/80 mm layouts, 42/48-column calibration, long item
names, copies, cutter-off mode, kitchen routing, payment/reprint idempotency,
restart recovery and names containing shell metacharacters. Graphics/Unicode,
drawer pulses and actual USB/network/Bluetooth behavior require physical device
checks. Existing fake-sink tests do not establish real transport compatibility.
