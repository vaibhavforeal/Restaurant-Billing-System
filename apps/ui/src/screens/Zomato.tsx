import { useCallback, useEffect, useRef, useState } from "react";
import { ZOMATO_CSV_COLUMNS, zomatoCsv, type ZomatoSettings, type ZomatoOrder, type ZomatoReconciliation,
  type ZomatoReconciliationRow, type ZomatoImportKind, type ZomatoImportPreview } from "@forkflow/domain/zomato";
import { apiFetch, type User } from "../api";
import { connectWs } from "../ws";
import { downloadText } from "../download";
import { recentPeriod, reportMoney } from "../sales-report";
import "../zomato.css";

const stateLabel: Record<ZomatoReconciliationRow["state"], string> = {
  matched: "Matched", mismatch: "Mismatch", missing_order: "Missing order", awaiting_statement: "Awaiting statement", review_cancellation: "Review cancellation",
};
const money = reportMoney;
const dateTime = (value: number | null) => value === null ? "—" : new Date(value).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" });
const errorMessage = (error: unknown) => error instanceof Error ? error.message : "Unable to complete this request";
type ImportHistory = { id: string; kind: string; added: number; skipped: number; actor: string; createdAt: number };

export function Zomato({ user }: { user: User }) {
  const [tab, setTab] = useState<"live" | "reconciliation" | "connection">("reconciliation");
  const [period, setPeriod] = useState(() => recentPeriod(7));
  const [settings, setSettings] = useState<ZomatoSettings | null>(null);
  const [orders, setOrders] = useState<ZomatoOrder[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [report, setReport] = useState<ZomatoReconciliation | null>(null);
  const [history, setHistory] = useState<ImportHistory[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(true);
  const [updated, setUpdated] = useState<number | null>(null);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const request = useRef<AbortController | null>(null);
  const refresh = useCallback(async () => {
    request.current?.abort();
    const controller = new AbortController(); request.current = controller;
    setBusy(true);
    try {
      const options = { signal: controller.signal };
      const [connection, live, reconciliation, imports] = await Promise.all([
        apiFetch<ZomatoSettings>("/api/zomato/settings", options),
        apiFetch<{ orders: ZomatoOrder[]; truncated: boolean }>("/api/zomato/orders", options),
        apiFetch<ZomatoReconciliation>(`/api/zomato/reconciliation?from=${encodeURIComponent(period.from)}&to=${encodeURIComponent(period.to)}`, options),
        apiFetch<{ imports: ImportHistory[] }>("/api/zomato/imports", options),
      ]);
      if (controller.signal.aborted) return;
      setSettings(connection); setOrders(live.orders); setTruncated(live.truncated); setReport(reconciliation); setHistory(imports.imports);
      setUpdated(Date.now()); setError("");
    } catch (e) { if (!controller.signal.aborted) setError(errorMessage(e)); }
    finally { if (!controller.signal.aborted) setBusy(false); }
  }, [period.from, period.to]);
  useEffect(() => {
    void refresh();
    return () => request.current?.abort();
  }, [refresh]);
  useEffect(() => {
    const disconnect = connectWs({ onEvent: event => { if (event === "zomato.changed") void refresh(); }, onStatus: connected => { if (connected) void refresh(); } });
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") void refresh(); }, 15000);
    return () => { disconnect(); clearInterval(timer); };
  }, [refresh]);
  const currentReport = report?.from === period.from && report?.to === period.to ? report : null;
  const visible = currentReport?.rows.filter(row => (filter === "all" || (filter === "review" ? row.state !== "matched" : row.state === filter)) &&
    `${row.orderId} ${row.references.join(" ")}`.toLowerCase().includes(search.toLowerCase())) ?? [];
  function exportReport() {
    if (!currentReport || busy || error) return;
    const header = ["restaurant_id", "period_from", "period_to", "timezone", "order_id", "ordered_at", "order_status", "reconciliation", "order_total", "statement_gross", "deductions", "additions", "statement_net", "net_paid", "gross_difference", "payout_difference", "settlement_references"];
    const amount = (value: number | null) => value === null ? null : value / 100;
    const rows = visible.map(row => [currentReport.restaurantId, currentReport.from, currentReport.to, currentReport.timezone, row.orderId,
      row.placedAt ? new Date(row.placedAt).toISOString() : "", row.orderStatus ?? "", stateLabel[row.state], amount(row.orderTotalPaise),
      amount(row.statementGrossPaise), amount(row.deductionsPaise), amount(row.additionsPaise), amount(row.expectedNetPaise), amount(row.paidPaise),
      amount(row.orderDifferencePaise), amount(row.payoutDifferencePaise), row.references.join(" | ")]);
    downloadText(zomatoCsv([header, ...rows]), `zomato-reconciliation-${period.from}-${period.to}.csv`, "text/csv;charset=utf-8");
  }
  return <section className="screen zomato-screen">
    <div className="page-header"><div><h2>Zomato</h2><p>Online orders and settlement reconciliation</p></div><button onClick={() => void refresh()} disabled={busy}>Refresh</button></div>
    <div className="zomato-status"><strong>{settings?.adapterConfigured && settings.enabled ? "Live receiver enabled" : "Live activation pending"}</strong>
      <span>{settings?.restaurantId ? `${settings.restaurantName || "Restaurant"} · ${settings.restaurantId}` : "Add your restaurant ID in Connection to get started."}</span></div>
    <div className="zomato-tabs" role="tablist" aria-label="Zomato workspace">
      {([['live', 'Live orders'], ['reconciliation', 'Reconciliation'], ['connection', 'Connection']] as const).map(([value, label]) =>
        <button key={value} id={`zomato-tab-${value}`} role="tab" aria-selected={tab === value} aria-controls="zomato-panel" onClick={() => setTab(value)}>{label}{value === "live" && orders.length > 0 ? ` (${orders.length})` : ""}</button>)}
    </div>
    {error && <p role="alert">{error}. Displayed data may be out of date. Use Refresh to try again.</p>}
    {!settings && busy && <p role="status">Loading Zomato workspace…</p>}
    <div id="zomato-panel" role="tabpanel" aria-labelledby={`zomato-tab-${tab}`}>
      {tab === "live" && <>
        {!settings?.adapterConfigured && <div className="panel zomato-notice"><h3>Ready for the next integration step</h3><p>Live receiving and order actions need approved Zomato POS access and a registered webhook service. They are not active in this build.</p><button onClick={() => setTab("connection")}>View connection setup</button></div>}
        <p className="muted">Open orders refresh automatically every 15 seconds and when a verified event arrives. Last refreshed: {dateTime(updated)}.</p>
        {truncated && <p role="alert">Showing the oldest 500 open orders. Use reconciliation to review the ledger by date.</p>}
        {orders.length === 0 ? <div className="panel zomato-empty"><h3>No open Zomato orders</h3><p>{settings?.adapterConfigured && settings.enabled ? "Verified incoming orders will appear here." : "Historical orders and settlements can be imported in Reconciliation."}</p></div> :
          <div className="zomato-order-grid">{orders.map(order => <article key={order.orderId} className="panel zomato-order">
            <div className="zomato-order-heading"><h3>#{order.orderId}</h3><span className="zomato-pill">{order.status.replaceAll("_", " ")}</span></div>
            <p className="muted">{dateTime(order.placedAt)} · {order.source === "webhook" ? "Verified webhook" : "Imported record"}</p>
            {order.items.length ? <ul>{order.items.map((item, i) => <li key={i}><strong>{item.quantity} × {item.name}</strong>{item.note && <small>{item.note}</small>}</li>)}</ul> : <p>Item details are not included in this record.</p>}
            <div className="zomato-order-heading"><strong>{money(order.totalPaise)}</strong><span>{order.paymentMode === "cod" ? "Cash on delivery" : order.paymentMode === "prepaid" ? "Prepaid" : "Payment mode unavailable"}</span></div>
            <small>Manage this order in the Zomato partner app until order actions are activated.</small>
          </article>)}</div>}
      </>}
      {tab === "reconciliation" && <>
        <div className="zomato-toolbar"><label>From<input type="date" value={period.from} onChange={e => setPeriod(p => ({ ...p, from: e.target.value }))} /></label>
          <label>To<input type="date" value={period.to} onChange={e => setPeriod(p => ({ ...p, to: e.target.value }))} /></label>
          <button onClick={exportReport} disabled={!currentReport || busy || !!error || !visible.length}>Export CSV</button></div>
        <p className="muted">Orders placed or settled in this period, with all imported settlement entries for each order. Dates use {currentReport?.timezone ?? "the restaurant server timezone"}.</p>
        {currentReport && <>
          <div className="zomato-metrics">
            <div><span>Order value</span><strong>{money(currentReport.totals.orderTotalPaise)}</strong></div>
            <div><span>Statement net</span><strong>{money(currentReport.totals.expectedNetPaise)}</strong></div>
            <div><span>Reported paid</span><strong>{money(currentReport.totals.paidPaise)}</strong></div>
            <div><span>Needs review</span><strong>{currentReport.totals.needsReview}<small> / {currentReport.rows.length} orders</small></strong></div>
          </div>
          <div className="zomato-toolbar"><label>Search order or reference<input type="search" value={search} onChange={e => setSearch(e.target.value)} placeholder="Order ID or settlement reference" /></label>
            <label>Show<select value={filter} onChange={e => setFilter(e.target.value)}><option value="all">All orders</option><option value="review">Needs review</option>{Object.entries(stateLabel).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label></div>
          <p className="muted">{visible.length} of {currentReport.rows.length} orders. Statement net = gross − deductions + additions. Reported paid comes from your import; bank receipt is not verified.</p>
          {!visible.length ? <div className="panel zomato-empty"><h3>{currentReport.rows.length ? "No matching orders" : "No orders or statements in this period"}</h3><p>{currentReport.rows.length ? "Change the search or status filter." : "Import your order history and settlement entries below, then choose their dates."}</p></div> :
            <div className="zomato-table-wrap" tabIndex={0} aria-label="Reconciliation table, scroll horizontally for all amounts"><table className="zomato-table"><thead><tr>
              <th>Order / date</th><th>Result</th><th>Order value</th><th>Statement gross</th><th>Deductions</th><th>Additions</th><th>Statement net</th><th>Reported paid</th><th>Gross difference</th><th>Payout difference</th>
            </tr></thead><tbody>{visible.map(row => <tr key={row.orderId}>
              <td><strong>#{row.orderId}</strong><small>{dateTime(row.placedAt)}</small><small>{row.orderStatus?.replaceAll("_", " ") ?? "Order not imported"}</small><small>{row.references.join(" · ") || "No settlement reference"}</small></td>
              <td><span className={`zomato-pill ${row.state === "matched" ? "is-matched" : "is-review"}`}>{stateLabel[row.state]}</span></td>
              <td>{row.orderTotalPaise === null ? "—" : money(row.orderTotalPaise)}</td>
              <td>{row.entries ? money(row.statementGrossPaise) : "—"}</td><td>{row.entries ? money(row.deductionsPaise) : "—"}</td><td>{row.entries ? money(row.additionsPaise) : "—"}</td>
              <td>{row.entries ? money(row.expectedNetPaise) : "—"}</td><td>{row.entries ? money(row.paidPaise) : "—"}</td>
              <td className={row.orderDifferencePaise ? "danger-text" : ""}>{row.orderDifferencePaise === null ? "—" : money(row.orderDifferencePaise)}</td>
              <td className={row.payoutDifferencePaise ? "danger-text" : ""}>{row.entries ? money(row.payoutDifferencePaise) : "—"}</td>
            </tr>)}</tbody></table></div>}
        </>}
        {settings && <ZomatoImport restaurantId={settings.restaurantId} onImported={refresh} />}
        {history.length > 0 && <details className="panel zomato-history"><summary>Recent imports</summary><ul>{history.slice(0, 10).map(item => <li key={item.id}><strong>{item.kind}</strong> · {item.added} added, {item.skipped} skipped · {item.actor} · {dateTime(item.createdAt)}</li>)}</ul></details>}
      </>}
      {tab === "connection" && settings && <ZomatoConnection settings={settings} canEdit={user.role === "admin"} onSaved={refresh} />}
    </div>
  </section>;
}

function ZomatoConnection({ settings, canEdit, onSaved }: { settings: ZomatoSettings; canEdit: boolean; onSaved: () => Promise<void> }) {
  const [form, setForm] = useState(settings);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const lock = useRef(false);
  useEffect(() => { if (!dirty) setForm(settings); }, [settings, dirty]);
  function update(key: "restaurantId" | "restaurantName" | "posId" | "webhookBaseUrl", value: string) { setForm(old => ({ ...old, [key]: value })); setDirty(true); setMessage(""); }
  async function save() {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError(""); setMessage("");
    try {
      const saved = await apiFetch<ZomatoSettings>("/api/zomato/settings", { method: "PATCH", body: JSON.stringify(form) });
      setForm(saved); setDirty(false); setMessage(saved.enabled ? "Connection saved. Verified live receiving is enabled." : "Connection details saved. Live activation still requires the approved integration."); await onSaved();
    } catch (e) { setError(errorMessage(e)); }
    finally { lock.current = false; setBusy(false); }
  }
  return <div className="zomato-connection"><form className="panel" onSubmit={e => { e.preventDefault(); void save(); }}>
    <h3>Restaurant connection</h3><p className="muted">Use the restaurant ID from your Zomato account. This ledger supports one restaurant.</p>
    {!canEdit && <p>Only an administrator can change the connection.</p>}
    <fieldset disabled={!canEdit || busy} className="zomato-fields"><label>Zomato restaurant ID<input required maxLength={160} value={form.restaurantId} onChange={e => update("restaurantId", e.target.value)} /></label>
      <label>Restaurant name<input maxLength={160} value={form.restaurantName} onChange={e => update("restaurantName", e.target.value)} /></label>
      <label>POS vendor ID <small>(when assigned by Zomato)</small><input maxLength={160} value={form.posId} onChange={e => update("posId", e.target.value)} /></label>
      <label>Public webhook service origin <small>(when available)</small><input type="url" placeholder="https://orders.your-domain.com" maxLength={500} value={form.webhookBaseUrl} onChange={e => update("webhookBaseUrl", e.target.value)} /></label>
      {settings.adapterConfigured && <label className="zomato-check"><input type="checkbox" checked={form.enabled} onChange={e => { setForm(old => ({ ...old, enabled: e.target.checked })); setDirty(true); }} /> Enable verified live receiving</label>}
    </fieldset>
    {dirty && form.version !== settings.version && <p role="alert">Another counter changed these settings. <button type="button" onClick={() => { setForm(settings); setDirty(false); }}>Reload saved values</button></p>}
    {error && <p role="alert">{error}</p>}{message && <p role="status">{message}</p>}
    {canEdit && <button type="submit" className="primary" disabled={busy || !dirty || form.version !== settings.version}>{busy ? "Saving…" : "Save connection"}</button>}
  </form><aside className="panel"><h3>Activate live orders later</h3><ol>
    <li>Apply for Zomato POS vendor onboarding and obtain approved organization access.</li>
    <li>Obtain the POS ID, API keys and authenticated webhook configuration from your Zomato contact.</li>
    <li>Connect an always-available HTTPS service to this local restaurant, including durable delivery while the PC is offline.</li>
    <li>Implement and certify the official payloads, authentication and order actions before switching on live orders.</li>
  </ol><p>Saving an address does not deploy a webhook service or register it with Zomato. Keep managing live orders in the Zomato partner app.</p>
    <p><a href="https://www.zomato.com/developer/integration/docs/overview" target="_blank" rel="noreferrer">Official integration guide</a></p>
    <p><a href="https://www.zomato.com/developer/integration/docs/getting-started/development-for-integration/pre-integration" target="_blank" rel="noreferrer">Zomato onboarding requirements</a></p>
    <small>Last verified incoming event: {dateTime(settings.lastEventAt)}</small>
  </aside></div>;
}

function ZomatoImport({ restaurantId, onImported }: { restaurantId: string; onImported: () => Promise<void> }) {
  const [kind, setKind] = useState<ZomatoImportKind>("orders");
  const [csv, setCsv] = useState("");
  const [preview, setPreview] = useState<ZomatoImportPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const lock = useRef(false);
  const file = useRef<HTMLInputElement>(null);
  const fileRevision = useRef(0);
  useEffect(() => () => { fileRevision.current++; }, []);
  function replaceCsv(value: string) { fileRevision.current++; setCsv(value); setPreview(null); setError(""); setMessage(""); }
  async function readFile(value: File | undefined) {
    if (!value) return;
    const revision = ++fileRevision.current; setPreview(null); setError(""); setMessage(""); setCsv("");
    if (value.size > 2_000_000) { setError("Choose a CSV file smaller than 2 MB."); return; }
    try { const text = await value.text(); if (fileRevision.current === revision) setCsv(text); }
    catch { if (fileRevision.current === revision) setError("Could not read the file. Try selecting it again."); }
  }
  async function run(commit: boolean) {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError(""); setMessage("");
    try {
      const result = await apiFetch<ZomatoImportPreview>(`/api/zomato/import/${commit ? "commit" : "preview"}`, {
        method: "POST", body: JSON.stringify({ kind, csv, ...(commit ? { revision: preview?.revision } : {}) }),
      });
      if (commit) { setPreview(null); setMessage(`Import complete: ${result.added} added, ${result.skipped} duplicates skipped.`); await onImported(); }
      else setPreview(result);
    } catch (e) { setError(errorMessage(e)); if (!commit) setPreview(null); }
    finally { lock.current = false; setBusy(false); }
  }
  return <section className="panel zomato-import" aria-label="Import Zomato records"><h3>Import orders and settlements</h3>
    <p className="muted">Map your Zomato exports to the ForkFlow template. Amounts are INR with two decimals. These templates are not Zomato's export format.</p>
    {!restaurantId && <p>Save a restaurant ID in Connection before importing.</p>}
    <fieldset disabled={busy || !restaurantId} className="zomato-fields">
      <div className="zomato-toolbar"><label>Import type<select value={kind} onChange={e => { setKind(e.target.value as ZomatoImportKind); replaceCsv(""); if (file.current) file.current.value = ""; }}><option value="orders">Order history</option><option value="settlements">Settlement entries</option></select></label>
        <button type="button" onClick={() => downloadText(zomatoCsv([ZOMATO_CSV_COLUMNS[kind]]), `zomato-${kind}-template.csv`, "text/csv;charset=utf-8")}>Download template</button>
        <label>CSV file<input ref={file} type="file" accept=".csv,text/csv" onChange={e => void readFile(e.target.files?.[0])} /></label></div>
      <p className="muted">{kind === "orders" ? "Use ordered_at with a timezone, such as 2026-10-02T12:30:00+05:30. Keep order IDs as text to preserve leading zeros." : "Use a unique entry_id for each statement line. For later adjustments, use a new entry ID and include only the incremental amounts. Negative net_paid is supported for recoveries."}</p>
      <details><summary>Paste CSV instead</summary><label>CSV content<textarea rows={6} value={csv} onChange={e => replaceCsv(e.target.value)} spellCheck={false} /></label></details>
      <button type="button" onClick={() => void run(false)} disabled={!csv.trim()}>Preview import</button>
    </fieldset>
    {error && <p role="alert">{error}</p>}{message && <p role="status">{message}</p>}
    {preview && <div className="zomato-preview"><h4>{preview.added} to add · {preview.skipped} duplicates to skip</h4>
      <div className="zomato-table-wrap"><table><thead><tr><th>Order ID</th><th>Reference</th><th>{kind === "orders" ? "Order value" : "Reported paid"}</th><th>Action</th></tr></thead><tbody>{preview.rows.slice(0, 8).map((row, i) => <tr key={i}><td>{row.orderId}</td><td>{row.reference || "—"}</td><td>{money(row.amountPaise)}</td><td>{row.action}</td></tr>)}</tbody></table></div>
      {preview.rows.length > 8 && <p>Showing 8 of {preview.rows.length} rows.</p>}
      <button className="primary" disabled={busy || !preview.added} onClick={() => void run(true)}>{busy ? "Importing…" : `Import ${preview.added} records`}</button>
    </div>}
  </section>;
}
