# Google Drive backup framework

ForkFlow 0.6.4 includes the settings, queue, worker and provider contract. Google
OAuth, Windows credential encryption, Drive networking, and cloud restore are
deferred. The shipping app supplies no provider and makes no Google requests.
Adding credentials alone will not activate it; implement the adapter below first.

Admins can save automatic-upload, folder-name and retention preferences now.
Settings show **Not configured** and disable Connect/Upload/Retry until integration.
Local daily, manual, second-folder and pre-update backups continue normally.

## Implemented behavior

`CloudBackups` in `apps/server/src/cloud-backups.ts` accepts a `CloudBackupProvider`
injected through `buildServer({ cloudBackupProvider })`. Production currently
supplies no provider. Shared schemas/types are in `packages/domain/src/cloud-backups.ts`.

The worker uploads verified standalone SQLite snapshots, rechecks integrity,
streams a SHA-256 hash, and queues work outside the local backup response. One
upload runs at a time with a two-minute cancellation deadline. Failed uploads
retry after 1, 2, 4, 8, 16, 32, then 60 minutes while the main PC runs.

Queue/completion metadata persists under the restaurant data directory in
`cloud-backup-state.json`; preferences are in `cloud-backup-settings.json`. Neither
contains OAuth credentials or is part of the database snapshot. Pending snapshots
are protected from local retention. Startup reconciles existing snapshots with
completion records when automatic uploads are enabled, recovering missed events.
An explicit cloud backup works even with automatic uploads off. Turning automatic
off prevents new automatic queue entries; previously queued files still retry.

Only a provider-confirmed remote file ID marks upload success. Remote cleanup
failure never re-uploads a confirmed snapshot. Queue entries belong to a stable
account ID; unexpected account changes require disconnect before resuming.
Disconnect cancels work, clears pending entries and preserves local/remote files.
Cloud metadata files that cannot be read are left untouched, keep billing and
local backups available, and keep cloud backup off until the server restarts. A
failed save of upload progress, such as a briefly full disk, is reported in
status and retried automatically; the message clears after the next successful run. Provider error details are not exposed in status or persisted.

## API contract

All endpoints require `settings.manage` (admin). Status GET uses `no-store`.

| Method | Route | Result |
| --- | --- | --- |
| GET | `/api/system/cloud-backups` | Safe status, account, preferences and queue |
| PUT | `/api/system/cloud-backups` | Save `automatic`, `folderName`, `retentionDays` |
| POST | `/api/system/cloud-backups/upload` | Verified manual snapshot queued; 202 |
| POST | `/api/system/cloud-backups/retry` | Pending account uploads made due; 202 |
| POST | `/api/system/cloud-backups/disconnect` | Provider disconnect; clear pending queue |

Without a provider, upload/retry/disconnect return 409 with an explanatory message.
No pretend account or success is created. Sign-in routes will be added with OAuth.

## Future Google integration

1. Create one ForkFlow Google Cloud project, enable Drive API, and configure an
   external consent screen and **Desktop app** OAuth client. Publish and complete
   applicable verification; Testing-mode Drive refresh tokens expire after seven days.
2. Implement sign-in on the main POS PC using the default browser, PKCE, random
   state, short-lived authorization, random-port 127.0.0.1 callback, exact redirect
   validation and a single-use callback. Do not use an embedded browser or accept
   tokens from LAN forms. Use `drive.file` for a visible app-created backup folder.
3. Keep refresh tokens encrypted with Windows credential protection, outside
   database snapshots, queue files, logs, renderer storage and API responses.
   A desktop client secret is not a server secret; do not rely on it to authenticate
   installations. Expired/revoked grants must show `reconnect_required`.
4. Implement `CloudBackupProvider.connection()` with a stable Google account ID
   and email. Supply the adapter from `apps/server/src/main.ts` to `buildServer`.
   Report `not_connected` before OAuth and `connected` only after credentials work.
5. Implement `upload()` using resumable Drive uploads and honoring `AbortSignal`.
   Use account plus supplied `idempotencyKey` in app properties to find/reuse an
   uploaded file after a lost success response. Include SHA-256 and installation
   ownership metadata. Validate completed size and a supported Drive checksum
   (binary files provide MD5, which can be computed locally) before returning
   `remoteId`; validate stored checksum properties on reuse.
6. Implement `prune()` strictly for app-owned files in this installation/account.
   Preserve the newest backup, daily backups for `retentionDays`, ten manual and
   ten pre-update points. Never delete user files or another restaurant's backups.
   Save a folder ID and define rename behavior without creating duplicate folders.
7. Implement `disconnect()` to stop credential use, revoke grants where possible,
   and erase local encrypted tokens. Never delete backups or switch accounts silently.
8. Wire the disabled Connect button to the desktop authorization bridge. Enable it
   only when OAuth is configured and the admin is on the main PC. Upload, retry,
   disconnect, account status and periodic status refresh are already wired.
9. Add cloud listing/download and restore preview. Download to a staging file,
   verify integrity, then use the existing desktop restore flow to stop counters
   and archive old data. Fresh-PC recovery must reauthorize and locate app-owned
   backups without the old queue file; credentials stay outside restored data.

## Verification

`npm test -- apps/server/src/cloud-backups.test.ts apps/server/src/backups.test.ts`
uses a fake provider to cover restart/backoff, missed events, integrity, retention,
cancellation, account changes, malformed metadata and admin API permissions.

For browser QA build the UI, start `node --import tsx tools/e2e/backups-server.mts`,
sign in as admin (1234) at `http://127.0.0.1:4169/`, then run
`tools/e2e/cloud-backups.js` through agent-browser with UTF-8 stdin. This uses a
temporary restaurant database and makes no Google requests.

References: [Desktop OAuth](https://developers.google.com/identity/protocols/oauth2/native-app),
[Drive scopes](https://developers.google.com/workspace/drive/api/guides/api-specific-auth).
