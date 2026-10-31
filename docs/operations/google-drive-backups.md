# Google Drive backups

Admins connect a Google account in **Settings → Backups & connections** on the main POS
PC. Every verified local backup (daily, manual, pre-update) is then uploaded to a
**MasalaPOS Backups** folder in that account, and any of them can be restored from the same
screen, including backups uploaded by an older PC. Local backups and backup files keep
working whether or not Drive is connected.

## One-time setup (MasalaPOS team, before building)

1. In Google Cloud console create one MasalaPOS project and enable the **Google Drive API**.
2. Configure the OAuth consent screen (External, app name/logo/support email, privacy
   policy URL). Add the scopes `openid`, `email` and `https://www.googleapis.com/auth/drive.file`.
   `drive.file` is a non-sensitive scope, so no security assessment is needed, but the
   app must be **published** (In production). In Testing mode only listed test users can
   sign in and refresh tokens expire after seven days.
3. Create an OAuth client of type **Desktop app**. Google treats a desktop client secret
   as public; sign-in is protected by PKCE and a single-use loopback redirect.
4. Build with the client in the environment:
   ```powershell
   $env:MASALAPOS_GOOGLE_CLIENT_ID = "...apps.googleusercontent.com"
   $env:MASALAPOS_GOOGLE_CLIENT_SECRET = "GOCSPX-..."
   npm run package:win
   ```
   `tools/build-desktop.mjs` embeds both. A build without them shows Drive as
   **Not available**; nothing else changes. For a development server, set the same two
   variables before `npm run dev:server`.

## How it works

- **Sign-in** (`apps/server/src/google-drive.ts`): *Connect Google Drive* is enabled only
  in the desktop window on the main PC (loopback request). The server opens a one-time
  listener on `127.0.0.1:<random port>`, the window opens Google in the system browser,
  and Google redirects back with a code checked against a random `state` and PKCE
  verifier. The listener closes after one valid redirect or 10 minutes. Sign-in fails
  with a clear message if the Drive permission box is unticked or a different Google
  account is used than the one already linked (disconnect first to switch).
- **Credentials**: the refresh token is sealed with AES-256-GCM in
  `<data>/google-drive.json`. The key is created by the desktop shell, protected with
  Windows DPAPI (Electron `safeStorage`) in `%APPDATA%\masalapos-desktop\cloud-secret.bin`
  and handed to the server in its environment, which removes it at start-up. Tokens
  never enter the database, backups, logs or API responses. A data folder moved to
  another PC or Windows user shows **Reconnect required**, and so does a revoked grant.
  Development servers without the desktop shell use an unprotected `dev-secret.key`;
  customer builds never do.
- **Upload**: the existing queue in `cloud-backups.ts` (retry after 1 to 60 min, one at a
  time, pending files protected from local retention) calls a resumable upload in 8 MB
  chunks. Drive's size and MD5 must match the local file before the upload counts. A file
  left over from a lost response is reused, not duplicated. Each file records its
  SHA-256, installation ID and restaurant name in `appProperties`.
- **Retention**: after each upload, this installation's Drive backups follow the same
  rules as local ones (`expiredBackups` in `backups.ts`): the newest backup is always
  kept, then dailies for the configured days, plus 10 manual and 10 pre-update. Expired
  files go to the Drive trash. Other PCs' backups and any non-MasalaPOS file are never touched.
- **Folder**: one app-created folder per account, found again by its `appProperties`
  after a reinstall. Changing the folder name in Settings renames it, and a rename done
  in Drive itself is kept.
- **Restore**: *Backups in Google Drive* lists every MasalaPOS backup in the account. A
  restore downloads into `<data>/restore-incoming/`, checks MD5 and SHA-256, and then
  follows the same preview and confirm flow as a backup file (see
  [backup-and-recovery.md](backup-and-recovery.md)).
- **Disconnect** forgets and revokes the credential and clears pending uploads. Files
  already in Drive and on the PC are kept.

## API

All routes need `settings.manage`. The routes marked "main PC" also require a loopback request.

| Method | Route | Result |
| --- | --- | --- |
| GET | `/api/system/cloud-backups` | Status, account, preferences, queue, `connecting`, `onMainPc` |
| PUT | `/api/system/cloud-backups` | Save `automatic`, `folderName`, `retentionDays` |
| POST | `/api/system/cloud-backups/connect` | main PC: `{ authUrl }` to open in the system browser |
| POST | `/api/system/cloud-backups/upload` | Verified manual snapshot queued; 202 |
| POST | `/api/system/cloud-backups/retry` | Pending uploads made due; 202 |
| POST | `/api/system/cloud-backups/disconnect` | Revoke and forget the credential; clear pending queue |
| GET | `/api/system/cloud-backups/files` | MasalaPOS backups in the account |
| POST | `/api/system/cloud-backups/restore` | main PC: `{ id }` → download, verify, restore preview |

## Verification

`npx vitest run apps/server/src/google-drive.test.ts apps/server/src/cloud-backups.test.ts apps/server/src/restore-staging.test.ts`
runs the provider against an in-memory Google. It covers the real loopback redirect,
forged state, a cancelled sign-in, a missing Drive permission, a switched account,
a revoked grant, a token sealed on another PC, chunked upload, duplicate reuse, checksum
mismatch, retention scope, listing and verified download.
An end-to-end check against real Google needs the OAuth client above and an
installed build on a Windows PC.
