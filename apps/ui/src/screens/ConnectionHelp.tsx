import { useEffect, useState } from "react";
import type { DeviceKind, JoinCodeIssued } from "@masalapos/domain/devices";
import { timeoutSignal } from "../abort-signal";
import { apiFetch, authHeaders, session } from "../api";
import { Icon } from "../Icon";
import "../connections.css";

interface Link { url: string; qr: string }
interface CaptainConnection { enabled: boolean; error?: string; fingerprint?: string; expiresAt?: string; connections: Link[] }
interface Connections { connections: Link[]; captain?: CaptainConnection; android?: { downloads: Link[] } }

async function download(path: string, filename: string) {
  const res = await fetch(path, { headers: authHeaders(), signal: timeoutSignal(60_000) });
  if (res.status === 401) session.clear();
  if (!res.ok) throw new Error("Download failed");
  const url = URL.createObjectURL(await res.blob());
  const link = document.createElement("a"); link.href = url; link.download = filename; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function Code({ url, qr, label, plain = false }: Link & { label: string; plain?: boolean }) {
  return <div className="connection-code"><img src={qr} width={180} height={180} alt={`${label}: ${url}`} />
    <div><span className="connection-address-label">{label}</span>{plain ? <code>{url}</code> : <a href={url} target="_blank" rel="noreferrer">{url}</a>}</div></div>;
}

/**
 * How to get a new device of this kind to the join screen, shown under its join code: the addresses to open, and what
 * each kind needs besides (a desktop shortcut, the kitchen app, the Android Captain app or the restaurant certificate).
 */
export function ConnectionHelp({ kind, issued }: { kind: DeviceKind; issued: JoinCodeIssued }) {
  const [info, setInfo] = useState<Connections | null>(null);
  const [apk, setApk] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    apiFetch<Connections>("/api/system/connections")
      .then((c) => { if (active) setInfo(c); })
      .catch((e: unknown) => { if (active) setError(e instanceof Error ? e.message : "Could not load the connection details"); });
    // Present only in builds that include the Android app; the static fallback serves HTML otherwise.
    if (kind === "captain") fetch("/captain/android/version.json", { cache: "no-store" }).then((res) => res.ok ? res.json() : null)
      .then((version: { versionName?: unknown } | null) => { if (active && typeof version?.versionName === "string") setApk(version.versionName); })
      .catch(() => {});
    return () => { active = false; };
  }, [kind]);
  async function shortcut(url: string) {
    if (busy) return;
    setBusy(true); setError("");
    try { await download(`/api/system/shortcut?url=${encodeURIComponent(url)}`, "Create-MasalaPOS-Shortcut.ps1"); }
    catch (e) { setError(e instanceof Error ? e.message : "Download failed"); }
    finally { setBusy(false); }
  }
  const lan = info?.connections ?? [];
  const captain = info?.captain;

  return <section className="connection-help" aria-label="How to connect the device">
    <p className="connection-help-lead">On the new device, open this address or scan the code. Keep it on the same restaurant Wi-Fi or Ethernet as the main POS.</p>
    {issued.links.length === 0 && <p className="connection-help-empty">This PC has no network address yet. Connect it to the restaurant network first.</p>}
    <div className="connection-code-list">{issued.links.map((link) => <Code key={link.url} {...link} label="Join address" />)}</div>
    {error && <p role="alert" className="devices-error">{error}</p>}

    {kind === "counter" && <>
      <h4>Desktop shortcut for a counter PC</h4>
      <p>On the counter PC, right-click the downloaded file and choose <strong>Run with PowerShell</strong> to create a desktop shortcut.</p>
      <div className="connection-help-actions">{lan.map((connection) => <button key={connection.url} type="button" disabled={busy} onClick={() => void shortcut(connection.url)}>
        <Icon name="download" size={16} />Edge shortcut for {connection.url}</button>)}</div>
      <p className="connection-footnote">Reserve the main PC's IP address in your router so the restaurant address stays the same.</p>
    </>}

    {kind === "kitchen" && <>
      <h4>Kitchen display</h4>
      <ol className="connection-instructions"><li>Create a staff member with the <strong>Kitchen</strong> role in Users.</li><li>Install MasalaPOS Kitchen on a kitchen PC and enter a POS address, or open a Kitchen link on a tablet.</li><li>Enter the join code, then sign in with the kitchen staff username and password.</li></ol>
      <ul className="connection-link-list">{lan.map((connection) => <li key={connection.url}><span>Kitchen address</span><a href={`${connection.url}/kitchen/`} target="_blank" rel="noreferrer">{connection.url}/kitchen/</a></li>)}</ul>
      {captain?.enabled && <><h4>Secure links for tablet installation</h4><ul className="connection-link-list">{captain.connections.map((connection) => {
        const kitchenUrl = new URL("/kitchen/", connection.url).href;
        return <li key={kitchenUrl}><a href={kitchenUrl} target="_blank" rel="noreferrer">{kitchenUrl}</a></li>;
      })}</ul><p><a href="/captain/restaurant-ca.cer" download>Download restaurant certificate</a> and trust it on each tablet once.</p></>}
      <p className="connection-footnote">In Chrome choose Install Kitchen; on iPad use Add to Home Screen. Tablet installation needs the restaurant certificate and Captain HTTPS setup on the main PC.</p>
    </>}

    {kind === "captain" && <>
      <h4>Android Captain app</h4>
      {apk && info?.android ? <>
        <div className="connection-step"><span>1</span><div><h4>Install MasalaPOS Captain {apk}</h4><p>Scan a download code. Android asks once to allow installs from the browser.</p></div></div>
        <div className="connection-code-list">{info.android.downloads.map((link) => <Code key={link.url} {...link} label="Download Captain" />)}</div>
        <div className="connection-step"><span>2</span><div><h4>Pair and join</h4><p>Open the app, tap <strong>Scan pairing code</strong> and scan a code below. The tablet connects and joins in one step.</p></div></div>
        <div className="connection-code-list">{issued.pairings.map((pairing) => <Code key={pairing.origin} url={pairing.origin} qr={pairing.qr} label={pairing.secure ? "Secure pairing" : "Unencrypted pairing"} plain />)}</div>
        <p className="connection-footnote">{issued.pairings.length > 0 && issued.pairings.every((pairing) => pairing.secure) ? "The app checks the restaurant certificate itself. Nothing else needs to be installed." : "Unencrypted connections need the local Captain HTTPS setup on the POS PC. Pair tablets again after setup."} The app updates itself from this POS after each MasalaPOS update.</p>
      </> : <p className="connection-help-empty">The Android app is not included in this build. Tablets can still use Captain in the browser.</p>}
      <h4>Captain in the browser</h4>
      {captain?.enabled ? <>
        <p>Install the restaurant certificate on the tablet once, then open the join address above. On Android, install in Chrome; on iPad, use Safari → Share → Add to Home Screen.</p>
        <p><a href="/captain/restaurant-ca.cer" download>Download restaurant certificate</a></p>
        <details className="connection-certificate"><summary>Certificate details</summary><p>Fingerprint<code>{captain.fingerprint}</code></p><p>Server certificate expires {captain.expiresAt ? new Date(captain.expiresAt).toLocaleDateString() : "—"}.</p></details>
      </> : <p className="connection-help-empty">{captain?.error ?? "Captain works in the browser. Run the local Captain HTTPS setup on the POS PC to enable tablet installation."}</p>}
    </>}
  </section>;
}
