# Code audit, bug fixes and simplification (paused)

On 2026-11-01 the user asked for a multi-agent audit of the whole codebase for bugs and simplification. Reviewers
on Opus, Sonnet and Haiku covered domain, server, licensing and portal, UI, and shells and tools. A second agent
checked each bug before it was fixed. The fixes, a security review, and most of the simplification list then landed
on branch `fix/audit-bugs` (PR #8, based on `codex/portal-uifix`; retarget it to `main` once that branch merges).

On 2026-11-02 the user stopped the simplification work. **The work still open is listed under "Not done" below.**

## Bugs fixed

All of these have tests, and each test failed before its fix.

- **Licensing:**
  - A licence term belongs to its order and starts at the order's first activation. Counters could previously renew for free by moving between orders. Paying a credit order uses the same end date.
  - The offline-licence route checks the PC's identity before taking a seat.
  - The portal sign-in lockout counts failures in one database statement, so simultaneous attempts can't get past it.
  - The portal has a "Replace computer" action for a counter that died after its order's term ended.
- **Server:**
  - Editing a sent QR-guest item no longer breaks the guest-request endpoints.
  - Slips for turned-off stations, or stations whose printer is turned off, are reported to the screen instead of being dropped.
  - Live updates and order responses leave customer details out for staff without `customers.read`.
  - Two simultaneous requests can no longer give two users the same PIN or remove the last admin.
  - Changing a staff member's role clears their per-person permission changes; the Users screen asks first.
  - `PUT /api/tables/order` saves a table reorder in one request.
- **Loyalty and billing:**
  - A void reverses that bill's own points, never twice.
  - Points given back on a void keep their original expiry.
  - Catalogue prices are capped at the billing limit.
  - CGST always equals SGST: an odd paisa stays in the taxable value.
- **Portal:**
  - A payment whose settlement fails can be completed later.
  - An order stores its place of supply and GST split at confirmation (migration `0010_order_supply.sql`).
  - Chats over 500 messages show the newest messages.
  - Live connections close when their session ends.
- **UI:**
  - Money actions (cash in and out, shift actions, loyalty adjustments) are safe to retry.
  - Older WebViews no longer crash the app, and a top-level error boundary catches render errors.
  - The cash drawer ignores out-of-date responses.
- **Desktop and tools:**
  - Remote input releases the mouse button and keys.
  - The Kitchen app keeps port 80 when it is typed.
  - Licence month-end dates are calculated correctly.
- **Installer security, after three rounds of security review:**
  - Identity files are read through the open file handle, and only from the session user's profile or setup's own.
  - `%ProgramData%\MasalaPOS` is owned by Administrators.
  - The staged secret file is created new, owned by the Administrators group, with a locked ACL.
  - The app adopts it (`readTrustedStagedFile`) only after checking owner, ACL and links on the same open handle it reads from.

## Simplification done

| Commit | Change |
|---|---|
| `715e855` | Folded the 43 POS migrations into `migrations/baseline.ts` at version 43. It was generated from the old chain and checked against it table by table: no differences. `migrate()` refuses a database at versions 1–42. New migrations start at 44. |
| `15e946b` | Removed the old in-app remote-support stack (and `koffi`) from the POS desktop app. The Support Connector owns remote sessions. |
| `5802ddb` | `print/station-slip.ts`: one helper for KOT, cancel, edit and table-change slips. Replaces four copies and the `enqueuePrint` decorator. |
| `1fc536c` | `packages/domain/src/csv.ts`: one CSV reader and writer. Replaces two parsers and five writers. Plain numbers, including negative ones, stay numeric. |
| `d2e6dbf` | `billSpendSql`: one definition of customer spend (bills less refunds). It was previously calculated four different ways. |
| `14924a6` | `guest-rate.ts`: one rate limiter for the public guest pages. The feedback page's copy had lost its size cap. |
| `7d5f21d` | `client-ref.ts` `priorRequest`: one helper for retried requests, used at six sites. |
| `47fcb81`, `d25ab30` | Licensing worker: one `newToken`, one `overLimit`, and one `serveSpa` for the portal and support pages, which now share the same security headers. India-time and financial-year helpers live in `dates.ts`. |
| `ea7a595` | Removed upgrade code for data that never shipped: the v1 queue migration, the old cart-draft key, and the receipt fields `taxInclusive`/`gstScheme` with the `receiptGstMode` shim. |
| `c094caa` | Removed `export` from 63 file-local symbols and deleted 4 unused ones. |
| `465c381` | `use-action.ts` `useAction`: one hook that runs a screen's actions one at a time, so a double click sends one request. Used by Settings (nine handlers), Users and the customer screens' `useRun`. Checked in the running app. |

## Not done

The user paused here on 2026-11-02. These are listed in the order they would be done.

### 1. Split the largest screens (medium risk)

Current sizes: `OrderScreen.tsx` 733 lines (39 hooks and refs), `Settings.tsx` 573, `BillingPanel.tsx` 395, `Tables.tsx` 334.

- **`OrderScreen`** mixes five concerns. Extract:
  - `useOrderLane(userId, orderId)`: queue-lane state (`laneState`, `queued`, `keepLocally`)
  - `useCartDraft(draftKey)`: `readDraft`, `saveDraft`, `punchDraft`
  - the kitchen send (`sendPending`)
  - `useTransferActions()`: table move and merge (`transfer`, `heldCart`)
  - presentational `CartPanel`, `MenuBrowser` and `OrderHeader` for the roughly 250 lines of JSX

  Target is about 350 lines.
- **`BillingPanel`:** separate issue, issue-and-pay and settle from the dialog JSX, with `PaymentRows` and `QuickPayment` components.
- **`Tables`** has five lock refs (qr, qrManager, service, reservation, action), each with a busy flag, and they are always OR-ed together. A `useBusyRegistry()` would replace about 25 lines and the eight repeated `if (qrLock.current || ...) return` guards. The navigation guard and the reload loop read these refs synchronously, so a registry must expose a synchronous "anything running?" check.
- **`Settings`:** split into one component per section (profile, printers, stations, print jobs). Its handlers already use `useAction`.
- **Risk:** these screens depend on subtle ordering and locking (`actionLock`, `billingLock`, `reloadRevision`, the offline queue lanes). There are no React component tests (no testing-library or jsdom in `apps/ui`). Extract mechanically, keep the refs inside the new hooks, and run order → KOT → bill → settle, table move/merge, and offline punch flows in the app before and after, as was done for `useAction`. Starting the server with `MASALAPOS_DATA_DIR=<temp dir> MASALAPOS_PORT=4199 npx tsx apps/server/src/main.ts`, after `npm run build -w @masalapos/ui`, gives a throwaway database.

### 2. `useLiveReload(events, reload)` hook (low risk; may fix a bug)

`connectWs({ onEvent, onStatus: reload on connect, onAuthFail: () => session.clear() })` with a manual dispose is repeated at about 22 call sites, and 17 of them repeat `onAuthFail`. **`ZomatoPanel` and `useAggregatorOrders` leave out `onAuthFail`.** Check whether those two keep running after a session ends. If they do, that is a bug to fix on its own, before or with the hook. The hook would remove about 100 lines.

### 3. `useBeforeUnloadGuard(active)` hook (low risk)

The `beforeunload` "unsaved changes" effect is copied 8 times.

### 4. More `useAction` adopters (optional)

Other screens with the same lock, busy and error pattern weren't converted because they carry extra state:

- Catalog and ProductEditor track which part is busy.
- RecipeEditor, Inventory and StockCostControls keep conflicts or retry references inside the save.
- Tables reads its lock elsewhere.

`useAction` could take an optional key for "which part is busy" if that pays off once the screens are split.

## Other open items

- **Manual tests on real devices** (on the PR checklist):
  - the error boundary and cash drawer on an older Android WebView or tablet
  - the installer on Windows, with a standard user elevating to a different admin: staged-file ACL, identity lookup, and the app adopting the file on first start
  - a remote-support drag across the protected banner, which should release the mouse button
- **Retired migration tests:** the server's upgrade-path tests for old migrations were removed with the baseline. Backups older than version 43 are refused.
