import { useEffect, useState } from "react";
import { apiFetch, authHeaders, session } from "../api";
import { BackupSettings } from "./BackupSettings";
import { useIntegrations } from "../integrations";
import { Icon, type IconName } from "../Icon";
import "../connections.css";

interface CaptainConnection {
  enabled: boolean; error?: string; fingerprint?: string; expiresAt?: string;
  connections: Array<{ url: string; qr: string }>;
}
interface AndroidCaptain {
  downloads: Array<{ url: string; qr: string }>;
  pairings: Array<{ origin: string; secure: boolean; qr: string }>;
}
async function download(path: string, filename: string) {
  const res = await fetch(path, { headers: authHeaders(), signal: AbortSignal.timeout(60_000) });
  if (res.status === 401) session.clear();
  if (!res.ok) throw new Error("Download failed");
  const url = URL.createObjectURL(await res.blob());
  const link = document.createElement("a"); link.href = url; link.download = filename; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function SystemSettings({ backupOnly = false }: { backupOnly?: boolean }) {
  const kitchenDisplay = useIntegrations().isEnabled("kds");
  const [view, setView] = useState<"backups" | "connections">("backups");
  const [device, setDevice] = useState("counter");
  const [loaded, setLoaded] = useState(false);
  const [connections, setConnections] = useState<Array<{ url: string; qr: string }>>([]);
  const [captain, setCaptain] = useState<CaptainConnection | null>(null);
  const [android, setAndroid] = useState<AndroidCaptain | null>(null);
  const [apk, setApk] = useState<{ versionName: string } | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    if (!backupOnly) apiFetch<{ connections: Array<{ url: string; qr: string }>; captain?: CaptainConnection; android?: AndroidCaptain }>("/api/system/connections")
      .then((c) => { if (active) { setConnections(c.connections); setCaptain(c.captain ?? null); setAndroid(c.android ?? null); setLoaded(true); } })
      .catch((e: unknown) => { if (active) setError(e instanceof Error ? e.message : "Could not load connection settings"); });
    // Present only in builds that include the Android app; the static fallback serves HTML otherwise.
    if (!backupOnly) fetch("/captain/android/version.json", { cache: "no-store" }).then((res) => res.ok ? res.json() : null)
      .then((info: { versionName?: unknown } | null) => { if (active && typeof info?.versionName === "string") setApk({ versionName: info.versionName }); })
      .catch(() => {});
    return () => { active = false; };
  }, [backupOnly]);
  async function run(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true); setError(""); setMessage("");
    try { await action(); } catch (e) { setError(e instanceof Error ? e.message : "Request failed"); } finally { setBusy(false); }
  }
  const devices: Array<{ id: string; title: string; detail: string; icon: IconName }> = [
    { id: "counter", title: "Counter PC", detail: "Billing & orders", icon: "monitor" },
    { id: "android", title: "Android Captain", detail: "App for waiters", icon: "tablet" },
    { id: "browser", title: "Captain in browser", detail: "Android & iPad", icon: "cloud" },
    ...(kitchenDisplay ? [{ id: "kitchen", title: "Kitchen display", detail: "Live kitchen tickets", icon: "kitchen" as const }] : []),
  ];
  return <section aria-label="Backups and connections" className="system-settings">
    {!backupOnly && <nav className="system-view-switch" aria-label="System settings views">
      <button aria-pressed={view === "backups"} onClick={() => setView("backups")}><Icon name="folder" size={18} />Backups</button>
      <button aria-pressed={view === "connections"} onClick={() => setView("connections")}><Icon name="monitor" size={18} />Connections</button>
    </nav>}
    <div hidden={!backupOnly && view !== "backups"}><BackupSettings /></div>
    {!backupOnly && <div hidden={view !== "connections"}>
      <header className="system-page-heading"><h2>Connect your team</h2><p>Set up a counter, waiter tablet or kitchen display on your restaurant network.</p></header>
      {error && <p role="alert" className="backup-error">{error}</p>}
      {message && <p role="status">{message}</p>}
      {!loaded && !error && <p role="status">Finding your restaurant connections…</p>}
      {loaded && <>
      <div className="connection-network-note"><Icon name="monitor" size={18} /><p>Keep every device on the <strong>same restaurant Wi-Fi or Ethernet</strong>. The main POS must stay running. Every device needs a staff PIN.</p></div>
      <nav className="connection-device-picker" aria-label="Device type">{devices.map((item) => <button key={item.id} aria-pressed={device === item.id} onClick={() => setDevice(item.id)}>
        <Icon name={item.icon} size={22} /><span><strong>{item.title}</strong><small>{item.detail}</small></span><Icon name="arrow" size={16} />
      </button>)}</nav>
      <section className="connection-setup" aria-label="Device setup">
      {device === "counter" && <>
        <div className="system-section-heading"><Icon name="monitor" size={22} /><div><h3>Connect a counter PC</h3><p>Open a restaurant address on the other PC, then sign in with a staff PIN.</p></div></div>
        {!connections.length && <p className="system-empty">No LAN address found. Connect this PC to Wi-Fi or Ethernet, then reopen Settings.</p>}
        <div className="connection-code-list">{connections.map((connection) => <div className="connection-code" key={connection.url}>
          <img src={connection.qr} width={180} height={180} alt={`Connect to MasalaPOS at ${connection.url}`} />
          <div><span className="connection-address-label">Restaurant address</span><a href={connection.url} target="_blank" rel="noreferrer">{connection.url}</a>
          <div className="backup-actions"><button disabled={busy} onClick={() => void run(() => download(`/api/system/shortcut?url=${encodeURIComponent(connection.url)}`, "Create-MasalaPOS-Shortcut.ps1"))}><Icon name="download" size={16} />Download Edge shortcut setup</button></div>
          <p>On the counter PC, right-click the downloaded file and choose <strong>Run with PowerShell</strong> to create a desktop shortcut.</p></div>
        </div>)}</div>
        <p className="connection-footnote">Reserve the main PC's IP address in your router so the restaurant address stays the same.</p>
      </>}
      {device === "android" && <>
        <div className="system-section-heading"><Icon name="tablet" size={22} /><div><h3>Android Captain app</h3><p>Take orders and send KOTs from an Android phone or tablet.</p></div></div>
        {apk && android ? <>
          <div className="connection-step"><span>1</span><div><h4>Install MasalaPOS Captain {apk.versionName}</h4><p>Scan a download code. Android asks once to allow installs from the browser.</p></div></div>
          <div className="connection-code-list">{android.downloads.map(link => <ConnectionCode key={link.url} url={link.url} qr={link.qr} label="Download Captain" />)}</div>
          <div className="connection-step"><span>2</span><div><h4>Pair with this restaurant</h4><p>Open the app, tap <strong>Scan pairing code</strong> and scan a code below. Sign in with a waiter PIN.</p></div></div>
          <div className="connection-code-list">{android.pairings.map(pairing => <ConnectionCode key={pairing.origin} url={pairing.origin} qr={pairing.qr} label={pairing.secure ? "Secure pairing" : "Unencrypted pairing"} pairing />)}</div>
          <p className="connection-footnote">{android.pairings.length > 0 && android.pairings.every(pairing => pairing.secure) ? "The app checks the restaurant certificate itself. Nothing else needs to be installed." : "Unencrypted connections need the local Captain HTTPS setup on the POS PC. Pair tablets again after setup."} The app updates itself from this POS after each MasalaPOS update.</p>
        </> : <div className="system-empty"><h4>Android app not included in this build</h4><p>Your tablets can still use Captain in the browser.</p><button onClick={() => setDevice("browser")}>Set up Captain in browser<Icon name="arrow" size={16} /></button></div>}
      </>}
      {device === "browser" && <>
        <div className="system-section-heading"><Icon name="cloud" size={22} /><div><h3>Captain in browser</h3><p>Use a waiter PIN for tables, orders and KOTs.</p></div></div>
        {captain?.enabled ? <>
          <div className="connection-step"><span>1</span><div><h4>Trust the restaurant certificate</h4><p>Install this certificate on each tablet once, before opening a secure Captain link.</p><a href="/captain/restaurant-ca.cer" download>Download restaurant certificate</a></div></div>
          <div className="connection-step"><span>2</span><div><h4>Open Captain and sign in</h4><p>Scan a code, sign in with a staff PIN, then choose Install Captain from the account menu.</p></div></div>
          <div className="connection-code-list">{captain.connections.map(connection => <ConnectionCode key={connection.url} {...connection} label="Secure Captain address" />)}</div>
          <details className="connection-certificate"><summary>Certificate details</summary><p>Fingerprint<code>{captain.fingerprint}</code></p><p>Server certificate expires {captain.expiresAt ? new Date(captain.expiresAt).toLocaleDateString() : "—"}.</p></details>
        </> : <p className="system-empty">{captain?.error ?? "Captain works in the browser. Run the local Captain HTTPS setup on the POS PC to enable tablet installation."}</p>}
        <p className="connection-footnote">On Android, install in Chrome. On iPad, use Safari → Share → Add to Home Screen.</p>
      </>}
      {device === "kitchen" && kitchenDisplay && <>
        <div className="system-section-heading"><Icon name="kitchen" size={22} /><div><h3>Kitchen displays</h3><p>Keep your kitchen in sync with live tickets and completion updates.</p></div></div>
        <ol className="connection-instructions"><li>Create a staff member with the <strong>Kitchen</strong> role in Users.</li><li>Install MasalaPOS Kitchen on a kitchen PC and enter a POS address, or open a Kitchen link on a tablet.</li><li>Sign in with the kitchen staff PIN.</li></ol>
        {!connections.length && <p className="system-empty">No LAN address found. Connect this PC to the restaurant network, then reopen Settings.</p>}
        <ul className="connection-link-list">{connections.map(connection => <li key={connection.url}><span>Kitchen address</span><a href={`${connection.url}/kitchen/`} target="_blank" rel="noreferrer">{connection.url}/kitchen/</a></li>)}</ul>
        {captain?.enabled && <><h4>Secure links for tablet installation</h4><ul className="connection-link-list">{captain.connections.map(connection => {
          const kitchenUrl = new URL("/kitchen/", connection.url).href;
          return <li key={kitchenUrl}><a href={kitchenUrl} target="_blank" rel="noreferrer">{kitchenUrl}</a></li>;
        })}</ul><p><a href="/captain/restaurant-ca.cer" download>Download restaurant certificate</a> and trust it on each tablet once.</p></>}
        <p className="connection-footnote">In Chrome choose Install Kitchen; on iPad use Add to Home Screen. Tablet installation needs the restaurant certificate and Captain HTTPS setup on the main PC.</p>
      </>}
      </section></>}
    </div>}
  </section>;
}

function ConnectionCode({ url, qr, label, pairing = false }: { url: string; qr: string; label: string; pairing?: boolean }) {
  return <div className="connection-code"><img src={qr} width={180} height={180} alt={`${label}: ${url}`} /><div><span className="connection-address-label">{label}</span>{pairing ? <code>{url}</code> : <a href={url} target="_blank" rel="noreferrer">{url}</a>}<p>Scan this code with the device you want to connect.</p></div></div>;
}
