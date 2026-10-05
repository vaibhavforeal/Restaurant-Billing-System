# Printer discovery, profiles and durable queue

Implemented the first phase of the BillTouch comparison, documented in
`docs/operations/printer-settings.md`.

- Migration 014 adds per-printer receipt/KOT profile JSON, persisted jobs and a
  recovery-generation marker. Defaults preserve one copy, three feed lines and
  auto-cut. Width and existing station assignments are unchanged.
- Admin-only Windows discovery uses a bounded, hidden PowerShell process.
  Printer names are passed as data during printing; full spool writes are checked.
- Queue payloads and destinations are frozen per copy. Business writes and jobs
  commit together for bill issue, KOT send and sent-item cancellation. Writes
  begin after the synchronous transaction commits.
- Queued copies resume after a normal restart. Interrupted sends and queued work
  from a restored database require a paper check. Staff can retry one copy or
  confirm it was already printed. Transport acceptance is labelled Submitted.
- Settings has discovery/manual entry, independent copy/feed/cutter controls,
  profile test actions and recovery controls, with a contained scrolling printer
  table at phone widths.

Verification: all 423 tests across 58 files passed; server/UI typechecks passed.
New tests cover migration preservation, job rollback with business writes,
database reopen, restore generation, frozen copy retries, discovery permissions,
and safe Windows names. Browser checks verified actual Windows discovery, saving
a selected printer, two bill copies versus three KOT copies with different feed/
cut bytes, a single-copy interrupted retry, and desktop/390px layouts. Output was
captured by a fake sink; physical printer validation remains outstanding.

Desktop artifacts are in `build/desktop/printer-preview` (119 dependency packages).
The staged server started and served its UI using a scratch database on port 4154.
Both scratch servers and browser sessions were stopped after verification.
Screenshots are under `output/printer-profiles`.

The normal build stage was locked by an existing Electron instance. After the
standard rebuild encountered that lock, missing generated files were restored
from the successful isolated build without replacing surviving files. The live
app was not stopped or switched to the new build. `FORKFLOW_BUILD_STAGE` now
supports a validated alternate stage name under `build/desktop`.

The workspace already contained extensive uncommitted work before this change;
no commit or reset was performed. Layout editing, QR/Unicode thermal output,
drawer automation, managed counter defaults and thermal reports are later phases.
