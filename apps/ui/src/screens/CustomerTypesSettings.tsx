import { useEffect, useState } from "react";
import { apiFetch } from "../api";
import { InfoTip } from "../InfoTip";
import { paiseToRupees, rupeesToPaise } from "../money";
import { useRun, type CustomerType } from "./customer-shared";
import "../customers.css";

/** Settings → Discounts & limits: customer types and their discount slabs (CRM & Loyalty add-on). */
export function CustomerTypesSettings() {
  const [types, setTypes] = useState<CustomerType[] | null>(null);
  const [error, setError] = useState("");
  const load = async () => setTypes((await apiFetch<{ customerTypes: CustomerType[] }>("/api/customer-types")).customerTypes);
  useEffect(() => { void load().catch(() => setError("Could not load customer types")); }, []);
  if (!types) return error ? <p role="alert">{error}</p> : <p role="status">Loading customer types…</p>;
  return <CustomerTypesEditor types={types} onChanged={load} />;
}

/** Slabs edited as text rows: minimum bill (₹), percent, optional from/to dates. */
function CustomerTypesEditor({ types, onChanged }: { types: CustomerType[]; onChanged: () => Promise<void> }) {
  const [name, setName] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [rows, setRows] = useState<Array<{ min: string; percent: string; from: string; to: string }>>([]);
  const { busy, run, status } = useRun();
  const begin = (t: CustomerType) => {
    setEditing(t.id);
    setRows(t.slabs.map((s) => ({ min: paiseToRupees(s.minBillPaise), percent: String(s.percent), from: s.validFrom ?? "", to: s.validTo ?? "" })));
  };
  const slabs = () => rows.filter((r) => r.percent.trim()).map((r) => {
    const minBillPaise = rupeesToPaise(r.min || "0");
    if (minBillPaise === null) throw new Error("Enter the minimum bill in rupees");
    return { minBillPaise, percent: Number(r.percent), validFrom: r.from || null, validTo: r.to || null };
  });
  return <section className="panel" aria-label="Customer types">
    <h3>Customer types and discount slabs <InfoTip>Give a type of customer (for example Regular or Staff) a percent off. A slab applies from a minimum bill, optionally only between two dates. The best slab a bill qualifies for is applied automatically and is not counted against staff discount limits.</InfoTip></h3>
    <fieldset disabled={busy} className="cash-drawer-form">
      {types.map((t) => <div key={t.id} className="customer-type">
        <strong>{t.name}</strong>{!t.isActive && <small className="muted"> (off)</small>}
        <span className="muted">{t.slabs.length ? t.slabs.map((s) => `${s.percent}% from ₹${paiseToRupees(s.minBillPaise)}${s.validFrom || s.validTo ? ` (${s.validFrom ?? "…"} to ${s.validTo ?? "…"})` : ""}`).join("; ") : "No slabs"}</span>
        <button onClick={() => begin(t)}>Edit slabs</button>
        <button onClick={() => void run(async () => { await apiFetch(`/api/customer-types/${t.id}`, { method: "PATCH", body: JSON.stringify({ isActive: !t.isActive }) }); await onChanged(); })}>{t.isActive ? "Turn off" : "Turn on"}</button>
        {editing === t.id && <div className="slab-editor">
          {rows.map((r, i) => <p key={i}>
            <label>From bill (₹) <input type="number" min="0" step="0.01" value={r.min} onChange={(e) => setRows(rows.map((x, j) => j === i ? { ...x, min: e.target.value } : x))} /></label>
            <label>Percent <input type="number" min="0" max="100" step="0.5" value={r.percent} onChange={(e) => setRows(rows.map((x, j) => j === i ? { ...x, percent: e.target.value } : x))} /></label>
            <label>Valid from <input type="date" value={r.from} onChange={(e) => setRows(rows.map((x, j) => j === i ? { ...x, from: e.target.value } : x))} /></label>
            <label>Valid to <input type="date" value={r.to} onChange={(e) => setRows(rows.map((x, j) => j === i ? { ...x, to: e.target.value } : x))} /></label>
            <button onClick={() => setRows(rows.filter((_, j) => j !== i))}>Remove</button>
          </p>)}
          <button onClick={() => setRows([...rows, { min: "0", percent: "", from: "", to: "" }])}>Add slab</button>{" "}
          <button className="primary" onClick={() => void run(async () => {
            await apiFetch(`/api/customer-types/${t.id}`, { method: "PATCH", body: JSON.stringify({ slabs: slabs() }) });
            setEditing(null); await onChanged();
          }, "Slabs saved.")}>Save slabs</button>
        </div>}
      </div>)}
      <label>New type <input value={name} maxLength={40} placeholder="Regular" onChange={(e) => setName(e.target.value)} /></label>
      <button disabled={!name.trim()} onClick={() => void run(async () => {
        await apiFetch("/api/customer-types", { method: "POST", body: JSON.stringify({ name }) }); setName(""); await onChanged();
      }, "Customer type added.")}>Add type</button>
    </fieldset>
    {status}
  </section>;
}
