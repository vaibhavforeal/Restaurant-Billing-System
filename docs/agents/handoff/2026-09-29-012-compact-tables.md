# Compact tables workspace

The user requested the same compact, viewport-filling treatment previously
applied to the order window for Tables & orders.

## Changes

- Shared the compact desktop navigation/window shell between tables and orders
  using `compact-workspace.css`. Order-specific panel styles remain separate.
- Added compact table cards, fixed status/search/area filters, independent table
  and parcel lists, and phone Tables/Parcels switching. Short landscape screens
  use single-row controls and keep both lists visible.
- Table management, QR code management, split selection, and guest request
  details use a reusable native `WorkspaceDialog` portaled to the document body.
  Focus stays in the active dialog; saving blocks Close/Escape.
- QR/service summaries retain live pending counts without tall inline inboxes.
  Service history fetches pending separately so a capped history response cannot
  change the pending badge. Summary errors have an attention indicator.
- Table mutations are protected by a synchronous action lock while a management
  dialog saves. Existing routes, payloads, billing, stock, roles, and licensing
  rules are preserved.

Tiny portrait windows below 550px height retain at least 100px for the item list
and allow the workspace to scroll if necessary, rather than hiding all tables.

## Verification

TypeScript, UI production build, and whitespace checks passed. Browser QA uses a
separate installation on port 4121 with 40 tables across four areas, 12 parcels,
mixed statuses/splits, and guest QR/service requests. The live desktop data on
port 4100 is separate from test fixtures.

The browser pass covers 1366x768, 1024x768, 1280x600, 1920x1080, 390x844, and
640x360 landscape. The old populated page was 2771px tall at 1366x768; the new
page fits the viewport with independent table/parcel scrolling. The landscape
fix retains a 171px table list instead of collapsing it below the viewport.

107 assertions cover filter counts, search/area filtering, mobile parcels,
existing/new split selection, free-table creation, New parcel, Quick takeaway,
management Add, QR preview, QR acceptance and count updates, and service-request
save/Close/Escape guards. The order screen still fits its viewport after sharing
the compact shell. Visual captures are `.e2e-scratch/compact-tables-*.png`.
The evidence summary is `.e2e-scratch/compact-tables-results.json`; it records a
test-browser profile reset during export, after the completed checks. Saved
screenshots and tool results were retained. No application page errors were
reported. The test browser/server were closed; physical printing was not tested.

The existing M8/M9 QR and guest-flow gate scripts were adapted for dialog
navigation and pass syntax checks. Their full historical runs were not repeated.

Assets were copied to `build/desktop/app/ui`. Port 4100 serves the exact current
index, `index-CHgVnB2q.js`, and `index-BjINFpf-.css`, verified by content hashes.
The desktop process and live data were left running; **Ctrl+R** loads the update.

See `docs/operations/tables-workspace.md` for staff-facing behavior.
