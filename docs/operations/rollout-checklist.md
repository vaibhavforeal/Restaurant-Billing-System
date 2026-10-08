# Restaurant rollout checklist

Use this before a restaurant relies on ForkFlow for real service. It checks what the automated tests cannot: a clean Windows install, the restaurant network, real printers, phones and tablets, and recovery from power or hardware problems.

Work through it on the actual restaurant hardware, top to bottom. Tick each box only when you saw the **Expect** result. Write down anything that differs in the [record sheet](#9-record-sheet) at the end. Skip sections for equipment the restaurant doesn't have (for example Bluetooth printers), and mark them "n/a".

Allow about 2–3 hours for a full run. Do it outside service hours.

---

## 0. Before you start

### On the build PC

- [ ] **Build a fresh installer.** The installer in `dist/commercial` is from 2 October 2026 and does not contain later work (inventory costing, table move and merge, review fixes). From the repository root in PowerShell:
  ```powershell
  $env:FORKFLOW_LICENSE_PUBLIC_KEY = Get-Content 'C:\secure\license-public.pem' -Raw
  npm.cmd run package:commercial
  ```
  **Expect:** `dist/commercial/ForkFlow-Setup-<version>.exe` with today's date.
- [ ] **Version number.** The current version is 0.7.0. For each later release, raise `version` in `package.json` before building. A new version number is what triggers the automatic pre-update backup on their PC.
- [ ] **Kitchen client** (only if the kitchen uses a Windows PC): `npm.cmd run package:kitchen` → `dist/kitchen/ForkFlow-Kitchen-Setup-<version>.exe`.
- [ ] Copy the installer(s) and a signed license file for this restaurant to a USB stick.

### Equipment

| Item | Needed for |
| --- | --- |
| Main POS PC (Windows 10/11, wired network preferred) | Everything |
| Each receipt and kitchen printer, with paper | Sections 4, 7 |
| One Android phone or tablet, and/or an iPad | Section 5 |
| Kitchen PC or tablet, if the kitchen uses a screen | Section 6 |
| Router admin access | Section 3 |
| A second Windows PC or laptop (optional) | Counter browser check |

---

## 1. Clean install on the main PC

- [ ] Run the installer on the main PC. **Expect:** Windows shows an "unknown publisher" (SmartScreen) warning because the installer is not code-signed yet. Choose **More info → Run anyway**. Write down that the warning appeared.
- [ ] Finish the install with the default folder. **Expect:** a ForkFlow desktop shortcut; ForkFlow opens to restaurant setup.
- [ ] Complete setup: restaurant name and administrator PIN. **Expect:** you reach the license screen.
- [ ] Import the license file. **Expect:** plan shows Basic or Pro correctly; this PC registers as a device.
- [ ] Close the window. **Expect:** ForkFlow stays in the system tray; the tray menu has **Open data and backups** and **Quit**.
- [ ] Restart Windows. **Expect:** ForkFlow starts by itself after login (tray icon present).

---

## 2. Basic setup for testing

- [ ] **Settings → Restaurant profile:** GST number, address, receipt footer, tax mode, UPI ID (if used). Save.
- [ ] **Kitchen screen:** decide with the owner. If the kitchen will use a Kitchen screen (Pro plan), turn on **Kitchen Display (KDS)** in the Marketplace; if it only gets printed KOTs, leave it off.
- [ ] Add staff: at least one cashier, one captain/waiter and one kitchen user, each with their own PIN.
- [ ] Add 3–5 test menu items across two kitchen stations (for example Kitchen and Bar), and tables T1–T6, including at least one AC table if the restaurant uses AC pricing.

---

## 3. Network access from other devices

- [ ] In the router, **reserve the main PC's IP address** (DHCP reservation). Write it down: `______________`.
- [ ] Set the main PC's Windows network to **Private**.
- [ ] From another device on the restaurant Wi-Fi, open `http://<main-PC-IP>:4100`. **Expect:** the ForkFlow login screen loads.
  - If it doesn't load: check the device is on the staff network, not guest Wi-Fi (guest networks often block devices from seeing each other), and that the Windows Defender Firewall inbound rule **"ForkFlow POS LAN"** (added by the installer, port 4100, Private networks) exists and is enabled. The rule only applies on Private networks, so the step above matters.
- [ ] Restart the router. **Expect:** after it comes back, the same address still works (the reservation held).

---

## 4. Printers

Do this for **each** printer. Start in **Settings → Printers**.

### 4a. Add and test

- [ ] Add the printer with the right connection type:
  - **Network:** its IP address (print a self-test page from the printer to find it), port 9100.
  - **USB (Windows driver):** install the manufacturer's Windows driver first, then pick the printer from the list.
  - **Bluetooth:** pair it in Windows first, then enter its COM port (Windows Settings → Bluetooth → More Bluetooth options → COM Ports, the "Outgoing" one).
- [ ] Set paper width (58 or 80 mm) to match the roll.
- [ ] **Test print → Bill profile** and **KOT profile**. **Expect:** a slip prints, text is readable and fits the width, the paper feeds out far enough, and the cutter cuts (if the printer has one). Adjust feed lines and cutter in each profile until it looks right.
- [ ] Assign each kitchen station to its printer (**Settings → Kitchen stations**).

### 4b. Real slips

- [ ] Open a table order, add one item from each station, send to kitchen. **Expect:** each station's printer prints its own KOT with the right items, table and KOT number.
- [ ] Cancel one sent item with a reason. **Expect:** a cancellation slip at that station.
- [ ] Issue the bill with a receipt printer selected. **Expect:** receipt with restaurant details, GST lines, total, and the UPI QR if a UPI ID is set. Scan the QR with a UPI app — **Expect:** correct payee and amount (don't pay).

### 4c. Failure handling (important — this was never tested on real hardware)

For each check, open **Settings → Print jobs** afterwards and note the job status.

- [ ] **Printer off:** switch the printer off, send a KOT. **Expect:** the order is saved and sent to the kitchen in the app; the print job shows **Failed** (network/USB/Bluetooth printer that never received data). Switch the printer on and **Retry** — **Expect:** it prints once.
- [ ] **Windows printer renamed or deleted** (USB/Windows printers only): rename it in Windows, send a KOT. **Expect:** **Failed** with a "not reached" message, not "Check paper". Rename it back and retry.
- [ ] **Bluetooth unpaired or out of range** (Bluetooth only): **Expect:** **Failed** with "could not be opened". Re-pair and retry.
- [ ] **Paper runs out mid-slip** (if you can simulate it): **Expect:** **Check paper**. Check the printout, then either **Retry this copy** or **Mark as already printed**.
- [ ] Whatever happened, the bill or KOT itself must never disappear because of a printer problem.

---

## 5. Captain app on phones and tablets

Phones need HTTPS to install the Captain app. Do this on the main PC, from the folder ForkFlow was built in (or a copy of `tools\setup-captain-https.ps1`):

- [ ] Run in PowerShell (use the reserved IP from section 3):
  ```powershell
  .\tools\setup-captain-https.ps1 -ServerAddress <main-PC-IP> -OpenFirewall
  ```
  Restart ForkFlow.
- [ ] **Settings → Backups & connections → Captain tablets** shows an HTTPS address, a QR code and a certificate expiry date.
- [ ] Install the restaurant certificate on each phone/tablet (download it from that settings panel; never copy the `.pfx` or password files). Android: Settings → Security → Install certificate → CA certificate. iPad: open the file, install the profile, then enable it under General → About → Certificate Trust Settings.
- [ ] Open `https://<main-PC-IP>:4443/captain/`. **Expect:** no certificate warning; captain login appears.
- [ ] Install it: Chrome → **Install app**; iPad Safari → Share → **Add to Home Screen**. Open it from the home screen.
- [ ] **Register the device** if the license asks (Basic allows 2 devices, Pro allows 5 — count the main PC, counters, captains and kitchen screens).
- [ ] As the captain: open a table, add items, send to kitchen. **Expect:** KOTs print; the main POS shows the order live.
- [ ] Walk to the far end of the dining area. **Expect:** the app stays connected. Note any dead spots.
- [ ] Turn the phone's Wi-Fi off for 30 seconds, then on. **Expect:** it reconnects by itself; nothing sent before was lost.

---

## 6. Kitchen screen (if used)

- [ ] **Marketplace:** as admin, turn on **Kitchen Display (KDS)**. **Expect:** the switch turns on and a **kitchen** item appears in the sidebar. (Needs the Pro plan.)
- [ ] **Windows kitchen PC:** install the Kitchen client, enter `http://<main-PC-IP>:4100`, sign in as the kitchen user. **Or tablet:** open `https://<main-PC-IP>:4443/kitchen/` and install it like the Captain app.
- [ ] Send an order from the POS. **Expect:** the ticket appears within a few seconds with the right table.
- [ ] Tap **Done**. **Expect:** the ticket leaves every kitchen screen; billing was already possible as soon as the order was sent.
- [ ] Leave the kitchen screen open for 30+ minutes. **Expect:** still live (send another order to confirm).

---

## 7. Full service run

Run a short mock service with real staff roles and printers. Check each **Expect** as you go.

- [ ] **Dine-in:** captain opens T1, adds items from two stations, sends. Cashier previews and issues the bill, records payment split between cash and UPI. **Expect:** totals and GST are correct; T1 becomes free.
- [ ] **Split bills:** two groups at T2 (A and B), each billed and paid separately.
- [ ] **Move a table:** move T3's order to T5. **Expect:** order follows; kitchen screen shows T5; each station with open tickets prints a "TABLE CHANGE  T3 -> T5" slip.
- [ ] **Merge tables:** open T4 and T6, then merge T6 into T4 ("Bill at T4"). **Expect:** T6 card shows "with T4"; T4 shows "T4, T6"; one bill containing everything; after payment both tables are free.
- [ ] **Quick takeaway:** a parcel order billed and paid with the cash-change helper.
- [ ] **Discount:** cashier applies a discount within 10%; over 10% is refused for the cashier.
- [ ] **Cancel:** cancel a sent item with a reason; check it appears in the cancellations report.
- [ ] **Refund:** on a paid bill, as a cashier choose **Refund items**, refund one item with the manager's PIN under **Admin approval**. **Expect:** a wrong PIN is refused; the right one issues CN-n and the credit note prints; the bill shows **Partly refunded**; Reports → Day-end / GST shows the credit-notes block and net figures.
- [ ] **Void:** void an unpaid table bill and a paid bill. **Expect:** the unpaid void frees the table; the paid void refunds the money by the method you choose; both appear in Reports → Detailed reports → Credit notes.
- [ ] **Guest QR (Pro):** print a table QR, order from a phone, accept the request on the POS.
- [ ] **Inventory (if used):** receive stock with an amount paid, check the stock decreases after a sale; on Pro, check Dish costing and the Food cost & profit report.
- [ ] **Day end:** open Reports → Day-end / GST. **Expect:** gross sales match the bills you just made (voided bills are still included), and the net figures reflect the credit notes. Export the CSV and open it.

---

## 8. Power, network and recovery

- [ ] **Unplug the main PC's network cable** (or turn its Wi-Fi off) for a minute during an open order, then reconnect. **Expect:** captain/kitchen devices reconnect; no order or item lost.
- [ ] **Restart the main PC** with orders open. **Expect:** ForkFlow comes back by itself; open orders are still there; print jobs that were mid-print show **Check paper**.
- [ ] **Backups:** Settings → Backups → **Back up now**, then set a **second backup folder** (USB drive or another disk). **Expect:** a backup file appears in both places.
- [ ] **Restore drill:** from the tray menu, restore yesterday's or the just-made backup. **Expect:** ForkFlow restarts, staff must sign in again, data matches the backup. *(Do this only after the test data is no longer needed, or before real data exists.)*
- [ ] Note where the data folder is (tray → **Open data and backups**) and tell the owner.

---

## 9. Record sheet

Fill in one row per problem. Anything in the **Severity: Blocker** category must be fixed before the restaurant goes live.

| # | Section / step | What you did | What happened | Expected | Severity (Blocker / Annoying / Cosmetic) | Photo / note |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | | | | | | |
| 2 | | | | | | |
| 3 | | | | | | |

**Sign-off**

| | |
| --- | --- |
| Restaurant | |
| Date | |
| ForkFlow version | |
| Printers tested (model, connection) | |
| Devices tested (model, browser/app) | |
| Tested by | |
| Ready for live service? (Yes / Not yet) | |

Send the completed record sheet back so issues can be fixed.
