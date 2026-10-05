import { useEffect, useRef, useState } from "react";
import { createPortal, flushSync } from "react-dom";
import type { GuestRequest, QrTable } from "@forkflow/domain";
import { apiFetch, session } from "../api";
import type { Order, TableInfo } from "../types";
import { connectWs } from "../ws";
import { useLicense } from "./LicenseSettings";
import { WorkspaceDialog } from "../WorkspaceDialog";
import { QrNotificationControls } from "../QrNotifications";
import "../qr-staff.css";
import "../tables-requests.css";

type RequestStatus = GuestRequest["status"];
const money = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR" });
const amount = (paise: number) => money.format(paise / 100);
const when = (value: number) => new Date(value).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
const statuses: RequestStatus[] = ["pending", "accepted", "rejected", "expired"];
const requestLimit = 500;
const isLoopbackOrigin = (value: string) => /^https?:\/\/(localhost(?=[:/]|$)|127\.|\[::1\])/.test(value);

interface InboxProps {
  tables: TableInfo[];
  disabled: boolean;
  onOpenOrder: (orderId: string) => void;
  onChanged: () => void;
  onBusyChange: (busy: boolean) => void;
  compact?: boolean;
  openSignal?: number | undefined;
}

export function QrRequests({ tables, disabled, onOpenOrder, onChanged, onBusyChange, compact = false, openSignal }: InboxProps) {
  const { status: license } = useLicense();
  const canAccept = license?.canOperate === true && license.features.qrOrdering;
  const [expanded, setExpanded] = useState(false);
  const [filter, setFilter] = useState<RequestStatus>("pending");
  const [pending, setPending] = useState<GuestRequest[]>([]);
  const [history, setHistory] = useState<{ status: RequestStatus; requests: GuestRequest[] } | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const lock = useRef(false);
  const readController = useRef<AbortController | null>(null);

  useEffect(() => { if (openSignal && !lock.current) { setFilter("pending"); setExpanded(true); } }, [openSignal]);

  useEffect(() => {
    if (lock.current) return;
    const controller = new AbortController();
    readController.current = controller;
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(12_000)]);
    setLoading(true);
    const pendingFetch = apiFetch<{ requests: GuestRequest[] }>("/api/qr/requests?status=pending", { signal });
    const historyFetch = filter !== "pending" && expanded
      ? apiFetch<{ requests: GuestRequest[] }>(`/api/qr/requests?status=${filter}`, { signal })
      : Promise.resolve(null);
    void Promise.all([pendingFetch, historyFetch]).then(([nextPending, nextHistory]) => {
      if (controller.signal.aborted) return;
      setPending(nextPending.requests);
      setLoaded(true);
      if (nextHistory) setHistory({ status: filter, requests: nextHistory.requests });
      setError("");
    }).catch((e: unknown) => {
      if (!controller.signal.aborted) setError(e instanceof Error ? e.message : "Could not refresh QR requests");
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [filter, expanded, refresh]);

  useEffect(() => {
    const reload = () => setRefresh((value) => value + 1);
    const timer = setInterval(reload, 15_000);
    const dispose = connectWs({
      onEvent: (event) => { if (event === "guest-request.changed") reload(); },
      onStatus: (up) => { setConnected(up); if (up) reload(); },
      onAuthFail: () => session.clear(),
    });
    return () => { clearInterval(timer); dispose(); };
  }, []);

  function closeInbox() {
    if (!lock.current && !disabled) setExpanded(false);
  }
  function openOrder(orderId: string) {
    if (lock.current || disabled) return;
    // Close the portaled native dialog before the parent switches screens.
    if (compact) flushSync(() => setExpanded(false));
    onOpenOrder(orderId);
  }

  async function review(request: GuestRequest, action: { orderId: string | null } | { reason: string }) {
    if (lock.current || disabled) return;
    lock.current = true;
    readController.current?.abort();
    setLoading(false); setBusyId(request.id); onBusyChange(true); setMessage("");
    try {
      if ("orderId" in action) {
        const result = await apiFetch<{ request: GuestRequest; order: Order }>(`/api/qr/requests/${request.id}/accept`, { method: "POST", body: JSON.stringify(action) });
        lock.current = false; setBusyId(null); onBusyChange(false);
        onChanged();
        openOrder(result.order.id);
      } else {
        await apiFetch<{ request: GuestRequest }>(`/api/qr/requests/${request.id}/reject`, { method: "POST", body: JSON.stringify(action) });
        setMessage(`Request from ${request.tableName} rejected.`);
        onChanged();
      }
      setRefresh((value) => value + 1);
    } finally {
      lock.current = false; setBusyId(null); onBusyChange(false);
    }
  }

  const requests = filter === "pending" ? pending : history?.status === filter ? history.requests : [];
  const feedback = <>
    <QrNotificationControls />
    {error && <p role="alert">{error} <button disabled={busyId !== null || loading} onClick={() => setRefresh((value) => value + 1)}>Retry refresh</button></p>}
    {message && <p role="status">{message}</p>}
    {!connected && <p className="qr-refresh-note" role="status">Checking for requests every 15 seconds while the live connection reconnects.</p>}
  </>;
  const inbox = <div id="qr-request-list" hidden={!expanded && !compact}>
      <div className="qr-inbox-toolbar"><div className="tabs" aria-label="QR request status">{statuses.map((value) => <button key={value} aria-pressed={filter === value} className={filter === value ? "selected" : ""} disabled={busyId !== null} onClick={() => setFilter(value)}>{value[0]!.toUpperCase() + value.slice(1)}</button>)}</div>
        <button disabled={loading || busyId !== null} onClick={() => setRefresh((value) => value + 1)}>{loading ? "Refreshing…" : "Refresh requests"}</button></div>
      {!canAccept && license && <p className="qr-plan-note">Pro is required to accept guest requests. You can still review or reject earlier requests.</p>}
      {filter === "pending" && <p className="qr-help">Accepting adds pending items to the selected bill group. Open the order and use <strong>Send to kitchen</strong> when ready.</p>}
      <div className="qr-request-grid">{requests.map((request) => <RequestCard key={request.id} request={request} table={tables.find((table) => table.id === request.tableId)} canAccept={canAccept} busy={busyId !== null || disabled} saving={busyId === request.id} onReview={review} onOpenOrder={openOrder} />)}</div>
      {requests.length === 0 && <p role="status" className="qr-empty">{loading ? "Loading requests…" : `No ${filter} QR requests.`}</p>}
      {requests.length === requestLimit && <p className="qr-help">Showing the latest {requestLimit} {filter} requests.</p>}
    </div>;
  const count = <span className="qr-pending-count" role="status" aria-label={compact && !loaded ? "Loading pending requests" : `${pending.length}${pending.length === requestLimit ? " or more" : ""} pending requests`}>{compact && !loaded ? "…" : `${pending.length}${pending.length === requestLimit ? "+" : ""}`}</span>;
  if (compact) return <section className="tables-request-summary" aria-label="Guest QR requests">
    <div className="tables-request-summary-heading"><h3>QR requests {count}</h3>{error && <span className="tables-request-attention" role="status" title={error}>Needs attention</span>}</div>
    <button aria-expanded={expanded} aria-controls="qr-request-list" aria-haspopup="dialog" disabled={busyId !== null || disabled} onClick={() => setExpanded(true)}>Review requests</button>
    <WorkspaceDialog open={expanded} title="QR requests" onClose={closeInbox} busy={busyId !== null || disabled} className="tables-requests-dialog qr-requests-dialog">{feedback}{inbox}</WorkspaceDialog>
  </section>;
  return <section className="qr-inbox panel" aria-label="Guest QR requests">
    <div className="qr-inbox-heading">
      <div><h3>QR requests {count}</h3><p>Review guests’ choices before adding them to a bill.</p></div>
      <button aria-expanded={expanded} aria-controls="qr-request-list" disabled={busyId !== null} onClick={() => setExpanded((value) => !value)}>{expanded ? "Hide requests" : "Review requests"}</button>
    </div>
    {feedback}{inbox}
  </section>;
}

function RequestCard({ request, table, canAccept, busy, saving, onReview, onOpenOrder }: {
  request: GuestRequest; table: TableInfo | undefined; canAccept: boolean; busy: boolean; saving: boolean;
  onReview: (request: GuestRequest, action: { orderId: string | null } | { reason: string }) => Promise<void>;
  onOpenOrder: (orderId: string) => void;
}) {
  const [target, setTarget] = useState("");
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const openGroups = table?.activeOrders.filter((order) => order.status === "open") ?? [];
  const targetValid = target === "new" || openGroups.some((order) => order.id === target);
  async function submit(action: { orderId: string | null } | { reason: string }) {
    setError("");
    try { await onReview(request, action); }
    catch (e) { setError(e instanceof Error ? e.message : "Could not review this request. Refresh to check its status before trying again."); }
  }
  return <article className="qr-request-card" aria-label={`QR request from ${request.tableName}`}>
    <div className="qr-request-title"><div><h4>{request.tableName}</h4><time dateTime={new Date(request.createdAt).toISOString()}>{when(request.createdAt)}</time></div><span className={`qr-request-status ${request.status}`}>{request.status}</span></div>
    <ul className="qr-request-items">{request.items.map((item, index) => <li key={`${item.productId}:${item.variantId ?? "base"}:${index}`}><div><span><strong>{item.qty} ×</strong> {item.name}</span><span>{amount(item.pricePaise * item.qty)}</span></div>{item.note && <p className="qr-item-note">Note: {item.note}</p>}</li>)}</ul>
    <div className="qr-request-subtotal"><span>Menu subtotal {request.taxInclusive ? "(GST included)" : "(before GST)"}</span><strong>{amount(request.subtotalPaise)}</strong></div>
    {request.reason && <p className="qr-review-note">{request.reason}</p>}
    {request.reviewedAt && <p className="qr-help">Reviewed {when(request.reviewedAt)}{request.reviewedByName ? ` by ${request.reviewedByName}` : ""}.</p>}
    {request.status === "accepted" && request.orderId && <button disabled={busy} onClick={() => onOpenOrder(request.orderId!)}>Open accepted order</button>}
    {request.status === "pending" && <>
      <p className="qr-help">Expires {when(request.expiresAt)}.</p>
      {error && <p role="alert">{error}</p>}
      {!rejecting ? <form onSubmit={(event) => { event.preventDefault(); if (targetValid && canAccept && !busy) void submit({ orderId: target === "new" ? null : target }); }}>
        <label>Bill group for {request.tableName}<select required value={target} disabled={busy || !canAccept} onChange={(event) => { setTarget(event.target.value); setError(""); }}>
          <option value="">Choose a bill group</option><option value="new">New bill group</option>
          {target && !targetValid && <option value={target} disabled>Selected bill group is no longer open</option>}
          {openGroups.map((order) => <option key={order.id} value={order.id}>Existing group {order.splitLabel ?? "?"}</option>)}
        </select></label>
        {target && !targetValid && <p role="status">Review the available bill groups before accepting.</p>}
        <div className="qr-card-actions"><button className="primary" disabled={busy || !canAccept || !targetValid}>{saving ? "Saving…" : "Accept & open order"}</button><button type="button" disabled={busy} onClick={() => setRejecting(true)}>Reject…</button></div>
      </form> : <form onSubmit={(event) => { event.preventDefault(); if (reason.trim() && !busy) void submit({ reason: reason.trim() }); }}>
        <label>Reason shown to the guest<textarea required maxLength={200} rows={3} value={reason} disabled={busy} onChange={(event) => setReason(event.target.value)} /></label>
        <div className="qr-card-actions"><button disabled={busy || !reason.trim()}>{saving ? "Rejecting…" : "Reject request"}</button><button type="button" disabled={busy} onClick={() => setRejecting(false)}>Keep pending</button></div>
      </form>}
    </>}
  </article>;
}

export function QrTableManager({ disabled, onBusyChange }: { disabled: boolean; onBusyChange: (busy: boolean) => void }) {
  const [tables, setTables] = useState<QrTable[]>([]);
  const [origins, setOrigins] = useState<string[]>([]);
  const [origin, setOrigin] = useState("");
  const [tableId, setTableId] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [savedCode, setCode] = useState<{ url: string; qr: string; tableId: string; path: string; origin: string } | null>(null);
  const [codeLoading, setCodeLoading] = useState(false);
  const [error, setError] = useState("");
  const [codeError, setCodeError] = useState("");
  const [message, setMessage] = useState("");
  const lock = useRef(false);
  const linkInput = useRef<HTMLInputElement>(null);
  const codeController = useRef<AbortController | null>(null);
  const table = tables.find((value) => value.id === tableId);
  const code = !busy && table?.enabled && table.isActive && savedCode?.tableId === table.id && savedCode.path === table.path && savedCode.origin === origin ? savedCode : null;

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    void apiFetch<{ tables: QrTable[]; origins: string[] }>("/api/qr/tables", { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]) }).then((result) => {
      if (controller.signal.aborted) return;
      setTables(result.tables); setOrigins(result.origins); setError("");
      setOrigin((current) => result.origins.includes(current) ? current : result.origins.find((value) => !isLoopbackOrigin(value)) ?? result.origins[0] ?? "");
      setTableId((current) => result.tables.some((value) => value.id === current) ? current : result.tables.find((value) => value.isActive)?.id ?? "");
    }).catch((e: unknown) => { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : "Could not load table QR codes"); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [refresh]);

  useEffect(() => {
    setCode(null); setCodeError(""); setCodeLoading(false);
    if (!table?.enabled || !table.isActive || !table.path || !origin) return;
    const controller = new AbortController();
    codeController.current = controller;
    const requestedTableId = table.id;
    const requestedPath = table.path;
    setCodeLoading(true);
    void apiFetch<{ url: string; qr: string }>(`/api/qr/tables/${table.id}/image?origin=${encodeURIComponent(origin)}`, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]) }).then((result) => {
      if (!controller.signal.aborted) setCode({ ...result, tableId: requestedTableId, path: requestedPath, origin });
    }).catch((e: unknown) => { if (!controller.signal.aborted) setCodeError(e instanceof Error ? e.message : "Could not generate this QR code"); })
      .finally(() => { if (!controller.signal.aborted) setCodeLoading(false); });
    return () => controller.abort();
  }, [table?.id, table?.enabled, table?.isActive, table?.path, origin, refresh]);

  async function update(enabled: boolean, rotate = false) {
    if (!table || lock.current || disabled) return;
    if (rotate && !window.confirm(`Replace the QR code for ${table.name}? Previous links and printed codes will stop working. Place the new code on the table after replacing it.`)) return;
    lock.current = true; setBusy(true); onBusyChange(true); setError(""); setMessage("");
    codeController.current?.abort(); setCode(null); setCodeLoading(false);
    try {
      const result = await apiFetch<{ table: QrTable }>(`/api/qr/tables/${table.id}`, { method: "PUT", body: JSON.stringify({ enabled, ...(rotate ? { rotate: true } : {}) }) });
      setTables((current) => current.map((value) => value.id === result.table.id ? result.table : value));
      setMessage(rotate ? "QR code replaced. Print and place the new code on the table." : enabled ? "Table QR code enabled." : "Table QR code disabled. Guests can no longer use its menu link.");
    } catch (e) { setError(`${e instanceof Error ? e.message : "Could not update this QR code"} Refresh codes to check the saved state before trying again.`); }
    finally { lock.current = false; setBusy(false); onBusyChange(false); }
  }

  async function copyLink() {
    if (!code) return;
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(code.url);
      else { linkInput.current?.select(); if (!document.execCommand("copy")) throw new Error("Clipboard unavailable"); }
      setMessage("Guest menu link copied.");
    } catch { linkInput.current?.focus(); linkInput.current?.select(); setMessage("Select and copy the guest menu link shown below."); }
  }

  function printCode() {
    if (!code) return;
    document.body.classList.add("printing-table-qr");
    try { window.print(); }
    finally { document.body.classList.remove("printing-table-qr"); }
  }

  return <section className="qr-manager panel" aria-label="Manage table QR codes">
    <div className="qr-inbox-heading"><div><h3>Table QR codes</h3><p>Guests scan at their table using the restaurant’s Wi-Fi.</p></div><button disabled={busy || loading} onClick={() => setRefresh((value) => value + 1)}>{loading ? "Loading…" : "Refresh codes"}</button></div>
    <p className="qr-help">Basic includes menu browsing; Pro also allows order requests for staff review. Guest phones do not use registered staff-device slots.</p>
    {error && <p role="alert">{error}</p>}{message && <p role="status">{message}</p>}
    <div className="qr-manager-fields"><label>Table<select value={tableId} disabled={busy || loading} onChange={(event) => { setTableId(event.target.value); setMessage(""); }}><option value="">Choose a table</option>{tables.map((value) => <option value={value.id} key={value.id}>{value.name}{value.area ? ` · ${value.area}` : ""}{value.isActive ? "" : " (inactive)"}</option>)}</select></label>
      <label>Restaurant network address<select value={origin} disabled={busy || loading || origins.length === 0} onChange={(event) => { setOrigin(event.target.value); setMessage(""); }}><option value="">Choose an address</option>{origins.map((value) => <option key={value} value={value}>{value}</option>)}</select></label></div>
    {origins.length === 0 && !loading && <p role="status">No restaurant network address is available. Connect the main PC to the restaurant network, then refresh codes.</p>}
    {isLoopbackOrigin(origin) && <p className="qr-plan-note" role="status">This address works only on the main PC. Choose a restaurant network address for guest phones before printing.</p>}
    {table && <>
      <p className="qr-code-state"><strong>{table.name}</strong> · {table.enabled ? "QR enabled" : "QR disabled"}{!table.isActive ? " · inactive table" : ""}</p>
      {!table.isActive && <p>Activate this table in Manage tables before enabling its QR code.</p>}
      <div className="qr-card-actions"><button disabled={busy || disabled || loading || (!table.isActive && !table.enabled)} onClick={() => void update(!table.enabled)}>{busy ? "Saving…" : table.enabled ? "Disable QR code" : "Enable QR code"}</button>
        {table.enabled && table.path && <button disabled={busy || disabled || loading || !table.isActive} onClick={() => void update(true, true)}>Replace QR code</button>}</div>
      {codeError && <p role="alert">{codeError}</p>}
      {codeLoading && <p role="status">Preparing QR code…</p>}
      {code && <div className="qr-code-preview"><img src={code.qr} alt={`Guest menu QR code for ${table.name}`} width={240} height={240} /><div><h4>{table.name} guest menu</h4><p>Test the link on a phone connected to the restaurant’s Wi-Fi before printing.</p>
        <label>Guest menu link<input ref={linkInput} readOnly value={code.url} onFocus={(event) => event.target.select()} /></label>
        <div className="qr-card-actions"><a href={code.url} target="_blank" rel="noreferrer">Open menu</a><button disabled={busy} onClick={() => void copyLink()}>Copy link</button><button disabled={busy} onClick={printCode}>Print QR code</button></div>
      </div></div>}
      {code && createPortal(<div className="qr-print-sheet" aria-hidden="true"><p>ForkFlow · Guest menu</p><h1>{table.name}</h1>{table.area && <p>{table.area}</p>}<img src={code.qr} alt="" width={280} height={280} /><h2>Scan for the menu</h2><p>Connect to the restaurant’s Wi-Fi, then scan this code.</p><p>Ask a member of staff if you need help.</p></div>, document.body)}
    </>}
    {!loading && tables.length === 0 && <p>Add a table in Manage tables to create its guest menu QR code.</p>}
  </section>;
}
