# Live support and remote access

Restaurants reach MasalaPOS support from inside the POS:

- **Get support** (in the menu, the Captain menu, and Settings → Help & support) opens a chat in the browser. Support answers it from the Portal's **Live chat**.
- **Remote access**: support can ask to see the restaurant's PC, and to use its mouse and keyboard. Nothing happens until someone at that PC allows it.

## How it works

```
POS window (desktop app) ── LAN socket ── POS server ── wss /v1/counter/live (installation secret) ──┐
   consent prompt, red strip                                                                         │
desktop shell: sharing window ── wss /v1/remote/agent (one-time token) ── WebRTC (TURN) ──┐          │
                                                                                          ▼          ▼
restaurant's browser ── /support/ (mp_support cookie) ──────────────────────────► portal host: SupportHub ◄── Portal: Live chat, remote viewer
```

- **Get support**:
  1. The POS server asks the service for a one-time link (`POST /v1/support/link`, authenticated with the installation secret).
  2. The browser opens it. `/support/start` turns the link into a cookie that speaks for that counter's chats for 24 hours.
  3. Messages are stored first and then pushed. Every page also falls back to checking every few seconds.
- **Remote access**:
  1. The counter keeps one live connection to the service. A request from support arrives on it.
  2. The POS window **on that PC only** asks whoever is there:
     - Allow view and control
     - Allow view only
     - Don't allow
  3. Allowing needs an admin: one signed in, or an admin's PIN typed there. The request lapses after 60 seconds.
  4. Then the desktop app shares the screen over WebRTC.
     - A red frame and a banner with **Stop** stay up the whole time.
     - Mouse and keyboard work only while control is allowed.
- **The session ends** at the first of these:
  - Stop, at the PC or in the Portal;
  - closing the viewer for two minutes;
  - one hour;
  - losing the connection.
- **Every step is recorded:**
  - **on the PC:** in Settings → Help & support (`remote_support_log`);
  - **in the Portal:** in the activity log, and as lines in the chat.

### What phase 1 cannot do

The sharing runs as the signed-in Windows user. Windows deliberately keeps these out of reach:

- **UAC prompts:** the "Do you want to allow…" prompt shows as black, and support can't click it. Ask the restaurant to click **Yes**.
- **Windows of programs running as administrator.** Support can see them but can't click or type into them. This includes:
  - Device Manager;
  - adding a printer or installing its driver;
  - changing an adapter's IP settings.
- **The lock screen, Ctrl+Alt+Del, and reconnecting after a restart.**

Phase 2 would add a small MasalaPOS Support Windows service running as SYSTEM, which is what AnyDesk and TeamViewer do. It needs a code-signing certificate.

### Who can do what

| | Admin | Sales | Accounts | Support |
| --- | --- | --- | --- | --- |
| Live chat (`support.chat`) | Yes | — | — | Yes |
| Ask for remote access (`support.remote`) | Yes | — | — | Yes |

**Watching a session:** only the person who asked can watch it, or an admin.

**At the restaurant, under Settings → Help & support** (admins only):
- an admin can turn off remote-access requests altogether;
- requests are then refused without asking anyone.

## Hosting requirements

The live parts (pushes, the counter's connection, remote sessions) run on the **Node host** (`apps/licensing-node`, the Lightsail server).

- Caddy proxies WebSockets with no change.
- On Cloudflare, chat still works by polling. Remote access answers 501 until a Durable Object adapter exists for `src/live/hub.ts`.

### TURN relay (coturn on the Lightsail box)

**Why it's needed:** a remote session goes directly between the restaurant PC and the support person's browser when their networks allow it. Restaurant routers and mobile hotspots often don't. A TURN relay carries the session then.

**Bandwidth:** about 1 GB per relayed hour at most (the sender caps at 2.5 Mbit/s). Keep an eye on the instance's transfer allowance.

Run these yourself (remote-write SSH isn't available to Claude here). Replace `<SECRET>` with a long random string, e.g. `openssl rand -hex 32`.

1. **Open the ports** (AWS CLI with the `aws-project` profile, region us-east-2):

   ```sh
   aws lightsail open-instance-public-ports --profile aws-project --region us-east-2 --instance-name forkflow-portal-1 --port-info fromPort=3478,toPort=3478,protocol=udp
   aws lightsail open-instance-public-ports --profile aws-project --region us-east-2 --instance-name forkflow-portal-1 --port-info fromPort=3478,toPort=3478,protocol=tcp
   aws lightsail open-instance-public-ports --profile aws-project --region us-east-2 --instance-name forkflow-portal-1 --port-info fromPort=49160,toPort=49200,protocol=udp
   ```

2. **Install coturn** on the server:

   ```sh
   sudo apt-get install -y coturn
   PRIVATE_IP=$(hostname -I | awk '{print $1}')
   sudo tee /etc/turnserver.conf >/dev/null <<EOF
   listening-port=3478
   fingerprint
   use-auth-secret
   static-auth-secret=<SECRET>
   realm=portal.billnroll.in
   external-ip=18.117.42.44/$PRIVATE_IP
   min-port=49160
   max-port=49200
   no-cli
   no-multicast-peers
   no-tlsv1
   no-tlsv1_1
   # Never relay into this machine or private networks.
   denied-peer-ip=0.0.0.0-0.255.255.255
   denied-peer-ip=10.0.0.0-10.255.255.255
   denied-peer-ip=127.0.0.0-127.255.255.255
   denied-peer-ip=169.254.0.0-169.254.255.255
   denied-peer-ip=172.16.0.0-172.31.255.255
   denied-peer-ip=192.168.0.0-192.168.255.255
   total-quota=20
   EOF
   sudo sed -i 's/^#\?TURNSERVER_ENABLED=.*/TURNSERVER_ENABLED=1/' /etc/default/coturn
   sudo systemctl enable --now coturn
   ```

3. **Tell the portal about it:** add to `/etc/forkflow-portal/env`, then `sudo systemctl restart forkflow-portal`.

   ```sh
   TURN_URLS=turn:portal.billnroll.in:3478?transport=udp,turn:portal.billnroll.in:3478?transport=tcp
   TURN_SECRET=<SECRET>
   ```

   The portal hands each session short-lived TURN credentials, valid for 2 hours: `username = <expiry>:<label>`, `password = base64(HMAC-SHA1(secret, username))`. coturn checks them with the same secret and keeps no user list. Without `TURN_URLS`, sessions connect only when the two ends can reach each other directly.

**Testing that the relay works:** open the viewer in a browser on a different network from the PC, e.g. a phone hotspot. If the picture never starts but the session shows **Live**, the relay isn't reachable. Check the ports and `journalctl -u coturn`.

### Deploying

1. Build the portal (`npm run build -w @masalapos/portal`, which also builds `dist/support`), then the Node host, and deploy as described in the portal memory notes. Migration `0008_support.sql` applies on start.
2. Counters need a new commercial build (`npm run build:commercial`) for:
   - the Get support button;
   - the live connection;
   - screen sharing;
   - migration `043`.

## Checking it end to end

- **Automated:**
  - `npx vitest run apps/licensing-worker/src/support apps/licensing-node apps/server/src/support.test.ts apps/desktop/src/remote`
  - `support-e2e.test.ts` runs the real Node host and a real counter over real sockets.
- **By hand, with two machines:**
  1. Click **Get support** on the counter. Write in the browser, answer in Live chat, then **Open a ticket** from it.
  2. Click **Ask for remote access** (view and control). On the PC, allow it with an admin PIN. Check the red frame and banner show.
  3. Open Windows Settings → Bluetooth & devices → Printers and print a test page from the viewer.
  4. Try **View only** on the banner: the viewer can no longer click. Press **Stop**: both sides end.
  5. Repeat from a phone hotspot to prove the TURN relay works.
