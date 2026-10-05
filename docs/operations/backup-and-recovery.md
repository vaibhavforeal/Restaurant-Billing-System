# Backups, recovery and Windows installation

For the prepared Google Drive backup framework and future integration steps, see
[Google Drive backups](google-drive-backups.md). Account linking is deferred;
verified local and second-folder backups work independently.

ForkFlow 0.6 runs one server process. The server owns the SQLite database; other
counters connect through the browser. Close the window to keep the server in the
tray. **Quit ForkFlow** in the tray menu stops service for every counter.

## Build and install

On a Windows x64 development PC with Node 24:

```powershell
npm ci --ignore-scripts
node node_modules/electron/install.js
npm run typecheck
npm test
$env:FORKFLOW_LICENSE_PUBLIC_KEY = Get-Content 'C:\secure\license-public.pem' -Raw
npm run package:win
```

The SQLite 13 package includes its Node-API native binary. The build copies the
installed, locked production dependency tree into `build/desktop/commercial`; it does
not download a separate Node runtime or compile SQLite. Electron supplies the
runtime. The builder's first run downloads Electron/NSIS packaging tools.
Close apps or test servers using `build/desktop/commercial` before rebuilding it.

Output: `dist/commercial/ForkFlow-Setup-0.6.4.exe`. The package includes the server,
UI, runtime and SQLite. Customer PCs do not need Node, npm or a compiler.
`package:win` creates the licensed customer edition. For a sample-data demo use
`npm run package:demo`; its separate installer is written to `dist/demo`.

Run the installer as administrator. It installs a private-network, local-subnet
firewall rule for TCP 4100 and creates the main PC shortcut. First launch enables
Windows login autostart; toggle **Start with Windows** from the tray menu.
Do not run development and installed servers on the same port at the same time.
Changing `FORKFLOW_PORT` also requires changing the firewall rule.

The current build is unsigned. Use a Windows signing certificate for a public
release. An installer build and packaged-runtime smoke test do not verify UAC,
firewall access from a second PC, or login startup on a clean customer machine.

Installed data defaults to `%APPDATA%\forkflow-desktop\data`. **Open data and
backups** in the tray is the authoritative location. Development defaults to
`./data`, or the absolute folder in `FORKFLOW_DATA_DIR`. The installer never
overwrites restaurant data, and uninstall retains it. Existing development data
is not automatically imported; take a manual backup and restore it in the app.

## Backup policy

In **Settings → Backups & recovery**:

- A daily snapshot is taken at startup, then checked hourly using the server's
  local calendar date. If the PC was off, it is taken on the next startup.
- **Back up now** creates a manual restore point. It can be downloaded by an
  administrator. Backups contain restaurant and staff data; store them securely.
- Daily retention defaults to 30 days, configurable from 7–365. Ten manual and
  ten pre-update snapshots are retained separately. The newest daily copy is
  always retained. Unrelated files in the backup folder are never pruned.
- An optional absolute second folder can point to USB or another local/synced
  folder. A missing drive does not invalidate a successful local backup. Its
  error is shown in Settings, and the current daily copy is retried hourly.

Each snapshot uses SQLite `VACUUM INTO`, integrity/reference checks, a disk flush
and a rename from `.partial`. It includes committed WAL data. Never copy only the
live `forkflow.db` while the app is running. Large snapshots can briefly pause
requests; queued order actions remain saved on their originating device.

A pre-update snapshot is mandatory before a pending migration or app-version
change. Startup stops if that local snapshot fails. New databases are migrated
directly. Databases from a newer app version are refused rather than downgraded.
Increment the app version for each distributed release.

## Restore on the main PC

1. Stop work on all counters and decide which snapshot to restore. Everything
   recorded after that point will leave the live database.
2. Open the main PC tray menu → **Restore backup…**, select the `.db` snapshot,
   and read the confirmation. This also works from the startup error dialog.
3. The desktop stops its server. A data-directory lock prevents another server
   from opening or restoring the same database, even on another port.
4. The server verifies and stages the snapshot before moving the current DB,
   WAL and sidecar files into `data/recovery/<id>/`. It installs the snapshot,
   clears old login sessions and starts normally, applying protected migrations
   if required. A journal resumes an interrupted restore on next startup.
5. Sign in again on every device and review open orders, last bill numbers,
   payments and inventory before resuming service. Browser drafts and queued
   actions from the previous database generation are archived in browser storage
   and cannot replay into the restored database. Do not clear browser data until
   any lost orders have been reconciled.

Recovery archives are **not** automatically pruned. Keep them until the restored
restaurant data has been verified. The original database in that archive may
require its accompanying WAL to inspect. Do not copy an archive's DB alone over
the live database. Use a verified snapshot for normal recovery.

For development-only recovery, with all servers stopped, set `FORKFLOW_DATA_DIR`
and `FORKFLOW_RESTORE` to absolute paths for one launch of
`node --import tsx apps/server/src/main.ts`. Remove `FORKFLOW_RESTORE` immediately
after that launch; never put it in a persistent environment or startup task.
Windows locks release automatically on process termination. The non-Windows
development fallback uses a 10-minute stale-lock interval after a forced kill.

## Reconnection and operational checks

Punch, kitchen send, bill issue and settlement requests are saved in browser
localStorage before sending. Retry bodies keep the same references and reviewed
bill preview. A changed order gets a review error instead of a new automatic bill.
Only the staff member who saved a request can resume it on that browser. Definitive
request errors stay visible until dismissed and reviewed. Keep the original
device/browser data until its saved actions finish.

New cart rows remain editable during a queued punch; submitted rows stay frozen
until acknowledged. A queued bill locks further additions to that order. Other
administrative mutations require a live connection. Closing the entire browser
pauses its queue until it is opened and the staff member signs in again.

For LAN devices, scan **Settings → Connect another device**, or download the
PowerShell shortcut creator and run it on the counter PC. It creates a desktop
`.lnk` launching Edge in app mode. Reserve the server's IP address in the router.
Use a private Windows network profile. All devices still require a staff PIN.

The watchdog checks the identity of its own server process, retries crashes with
backoff and shows a recovery dialog after repeated failure. Diagnostics rotate
between `server.log` and `server.log.previous`. No production database is created
by the test gates.

Before customer rollout: test installer upgrade/uninstall retention, Windows
login startup, access from a second device, and physical printer output. Print
jobs currently live in memory and do not survive a server restart; KOTs and bills
remain in SQLite. Check the kitchen board and reprint receipts after an outage.
Physical printer delivery cannot be guaranteed by database idempotency. A UPS
and a second backup drive are useful operational protection for the main PC.
