# Local Restic backups

Restic 0.19.1 is installed on the development PC through WinGet (`restic.restic`). Open a new terminal to pick up its command alias. It encrypts and deduplicates verified SQLite snapshots in a local repository. This is a manual backup path for now; it does not replace cloud transaction synchronization or menu-image storage.

Choose a repository outside the outlet data folder, preferably on another disk. Create a password file outside the repository and source checkout, restrict its Windows permissions to the operator/service account, and keep a separate secure recovery copy. Never commit or share it. Set `RESTIC_REPOSITORY` and `RESTIC_PASSWORD_FILE` to absolute paths, then run `restic init` once. Do not initialize over an existing repository or change its password file casually.

With the outlet service stopped, run from the source checkout:

```powershell
$env:RESTIC_REPOSITORY = 'D:\ForkFlowBackups\restic'
$env:RESTIC_PASSWORD_FILE = 'C:\Private\forkflow-restic-password.txt'
npx tsx tools/outlet/restic.mts 'C:\ProgramData\ForkFlow\Outlet'
restic check --read-data
restic snapshots --tag forkflow-verified-sqlite
```

Use the actual outlet data path. The wrapper takes ForkFlow's data-directory lock, creates a SQLite snapshot with integrity/schema/reference validation, releases the database, then passes only that snapshot to Restic. It never backs up the live SQLite file directly. A running outlet owns the lock, so this manual command fails rather than competing with it. Restart the service after maintenance. If the alias is unavailable, set `FORKFLOW_RESTIC_EXE` to the absolute executable path.

Restore for inspection into an empty separate folder:

```powershell
restic restore SNAPSHOT_ID --target 'D:\ForkFlowRecovery\inspection'
```

Find the restored `.db` and use ForkFlow's verified/journaled restore procedure with the service stopped. A paired outlet must complete cloud reconciliation before billing resumes. Never copy a restored database over a running outlet. Restic does not reconcile invoices, browser retries, payments, or printing.

Retention is manual for now: review `restic forget --tag forkflow-verified-sqlite --keep-daily 30 --keep-monthly 12 --group-by host,tags --dry-run` before applying deletion. The wrapper does not automatically prune or delete repository snapshots. Retention must account for recovery needs and independent backup copies.

Verification on 2026-10-12: disposable migrated SQLite snapshot backed up, full Restic data check passed, restored to an inspection directory, and restored database passed ForkFlow validation at schema 33. No live restaurant database was restored. Scheduling, a second disk, service-account access, customer installer inclusion, and remote repository destinations remain to be configured and tested.
