import { useEffect, useState } from "react";
import { apiFetch, authHeaders, session } from "../api";
import { CloudBackupSettings } from "./CloudBackupSettings";

interface BackupStatus {
  retentionDays: number; secondLocation: string; folder: string;
  lastError: string | null; secondError: string | null;
  backups: Array<{ name: string; kind: string; createdAt: number; bytes: number }>;
}
interface CaptainConnection {
  enabled: boolean; error?: string; fingerprint?: string; expiresAt?: string;
  connections: Array<{ url: string; qr: string }>;
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
  const [status, setStatus] = useState<BackupStatus | null>(null);
  const [days, setDays] = useState(30);
  const [second, setSecond] = useState("");
  const [connections, setConnections] = useState<Array<{ url: string; qr: string }>>([]);
  const [captain, setCaptain] = useState<CaptainConnection | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    Promise.all([apiFetch<BackupStatus>("/api/system/backups"), backupOnly ? Promise.resolve({ connections: [], captain: undefined }) : apiFetch<{ connections: Array<{ url: string; qr: string }>; captain?: CaptainConnection }>("/api/system/connections")])
      .then(([s, c]) => { if (active) { setStatus(s); setDays(s.retentionDays); setSecond(s.secondLocation); setConnections(c.connections); setCaptain(c.captain ?? null); } })
      .catch((e: unknown) => { if (active) setError(e instanceof Error ? e.message : "Could not load backup settings"); });
    return () => { active = false; };
  }, [backupOnly]);
  async function run(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true); setError(""); setMessage("");
    try { await action(); } catch (e) { setError(e instanceof Error ? e.message : "Request failed"); } finally { setBusy(false); }
  }
  return <section aria-label="Backups and connections" className="panel system-settings">
    <h2>Backups & recovery</h2>
    <p role="alert" style={{ color: "var(--danger-text, crimson)" }}>{error || status?.lastError || status?.secondError}</p>
    <p role="status">{message}</p>
    {status && <>
      <p>Verified daily snapshots are saved in <code>{status.folder}</code>. The latest 10 manual and 10 pre-update backups are also kept.</p>
      <fieldset disabled={busy}><legend>Backup storage</legend>
        <p><label>Keep daily backups (days) <input type="number" min={7} max={365} value={days} onChange={(e) => setDays(Number(e.target.value))} /></label></p>
        <p><label>Second backup folder on the server PC <input style={{ width: "min(100%, 460px)" }} placeholder="E:\\ForkFlow Backups (optional)" value={second} onChange={(e) => setSecond(e.target.value)} /></label></p>
        <button onClick={() => void run(async () => {
          setStatus(await apiFetch<BackupStatus>("/api/system/backups", { method: "PUT", body: JSON.stringify({ retentionDays: days, secondLocation: second }) }));
          setMessage("Backup settings saved. Use Back up now to check the second folder.");
        })}>Save backup settings</button>{" "}
        <button className="primary" onClick={() => void run(async () => { setStatus(await apiFetch<BackupStatus>("/api/system/backups", { method: "POST" })); setMessage("Verified local backup saved."); })}>Back up now</button>
      </fieldset>
      <p>To restore: on the main PC, open the ForkFlow tray menu → Restore backup. All counters must stop work. Restore replaces current data with the selected snapshot and archives the previous database.</p>
      <details><summary>Available backups ({status.backups.length})</summary>
        <ul>{status.backups.map((b) => <li key={b.name} style={{ marginBlock: 8 }}>{new Date(b.createdAt).toLocaleString()} · {b.kind} · {Math.ceil(b.bytes / 1024)} KB {" "}
          <button disabled={busy} onClick={() => void run(() => download(`/api/system/backups/${encodeURIComponent(b.name)}`, b.name))}>Download</button>
        </li>)}</ul>
      </details>
      <CloudBackupSettings />
    </>}
    {!backupOnly && <><h2>Connect another device</h2>
    <p>Use the same local network. Scan a QR code on a phone, or open its address on a counter PC. Every device needs a staff PIN.</p>
    {!connections.length && <p>No LAN address found. Connect this PC to Wi-Fi or Ethernet, then reopen Settings.</p>}
    <div style={{ display: "flex", gap: 24, flexWrap: "wrap" }}>{connections.map((connection) => <div key={connection.url} style={{ border: "1px solid #ddd", padding: 16 }}>
      <img src={connection.qr} width={220} height={220} alt={`Connect to ForkFlow at ${connection.url}`} />
      <p><a href={connection.url} target="_blank" rel="noreferrer">{connection.url}</a></p>
      <button disabled={busy} onClick={() => void run(() => download(`/api/system/shortcut?url=${encodeURIComponent(connection.url)}`, "Create-ForkFlow-Shortcut.ps1"))}>Download Edge shortcut setup</button>
    </div>)}</div>
    <p>On a counter PC, right-click the downloaded file → Run with PowerShell to create a desktop shortcut. Reserve the main PC's IP address in your router so the address stays the same.</p>
    <h2>Kitchen displays</h2>
    <p>Install ForkFlow Kitchen on a kitchen PC and enter a POS address above, or open a Kitchen link on a tablet. Create a staff member with the Kitchen role in Users, then sign in with that PIN.</p>
    <ul>{connections.map(connection => <li key={connection.url}><a href={`${connection.url}/kitchen/`} target="_blank" rel="noreferrer">{connection.url}/kitchen/</a></li>)}</ul>
    {captain?.enabled && <><p>For tablet installation, use the trusted HTTPS connection:</p><ul>{captain.connections.map(connection => {
      const kitchenUrl = new URL("/kitchen/", connection.url).href;
      return <li key={kitchenUrl}><a href={kitchenUrl} target="_blank" rel="noreferrer">{kitchenUrl}</a></li>;
    })}</ul></>}
    <p>The main POS must stay running. Tickets, acceptance and completion synchronize over the restaurant network. In Chrome choose Install Kitchen; on iPad use Add to Home Screen. Installation uses the restaurant certificate described below.</p>
    <h2>Captain tablets</h2>
    {captain?.enabled ? <>
      <p>Trust the restaurant certificate on each tablet once, then open a secure Captain link below. Sign in with a staff PIN and choose Install Captain from the account menu.</p>
      <p><a href="/captain/restaurant-ca.cer" download>Download restaurant certificate</a></p>
      <p>Certificate fingerprint: <code style={{ overflowWrap: "anywhere" }}>{captain.fingerprint}</code></p>
      <p>Server certificate expires {captain.expiresAt ? new Date(captain.expiresAt).toLocaleDateString() : "—"}.</p>
      <div className="captain-connection-list">{captain.connections.map((connection) => <div key={connection.url}><img src={connection.qr} width={180} height={180} alt={`Install Captain from ${connection.url}`} /><p><a href={connection.url} target="_blank" rel="noreferrer">{connection.url}</a></p></div>)}</div>
    </> : <p>{captain?.error ?? "Captain works in the browser. Run the local Captain HTTPS setup on the POS PC to enable tablet installation."}</p>}
    <p>Use a waiter PIN for tables, orders and KOTs. Keep tablets on the restaurant Wi-Fi. On Android install in Chrome; on iPad use Safari → Share → Add to Home Screen.</p></>}
  </section>;
}
