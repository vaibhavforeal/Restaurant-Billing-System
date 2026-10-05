import { useEffect, useId, useRef, useState } from "react";
import type { CloudBackupStatus } from "@forkflow/domain";
import { apiFetch } from "../api";
import "../cloud-backups.css";

const stateLabels = { not_configured: "Not configured", not_connected: "Not connected", connected: "Connected", reconnect_required: "Reconnect required" };

export function CloudBackupSettings() {
  const [status, setStatus] = useState<CloudBackupStatus | null>(null);
  const [automatic, setAutomatic] = useState(true);
  const [folderName, setFolderName] = useState("ForkFlow Backups");
  const [retentionDays, setRetentionDays] = useState(30);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const lock = useRef(false);
  const revision = useRef(0);
  const titleId = useId();
  const stateId = useId();

  useEffect(() => {
    const controller = new AbortController();
    const current = ++revision.current;
    apiFetch<CloudBackupStatus>("/api/system/cloud-backups", { signal: controller.signal }).then((value) => {
      if (revision.current !== current) return;
      setStatus(value); setAutomatic(value.automatic); setFolderName(value.folderName); setRetentionDays(value.retentionDays);
    }).catch((error: unknown) => {
      if (!controller.signal.aborted && revision.current === current) setError(error instanceof Error ? error.message : "Could not load cloud backup settings");
    });
    return () => { revision.current++; controller.abort(); };
  }, []);

  useEffect(() => {
    if (status?.state !== "connected") return;
    const controller = new AbortController();
    const timer = setInterval(() => {
      if (lock.current) return;
      const current = ++revision.current;
      void apiFetch<CloudBackupStatus>("/api/system/cloud-backups", { signal: controller.signal }).then((value) => {
        if (revision.current === current) setStatus(value);
      }).catch(() => { /* Manual refresh reports errors; preserve the last confirmed status. */ });
    }, 10_000);
    return () => { clearInterval(timer); controller.abort(); };
  }, [status?.state]);

  async function run(action: () => Promise<CloudBackupStatus>, success: string) {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError(""); setMessage("");
    const current = ++revision.current;
    try {
      const value = await action();
      if (revision.current === current) { setStatus(value); setMessage(success); }
    } catch (error) {
      if (revision.current === current) setError(error instanceof Error ? error.message : "Cloud backup request failed");
    } finally { lock.current = false; setBusy(false); }
  }
  const connected = status?.state === "connected";
  return <section className="cloud-backups" aria-labelledby={titleId}>
    <div className="cloud-backup-heading"><h3 id={titleId}>Google Drive backup</h3><span className="cloud-backup-state" role="status">{status ? stateLabels[status.state] : "Loading…"}</span></div>
    {error && <p role="alert" className="cloud-backup-error">{error}</p>}
    {message && <p role="status">{message}</p>}
    {status && <>
      <p id={stateId}>{status.state === "not_configured" ? "Google Drive backup is not available yet. Save your preferences now for when account linking is enabled." :
        status.state === "reconnect_required" ? "Reconnect your Google account on the main POS PC to resume cloud backups." :
        status.state === "not_connected" ? "Connect a Google account on the main POS PC to store cloud backups." : `Backups upload to ${status.account?.email ?? "your connected Google account"}.`}</p>
      <p>Verified local backups continue independently. Cloud uploads require internet and the main POS PC to be running.</p>
      {status.lastError && <p role="alert" className="cloud-backup-error">{status.lastError}</p>}
      <fieldset disabled={busy}><legend>Cloud backup preferences</legend>
        <label className="cloud-backup-toggle"><input type="checkbox" checked={automatic} onChange={(event) => setAutomatic(event.target.checked)} />Automatically upload verified backups when connected</label>
        <div className="cloud-backup-fields">
          <label>Drive folder name<input maxLength={100} value={folderName} onChange={(event) => setFolderName(event.target.value)} /></label>
          <label>Keep daily cloud backups (days)<input type="number" min={7} max={365} value={retentionDays} onChange={(event) => setRetentionDays(Number(event.target.value))} /></label>
        </div>
        <button disabled={!folderName.trim() || !Number.isInteger(retentionDays) || retentionDays < 7 || retentionDays > 365} onClick={() => void run(() => apiFetch<CloudBackupStatus>("/api/system/cloud-backups", {
          method: "PUT", body: JSON.stringify({ automatic, folderName: folderName.trim(), retentionDays }),
        }), "Cloud backup preferences saved.")}>Save cloud preferences</button>
      </fieldset>
      <dl className="cloud-backup-facts"><div><dt>Last cloud backup</dt><dd>{status.lastUploadedAt ? new Date(status.lastUploadedAt).toLocaleString() : "No uploads yet"}</dd></div><div><dt>Waiting to upload</dt><dd>{status.pendingCount}{status.uploading ? " · Uploading…" : ""}</dd></div></dl>
      <div className="cloud-backup-actions">
        {!connected && <button disabled aria-describedby={stateId}>Connect Google Drive</button>}
        <button disabled={busy || !connected || status.uploading} onClick={() => void run(() => apiFetch<CloudBackupStatus>("/api/system/cloud-backups/upload", { method: "POST" }), "Verified backup queued for upload. Check the cloud backup status for confirmation.")}>Back up to Drive now</button>
        <button disabled={busy || !connected || !status.pendingCount || status.uploading} onClick={() => void run(() => apiFetch<CloudBackupStatus>("/api/system/cloud-backups/retry", { method: "POST" }), "Pending uploads will be retried.")}>Retry uploads</button>
        <button disabled={busy} onClick={() => void run(() => apiFetch<CloudBackupStatus>("/api/system/cloud-backups"), "Cloud backup status refreshed.")}>Refresh cloud status</button>
        {status.account && <button disabled={busy} onClick={() => {
          if (window.confirm("Disconnect Google Drive? Automatic cloud backups will stop. Existing local and cloud backups will remain.")) {
            void run(() => apiFetch<CloudBackupStatus>("/api/system/cloud-backups/disconnect", { method: "POST" }), "Google Drive disconnected.");
          }
        }}>Disconnect Google Drive</button>}
      </div>
    </>}
  </section>;
}
