import { useEffect, useId, useRef, useState } from "react";
import type { RestorePreview } from "@forkflow/domain";
import { apiFetch, authHeaders, session } from "../api";
import { CloudBackupSettings } from "./CloudBackupSettings";
import { backupKindLabels as kindLabels, formatBytes, formatWhen } from "../backup-format";
import "../backups.css";

interface BackupStatus {
  retentionDays: number; secondLocation: string; folder: string;
  lastError: string | null; secondError: string | null;
  backups: Array<{ name: string; kind: string; createdAt: number; bytes: number }>;
  /** Why restore is unavailable here (e.g. not the main PC), or null. */
  restoreBlockedReason: string | null;
}


async function failure(res: Response, fallback: string): Promise<Error> {
  if (res.status === 401) session.clear();
  const body = await res.json().catch(() => null) as { error?: string } | null;
  return new Error(body?.error ?? fallback);
}
/** Save a file response with the server's file name (Electron asks where to save it). */
async function saveResponse(res: Response, fallback: string) {
  if (!res.ok) throw await failure(res, "Download failed");
  const name = /filename="([^"]+)"/.exec(res.headers.get("content-disposition") ?? "")?.[1] ?? fallback;
  const url = URL.createObjectURL(await res.blob());
  const link = document.createElement("a"); link.href = url; link.download = name; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function BackupSettings() {
  const [status, setStatus] = useState<BackupStatus | null>(null);
  const [days, setDays] = useState(30);
  const [second, setSecond] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [preview, setPreview] = useState<RestorePreview | null>(null);
  const [restoring, setRestoring] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const reviewRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let active = true;
    apiFetch<BackupStatus>("/api/system/backups")
      .then((s) => { if (active) { setStatus(s); setDays(s.retentionDays); setSecond(s.secondLocation); } })
      .catch((e: unknown) => { if (active) setError(e instanceof Error ? e.message : "Could not load backup settings"); });
    return () => { active = false; };
  }, []);
  useEffect(() => { if (preview) reviewRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" }); }, [preview]);

  async function run(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true); setError(""); setMessage("");
    try { await action(); } catch (e) { setError(e instanceof Error ? e.message : "Request failed"); } finally { setBusy(false); }
  }
  /** Check a backup on the server and show what it contains. Nothing is restored yet. */
  function stage(action: () => Promise<RestorePreview>, checking: string) {
    return run(async () => { setPreview(null); setMessage(checking); setPreview(await action()); setMessage(""); });
  }
  function cancelPreview() {
    setPreview(null);
    void apiFetch("/api/system/restore/cancel", { method: "POST" }).catch(() => {});
  }
  const canRestore = !!status && !status.restoreBlockedReason;
  const latest = status?.backups[0];

  return <section aria-label="Backups and recovery" className="backup-settings">
    <h2>Backups & recovery</h2>
    {(error || status?.lastError || status?.secondError) && <p role="alert" className="backup-error">{error || status?.lastError || status?.secondError}</p>}
    <p role="status" className="backup-message">{message}</p>
    {status && <>
      <div className="backup-summary">
        <div>
          <strong>{latest ? `Last backup ${formatWhen(latest.createdAt)}` : "No backups yet"}</strong>
          <p>ForkFlow backs up all restaurant data on this PC every day. The latest 10 manual and 10 before-update copies are kept as well.</p>
        </div>
        <div className="backup-actions">
          <button disabled={busy} onClick={() => void run(async () => {
            setStatus(await apiFetch<BackupStatus>("/api/system/backups", { method: "POST" }));
            setMessage("Backup saved on this PC.");
          })}>Back up now</button>
          <button className="primary" disabled={busy} onClick={() => void run(async () => {
            setMessage("Preparing backup file…");
            await saveResponse(await fetch("/api/system/backups/export", { method: "POST", headers: authHeaders(), signal: AbortSignal.timeout(10 * 60_000) }), "ForkFlow backup.db");
            setStatus(await apiFetch<BackupStatus>("/api/system/backups"));
            setMessage("Backup file downloaded. Keep it somewhere safe, away from this PC, such as a USB drive.");
          })}>Download backup file</button>
        </div>
      </div>
      <p className="backup-hint">The backup file is one complete copy of this restaurant: menu and photos, orders, bills, customers, stock, staff and settings. It contains staff and customer details, so store it securely.</p>

      <h3>Restore</h3>
      {canRestore ? <>
        <p>Restore a backup file from a USB drive or download, or pick one of the backups below. You will see what it contains before anything changes.</p>
        <input ref={fileInput} type="file" accept=".db" hidden onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) void stage(async () => {
            const res = await fetch("/api/system/restore/file", { method: "POST", body: file, signal: AbortSignal.timeout(10 * 60_000),
              headers: { ...authHeaders(), "content-type": "application/octet-stream", "x-file-name": encodeURIComponent(file.name) } });
            if (!res.ok) throw await failure(res, "Could not read the backup file");
            return await res.json() as RestorePreview;
          }, `Checking ${file.name}…`);
        }} />
        <button disabled={busy || restoring} onClick={() => fileInput.current?.click()}>Restore from a backup file…</button>
      </> : <p className="backup-hint">{status.restoreBlockedReason}</p>}

      {preview && <div ref={reviewRef}><RestoreReview preview={preview} busy={busy || restoring} onCancel={cancelPreview} onConfirm={() => void run(async () => {
        await apiFetch("/api/system/restore/confirm", { method: "POST", body: JSON.stringify({ token: preview.token }) });
        setRestoring(true); setPreview(null);
        setMessage("Restoring… ForkFlow will restart. Sign in again once it is back.");
      })} /></div>}

      <details className="backup-list">
        <summary>Backups on this PC ({status.backups.length})</summary>
        {status.backups.length ? <ul>{status.backups.map((b) => <li key={b.name}>
          <span><strong>{formatWhen(b.createdAt)}</strong><small>{kindLabels[b.kind] ?? b.kind} · {formatBytes(b.bytes)}</small></span>
          <span className="backup-row-actions">
            <button disabled={busy} onClick={() => void run(async () => {
              await saveResponse(await fetch(`/api/system/backups/${encodeURIComponent(b.name)}`, { headers: authHeaders(), signal: AbortSignal.timeout(10 * 60_000) }), b.name);
            })}>Download</button>
            {canRestore && <button disabled={busy || restoring} onClick={() => void stage(() => apiFetch<RestorePreview>("/api/system/restore/local", { method: "POST", body: JSON.stringify({ name: b.name }) }), "Checking backup…")}>Restore…</button>}
          </span>
        </li>)}</ul> : <p>No backups yet.</p>}
      </details>

      <CloudBackupSettings restoreBlockedReason={status.restoreBlockedReason} restoreBusy={busy || restoring}
        onRestore={(id) => void stage(() => apiFetch<RestorePreview>("/api/system/cloud-backups/restore", { method: "POST", body: JSON.stringify({ id }), signal: AbortSignal.timeout(30 * 60_000) }), "Downloading backup from Google Drive…")} />

      <fieldset disabled={busy} className="backup-storage"><legend>Backup storage on this PC</legend>
        <p>Saved in <code>{status.folder}</code></p>
        <label>Keep daily backups (days) <input type="number" min={7} max={365} value={days} onChange={(e) => setDays(Number(e.target.value))} /></label>
        <label>Also copy each backup to another folder (optional) <input placeholder="E:\ForkFlow Backups" value={second} onChange={(e) => setSecond(e.target.value)} /></label>
        <small>Use a USB drive or a synced folder on the main PC. A missing drive never stops the backup on this PC.</small>
        <div><button onClick={() => void run(async () => {
          setStatus(await apiFetch<BackupStatus>("/api/system/backups", { method: "PUT", body: JSON.stringify({ retentionDays: days, secondLocation: second }) }));
          setMessage("Backup settings saved. Use Back up now to check the second folder.");
        })}>Save backup settings</button></div>
      </fieldset>
    </>}
  </section>;
}

function RestoreReview({ preview, busy, onCancel, onConfirm }: { preview: RestorePreview; busy: boolean; onCancel: () => void; onConfirm: () => void }) {
  const [confirmed, setConfirmed] = useState(false);
  const titleId = useId();
  const lastActivity = preview.lastBillAt ?? preview.lastOrderAt;
  return <div className="restore-review" role="region" aria-labelledby={titleId}>
    <h3 id={titleId}>Restore {preview.restaurantName || "this backup"}?</h3>
    <dl>
      <div><dt>Backup</dt><dd>{preview.takenAt ? formatWhen(preview.takenAt) : preview.label}</dd></div>
      <div><dt>Bills</dt><dd>{preview.bills.toLocaleString()}{preview.lastBillAt ? ` · last ${formatWhen(preview.lastBillAt)}` : ""}</dd></div>
      <div><dt>Orders</dt><dd>{preview.orders.toLocaleString()}</dd></div>
      <div><dt>Size</dt><dd>{formatBytes(preview.bytes)}</dd></div>
    </dl>
    <p className="restore-warning">This replaces all current data with this backup. {lastActivity ? `Anything recorded after ${formatWhen(lastActivity)} will no longer appear. ` : ""}ForkFlow keeps the current data in its recovery folder. Every counter must stop work, and everyone signs in again afterwards.</p>
    <label className="restore-confirm"><input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />All counters have stopped work. Replace the current data with this backup.</label>
    <div className="backup-actions">
      <button disabled={busy} onClick={onCancel}>Cancel</button>
      <button className="primary" disabled={busy || !confirmed} onClick={onConfirm}>Restore and restart</button>
    </div>
  </div>;
}
