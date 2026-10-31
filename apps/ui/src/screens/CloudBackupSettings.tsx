import { useEffect, useId, useRef, useState } from "react";
import type { CloudBackupFile, CloudBackupStatus } from "@forkflow/domain";
import { apiFetch } from "../api";
import { Icon } from "../Icon";
import { backupKindLabels as kindLabels, formatBytes, formatWhen } from "../backup-format";
import "../cloud-backups.css";

const stateLabels = { not_configured: "Not available", not_connected: "Not connected", connected: "Connected", reconnect_required: "Reconnect required" };

export function CloudBackupSettings({ restoreBlockedReason, restoreBusy, onRestore }: {
  restoreBlockedReason: string | null; restoreBusy: boolean; onRestore: (id: string) => void;
}) {
  const [status, setStatus] = useState<CloudBackupStatus | null>(null);
  const [automatic, setAutomatic] = useState(true);
  const [folderName, setFolderName] = useState("ForkFlow Backups");
  const [retentionDays, setRetentionDays] = useState(30);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [files, setFiles] = useState<CloudBackupFile[] | null>(null);
  const [waitingForGoogle, setWaitingForGoogle] = useState(false);
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
      if (!controller.signal.aborted && revision.current === current) setError(error instanceof Error ? error.message : "Could not load Google Drive settings");
    });
    return () => { revision.current++; controller.abort(); };
  }, []);

  // Poll quickly while Google sign-in is open in the browser, slowly while uploads may be running.
  const connecting = waitingForGoogle || !!status?.connecting;
  useEffect(() => {
    if (!connecting && status?.state !== "connected") return;
    const controller = new AbortController();
    const timer = setInterval(() => {
      if (lock.current) return;
      const current = ++revision.current;
      void apiFetch<CloudBackupStatus>("/api/system/cloud-backups", { signal: controller.signal }).then((value) => {
        if (revision.current !== current) return;
        setStatus(value);
        if (!value.connecting) setWaitingForGoogle(false);
        if (waitingForGoogle && !value.connecting && value.state === "connected") setMessage(`Connected to ${value.account?.email ?? "Google Drive"}. New backups will upload automatically.`);
      }).catch(() => { /* Manual refresh reports errors; keep the last confirmed status. */ });
    }, connecting ? 2_000 : 10_000);
    return () => { clearInterval(timer); controller.abort(); };
  }, [connecting, status?.state, waitingForGoogle]);

  async function run<T>(action: () => Promise<T>, done: (value: T) => void) {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError(""); setMessage("");
    const current = ++revision.current;
    try {
      const value = await action();
      if (revision.current === current) done(value);
    } catch (error) {
      if (revision.current === current) setError(error instanceof Error ? error.message : "Google Drive request failed");
    } finally { lock.current = false; setBusy(false); }
  }
  const update = (success: string) => (value: CloudBackupStatus) => { setStatus(value); setMessage(success); };
  const connected = status?.state === "connected";
  const canConnect = !!status && status.state !== "not_configured" && status.state !== "connected" && status.onMainPc;

  return <section className="cloud-backups" aria-labelledby={titleId}>
    <div className="cloud-backup-heading"><span className="system-icon"><Icon name="cloud" size={22} /></span><div><h3 id={titleId}>Google Drive backup</h3><span className={`cloud-backup-state ${status?.state ?? ""}`} role="status">{status ? stateLabels[status.state] : "Loading…"}</span></div></div>
    {error && <p role="alert" className="cloud-backup-error">{error}</p>}
    {message && <p role="status">{message}</p>}
    {status && <>
      <p id={stateId}>{status.state === "not_configured" ? "Google Drive backup is not set up in this ForkFlow build. Backups on this PC and backup files work as usual."
        : status.state === "reconnect_required" ? "Google needs you to sign in again before backups can upload. Your backups on this PC are safe."
        : status.state === "not_connected" ? "Keep a copy of every backup in your Google Drive, so you can recover even if this PC is lost or damaged. ForkFlow can only see the backup files it creates."
        : <>Backups upload to <strong>{status.account?.email ?? "your Google account"}</strong> in the folder “{status.folderName}”.</>}</p>
      {status.lastError && <p role="alert" className="cloud-backup-error">{status.lastError}</p>}
      {connecting && <p role="status" className="cloud-backup-waiting">Finish signing in to Google in your browser. This page updates when you are done.</p>}

      <div className="cloud-backup-actions">
        {status.state !== "not_configured" && !connected && <button className="primary" disabled={busy || !canConnect} aria-describedby={stateId} onClick={() => void run(
          () => apiFetch<{ authUrl: string }>("/api/system/cloud-backups/connect", { method: "POST" }),
          ({ authUrl }) => { window.open(authUrl, "_blank", "noopener"); setWaitingForGoogle(true); })}>
          {status.state === "reconnect_required" ? "Reconnect Google Drive" : "Connect Google Drive"}</button>}
        {connected && <>
          <button className="primary" disabled={busy || status.uploading} onClick={() => void run(() => apiFetch<CloudBackupStatus>("/api/system/cloud-backups/upload", { method: "POST" }), update("Backup saved and uploading to Google Drive."))}>Back up to Drive now</button>
          {status.pendingCount > 0 && <button disabled={busy || status.uploading} onClick={() => void run(() => apiFetch<CloudBackupStatus>("/api/system/cloud-backups/retry", { method: "POST" }), update("Waiting uploads will be retried now."))}>Retry uploads</button>}
        </>}
        {status.account && <button disabled={busy} onClick={() => {
          if (window.confirm("Disconnect Google Drive? Automatic Drive backups will stop. Backups already in Drive and on this PC are kept.")) {
            void run(() => apiFetch<CloudBackupStatus>("/api/system/cloud-backups/disconnect", { method: "POST" }), (value) => { setStatus(value); setFiles(null); setMessage("Google Drive disconnected."); });
          }
        }}>Disconnect</button>}
      </div>
      {!status.onMainPc && status.state !== "not_configured" && !connected && <p className="backup-hint">Connect Google Drive from Settings on the main POS PC.</p>}

      {connected && <dl className="cloud-backup-facts">
        <div><dt>Last upload</dt><dd>{status.lastUploadedAt ? formatWhen(status.lastUploadedAt) : "No uploads yet"}</dd></div>
        <div><dt>Waiting to upload</dt><dd>{status.pendingCount}{status.uploading ? " · Uploading…" : ""}</dd></div>
      </dl>}

      {connected && <details className="backup-list" onToggle={(event) => {
        if ((event.target as HTMLDetailsElement).open && !files) void run(() => apiFetch<{ files: CloudBackupFile[] }>("/api/system/cloud-backups/files", { signal: AbortSignal.timeout(60_000) }), (value) => setFiles(value.files));
      }}>
        <summary>Backups in Google Drive{files ? ` (${files.length})` : ""}</summary>
        {!files ? <p>{busy ? "Loading…" : "Open to load the list."}</p> : !files.length ? <p>No backups in Google Drive yet.</p> : <>
          {restoreBlockedReason && <p className="backup-hint">{restoreBlockedReason}</p>}
          <ul>{files.map((file) => <li key={file.id}>
            <span><strong>{formatWhen(file.createdAt)}</strong>
              <small>{file.restaurantName ? `${file.restaurantName} · ` : ""}{kindLabels[file.kind] ?? file.kind} · {formatBytes(file.bytes)}{file.thisPc ? "" : " · from another PC"}</small></span>
            {!restoreBlockedReason && <span className="backup-row-actions"><button disabled={busy || restoreBusy} onClick={() => onRestore(file.id)}>Restore…</button></span>}
          </li>)}</ul>
          <button className="text-button" disabled={busy} onClick={() => void run(() => apiFetch<{ files: CloudBackupFile[] }>("/api/system/cloud-backups/files", { signal: AbortSignal.timeout(60_000) }), (value) => setFiles(value.files))}>Refresh list</button>
        </>}
      </details>}

      {status.state !== "not_configured" && <details className="cloud-backup-prefs">
        <summary>Google Drive settings</summary>
        <fieldset disabled={busy}>
          <label className="cloud-backup-toggle"><input type="checkbox" checked={automatic} onChange={(event) => setAutomatic(event.target.checked)} />Upload every backup automatically</label>
          <div className="cloud-backup-fields">
            <label>Drive folder name<input maxLength={100} value={folderName} onChange={(event) => setFolderName(event.target.value)} /></label>
            <label>Keep daily Drive backups (days)<input type="number" min={7} max={365} value={retentionDays} onChange={(event) => setRetentionDays(Number(event.target.value))} /></label>
          </div>
          <button disabled={!folderName.trim() || !Number.isInteger(retentionDays) || retentionDays < 7 || retentionDays > 365} onClick={() => void run(() => apiFetch<CloudBackupStatus>("/api/system/cloud-backups", {
            method: "PUT", body: JSON.stringify({ automatic, folderName: folderName.trim(), retentionDays }),
          }), update("Google Drive settings saved."))}>Save Drive settings</button>
        </fieldset>
      </details>}
      <p className="backup-hint">Uploads need an internet connection and run while the main POS PC is on. Backups on this PC continue either way.</p>
    </>}
  </section>;
}
