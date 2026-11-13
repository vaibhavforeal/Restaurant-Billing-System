# MasalaPOS Cafe (Android)

MasalaPOS Cafe is a standalone Android POS for cafes, tea and juice counters, bakeries and takeaway kitchens. The
phone (or tablet) is the whole till: no Windows PC, no tables, no internet needed. It is a separate product from the
Windows POS; nothing moves between them.

Code: `apps/cafe-android` (Expo app and the Kotlin printer module), `packages/cafe-data` (the phone's SQLite data
layer and the bill flow), `packages/print` (receipt and slip bytes, shared with the Windows POS server).
Design: `docs/superpowers/specs/2026-11-13-cafe-mobile-design.md`.

## Build and install a debug APK

Needs JDK 17+ (Android Studio's bundled JBR is found automatically when `JAVA_HOME` is older) and the Android SDK
(`ANDROID_HOME`, on this machine `E:\Android\Sdk`). The NDK is installed by Gradle on the first build.

```
npm run build:cafe-android                 # expo prebuild + gradlew assembleDebug (arm64-v8a, armeabi-v7a)
node tools/build-cafe-android.mjs --install  # also adb install -r on the phone attached over USB
```

The APK is `apps/cafe-android/android/app/build/outputs/apk/debug/app-debug.apk`. The `android/` folder is generated
from `app.json` and config plugins and is never committed; delete it to start clean. A debug build loads its
JavaScript from Metro:

```
adb reverse tcp:8081 tcp:8081
npm run dev:cafe
```

When the phone cannot reach this computer over USB or adb (this build machine is a VM, and a phone sharing a hotspot
cannot turn on Wireless debugging), build a standalone test APK instead. It has the JavaScript inside, needs no
computer while it runs, and works in flight mode. It is signed with the debug key: for testing only.

```
node tools/build-cafe-android.mjs --standalone
"C:\Program Files\Tailscale\tailscale.exe" file cp apps/cafe-android/android/app/build/outputs/apk/release/app-release.apk <phone-name>:
```

The second line sends it over Tailscale (Taildrop; the phone must be signed in to the same tailnet). Accept the file
in the Tailscale app on the phone, open it and allow installing from Tailscale. Installing over a different build
type (debug over standalone or the reverse) needs the old app uninstalled first, which deletes its data.

Rebuild the APK after changing native code (the printer module, a new native package, `app.json` plugins). JS-only
changes reload from Metro. Release signing, Play listing and subscriptions are Phase 5.

Windows notes:
- React Native's C++ codegen makes CMake object paths longer than Windows' 260-character limit in this repository.
  `apps/cafe-android/plugins/with-short-cmake-object-paths.js` sets `CMAKE_OBJECT_PATH_MAX=250` so CMake hashes long
  names. Keep it unless long paths are enabled machine-wide and the SDK's CMake is 3.31 or newer.
- The Windows POS keeps React 19.2 at the repository root (pinned in the root `package.json`); the app has React 19.3
  in `apps/cafe-android/node_modules`. `metro.config.js` sends every `react` import to the app's copy, so `npm ls`
  and `expo-doctor` report a duplicate React; that is expected.

## First run

The owner enters the cafe name, optional address, phone and GSTIN, how GST is charged and the usual rate, and a 4-6
digit owner PIN (needed to void a bill). Then an empty menu or a small sample menu, then a printer (can be skipped).

## Pair and add a printer

Thermal printers that use Bluetooth Classic (serial/SPP) or a network socket on port 9100 are supported, on 58 mm
or 80 mm paper.

1. Switch the printer on and pair it in Android's Settings, Bluetooth (the pairing PIN is often 0000 or 1234).
2. In the app: More, Printers, Add Bluetooth printer. Allow the Bluetooth permission when asked (Android 12+).
3. Choose the printer from the paired list, choose the paper width, Save and test.
4. The test slip prints a line of numbers that should fill exactly one line; if it wraps, the paper width is wrong.

A network printer takes its IP address (`192.168.1.50`, or `192.168.1.50:9101` for another port).

A bill is always saved before its receipt is printed. If the printer is off, out of range or out of paper, the
payment screen says so with Try again, and any bill can be reprinted from Bills.

## What works offline

Everything in this phase: the menu, billing with cash, UPI QR (generated on the phone) and card, split payments,
discounts, custom items, receipts and tokens, reprints, voids with the owner PIN, and the day report. Data lives in
`cafe.db` on the phone. There is no backup yet: uninstalling the app deletes its bills.

## Not built yet

- Phase 2: add-ons, offers, kitchen slip, staff PINs and roles, customers and bill sharing, hold order,
  Takeaway or Delivery.
- Phase 3: Google sign-in, cloud backup and restore, owner view on a second device, bill link.
- Phase 4: free trial and signed entitlement, cafes in the Portal, menu from a photo.
- Phase 5: Play subscription, release signing, store listing and production release.
- After release: USB printers, Hindi screens.
