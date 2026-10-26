# Android Captain app

The user asked for an Android Captain app. They chose a native shell around the
existing Captain screens (not a full Kotlin rewrite or a TWA) and sideloaded
distribution from the POS (not the Play Store).

## What was built

- `apps/captain-android/`: Kotlin app, AGP 9.4.1 with built-in Kotlin, Gradle 9.8.2
  wrapper, minSdk 24, targetSdk 36, compileSdk 37, no AppCompat. Dependencies:
  androidx.core (FileProvider) and zxing-android-embedded (QR scan).
  - `SetupActivity`: scans `forkflow-captain://pair?server=<origin>&ca=<sha256>` or
    takes a typed address (tries `https://host:4443`, then `http://host:4100`).
    Downloads `/captain/restaurant-ca.cer`, checks the fingerprint (or shows it for
    staff to compare), checks `/api/health` with the pinned CA. Plain HTTP gets an
    "unencrypted" warning. Deep links from the system camera ask before re-pairing.
  - `CaptainActivity`: WebView on `<origin>/captain/`. `onReceivedSslError`
    proceeds only for the paired origin when `RestaurantTrust.accepts` (signed by
    the pinned CA, in date, SAN matches). Keeps the screen on, handles edge-to-edge
    insets including the IME, native reconnect screen, back button through
    `window.forkflowBack`, JS bridge `ForkFlowAndroid` (version/server/changeServer).
  - `AppUpdater`: reads `/captain/android/version.json` on start and every 6 h,
    downloads the APK over the pinned connection, checks the SHA-256, installs via
    FileProvider. Asks for the "install unknown apps" permission when needed.
  - Unit tests: `PairingTest`, `RestaurantTrustTest` (openssl fixtures in
    `src/test/resources`, public certificates only).
- Server: `GET /api/system/connections` returns
  `android.downloads` (LAN HTTP APK links) and `android.pairings` (HTTPS when
  configured, else HTTP), via `captainPairingUri` in `system.ts`.
  `version.json` is served no-cache.
- UI: Settings "Android Captain app" section (shown when
  `/captain/android/version.json` exists). `captainAndroid()` in `captain-pwa.ts`
  skips the manifest and service worker inside the app. `CaptainInstall` and
  `CaptainReconnect` show "Change POS server". `android-back.ts` closes the top
  `<dialog>` via a cancel event, then leaves the order.
- Build: `npm run build:captain-android` (`tools/build-captain-android.mjs`) finds
  a JDK 17+ (JAVA_HOME, else the Android Studio JBR) and the SDK, signs with
  `~/.forkflow/captain-android/signing.properties` (or `FORKFLOW_ANDROID_SIGNING`),
  and runs `testDebugUnitTest assembleRelease`. AGP 9 creates unit-test tasks for
  debug only. `--create-signing-key` makes the key on first use.
  `tools/captain-android-release.mjs` (called by `build-desktop.mjs`) copies the APK
  and writes `version.json` only when its versionName matches `package.json`.
  Version code = major×1,000,000 + minor×1,000 + patch.
- `tools/e2e/captain-server.mts` now passes the HTTPS fixture info into the server,
  so the fixture also serves `/captain/restaurant-ca.cer`.
  `freshAppWithFakeSink` accepts extra server options.

## Follow-up fix: captain picker in the app

The user asked why a signed-in captain sees "Select captain". Now
`POST /api/orders` assigns a dine-in order to the waiter who opens it, unless
another `captainId` is given. Counter-opened orders stay unassigned. In
`OrderScreen`, waiters see the assignment read-only, or **Assign to me** when it
is empty. Admins and cashiers keep the picker. Test added in
`table-captains.test.ts`.

## Verification

- Full vitest suite passed (1255 tests), `npm run typecheck` clean,
  `npm run test:packaging` 7/7, Android unit tests 10/10, release APK signature
  checked with apksigner.
- **Not run on a device.** This PC is a VM without hardware acceleration, so the
  API 37 emulator does not start. Untested on hardware: WSS live updates after
  `onReceivedSslError` proceed, QR scanning, back button, insets, self-update.
  Ask the user for tablet results.

## Artifacts and state

- `dist/captain-android/ForkFlow-Captain-0.7.0.apk` (signed release 0.7.0).
- `dist/dev/ForkFlow-Dev-Setup-0.7.0.exe` (includes the APK and the picker fix).
- Release key: `C:\Users\aiadmin\.forkflow\captain-android\` (outside the repo).
  The user plans to keep it in a password manager now and move to CI secrets later.
- Nothing committed. `apps/server/src/print/__snapshots__/*.snap` show
  line-ending-only changes from a vitest run. Restoring them with `git checkout`
  was blocked by the permission classifier, so the user needs to run it.
- Rebuilding `build/desktop/app` while ForkFlow Dev runs from it fails with EPERM
  and leaves a half-deleted stage. Ask the user to close the app first.
