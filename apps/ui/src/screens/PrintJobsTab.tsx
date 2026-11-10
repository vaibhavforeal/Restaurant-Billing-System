import { useCallback, useEffect, useState } from "react";
import { apiFetch, session } from "../api";
import { InfoTip } from "../InfoTip";
import { useCan } from "../permissions";
import type { PrintJobInfo } from "../types";
import { useAction } from "../use-action";
import { connectWs } from "../ws";

/** Settings → Devices → Print jobs: what was sent to the printers, live, with a retry for a copy that failed. */
export function PrintJobsTab() {
  const manage = useCan()("printers.manage");
  const [jobs, setJobs] = useState<PrintJobInfo[] | null>(null);
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const { busy, error, setError, run } = useAction();

  const load = useCallback(async (quiet = false) => {
    try { setJobs((await apiFetch<{ jobs: PrintJobInfo[] }>("/api/print-jobs")).jobs); }
    catch { if (!quiet) setError("Could not load the print jobs"); }
  }, [setError]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => connectWs({
    onEvent: (event, data) => {
      if (event !== "print.job") return;
      const { job } = data as { job: PrintJobInfo };
      setJobs((previous) => {
        if (!previous) return previous;
        return previous.some((j) => j.id === job.id) ? previous.map((j) => j.id === job.id ? job : j) : [job, ...previous];
      });
    },
    // Jobs may have changed while the connection was down.
    onStatus: (connected) => { if (connected) void load(true); },
    onAuthFail: () => session.clear(),
  }), [load]);

  const act = (jobId: string, action: "retry" | "confirm-printed") => void run(async () => {
    await apiFetch(`/api/print-jobs/${jobId}/${action}`, { method: "POST", body: JSON.stringify({ checkedPaper: checked[jobId] === true }) });
    setChecked((previous) => ({ ...previous, [jobId]: false }));
    await load();
  }, "Retry failed");

  return <div className="panel devices-panel" role="region" aria-label="Print jobs">
    <p className="muted devices-note">Jobs survive a restart. <InfoTip>Submitted means the printer connection accepted the data; check the paper before retrying an uncertain copy.</InfoTip></p>
    {error && <p role="alert" className="devices-error">{error}</p>}
    {jobs === null && !error && <p role="status">Loading print jobs…</p>}
    {jobs?.length === 0 && <p className="muted">No print jobs yet.</p>}
    <div className="print-job-list">{jobs?.map((job) => <div key={job.id} className="print-job-card">
      <div className="print-job-detail">
        <strong>{job.label}</strong>
        <span>{job.printerName} · Copy {job.copyNumber} of {job.copyCount}</span>
        <span>
          {job.status === "done" && `✓ ${job.error ?? "Submitted"}`}
          {job.status === "queued" && "⏳ Queued"}
          {job.status === "printing" && "⏳ Printing"}
          {job.status === "failed" && <span className="devices-error">✗ Failed: {job.error}</span>}
          {job.status === "unknown" && <span className="devices-error">Check paper: {job.error}</span>}
        </span>
      </div>
      {manage && (job.status === "failed" || job.status === "unknown") && <div className="print-job-actions">
        {job.status === "unknown" && <label><input type="checkbox" checked={checked[job.id] === true}
          onChange={(event) => setChecked((previous) => ({ ...previous, [job.id]: event.target.checked }))} /> I checked the paper</label>}
        <button onClick={() => act(job.id, "retry")} disabled={busy || (job.status === "unknown" && !checked[job.id])}>Retry this copy</button>
        {job.status === "unknown" && <button disabled={busy || !checked[job.id]} onClick={() => act(job.id, "confirm-printed")}>Mark as already printed</button>}
      </div>}
    </div>)}</div>
  </div>;
}
