import { useCallback, useEffect, useRef, useState } from "react";
import { ZOMATO_CSV_COLUMNS, zomatoCsv, type ZomatoSettings, type ZomatoReconciliation,
  type ZomatoReconciliationRow, type ZomatoImportKind, type ZomatoImportPreview } from "@forkflow/domain/zomato";
import { apiFetch } from "../api";
import { connectWs } from "../ws";
import { downloadText } from "../download";
import { recentPeriod, reportMoney } from "../sales-report";
import { dateTime, errorMessage } from "../zomato-format";
import "../zomato.css";

const stateLabel: Record<ZomatoReconciliationRow["state"], string> = {
  matched: "Matched", mismatch: "Mismatch", missing_order: "Missing order", awaiting_statement: "Awaiting statement", review_cancellation: "Review cancellation",
};
const money = reportMoney;
type ImportHistory = { id: string; kind: string; added: number; skipped: number; actor: string; createdAt: number };

/** Zomato settlement reconciliation, shown as a tab of Reports. Covers POS Zomato orders and imported records. */
export function ZomatoReconciliationPanel() {
  const [period, setPeriod] = useState(() => recentPeriod(7));
  const [settings, setSettings] = useState<ZomatoSettings | null>(null);
  const [report, setReport] = useState<ZomatoReconciliation | null>(null);
  const [history, setHistory] = useState<ImportHistory[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(true);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const request = useRef<AbortController | null>(null);
  const refresh = useCallback(async () => {
    request.current?.abort();
    const controller = new AbortController(); request.current = controller;
    setBusy(true);
    try {
      const options = { signal: controller.signal };
      const [connection, reconciliation, imports] = await Promise.all([
        apiFetch<ZomatoSettings>("/api/zomato/settings", options),
        apiFetch<ZomatoReconciliation>(`/api/zomato/reconciliation?from=${encodeURIComponent(period.from)}&to=${encodeURIComponent(period.to)}`, options),
        apiFetch<{ imports: ImportHistory[] }>("/api/zomato/imports", options),
      ]);
      if (controller.signal.aborted) return;
      setSettings(connection); setReport(reconciliation); setHistory(imports.imports);
      setError("");
    } catch (e) { if (!controller.signal.aborted) setError(errorMessage(e)); }
    finally { if (!controller.signal.aborted) setBusy(false); }
  }, [period.from, period.to]);
  useEffect(() => {
    void refresh();
    return () => request.current?.abort();
  }, [refresh]);
  useEffect(() => {
    const disconnect = connectWs({ onEvent: event => { if (event === "zomato.changed" || event === "order.updated") void refresh(); }, onStatus: connected => { if (connected) void refresh(); } });
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
  return <section className="zomato-screen">
    <div className="page-header"><div><h3>Zomato reconciliation</h3><p>Zomato orders and settlement reconciliation</p></div><button onClick={() => void refresh()} disabled={busy}>Refresh</button></div>
    <div className="zomato-status"><strong>{settings?.adapterConfigured && settings.enabled ? "Live receiver enabled" : "Live activation pending"}</strong>
      <span>{settings?.restaurantId ? `${settings.restaurantName || "Restaurant"} · ${settings.restaurantId}` : "Add your restaurant ID in Marketplace, Zomato settings to get started."}</span></div>
    {error && <p role="alert">{error}. Displayed data may be out of date. Use Refresh to try again.</p>}
    {!settings && busy && <p role="status">Loading Zomato workspace…</p>}
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
  </section>;
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
    {!restaurantId && <p>Save a restaurant ID in Marketplace, Zomato settings before importing.</p>}
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
