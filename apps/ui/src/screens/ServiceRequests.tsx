import { useEffect, useRef, useState } from "react";
import type { ServiceRequest } from "@forkflow/domain";
import { apiFetch, session } from "../api";
import { connectWs } from "../ws";
import { WorkspaceDialog } from "../WorkspaceDialog";
import "../service-requests.css";
import "../tables-requests.css";

const when = (at: number) => new Date(at).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" });

export function ServiceRequests({ disabled, onBusyChange, compact = false }: { disabled: boolean; onBusyChange: (busy: boolean) => void; compact?: boolean }) {
  const [requests, setRequests] = useState<ServiceRequest[]>([]);
  const [pending, setPending] = useState<ServiceRequest[] | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [history, setHistory] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [connected, setConnected] = useState(false);
  const lock = useRef(false);
  const readController = useRef<AbortController | null>(null);

  useEffect(() => {
    if (lock.current) return;
    const controller = new AbortController();
    readController.current = controller;
    setLoading(true);
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]);
    // History is capped independently; it cannot supply an accurate pending badge.
    const pendingFetch = apiFetch<{ requests: ServiceRequest[] }>("/api/qr/service-requests?status=pending", { signal });
    const historyFetch = history ? apiFetch<{ requests: ServiceRequest[] }>("/api/qr/service-requests?status=all", { signal }) : Promise.resolve(null);
    void Promise.all([pendingFetch, historyFetch]).then(([current, recent]) => {
      if (!controller.signal.aborted) { setPending(current.requests); setRequests(recent ? recent.requests : current.requests); setError(""); }
    }).catch((cause: unknown) => {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Could not load table service requests");
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [history, refresh]);

  useEffect(() => {
    const reload = () => setRefresh((value) => value + 1);
    const timer = window.setInterval(reload, 15_000);
    const disconnect = connectWs({
      onEvent: (event) => { if (event === "service-request.changed") reload(); },
      onStatus: (up) => { setConnected(up); if (up) reload(); }, onAuthFail: () => session.clear(),
    });
    return () => { window.clearInterval(timer); disconnect(); };
  }, []);

  async function resolve(request: ServiceRequest) {
    if (lock.current || disabled) return;
    lock.current = true; setBusyId(request.id); onBusyChange(true);
    readController.current?.abort(); setLoading(false); setError(""); setMessage("");
    try {
      const { request: resolved } = await apiFetch<{ request: ServiceRequest }>(`/api/qr/service-requests/${request.id}/resolve`, { method: "POST", body: "{}" });
      setRequests((values) => history ? values.map((value) => value.id === resolved.id ? resolved : value) : values.filter((value) => value.id !== resolved.id));
      setPending((values) => values?.filter((value) => value.id !== resolved.id) ?? null);
      setMessage(`${request.kind === "waiter" ? "Waiter call" : "Bill request"} for ${request.tableName} marked handled.`);
    } catch (cause) {
      setError(`${cause instanceof Error ? cause.message : "Could not mark the request handled"}. Refresh to check its status; retrying this request is safe.`);
    } finally {
      lock.current = false; setBusyId(null); onBusyChange(false); setRefresh((value) => value + 1);
    }
  }

  const actions = <div className="service-inbox-actions"><button disabled={busyId !== null || loading} onClick={() => { setHistory((value) => !value); setRequests([]); }}>{history ? "Show pending only" : "Show recent history"}</button><button disabled={busyId !== null || loading} onClick={() => setRefresh((value) => value + 1)}>{loading ? "Refreshing…" : "Refresh"}</button></div>;
  const inbox = <>
    {error && <p role="alert">{error}</p>}{message && <p role="status">{message}</p>}
    {!connected && <p className="service-inbox-help" role="status">Checking every 15 seconds while the live connection reconnects.</p>}
    {requests.length === 0 && <p className="service-inbox-empty" role="status">{loading ? "Loading service requests…" : history ? "No recent service requests." : "No service requests awaiting attention."}</p>}
    <ul className="service-inbox-list">{requests.map((request) => <li key={request.id} aria-label={`${request.kind === "waiter" ? "Waiter call" : "Bill request"} from ${request.tableName}`}>
      <div className="service-inbox-request"><strong>{request.tableName}</strong><span>{request.kind === "waiter" ? "Waiter requested" : "Bill requested"}</span><small>Requested {when(request.createdAt)}{request.status === "pending" ? ` · Expires ${when(request.expiresAt)}` : ""}</small>
        {request.status === "resolved" && <small>Handled{request.resolvedByName ? ` by ${request.resolvedByName}` : ""}{request.resolvedAt ? ` at ${when(request.resolvedAt)}` : ""}</small>}
      </div>
      <span className={`service-inbox-status service-inbox-${request.status}`}>{request.status === "resolved" ? "Handled" : request.status === "expired" ? "Expired" : "Needs attention"}</span>
      {request.status === "pending" && <button disabled={disabled || busyId !== null} onClick={() => void resolve(request)}>{busyId === request.id ? "Saving…" : "Mark handled"}</button>}
    </li>)}</ul>
    {requests.length === 100 && <p className="service-inbox-help">Showing the latest 100 {history ? "service" : "pending"} requests.</p>}
    <p className="service-inbox-help">Mark handled after helping the guest. A bill request does not create a bill or record a payment.</p>
  </>;
  if (compact) return <section className="tables-request-summary" aria-label="Table service requests">
    <div className="tables-request-summary-heading"><h3>Table service <span className="qr-pending-count" role="status" aria-label={pending === null ? "Loading pending service requests" : `${pending.length}${pending.length === 100 ? " or more" : ""} pending service requests`}>{pending === null ? "…" : `${pending.length}${pending.length === 100 ? "+" : ""}`}</span></h3>{error && <span className="tables-request-attention" role="status" title={error}>Needs attention</span>}</div>
    <button aria-expanded={expanded} aria-haspopup="dialog" disabled={busyId !== null || disabled} onClick={() => setExpanded(true)}>View service requests</button>
    <WorkspaceDialog open={expanded} title="Table service requests" onClose={() => { if (!lock.current && !disabled) setExpanded(false); }} busy={busyId !== null || disabled} className="tables-requests-dialog service-requests-dialog">{actions}{inbox}</WorkspaceDialog>
  </section>;
  return <section className="service-inbox panel" aria-label="Table service requests">
    <div className="service-inbox-heading"><div><h3>Table service requests</h3><p>Waiter calls and requests for the bill from guests.</p></div>{actions}</div>
    {inbox}
  </section>;
}
