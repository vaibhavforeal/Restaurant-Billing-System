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

The owner enters the cafe name, optional address, phone and GSTIN, how GST is charged and the usual rate, their name
and a 4-6 digit owner PIN. Then an empty menu or a small sample menu, then a printer (can be skipped). The owner is
signed in at the end. If set-up stopped after the cafe was saved but before the owner was, the app opens on
**Set owner PIN** next time.

## Staff, PINs and the lock

- **Roles.** Owner (everything), Manager (bills, discounts above the cashier limit, voids, reports, menu, printers,
  customers) and Cashier (bills, reprints, customers). The owner adds people in More, Staff: name, role and a 4-6
  digit PIN entered twice; Reset PIN and Deactivate are there too. The last active owner cannot be demoted or
  deactivated. Deactivated staff stay on their old bills.
- **Lock screen.** The app opens on it: pick a name, enter that person's PIN. It comes back after the idle time set in
  More, Counter (default 5 minutes, or Never), checked when the app returns to the foreground and every 30 seconds
  while it stays open, and on **Switch staff** (the name button on the Bill screen, and More).
- **Wrong PINs.** After five wrong PINs that person's entry locks for 30 seconds, then 60, 120... The lock is kept on
  the phone, so restarting the app does not clear it.
- **Approvals.** When the signed-in person may not do something (a cashier's discount above the limit, a void, Reports,
  Menu, Printers), a sheet asks a manager or the owner to pick their name and enter their PIN, for that one action. The
  bill records who approved a discount; a void records who voided. Cafe details, Tax, Receipt, Counter and the kitchen
  slip setting always ask for the owner PIN on save.
- **Every owner has forgotten their PIN.** There is no reset yet. If every owner forgets their PIN, the app must be
  reinstalled until Phase 3 adds Google sign-in. Data on the phone is lost.

## Counter settings (More, Counter)

Cashier discount limit (percent of the bill a cashier may take off without approval; 0 means every discount needs
approval), lock after (Never, 1, 2, 5, 10, 15 or 30 minutes without a touch) and whether receipts print who served.

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

## Kitchen slip

More, Printers, Kitchen slip: **No kitchen slip**, **Kitchen printer** (a second printer added under Kitchen printer)
or **Receipt printer** (the slip prints on the counter printer after the receipt). The slip shows `TOKEN n`, Takeaway
or Delivery, each item with its note (long press a cart line to add one) and the delivery note. It is queued after the
receipt; the token screen shows each with its own Try again, and a failed slip never affects the saved bill. A bill's
screen has **Reprint kitchen slip**; a reprint says REPRINT at the foot, and a void bill cannot be reprinted to the
kitchen.

## Customers, Delivery and held orders

- The cart switches between Takeaway and Delivery. Delivery has a "Deliver to" note that prints on the receipt and
  the kitchen slip; choosing a customer with an address fills an empty note.
- **Customer** on the cart finds a customer by phone or name, or adds one. A phone is stored as 10 digits (+91, 0 and
  spaces are dropped) and belongs to one customer. More, Customers lists them with their bills. The receipt shows the
  customer's name and the last four digits of the phone.
- **Hold** saves the cart (with an optional note) to serve the next customer; **Held (n)** on the Bill screen opens it
  again, priced from the menu as it is then. Items deleted meanwhile are named and left out. Held orders stay on this
  phone and do not expire.

## What works offline

Everything: the menu, billing with cash, UPI QR (generated on the phone) and card, split payments across cash, UPI
and card, discounts, custom items, receipts and tokens, the kitchen slip, staff PINs and approvals, customers, held
orders, reprints, voids by a manager or the owner, and the day report with sales by staff and by Takeaway or
Delivery. Data lives in
`cafe.db` on the phone. There is no backup yet: uninstalling the app deletes its bills.

## Not built yet

- Phase 2B: add-ons, offers and sharing a bill as an image.
- Phase 3: Google sign-in, cloud backup and restore, owner view on a second device, bill link.
- Phase 4: free trial and signed entitlement, cafes in the Portal, menu from a photo.
- Phase 5: Play subscription, release signing, store listing and production release.
- After release: USB printers, Hindi screens.
