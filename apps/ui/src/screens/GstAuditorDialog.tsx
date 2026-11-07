import { useEffect, useMemo, useRef, useState } from "react";
import type { GstReturnsReport } from "@masalapos/domain/gst-returns";
import { apiFetch } from "../api";
import { withTimeout } from "../abort-signal";
import { downloadText } from "../download";
import { gstAuditorCsv, gstAuditorEmail, gstr1JsonName, type GstAuditorFile } from "../gst-returns";
import { WorkspaceDialog } from "../WorkspaceDialog";
import "../gst-auditor.css";

export function GstAuditorDialog({ report, onClose }: { report: GstReturnsReport; onClose: () => void }) {
  const csv = useMemo(() => gstAuditorCsv(report), [report]);
  const [json, setJson] = useState<GstAuditorFile | null>(null);
  const [loading, setLoading] = useState(report.gstr1Available);
  const [jsonError, setJsonError] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [email, setEmail] = useState("");
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState(false);
  const shareLock = useRef(false);
  useEffect(() => {
    if (!report.gstr1Available) return;
    let active = true;
    const controller = new AbortController();
    setLoading(true); setJsonError("");
    const query = new URLSearchParams({ period: report.from.slice(0, 7), span: report.period.span });
    apiFetch<Record<string, unknown>>(`/api/reports/gst-returns/gstr1.json?${query}`, { signal: withTimeout(controller.signal, 20000) })
      .then(data => {
        if (data.gstin !== report.gstin || data.fp !== report.period.fp) throw new Error("The GST profile changed. Close this dialog and refresh the report.");
        if (active) setJson({ name: gstr1JsonName(report.gstin, report.period.fp), type: "application/json", content: JSON.stringify(data, null, 2) });
      })
      .catch((e: unknown) => { if (active) setJsonError(e instanceof Error ? e.message : "Could not prepare GSTR-1 JSON."); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; controller.abort(); };
  }, [report, revision]);

  const attachments = useMemo(() => json ? [csv, json] : [csv], [csv, json]);
  const files = useMemo(() => attachments.map(file => new File([file.content], file.name, { type: file.type.split(";")[0] ?? file.type })), [attachments]);
  const draft = gstAuditorEmail(report, attachments);
  let canShare = false;
  try { canShare = typeof navigator.share === "function" && !!navigator.canShare?.({ files }); } catch { /* Downloads remain available. */ }

  async function share() {
    if (shareLock.current || loading) return;
    shareLock.current = true; setBusy(true); setError(""); setMessage("");
    try {
      await navigator.share({ files, title: draft.subject });
      setMessage("Reports handed to your selected sharing app. Complete sending there.");
    } catch (e) {
      if (!(e instanceof Error && e.name === "AbortError")) setError("Sharing did not complete. Download the files below and attach them to your email.");
    } finally { shareLock.current = false; setBusy(false); }
  }

  return <WorkspaceDialog open title="Send to auditor" onClose={onClose} busy={busy} className="gst-auditor-dialog">
    <p><strong>{report.period.label}</strong> · {report.from} to {report.to}</p>
    <p>GSTIN: {report.gstin}</p>
    <p>{report.regime === "composition" ? "CMP-08 summary" : "GSTR-1 tables and GSTR-3B outward supplies"}. Amounts are in rupees.</p>
    {report.warnings.length > 0 && <div className="gst-auditor-warnings"><strong>Include in the auditor’s review</strong><ul>{report.warnings.map(w => <li key={w}>{w}</li>)}</ul></div>}
    <ul className="gst-auditor-files">{attachments.map(file => <li key={file.name}><span>{file.name}</span><button disabled={busy} onClick={() => {
      try { downloadText(file.content, file.name, file.type); setError(""); setMessage(`${file.name} downloaded. Attach it when sending your email.`); }
      catch { setError("Could not download the file. Please try again."); }
    }}>Download {file === csv ? "CSV" : "JSON"}</button></li>)}</ul>
    {loading && <p role="status">Preparing GSTR-1 JSON…</p>}
    {jsonError && <div role="alert"><p>GSTR-1 JSON is unavailable: {jsonError} You can still send the CSV.</p><button onClick={() => setRevision(v => v + 1)} disabled={loading || busy}>Retry JSON</button></div>}
    {!report.gstr1Available && report.regime === "regular" && <p>GSTR-1 JSON is unavailable until the restaurant GSTIN is corrected in Settings. The CSV is available for review.</p>}
    {error && <p role="alert">{error}</p>}{message && <p role="status">{message}</p>}
    {canShare ? <button className="primary" disabled={busy || loading} onClick={() => void share()}>{busy ? "Sharing…" : `Share ${attachments.length === 1 ? "CSV" : "reports"}…`}</button>
      : <p>This browser cannot share these files directly. Download them and attach them to an email.</p>}
    <form className="gst-auditor-email" onSubmit={event => {
      event.preventDefault();
      if (busy || loading) return;
      window.location.href = `mailto:${encodeURIComponent(email.trim())}?subject=${encodeURIComponent(draft.subject)}&body=${encodeURIComponent(draft.body)}`;
      setMessage("Email draft requested. Attach the downloaded files and send it from your email app.");
    }}>
      <label>Auditor email<input type="email" required value={email} onChange={event => setEmail(event.target.value)} placeholder="auditor@example.com" disabled={busy} autoComplete="email" /></label>
      <p>The email draft includes the period and file names. Attach the downloaded files before sending.</p>
      <button disabled={busy || loading}>Open email draft</button>
    </form>
  </WorkspaceDialog>;
}
