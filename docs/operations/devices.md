# Devices

**Settings → Devices** is where a restaurant sees and manages every counter, kitchen display and captain tablet, and
the printers they use. It has four tabs.

| Tab | Who sees it | What it is for |
|---|---|---|
| Devices | Administrators | The device list, adding and replacing devices, each device's settings, device history |
| Printers | Staff who can view printers | The printers the main PC can reach, and who prints to each |
| Kitchen stations | Staff who can view printers | Which printer each station's kitchen tickets go to |
| Print jobs | Staff who can view printers | What was sent to the printers, with a retry for a failed copy |

Staff who can view printers but are not administrators see Settings with the Devices card only. Changing printers,
stations or print jobs needs the **Manage** printers permission (see [Staff permissions](staff-permissions.md)).

## The device list

Each row shows the device's name, its type, whether it is connected now, and the printer its bills go to.

- **Online** means someone is signed in on the device and it is connected to the main PC. A device on the sign-in
  screen counts as offline and shows when it was last seen.
- **Main** is the main counter: the browser on the main POS PC that set the restaurant up.
- **This device** is the one you are looking at.
- **Over limit** means the plan allows fewer devices than have joined. The oldest devices keep working; the ones
  marked cannot be used until a device is removed or the plan is upgraded.
- **Printer inactive** means the device's bill printer has been switched off. Its bills use the browser receipt until
  the printer is switched on again or another is chosen.

In a licensed build the line above the list shows how many of the plan's devices are in use.

## Adding a device

1. Select **Add device**, choose **New device**, its type (billing counter, kitchen display or captain) and a name,
   then **Create join code**. Kitchen display is offered while the Kitchen Display add-on is on.
2. The screen shows a six-character code, how long it is valid (ten minutes), a QR code and address for each address of
   the main PC, and how to connect a device of that type:
   - **Billing counter:** open the address on the counter PC. A download creates a desktop shortcut that opens
     MasalaPOS in Microsoft Edge.
   - **Kitchen display:** install MasalaPOS Kitchen on a kitchen PC, or open the Kitchen link on a tablet.
   - **Captain:** install the Android Captain app and scan the pairing code, which connects the tablet and joins it in
     one step; or open the address in the tablet's browser after trusting the restaurant certificate.
     See [Captain app](captain-app.md).
3. On the new device, enter the code and select **Join**. Scanning the QR code fills the code in. The device lands on
   the screen for its type and the normal sign-in.
4. The dialog on the first device says the device has joined and closes.

A code works once. A wrong, used or expired code gets the same answer, "That code is not valid or has expired", and one
address can try ten codes a minute. Making another code for the same device cancels the earlier unused one. When every
device the plan allows is in use, a new device is refused; replacing a device is still possible.

Keep every device on the same restaurant Wi-Fi or Ethernet as the main PC, and reserve the main PC's IP address in the
router so its address does not change.

## Replacing a device

Use this after a browser's storage was cleared, or when a PC or tablet is swapped. Open the device and select
**Replace**, or select **Add device → Replace an existing device** and choose it. The new browser joins with the code
shown.

The device keeps its name, type, settings and place in the plan's allowance, so it needs no free slot. Its old browser
is signed out. A captain tablet that uses the HTTPS address must join on the HTTPS address; its join links and pairing
codes point there when HTTPS is set up.

## The main counter

The main counter cannot be removed. If its own browser storage is cleared, no other device is needed: on the main POS
PC the join screen offers **This is the main counter**. An administrator signs in there and selects **Re-join as main
counter**. It works only on the main PC itself and only for an administrator.

## One device's settings

Select a row to open the device.

- **Name.** Renaming keeps the device's place in the allowance.
- **Bill printer.** The printer a new bill from this device uses, or **Browser / A4 receipt** for no thermal print.
  Staff can still pick another printer for one bill on the billing screen.
- **Payment method a new bill starts on.** The method used last on that device, or always Cash, Card or UPI.
- **Replace** and **Remove.**

A kitchen display has no bill printer or payment method. Settings are kept on the main PC, so they survive clearing the
browser and replacing the device. If two administrators change the same device at once, the second is told the device
changed and sees the current values.

## Removing a device

**Remove** asks for confirmation, signs out the staff on that device and disconnects it. Removing the device you are
using signs you out too. A removed device needs a new join code to come back, and joins as a new device at the end of
the list.

## Device history

Below the list: every join, rename, replacement, removal and settings change, with who did it and when. **Load older
changes** shows earlier entries. Licence changes are listed separately under **Settings → Plan**.

## When the licence has stopped this device

If the plan has expired, or this device is over the limit, an administrator who signs in sees the recovery screen. It
includes the device list, so a device can still be renamed or removed to free a slot. Adding a device and changing a
device's printer wait until billing is available again.

## Printers

Printers must be reachable from the main PC: on the network, installed in Windows on the main PC, or paired to it by
Bluetooth. The **Used by** column lists the devices whose bills go to each printer and the kitchen stations routed to
it, including for a printer that is switched off, so it is clear what stopped printing.
See [Printer settings](printer-settings.md).
