# Captain App

The Captain App is ForkFlow's tablet and phone interface for tables, orders and KOTs. It uses the existing staff PIN, waiter permissions, database, retry queue and kitchen printers. Open `/captain/` on the restaurant server. Waiters signing into the ordinary POS address enter Captain automatically.

## Implementation plan and audit

- `apps/ui/src/App.tsx:66`: waiters currently land on the generic dashboard. Start Captain at tables and use a dedicated header.
- `apps/ui/src/NavBar.tsx:68`: waiter navigation is a reduced desktop sidebar. Move overview, theme, installation and logout into the Captain account panel.
- `apps/ui/src/screens/OrderScreen.tsx:50`: automatic search focus opens the tablet keyboard unnecessarily. Captain focuses search only when requested.
- `apps/ui/src/screens/OrderScreen.tsx:172`: Punch and KOT are separate actions. Captain's primary action sequences the existing save and send requests; Save only stays available.
- `apps/ui/src/screens/OrderScreen.tsx:217`: cooking notes use a browser prompt. Replace it in Captain with a touch dialog supporting the existing 200-character limit.
- `apps/ui/src/pos.css:258`: narrow screens retain a vertical category rail and one menu column. Captain uses horizontal categories, two or more menu columns, and a persistent review bar.
- `apps/ui/index.html:1`, `apps/ui/vite.config.ts:1`: no manifest or service worker exists. Add a scoped Captain shell cache; never cache API responses or replay writes in a service worker.
- `apps/server/src/main.ts:52`: the server currently exposes HTTP only. Add optional local TLS using the same request handlers and WebSocket connection, preserving the desktop HTTP listener.

Captain tokens extend the existing palette and spacing: 44px touch controls, 48px header, 13px base text, 16px inputs, 24px totals, 96px minimum menu tiles, 4/6px corners. Phones use Menu/Order panes; landscape tablets show menu and cart together.

## Connectivity and offline behavior

Internet is not needed. Keep the POS PC running and connect tablets to the same restaurant network. HTTPS adds encryption to this local connection, not a cloud round trip.

The installed app caches only its interface. Table availability, sign-in and KOT confirmation come from the POS. Drafts and queued actions stay in existing browser storage. Keep Captain open while a queued send reconnects. After closing or reloading during a disconnection, reopen the order and check its item statuses; saved items may still need **Send to kitchen**. An offline tablet cannot confirm printing or create new server orders.

Installation requires a certificate trusted by each tablet. A certificate warning must be resolved before installing; clicking through a warning is insufficient for service workers. The shell and its assets stay on the same installed release. Updates activate after all Captain windows close, without interrupting an order.

## Set up local HTTPS

On the POS PC, reserve its IPv4 address in the router. In a PowerShell window at the project root, run:

```powershell
.\tools\setup-captain-https.ps1 -ServerAddress 192.168.171.101
```

Replace the example with that PC's actual restaurant LAN address. The default data directory is `%APPDATA%\forkflow-desktop\data` and the HTTPS port is 4443. For a development server, pass its actual `-DataDirectory`. Restart ForkFlow after setup. The desktop continues to use HTTP port 4100; HTTPS uses the same handlers, database, staff permissions and live event hub.

In **Settings → Backups & connections → Captain tablets**, find the HTTPS URL, QR code, certificate expiry and certificate fingerprint. Download the public restaurant certificate there, or copy only `restaurant-ca.cer` from the path printed by the setup script. Never transfer the `.pfx` files or `pfx-password.txt` to tablets.

### Windows Firewall

Only on the trusted restaurant network, set the PC's network profile to **Private** in Windows network settings. From an Administrator PowerShell window, allow the Captain port from the local subnet:

```powershell
New-NetFirewallRule -DisplayName 'ForkFlow Captain HTTPS 4443' -Direction Inbound -Protocol TCP -LocalPort 4443 -Action Allow -Profile Private -RemoteAddress LocalSubnet
```

Run this once; check for an existing rule with the same name first. The setup script's optional `-OpenFirewall` does the same check during initial setup. Do not forward the port in the router. Tablets must be on a network that can reach the POS PC; guest Wi-Fi/client isolation may prevent this even when the signal is strong. Ethernet for the POS PC is preferable when available.

### Android tablets

1. Transfer **only the public restaurant CA certificate** to the tablet and compare its SHA-256 fingerprint with the POS settings. Android menu wording varies: **Settings → Security & privacy → More security settings → Encryption & credentials → Install a certificate → CA certificate**. A device PIN may be required; managed tablets may need their administrator.
2. In Chrome, open the HTTPS Captain URL. Confirm there is no certificate warning.
3. Choose **Install Captain** from the Captain account panel, or **Install app / Add to Home screen** in Chrome's menu. Open the installed app and sign in with an existing waiter PIN.

### iPad

1. Transfer/open the public CA certificate, then install the downloaded profile in **Settings → General → VPN & Device Management**.
2. Enable this restaurant CA in **Settings → General → About → Certificate Trust Settings → Enable Full Trust for Root Certificates**. Compare its fingerprint with the POS settings before trusting it.
3. Open the HTTPS Captain URL in Safari without a certificate warning. Tap **Share → Add to Home Screen**; enable **Open as Web App** if shown. Open Captain from the Home Screen and sign in.

The CA should be installed only on the restaurant's staff devices. Removing the installed app does not remove the trusted certificate; remove the certificate/profile separately when retiring a tablet. Each browser/origin has its own session, draft and queue storage. Finish pending work on the old HTTP address before moving a device to HTTPS.

### Renewal and recovery

The server certificate lasts one year. Before expiry, run the setup script with `-Renew` from the same Windows account and restart ForkFlow. It reuses the existing CA so tablet trust continues. If the server IP changes, use the new IP with `-Renew`, and reopen/reinstall Captain at the new address after clearing any pending work at the old address. A router DHCP reservation avoids this interruption.

The local CA lasts three years. Its replacement requires trusting the new public CA on each tablet. Keep the private certificate files and their password in a protected backup on the POS PC; ordinary SQLite backups do not include these files. Renewal requires the original CA private key in that Windows account's certificate store; the script reports an error if it is missing.

## Verified result — 30 September 2026

- Production Captain listener: `https://192.168.171.101:4443/captain/`; desktop HTTP remains available on port 4100. Trusted HTTPS health, shell, manifest, worker and public certificate requests passed using the explicit restaurant CA, without disabling TLS validation. Anonymous order access returns 401.
- Windows currently reports **Wi-Fi 3 / Public**. This session had no administrator rights, so the firewall/profile step above is still required before tablet rollout. No Windows root trust was installed. Physical tablet certificate installation and thermal-printer output remain untested.
- 60 targeted tests passed: PWA cache boundaries, trusted HTTPS/WSS, orders, billing, KOT, system and role permissions. The final cache-update correction also passed its six tests. Type checks, UI build and staged desktop build passed. No dependencies were added.
- Browser checks covered 360×640, 390×844, 768×1024, 1024×768, 1280×720 and 1920×1080; a 390×440 viewport checked dialog behavior with reduced vertical room. Light/dark theme, touch controls, typed quantity, notes, variants, remove/undo, parcels and splits were checked. Landscape menu/cart and send action fit without page scrolling; long item/table lists scroll inside their panels.
- A four-line order with five units retained its ₹630.00 subtotal. Three kitchen lines produced one KOT, including the cooking note, through the existing print queue and a test sink. The stationless drink stayed saved without a kitchen ticket. Waiter billing attempts returned 403. Kitchen-ready changes appeared live in the order and tables.
- A disconnected send retained one queued request without reporting success. Reconnection created one item and one KOT. Reloading during disconnection preserved queued items; on reopening, the item was saved and required review/send as documented. Offline startup displayed the reconnect screen. API responses were absent from the service-worker cache.
- The user authorized the project's pre-existing schema upgrades from 11 to 13. A verified pre-update backup was saved, all original data across 26 tables was unchanged in the upgraded copy, and the restarted live database passed integrity/foreign-key checks with existing record counts preserved. The 126-file business-source baseline changed only in `main.ts`, `server.ts` and `system.ts` for hosting/connection setup; schema definitions, billing calculations, numbering, order rules and print templates were unchanged by Captain work.

Screenshots and machine-readable checks are in `output/captain/`. `tools/e2e/captain-app.js` records the primary browser order flow against the disposable fixture.

## Before and after

| Area | Before | Captain |
| --- | --- | --- |
| Entry/navigation | Generic dashboard and desktop navigation | Tables first; account panel for overview, theme and installation |
| Order entry | Desktop category rail and separate Punch/KOT actions | Horizontal categories; menu/cart side by side on landscape tablets; Menu/Order panes on phones |
| Controls | Counter-sized 24–32px controls mixed with larger targets | 44px touch controls, 48px send action, 96px minimum menu/table tiles |
| Three-item order from Tables | 6 taps: table, three items, Punch, KOT | 5 taps on landscape tablet: table, three items, Send to kitchen; phones add one Review tap |
| Notes and status | Browser prompt; sent status | Touch note dialog; live kitchen-ready status; explicit reconnect/queue feedback |
| Billing/payment/reports | Existing cashier workflows | Continue on the full POS; Captain retains the same role restrictions |
