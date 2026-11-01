import { useEffect, useState } from "react";
import { SEGMENT_PRESETS, type SavedSegment, type SegmentCustomer, type SegmentFilterInput } from "@masalapos/domain/customer-segments";
import { ApiError, apiFetch, authHeaders } from "../api";
import { parseTags } from "../crm";
import { downloadText } from "../download";
import { paiseToRupees, rupeesToPaise } from "../money";
import { useRun, type CustomerType, type LoyaltyTier } from "./customer-shared";

/** The builder's fields as typed; blank means "any". */
interface Form {
  tierIds: string[]; typeIds: string[]; tags: string;
  visitedWithinDays: string; notVisitedForDays: string; joinedWithinDays: string;
  minVisits: string; minSpend: string; minPoints: string;
  occasionKind: "" | "birthday" | "anniversary" | "either"; occasionDays: string;
  optedInOnly: boolean; includeInactive: boolean;
}
const BLANK: Form = {
  tierIds: [], typeIds: [], tags: "", visitedWithinDays: "", notVisitedForDays: "", joinedWithinDays: "",
  minVisits: "", minSpend: "", minPoints: "", occasionKind: "", occasionDays: "7", optedInOnly: false, includeInactive: false,
};

const num = (text: string) => text.trim() === "" ? undefined : Number(text);
function toFilter(f: Form): SegmentFilterInput {
  const minSpendPaise = f.minSpend.trim() ? rupeesToPaise(f.minSpend) ?? undefined : undefined;
  return {
    tierIds: f.tierIds, typeIds: f.typeIds, tags: parseTags(f.tags),
    visitedWithinDays: num(f.visitedWithinDays), notVisitedForDays: num(f.notVisitedForDays), joinedWithinDays: num(f.joinedWithinDays),
    minVisits: num(f.minVisits), minSpendPaise, minPoints: num(f.minPoints),
    ...(f.occasionKind ? { occasion: { kind: f.occasionKind, withinDays: Number(f.occasionDays || 0) } } : {}),
    optedInOnly: f.optedInOnly, includeInactive: f.includeInactive,
  };
}
const text = (n: number | undefined) => n === undefined ? "" : String(n);
function toForm(filter: SegmentFilterInput): Form {
  return {
    tierIds: filter.tierIds ?? [], typeIds: filter.typeIds ?? [], tags: (filter.tags ?? []).join(", "),
    visitedWithinDays: text(filter.visitedWithinDays), notVisitedForDays: text(filter.notVisitedForDays), joinedWithinDays: text(filter.joinedWithinDays),
    minVisits: text(filter.minVisits), minSpend: filter.minSpendPaise === undefined ? "" : paiseToRupees(filter.minSpendPaise), minPoints: text(filter.minPoints),
    occasionKind: filter.occasion?.kind ?? "", occasionDays: String(filter.occasion?.withinDays ?? 7),
    optedInOnly: filter.optedInOnly ?? false, includeInactive: filter.includeInactive ?? false,
  };
}
const toggle = (list: string[], id: string) => list.includes(id) ? list.filter((x) => x !== id) : [...list, id];

/** Find a group of customers, save it, and (admin) export it as CSV for an offer sent from another tool. */
export function CustomerSegments({ types, tiers, canExport }: { types: CustomerType[]; tiers: LoyaltyTier[]; canExport: boolean }) {
  const [form, setForm] = useState<Form>(BLANK);
  const [saved, setSaved] = useState<SavedSegment[]>([]);
  const [current, setCurrent] = useState<SavedSegment | null>(null);
  const [name, setName] = useState("");
  const [result, setResult] = useState<{ count: number; optedIn: number; customers: SegmentCustomer[] } | null>(null);
  const [includeAll, setIncludeAll] = useState(false);
  const [previewError, setPreviewError] = useState("");
  const { busy, run, status } = useRun();
  const set = (patch: Partial<Form>) => setForm({ ...form, ...patch });

  const loadSaved = async () => setSaved((await apiFetch<{ segments: SavedSegment[] }>("/api/customer-segments")).segments);
  useEffect(() => { void loadSaved().catch(() => undefined); }, []);
  useEffect(() => {
    let active = true;
    const t = setTimeout(() => {
      apiFetch<{ count: number; optedIn: number; customers: SegmentCustomer[] }>("/api/customer-segments/preview", { method: "POST", body: JSON.stringify({ filter: toFilter(form) }) })
        .then((r) => { if (active) { setResult(r); setPreviewError(""); } })
        .catch((e) => { if (active) setPreviewError(e instanceof ApiError ? e.message : "Could not load the segment"); });
    }, 300);
    return () => { active = false; clearTimeout(t); };
  }, [form]);

  const pick = (segment: SavedSegment | null, filter: SegmentFilterInput) => { setCurrent(segment); setName(segment?.name ?? ""); setForm(toForm(filter)); };
  async function exportCsv() {
    const res = await fetch("/api/customer-segments/export", { method: "POST", headers: { ...authHeaders(), "content-type": "application/json" }, body: JSON.stringify({ filter: toFilter(form), all: includeAll }) });
    if (!res.ok) throw new Error((await res.json().catch(() => ({ error: res.statusText }))).error ?? "Export failed");
    downloadText(await res.text(), `${(name || "customers").replace(/[^\w-]+/g, "-")}.csv`, "text/csv;charset=utf-8");
  }

  return <div className="crm-segments">
    <aside className="panel">
      <h3>Start from</h3>
      <ul className="crm-preset-list">
        <li><button type="button" onClick={() => pick(null, {})}>Everyone</button></li>
        {SEGMENT_PRESETS.map((p) => <li key={p.id}><button type="button" title={p.description} onClick={() => pick(null, p.filter)}>{p.name}</button></li>)}
      </ul>
      <h3>Saved segments</h3>
      <ul className="crm-preset-list">
        {saved.map((s) => <li key={s.id}><button type="button" aria-pressed={current?.id === s.id} onClick={() => pick(s, s.filter)}>{s.name}</button></li>)}
        {!saved.length && <li className="muted">None yet.</li>}
      </ul>
    </aside>

    <div className="panel">
      <fieldset className="cash-drawer-form crm-filter">
        <legend>Customers who…</legend>
        {tiers.length > 0 && <div className="crm-chip-group" role="group" aria-label="Tier">
          <span>Tier</span>
          {[...tiers.map((t) => ({ id: t.id, name: t.name })), { id: "none", name: "No tier" }].map((t) => <label key={t.id} className="crm-check">
            <input type="checkbox" checked={form.tierIds.includes(t.id)} onChange={() => set({ tierIds: toggle(form.tierIds, t.id) })} /> {t.name}
          </label>)}
        </div>}
        {types.length > 0 && <div className="crm-chip-group" role="group" aria-label="Customer type">
          <span>Type</span>
          {[...types.map((t) => ({ id: t.id, name: t.name })), { id: "none", name: "No type" }].map((t) => <label key={t.id} className="crm-check">
            <input type="checkbox" checked={form.typeIds.includes(t.id)} onChange={() => set({ typeIds: toggle(form.typeIds, t.id) })} /> {t.name}
          </label>)}
        </div>}
        <label>Have any of these tags <input value={form.tags} placeholder="Vegan, VIP" onChange={(e) => set({ tags: e.target.value })} /></label>
        <label>Visited in the last (days) <input type="number" min="1" value={form.visitedWithinDays} onChange={(e) => set({ visitedWithinDays: e.target.value })} /></label>
        <label>Have not visited for (days) <input type="number" min="1" value={form.notVisitedForDays} onChange={(e) => set({ notVisitedForDays: e.target.value })} /></label>
        <label>Joined in the last (days) <input type="number" min="1" value={form.joinedWithinDays} onChange={(e) => set({ joinedWithinDays: e.target.value })} /></label>
        <label>At least (visits) <input type="number" min="0" value={form.minVisits} onChange={(e) => set({ minVisits: e.target.value })} /></label>
        <label>Spent at least (₹) <input type="number" min="0" step="0.01" value={form.minSpend} onChange={(e) => set({ minSpend: e.target.value })} /></label>
        <label>Have at least (points) <input type="number" min="0" value={form.minPoints} onChange={(e) => set({ minPoints: e.target.value })} /></label>
        <label>Celebrating <select value={form.occasionKind} onChange={(e) => set({ occasionKind: e.target.value as Form["occasionKind"] })}>
          <option value="">Any time</option><option value="birthday">A birthday</option><option value="anniversary">An anniversary</option><option value="either">Either</option>
        </select></label>
        {form.occasionKind && <label>In the next (days) <input type="number" min="0" max="60" value={form.occasionDays} onChange={(e) => set({ occasionDays: e.target.value })} /></label>}
        <label className="crm-check"><input type="checkbox" checked={form.optedInOnly} onChange={(e) => set({ optedInOnly: e.target.checked })} /> Opted in to offers only</label>
        <label className="crm-check"><input type="checkbox" checked={form.includeInactive} onChange={(e) => set({ includeInactive: e.target.checked })} /> Include inactive</label>
      </fieldset>

      <fieldset disabled={busy} className="cash-drawer-form">
        <label>Segment name <input value={name} maxLength={60} onChange={(e) => setName(e.target.value)} /></label>
        <button disabled={!name.trim()} onClick={() => void run(async () => {
          const body = JSON.stringify({ name, filter: toFilter(form) });
          const { segment } = current
            ? await apiFetch<{ segment: SavedSegment }>(`/api/customer-segments/${current.id}`, { method: "PUT", body })
            : await apiFetch<{ segment: SavedSegment }>("/api/customer-segments", { method: "POST", body });
          setCurrent(segment); await loadSaved();
        }, "Segment saved.")}>{current ? "Save changes" : "Save segment"}</button>
        {current && <button onClick={() => void run(async () => {
          await apiFetch(`/api/customer-segments/${current.id}`, { method: "DELETE" });
          setCurrent(null); setName(""); await loadSaved();
        }, "Segment deleted.")}>Delete</button>}
        {canExport && <>
          <label className="crm-check"><input type="checkbox" checked={includeAll} onChange={(e) => setIncludeAll(e.target.checked)} /> Include customers who did not opt in</label>
          <button className="primary" disabled={!result?.count} onClick={() => void run(exportCsv, "CSV downloaded.")}>Export CSV</button>
        </>}
      </fieldset>
      {status}
      {previewError && <p role="alert">{previewError}</p>}

      {result && <>
        <p><strong>{result.count}</strong> customer{result.count === 1 ? "" : "s"} · {result.optedIn} opted in to offers{result.count > result.customers.length ? ` · showing the first ${result.customers.length}` : ""}</p>
        <table className="customer-ledger crm-segment-table">
          <thead><tr><th>Name</th><th>Phone</th><th>Tier</th><th>Visits</th><th>Spend</th><th>Last visit</th><th>Points</th></tr></thead>
          <tbody>{result.customers.map((c) => <tr key={c.id}>
            <td>{c.name}{c.marketingOptIn ? "" : <small className="muted"> · no offers</small>}</td><td>{c.phone}</td><td>{c.tierName ?? ""}</td>
            <td>{c.visits}</td><td className="pos-money">₹{paiseToRupees(c.spendPaise)}</td>
            <td>{c.lastVisitAt ? new Date(c.lastVisitAt).toLocaleDateString() : "—"}</td><td>{c.points}</td>
          </tr>)}</tbody>
        </table>
      </>}
    </div>
  </div>;
}
