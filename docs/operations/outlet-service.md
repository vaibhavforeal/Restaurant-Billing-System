# Windows outlet service

The outlet service packages the existing Fastify/SQLite server and browser UI with Node 24 and WinSW 2.12.0 x64. Electron remains the supported fallback until the clean-machine, printer, and disconnected-operation gates below pass. This runbook describes the new service artifact, separate from the Electron instructions in [backup and recovery](backup-and-recovery.md).

## Build a signed release

Run on Windows x64 after `npm ci` and `npm run build -w @forkflow/ui`. No customer machine needs Node/npm. The builder copies the installed production dependencies, bundles workspace source with esbuild, and executes the staged Node runtime against the staged native `better-sqlite3` package. No artifact download occurs in the builder.

Obtain Node 24 Windows x64 and WinSW **2.12.0 x64** through the release team's approved acquisition process. Pin their SHA-256 digests in a reviewed build configuration; checksums calculated from an unchecked download alone are not a trust decision. Node publishes signed `SHASUMS256.txt`; verify that release metadata through the trusted Node release key process. WinSW's 2.12.0 GitHub assets currently provide no publisher SHA-256 through their asset API, so the release team must establish and retain its approved artifact digest separately. Supply paths to an Ed25519 release signing private key and the commercial license verification **public** key. These are separate roles; private keys never enter the bundle.

Example `C:\release-secure\outlet-build.json`:

```json
{
  "runtime": "C:/release-artifacts/node-v24.19.0-win-x64/node.exe",
  "runtimeSha256": "<reviewed 64-character SHA-256>",
  "winsw": "C:/release-artifacts/WinSW-2.12.0-x64.exe",
  "winswSha256": "<reviewed 64-character SHA-256>",
  "winswVersion": "2.12.0",
  "output": "build/outlet/release-0-8-0",
  "version": "0.8.0",
  "minSchema": 1,
  "signingKeyFile": "C:/release-secure/outlet-release-private.pem",
  "licensePublicKeyFile": "C:/release-secure/license-public.pem",
  "licenseServiceUrl": "https://licenses.example.com"
}
```

Set `minSchema` to the oldest schema the release has actually been tested to migrate. The schema upper bound is obtained from the bundled migrations, currently 33. The example key paths, URL, and digests are placeholders.

```powershell
node tools/outlet/build.mjs --config C:\release-secure\outlet-build.json
node tools/outlet/release.mjs verify build/outlet/release-0-8-0 C:\release-secure\outlet-release-public.pem
```

Outputs include `node.exe`, the WinSW wrapper, server/UI, maintenance/recovery tools, installation scripts, `release.json`, and `release.sig`. Ed25519 authenticates the exact manifest bytes and every payload hash. The verifier rejects extra files, links, Windows alternate data streams/reserved names, traversal, case collisions, incompatible schemas, and update version downgrades. Staging verifies the copied bytes again before renaming the completed directory. The output directory must be new; release artifacts are never overwritten. Include third-party licenses from copied dependencies and the Node/WinSW distribution in customer release deliverables.

The PowerShell bootstrap scripts and trusted verification key must be distributed as a trusted installer kit independently of the incoming update directory. Ed25519 manifest signing does not sign the PowerShell installer or Windows executable for SmartScreen/UAC. Authenticode-sign the installer kit for distribution and pin its verification key through the release team's trusted delivery channel. Do not run an incoming package's installer merely because that package includes its own public key.

## Install on a clean Windows staging PC

First reserve the POS PC's LAN IPv4 address in the router and use the Windows **Private** network profile. Stop the old Electron app and all development servers; only one process may own the data directory or TCP 4100. Run the trusted installer kit from an elevated Windows PowerShell 5.1 session. A reviewed local process execution policy must allow the installer scripts; the scripts never change machine execution policy.

```powershell
.\install.ps1 `
  -ReleaseDirectory C:\release-artifacts\forkflow-outlet-0.8.0 `
  -TrustedPublicKeyFile C:\trusted-kit\outlet-release-public.pem `
  -TrustedNodeFile C:\trusted-kit\node.exe `
  -TrustedNodeSha256 '<externally pinned SHA-256>' `
  -ServerAddress 192.168.1.20 `
  -OpenPrivateSubnetFirewall
```

`-OpenPrivateSubnetFirewall` explicitly creates only the TCP 4443 rule, scoped to **Private**, **LocalSubnet**, and the active Node executable. HTTP always binds to **127.0.0.1:4100** and has no incoming rule. HTTPS uses **4443** and the same API/database/WebSocket handlers. Tablet/PC browsers must trust the restaurant's public `restaurant-ca.cer`; installation creates certificates but does not install trusted roots. Take the public certificate from the TLS path printed by setup, verify the CA fingerprint, and distribute only that public `.cer` to browser devices. Keep the CA private PFX and password protected on the POS PC. Renewal uses the established `setup-captain-https.ps1 -Renew` workflow with the original Windows CA-owning account, followed by reapplying outlet permissions before restart.

Binaries and admin control files live under `%ProgramFiles%\ForkFlow\Outlet`. Releases are immutable version directories; the WinSW executable and active XML stay at the root. Data/backups/licenses/TLS files live under `%ProgramData%\ForkFlow\Outlet\data`; logs live in its sibling `logs`. The service runs as virtual account **NT SERVICE\ForkFlowOutlet**, with no stored password. Only SYSTEM/Administrators can change binaries; ordinary local users can read the binaries and run shortcuts. Restaurant state is readable by the service/SYSTEM/Administrators; the service can modify only data and logs. Certificate subdirectory ACLs are normalized so the virtual account can read TLS private files, while regular users cannot.

The service starts automatically at boot, survives browser closure/logout, restarts after process failure with 10/30/60-second delays, and retains eight rotated 10 MB log files. Start Menu shortcuts open the local HTTPS POS, Kitchen, and Captain pages. Remote devices use `https://<reserved-address>:4443/`, `/kitchen/`, or `/captain/` after certificate trust. The updater verifies health over both loopback HTTP and CA-validated HTTPS, including the expected release version and matching outlet identity/generation.

For an existing installation add `-ExistingDataDirectory C:\Users\<operator>\AppData\Roaming\forkflow-desktop\data`. Full-store migration holds the existing directory's writer lock and copies the database, WAL/sidecars, installation identity, backups, TLS configuration, and cloud binding. The destination must be empty; the source remains intact. Keep the old process stopped throughout migration and retire its autostart before the new service opens. If old TLS does not cover the chosen IP on 4443, renew it before starting the service. Installation refuses an existing service/ProgramFiles/ProgramData destination instead of merging or deleting it. An interrupted install leaves files for administrator diagnosis; do not repeat with a different data source or delete restaurant state.

## Maintenance and recovery

Online backup downloads use the existing authenticated administrator UI. Offline operations require an elevated local Administrator session and the data-directory lock; neither browser clients nor ordinary Windows accounts receive direct database access.

```powershell
& 'C:\Program Files\ForkFlow\Outlet\releases\0.8.0\maintenance.ps1' -Command status
& 'C:\Program Files\ForkFlow\Outlet\releases\0.8.0\maintenance.ps1' -Command backup
& 'C:\Program Files\ForkFlow\Outlet\releases\0.8.0\maintenance.ps1' -Command restore -BackupFile C:\verified-backups\forkflow-manual-....db
```

The wrapper stops the service, runs the existing verified backup/journaled restore logic, and restarts/checks health. Restoring archives the current DB/WAL/sidecars, clears sessions, and changes the browser recovery generation so drafts from the abandoned timeline cannot replay. Interrupted restores finish before normal maintenance/startup. A paired outlet's cloud binding blocks billing after restore until cloud reconciliation completes. Preserve the recovery archive, outbox, and cloud credentials; do not delete the binding to bypass this guard.

### Reconcile a cloud-paired outlet after restore or host replacement

Use an elevated local Administrator PowerShell session on the stopped outlet host. Keep the old host and service stopped throughout; cloud journal replay must have a single writer. Select the newest verified native SQLite snapshot, or an encrypted `ffbk1` backup with its matching manifest and 256-bit key file. The maintenance CLI acquires the same data-directory lock as the service. It reads the existing `cloud-binding.json` and fetches the paired installation's journal with that credential. Do not create a new pairing or change the epoch.

```powershell
Stop-Service ForkFlowOutlet
$release = 'C:\Program Files\ForkFlow\Outlet\releases\0.8.0'
$data = 'C:\ProgramData\ForkFlow\Outlet\data'
& "$release\node.exe" "$release\maintenance.mjs" reconcile-cloud $data --snapshot C:\verified-backups\forkflow-manual-....db
# Or use an encrypted cloud backup. --key names a protected file containing
# 32 raw bytes, 64 hex characters, base64, or the protected cloud-backup-key.json.
& "$release\node.exe" "$release\maintenance.mjs" reconcile-cloud $data --encrypted C:\verified-backups\snapshot.ffbk --manifest C:\verified-backups\snapshot.json --key C:\protected\backup-key.txt
Start-Service ForkFlowOutlet
```

The command stages a SQLite copy, validates every cloud event's outlet, installation, epoch, order, and any overlap with the retained local outbox, then replays recorded row states without invoking billing, stock, printing, or network handlers. It preserves a complete unsynced local suffix when its outbox is still available. The staged database must pass full SQLite integrity and foreign-key checks before the journaled live replacement. Recovery archives the previous database, clears sessions, changes browser generation, and updates the cloud binding only after the installed database is verified. An interrupted command resumes from `cloud-reconcile-pending.json`; run the same `reconcile-cloud` command again with the service stopped. Do not remove that marker, the staged file, or `restore-pending.json` during diagnosis.

When the host was lost or its local database is older than the cloud journal, the cloud cannot know whether there were completed local sales after the last upload. Review local/second-location backups and any surviving host outbox first. If that interval cannot be recovered, rerun with `--acknowledge-unsynced-loss` to explicitly accept the possible loss. This acknowledgment does not erase cloud history. Missing or conflicting journal sequences, identity mismatches, invalid rows, and broken references stop the operation before live replacement. Leave the service stopped on failure and preserve all backups and recovery archives for investigation. The previous print queue's queued or printing jobs become `unknown`; inspect paper and manually reprint only when needed. Staff records created solely from cloud attribution are disabled with unusable PIN hashes until an administrator resets access, and recovered guest request receipt links are invalidated because their private receipt hashes never leave the outlet.

Daily snapshots, retention, second-location backup errors, and administrator downloads retain the behavior documented in [backup and recovery](backup-and-recovery.md). Test a restore from the actual second backup location before rollout.

## Update and interrupted-update recovery

Use the **installed version's** `update.ps1` from an elevated local Administrator session:

```powershell
& 'C:\Program Files\ForkFlow\Outlet\releases\0.7.0\update.ps1' -ReleaseDirectory C:\verified-updates\forkflow-outlet-0.8.0
& 'C:\Program Files\ForkFlow\Outlet\releases\0.7.0\update.ps1' -Resume
```

The installed runtime/key verify and stage every incoming byte before stopping the service. Stable versions must increase; the proposed schema range must cover the live schema. The service's automatic startup is temporarily disabled before stopping, preventing reboot from opening old normal-mode code during preparation. A mandatory pre-update backup precedes the durable `update-pending.json` journal. The new server starts in maintenance probe mode: all routes except `GET /api/health` return 503, printing/cloud synchronization and license renewal jobs stay stopped. After both transports pass health/version checks, the service stops and the journal commits before normal traffic is enabled. The service then returns to automatic startup and starts normally.

Failure before commit restores the pre-update database using the **new** runtime, which understands its newer schema, then restarts the old release. An interrupted probe resumes conservatively through rollback. The restore phase is journaled so completed rollback is not repeated. After the committed boundary, failures preserve the migrated database and journal; automatic restore is forbidden because clients may already have accepted new orders. `-Resume` retries activation/health without discarding their work. A cloud-paired rollback may remain blocked pending assisted generation reconciliation; preserve the journal and recovery archive for support. Do not edit `installed.json` or service XML to force an older binary against a newer database.

The WinSW wrapper itself stays pinned at 2.12.0 in this updater. A wrapper major/version change or update-key rotation requires a separately reviewed installer migration. The active private-subnet firewall application path follows configuration changes, including rollback and resume. Failed stages are preserved for administrator diagnosis; updates never delete prior releases or restaurant backups.

`uninstall.ps1` stops/removes the service and its shortcuts/firewall rule while preserving ProgramData restaurant state and ProgramFiles release/control files. Reinstallation of preserved state requires administrator review and an explicit recovery plan.

## Verification and release gates

Local verification runs `node --test tools/outlet/*.test.mjs`, Vitest maintenance/runtime/HTTPS tests, PowerShell parse checks, and `node tools/outlet/smoke.mjs` after building the UI. The smoke builds an actual esbuild release bundle, executes staged Node/native SQLite, and runs packaged status/backup/restore/full-store migration on generated test data. It uses an explicitly marked **nonexecutable WinSW fixture** and temporary signing keys; it proves dependency closure/native SQLite and signature mechanics, not a distributable Windows service. No service installation, firewall change, certificate trust change, or reboot was executed on the development machine.

Before distributing, record a real pinned and signed installer artifact and verify on clean supported Windows x64:

- Install/upgrade/uninstall under UAC; virtual account identity, boot before login, browser close/logout, process kill/restart, rotated logs, and restricted ACLs for ordinary users.
- HTTPS trust and WebSocket behavior from POS/kitchen/captain devices; remote HTTP 4100 blocked; HTTPS 4443 reachable only on Private/LocalSubnet; Public profile denied; stable reserved address and certificate renewal.
- Upgrade health failure before commit, interruption/reboot in each journal phase, restore integrity, restored browser generation, paired-cloud reconciliation, and postcommit failure without accepted-write loss.
- Real Windows/network/Bluetooth printers under the virtual service account, including device permissions, per-machine spooler queues, COM port access, USB removal, uncertain print outcomes, and no automatic duplicate paper.
- Existing Electron-store migration with WAL/installation identity preserved; manual and second-location backup restore; no second writer.
- A real 24-hour WAN outage with local authenticated billing/stock/printing, browser reload/reconnect, queued work, and eventual cloud convergence.

These external gates remain pending until a configured staging PC and restaurant hardware provide recorded evidence.
