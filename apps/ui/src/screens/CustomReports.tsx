import { InfoTip } from "../InfoTip";
import { useCallback, useEffect, useRef, useState } from "react";
import { CUSTOM_FILTER_OP_LABELS, CUSTOM_REPORT_SOURCES, customReportSource, filterOpsFor, type CustomReport, type CustomReportSource, type SavedCustomReport } from "@forkflow/domain/custom-reports";
import { apiFetch } from "../api";
import { SalesPeriodControls } from "../SalesReportControls";
import { recentPeriod, type ReportPeriod } from "../sales-report";
import { downloadText } from "../download";
import { operationalCell, operationalCsv } from "../operational-report";
import { draftToConfig, newDraft, newFilter, savedToDraft, withColumn, withGrouping, type CustomDraft } from "../custom-report";

const SOURCES = CUSTOM_REPORT_SOURCES;

export function CustomReports({ canManage, initialPeriod, onPeriodChange }: { canManage: boolean; initialPeriod?: ReportPeriod | undefined; onPeriodChange: (period: ReportPeriod) => void }) {
  const [draft, setDraft] = useState<CustomDraft>(() => newDraft(SOURCES[0]!.id));
  const [saved, setSaved] = useState<SavedCustomReport[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [name, setName] = useState("");
  const [period, setPeriod] = useState(initialPeriod ?? recentPeriod(7));
  const [report, setReport] = useState<CustomReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  // Each run and each edit takes a new number; a response is shown only if nothing has happened since it was asked for.
  const request = useRef(0);
  const source = customReportSource(draft.source) as CustomReportSource;
  const built = draftToConfig(draft);
  const field = (id: string) => source.fields.find((f) => f.id === id)!;

  const loadSaved = useCallback(() => apiFetch<{ reports: SavedCustomReport[] }>("/api/custom-reports").then(({ reports }) => setSaved(reports)).catch((e: unknown) => setError(e instanceof Error ? e.message : "Could not load saved reports")), []);
  useEffect(() => { void loadSaved(); }, [loadSaved]);

  async function run(next: CustomDraft = draft, range: ReportPeriod = period, title = name) {
    const result = draftToConfig(next);
    if ("problem" in result) { setError(result.problem); return; }
    const id = ++request.current;
    setLoading(true); setError(""); setMessage("");
    try {
      const { report } = await apiFetch<{ report: CustomReport }>("/api/custom-reports/run", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ config: result.config, name: title, from: range.from, to: range.to }) });
      if (id === request.current) setReport(report);
    } catch (e) { if (id === request.current) { setReport(null); setError(e instanceof Error ? e.message : "Could not run report"); } }
    finally { if (id === request.current) setLoading(false); }
  }
  const edit = (next: CustomDraft) => { request.current++; setDraft(next); setReport(null); setLoading(false); setMessage(""); };
  function chooseSaved(id: string) {
    setSelectedId(id); setMessage(""); setError("");
    const found = saved.find((r) => r.id === id);
    if (!found) { setName(""); edit(newDraft(draft.source)); return; }
    setName(found.name);
    const opened = savedToDraft(found.config);
    // An outdated saved report stays selected so it can be rebuilt and saved over, or deleted.
    if ("problem" in opened) { edit(newDraft(customReportSource(found.config.source) ? found.config.source : SOURCES[0]!.id)); setError(opened.problem); return; }
    edit(opened.draft); void run(opened.draft, period, found.name);
  }
  async function save(asNew: boolean) {
    if (!("config" in built)) { setError(built.problem); return; }
    const title = name.trim();
    if (!title) { setError("Give the report a name before saving"); return; }
    try {
      const update = !asNew && selectedId;
      const { report: savedReport } = await apiFetch<{ report: SavedCustomReport }>(update ? `/api/custom-reports/${selectedId}` : "/api/custom-reports", { method: update ? "PUT" : "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: title, config: built.config }) });
      await loadSaved(); setSelectedId(savedReport.id); setError(""); setMessage(`Saved “${savedReport.name}”.`);
    } catch (e) { setMessage(""); setError(e instanceof Error ? e.message : "Could not save report"); }
  }
  async function remove() {
    const found = saved.find((r) => r.id === selectedId);
    if (!found || !window.confirm(`Delete the saved report “${found.name}”?`)) return;
    try {
      await apiFetch(`/api/custom-reports/${found.id}`, { method: "DELETE" });
      await loadSaved(); setSelectedId(""); setName(""); setReport(null); setError(""); setMessage(`Deleted “${found.name}”.`);
    } catch (e) { setMessage(""); setError(e instanceof Error ? e.message : "Could not delete report"); }
  }
  function exportCsv() {
    if (!report) return;
    downloadText(operationalCsv(report), `forkflow-${(name.trim() || "custom-report").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "custom-report"}-${report.from}-to-${report.to}.csv`, "text/csv;charset=utf-8");
    setMessage("CSV downloaded. Amounts are in rupees.");
  }
  function move(index: number, by: -1 | 1) {
    const columns = [...draft.columns], to = index + by;
    if (to < 0 || to >= columns.length) return;
    [columns[index], columns[to]] = [columns[to]!, columns[index]!];
    edit({ ...draft, columns });
  }
  const table = report?.tables[0];
  const groupable = source.fields.filter((f) => f.role === "dimension" && f.groupable !== false);

  return <div className="custom-report">
    <div className="page-header"><h3>Custom reports</h3><button disabled={!table || loading} onClick={exportCsv}>Export CSV</button></div>
    <div className="custom-report-bar">
      <label>Saved report <select aria-label="Saved report" value={selectedId} onChange={(e) => chooseSaved(e.target.value)}>
        <option value="">New report</option>{saved.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
      </select></label>
      {canManage && <>
        <label>Report name <input aria-label="Report name" value={name} maxLength={80} placeholder="e.g. Daily sales by category" onChange={(e) => setName(e.target.value)} /></label>
        <button disabled={!name.trim() || !("config" in built)} onClick={() => void save(false)}>{selectedId ? "Save changes" : "Save report"}</button>
        {selectedId && <button disabled={!name.trim() || !("config" in built)} onClick={() => void save(true)}>Save as new</button>}
        {selectedId && <button className="danger" onClick={() => void remove()}>Delete</button>}
      </>}
    </div>
    {!canManage && <p className="sales-report-empty">Saved reports can be run by everyone; an admin creates and edits them.</p>}

    <details className="custom-report-builder" open>
      <summary>Report design</summary>
      <fieldset><legend>Data</legend>
        <label>Data source <select aria-label="Data source" value={draft.source} onChange={(e) => edit(newDraft(e.target.value))}>
          {SOURCES.map((s) => <option key={s.id} value={s.id}>{s.title}</option>)}
        </select></label>
        <p className="report-notes">{source.description}</p>
      </fieldset>

      <fieldset><legend>Columns</legend>
        <div className="custom-report-fields">{source.fields.map((f) => <label key={f.id}>
          <input type="checkbox" checked={draft.columns.some((c) => c.field === f.id)} disabled={draft.groupBy.length > 0 && f.groupable === false} title={draft.groupBy.length > 0 && f.groupable === false ? "Not available on a grouped report" : undefined} onChange={(e) => edit(withColumn(draft, f.id, e.target.checked))} /> {f.label}
          <small> {f.role === "measure" ? "(number)" : ""}</small></label>)}</div>
        {draft.columns.length > 0 && <ol className="custom-report-order" aria-label="Column order and headings">{draft.columns.map((c, i) => <li key={c.field}>
          <span>{field(c.field).label}</span>
          <input aria-label={`Heading for ${field(c.field).label}`} value={c.label} maxLength={60} placeholder="Heading (optional)" onChange={(e) => edit({ ...draft, columns: draft.columns.map((x) => x.field === c.field ? { ...x, label: e.target.value } : x) })} />
          <button aria-label={`Move ${field(c.field).label} left`} disabled={i === 0} onClick={() => move(i, -1)}>↑</button>
          <button aria-label={`Move ${field(c.field).label} right`} disabled={i === draft.columns.length - 1} onClick={() => move(i, 1)}>↓</button>
        </li>)}</ol>}
      </fieldset>

      <fieldset><legend>Group by <InfoTip>(optional — combine rows that share these values)</InfoTip></legend>
        <div className="custom-report-fields">{groupable.map((f) => <label key={f.id}>
          <input type="checkbox" checked={draft.groupBy.includes(f.id)} onChange={(e) => edit(withGrouping(draft, f.id, e.target.checked))} /> {f.label}</label>)}</div>
      </fieldset>

      <fieldset><legend>Filters</legend>
        {draft.filters.map((filter, i) => {
          const f = field(filter.field);
          const set = (patch: Partial<CustomDraft["filters"][number]>) => edit({ ...draft, filters: draft.filters.map((x, j) => j === i ? { ...x, ...patch } : x) });
          return <div className="custom-report-filter" key={i}>
            <select aria-label="Filter column" value={filter.field} onChange={(e) => { const next = field(e.target.value); set({ field: next.id, op: filterOpsFor(next.type)[0]!, text: "" }); }}>
              {source.fields.filter((x) => filterOpsFor(x.type).length).map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
            </select>
            <select aria-label="Filter condition" value={filter.op} onChange={(e) => set({ op: e.target.value as typeof filter.op })}>
              {filterOpsFor(f.type).map((op) => <option key={op} value={op}>{CUSTOM_FILTER_OP_LABELS[op]}</option>)}
            </select>
            <input aria-label="Filter value" type={f.type === "date" ? "date" : "text"} inputMode={f.type === "money" || f.type === "quantity" || f.type === "number" ? "decimal" : undefined} placeholder={f.type === "money" ? "Amount in ₹" : "Value"} value={filter.text} onChange={(e) => set({ text: e.target.value })} />
            <button aria-label="Remove filter" onClick={() => edit({ ...draft, filters: draft.filters.filter((_, j) => j !== i) })}>✕</button>
          </div>;
        })}
        <button disabled={draft.filters.length >= 10} onClick={() => { const next = newFilter(draft); if (next) edit({ ...draft, filters: [...draft.filters, next] }); }}>Add filter</button>
        {draft.groupBy.length > 0 && draft.filters.some((f) => field(f.field).role === "measure") && <p className="report-notes">Filters on number columns keep or drop whole groups.</p>}
      </fieldset>

      <fieldset><legend>Sort</legend>
        <select aria-label="Sort column" value={draft.sort?.field ?? ""} onChange={(e) => edit({ ...draft, sort: e.target.value ? { field: e.target.value, dir: draft.sort?.dir ?? "asc" } : null })}>
          <option value="">Default order</option>{draft.columns.map((c) => <option key={c.field} value={c.field}>{c.label || field(c.field).label}</option>)}
        </select>
        <select aria-label="Sort direction" disabled={!draft.sort} value={draft.sort?.dir ?? "asc"} onChange={(e) => draft.sort && edit({ ...draft, sort: { ...draft.sort, dir: e.target.value as "asc" | "desc" } })}>
          <option value="asc">Lowest first</option><option value="desc">Highest first</option>
        </select>
      </fieldset>
    </details>

    <SalesPeriodControls period={period} today={report?.today} loading={loading} onChange={(next) => { setPeriod(next); onPeriodChange(next); setReport(null); void run(draft, next); }} onRefresh={() => void run()} />
    <div className="custom-report-run"><button disabled={loading || !("config" in built)} onClick={() => void run()}>{loading ? "Running…" : "Run report"}</button>
      {"problem" in built && <span role="status">{built.problem}</span>}</div>
    {error && <p role="alert">{error}</p>}{message && <p role="status">{message}</p>}
    {report && table && <>
      <div className="sales-range-caption"><span>{report.from} → {report.to} · {report.timezone}</span><span>Updated {new Date(report.generatedAt).toLocaleTimeString()}</span></div>
      <details className="report-notes"><summary>How this report is calculated</summary>{report.notes.map((note) => <p key={note}>{note}</p>)}</details>
      {!table.rows.length ? <p className="sales-report-empty">No records for these dates and filters.</p> : <div className="sales-report-table" role="region" aria-label={table.title} tabIndex={0}>
        <table><caption>{table.title} · {report.from} to {report.to} · {table.rows.length} row{table.rows.length === 1 ? "" : "s"}</caption>
          <thead><tr>{table.columns.map((c) => <th scope="col" key={c.key}>{c.label}</th>)}</tr></thead>
          <tbody>{table.rows.map((row, index) => <tr key={index}>{table.columns.map((c, i) => i === 0
            ? <th scope="row" key={c.key}>{operationalCell(row[c.key], c, report.timezone)}</th>
            : <td key={c.key}>{operationalCell(row[c.key], c, report.timezone)}</td>)}</tr>)}</tbody>
          {table.totals && <tfoot><tr>{table.columns.map((c, i) => i === 0
            ? <th scope="row" key={c.key}>{operationalCell(table.totals![c.key], c, report.timezone)}</th>
            : <td key={c.key}>{operationalCell(table.totals![c.key], c, report.timezone)}</td>)}</tr></tfoot>}
        </table>
      </div>}
    </>}
  </div>;
}
