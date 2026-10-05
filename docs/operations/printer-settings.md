# Printer setup and recovery

Open **Settings > Printers** as an administrator.

## Add and configure a printer

- **Network:** enter an IP address or hostname, optionally followed by a port
  (for example `192.168.1.50:9100`). The default port is 9100.
- **USB (Windows driver):** select an installed printer from the POS computer.
  The list loads automatically; **Refresh printers** reloads it. Manual name
  entry remains available. This is the server computer's printer list, even
  when Settings is opened from another counter or phone.
- **Bluetooth:** use the Windows paired COM port, such as `COM3`.

Select 58 mm or 80 mm paper. These paths send ESC/POS thermal printer data;
discovering a laser printer or PDF printer does not make it ESC/POS compatible.
For A4 or PDF, use **View receipt > Print / save PDF**.

Each printer has separate **Bill** and **KOT and cancellation** profiles:

| Setting | Range | Upgrade default |
|---|---|---|
| Copies | 1–5 | 1 |
| Feed lines at end | 0–10 | 3 |
| Auto-cut | On/off | On |

Existing printers retain their connection, paper width, activation state and
station assignments. Default profiles preserve the existing output. Editing a
profile affects future requests; queued jobs and retries retain their original
bytes, destination and copy count.

**Test print** uses the saved bill profile; **Test KOT** uses the saved KOT
profile. Test prints produce the configured number of copies. Save edits before
testing. Deactivated printers cannot be test-printed.

## Print jobs

Each requested copy is a separate job under **Settings > Print jobs**, with its
printer name and copy number. A retry resends only that copy.

- **Queued:** saved in SQLite; not yet handed to the connection.
- **Printing:** submission is in progress.
- **Submitted:** the connection/spooler accepted the bytes. This does not prove
  that paper physically printed.
- **Failed:** an error stopped submission before any data reached the printer
  or spooler, such as a network printer that cannot be reached, a Windows
  printer that cannot be opened, or a Bluetooth COM port that cannot be opened.
  Check the printer, then retry.
- **Check paper:** the physical outcome is uncertain. This covers a failure
  after data started to be sent, a timeout, and any Windows spooler error that
  cannot be shown to have happened before sending. Check **I checked the
  paper**, then either **Retry this copy** or **Mark as already printed**.

Jobs survive server restarts. Never-started jobs resume; interrupted writes are
held for review. A restore performed through ForkFlow's recovery system changes
the recovery generation, which also holds queued jobs from the restored backup
for review. Do not manually replace the live database outside that recovery
flow. Successful history is capped at 100 entries during queue processing.
Failed and uncertain jobs stay until retried or marked, but only the newest 200
are kept; older ones are removed together with their saved print data and can no
longer be retried. Reprint an old bill from the bill itself.

Bill issue, kitchen send and sent-item cancellation save their print jobs in
the same database transaction as the business change. If saving the job fails,
that business change rolls back. If the slip itself cannot be built, for example
because a printer's saved profile is damaged, the bill or kitchen ticket is still
saved, no job is created, and the screen shows that it could not be queued for
printing. Fix the printer in Settings and reprint the bill. Manual receipt printing is a new request; use
the job retry action when recovering a specific uncertain copy.

## Scope and verification

This phase adds discovery, per-printer bill/KOT copy/feed/cutter profiles and
durable recovery. Layout/column/font editing, Unicode thermal rendering, receipt
payment QR, cash-drawer automation, server-managed counter defaults and thermal
reports remain later work. Existing browser receipt preferences remain in use.

Automated checks cover legacy upgrades, copy routing, transaction rollback,
database reopen, backup-generation changes, ambiguous retry confirmation, and
Windows printer-name handling. Windows discovery was checked against the actual
installed printer list. Browser checks used a fake print sink and verified saved
profiles and captured ESC/POS bytes at desktop and phone widths. Physical USB,
network, Bluetooth, feed and cutter behavior still need testing on the intended
thermal printer.

For a disposable browser fixture, build the UI and run
`node --import tsx tools/e2e/printers-server.mts`. Open
`http://127.0.0.1:4153`, sign in with PIN `1234`, and open Settings. Discovery
queries Windows; all print output is captured. The fixture uses an in-memory
database and never sends bytes to physical printers.

The desktop build for this change is staged at `build/desktop/printer-preview`.
The running desktop app was not restarted or switched to that build. To prepare
an isolated stage while another desktop instance is open, set
`FORKFLOW_BUILD_STAGE=printer-preview` before running `npm run build:desktop`.
Stage names are restricted to letters, digits and hyphens under `build/desktop`.

Verification result: 423 tests passed across 58 files; server and UI TypeScript
checks passed. The staged server also started against a separate scratch database
and served the setup screen successfully.
