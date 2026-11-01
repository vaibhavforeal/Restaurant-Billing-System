import { InfoTip } from "../InfoTip";
import { useEffect, useState } from "react";
import type { UpdateChannel, UpdateStatus } from "@masalapos/domain/updates";
import { ApiError, apiFetch } from "../api";

interface UpdateState { channel: UpdateChannel; status: UpdateStatus; openOrders: number }

const STATE_TEXT: Record<UpdateStatus["state"], string> = {
  unsupported: "Automatic updates are not available here.",
  idle: "Waiting for the first check.",
  checking: "Checking for updates…",
  "up-to-date": "MasalaPOS is up to date.",
  downloading: "Downloading an update in the background.",
  ready: "An update is downloaded and ready to install.",
  error: "The last update check did not finish.",
};

/** Settings → Updates: version, Stable / Patch channel, and installing a downloaded update outside service. */
export function UpdateSettings() {
  const [data, setData] = useState<UpdateState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  const load = async () => setData(await apiFetch<UpdateState>("/api/system/updates"));
  useEffect(() => {
    void load().catch(() => setError("Could not load update status"));
    // Download progress is reported by the desktop app; refresh while this page is open.
    const timer = setInterval(() => { void load().catch(() => undefined); }, 5000);
    return () => clearInterval(timer);
  }, []);

  async function run(action: () => Promise<unknown>, done: string) {
    if (busy) return;
    setBusy(true); setError(""); setMessage("");
    try { await action(); await load(); setMessage(done); }
    catch (e) { setError(e instanceof ApiError ? e.message : "Request failed"); }
    finally { setBusy(false); }
  }

  if (!data) return <section className="panel">{error ? <p role="alert">{error}</p> : <p role="status">Loading…</p>}</section>;
  const { status } = data;
  const unsupported = status.state === "unsupported";
  return <section className="panel" aria-label="Updates">
    <h3>Updates</h3>
    <p>Installed version <strong>{status.currentVersion}</strong>.</p>
    <p role="status">{STATE_TEXT[status.state]}{status.availableVersion ? ` Version ${status.availableVersion}` : ""}{status.state === "downloading" && status.percent !== null ? ` — ${status.percent}%` : ""}</p>
    {status.message && <p className="muted">{status.message}</p>}
    {status.checkedAt && <p className="muted">Last checked {new Date(status.checkedAt).toLocaleString()}.</p>}

    <fieldset disabled={busy || unsupported} style={{ border: 0, padding: 0, minWidth: 0, display: "grid", gap: 8 }}>
      <label style={{ display: "grid", gap: 4, maxWidth: 420 }}>
        <span>Update channel <InfoTip>Patch gets fixes earlier. Switching back to Stable keeps the current version until a newer stable release is out.</InfoTip></span>
        <select value={data.channel} onChange={(e) => void run(() => apiFetch("/api/system/updates", { method: "PUT", body: JSON.stringify({ channel: e.target.value }) }), "Update channel saved.")}>
          <option value="stable">Stable — full releases only (recommended)</option>
          <option value="patch">Patch — also hotfixes as soon as they are released</option>
        </select>
      </label>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button onClick={() => void run(() => apiFetch("/api/system/updates/check", { method: "POST" }), "Checking for updates…")}>Check now</button>
        {status.state === "ready" && <button className="primary" disabled={data.openOrders > 0} onClick={() => void run(async () => {
          if (!window.confirm(`Install version ${status.availableVersion} now? MasalaPOS restarts and every counter disconnects for about a minute. A backup is taken first.`)) return;
          await apiFetch("/api/system/updates/install", { method: "POST" });
        }, "Installing. MasalaPOS will restart in a moment.")}>Restart &amp; update</button>}
      </div>
      {status.state === "ready" && data.openOrders > 0 && <p className="muted">Finish service first: {data.openOrders} order(s) are open or waiting for payment. The update also installs when MasalaPOS is next quit from the tray.</p>}
    </fieldset>
    {error && <p role="alert">{error}</p>}
    {message && <p role="status">{message}</p>}
  </section>;
}
