import { useEffect, useState } from "react";
import { ApiError, apiFetch } from "../api";
import { paiseToRupees, rupeesToPaise } from "../money";
import { uuid } from "../uuid";
import type { Customer } from "../types";
import "../customers.css";

interface CustomerType { id: string; name: string; isActive: boolean; slabs: Array<{ minBillPaise: number; percent: number; validFrom: string | null; validTo: string | null }> }
interface LoyaltySettings { enabled: boolean; pointsPer100: number; pointValuePaise: number; minRedeemPoints: number }
interface Detail {
  customer: Customer;
  ledger: Array<{ id: string; kind: "earn" | "redeem" | "reverse" | "adjust"; points: number; note: string | null; createdAt: number; billNo: number | null; createdByName: string }>;
  bills: Array<{ id: string; billNo: number; createdAt: number; totalPaise: number; status: string }>;
}
const KIND: Record<Detail["ledger"][number]["kind"], string> = { earn: "Earned", redeem: "Redeemed", reverse: "Reversed", adjust: "Adjusted" };

function useRun() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  async function run(action: () => Promise<unknown>, done = "Saved.") {
    if (busy) return;
    setBusy(true); setError(""); setMessage("");
    try { await action(); setMessage(done); }
    catch (e) { setError(e instanceof ApiError || e instanceof Error ? e.message : "Request failed"); }
    finally { setBusy(false); }
  }
  const status = <>{error && <p role="alert">{error}</p>}{message && <p role="status">{message}</p>}</>;
  return { busy, run, status };
}

/** Customer list, details with points history, and (admin) customer types, slabs and loyalty settings. */
export function Customers({ isAdmin }: { isAdmin: boolean }) {
  const [query, setQuery] = useState("");
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [types, setTypes] = useState<CustomerType[]>([]);
  const [selected, setSelected] = useState<Detail | null>(null);
  const [form, setForm] = useState({ name: "", phone: "", typeId: "", notes: "" });
  const { busy, run, status } = useRun();

  const search = async (q = query) => setCustomers((await apiFetch<{ customers: Customer[] }>(`/api/customers?q=${encodeURIComponent(q)}`)).customers);
  const loadTypes = async () => setTypes((await apiFetch<{ customerTypes: CustomerType[] }>("/api/customer-types")).customerTypes);
  const open = async (id: string) => setSelected(await apiFetch<Detail>(`/api/customers/${id}`));
  useEffect(() => { void search("").catch(() => undefined); void loadTypes().catch(() => undefined); }, []);
  useEffect(() => { const t = setTimeout(() => void search().catch(() => undefined), 250); return () => clearTimeout(t); }, [query]);

  return <section className="screen customers">
    <div className="page-header"><h2>Customers</h2></div>
    <div className="customers-layout">
      <div className="panel">
        <label>Search by mobile or name <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="98765…" /></label>
        <ul className="customer-list">{customers.map((c) => <li key={c.id}>
          <button aria-pressed={selected?.customer.id === c.id} onClick={() => void open(c.id)}><strong>{c.name}</strong><span>{c.phone}</span>{c.typeName && <small>{c.typeName}</small>}<small>{c.pointsBalance} pts</small></button>
        </li>)}{!customers.length && <li className="muted">No customers found.</li>}</ul>
        <fieldset disabled={busy} className="cash-drawer-form">
          <legend>Add customer</legend>
          <label>Name <input value={form.name} maxLength={80} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
          <label>Mobile <input value={form.phone} inputMode="tel" maxLength={16} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></label>
          <label>Type <select value={form.typeId} onChange={(e) => setForm({ ...form, typeId: e.target.value })}><option value="">None</option>{types.filter((t) => t.isActive).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></label>
          <button className="primary" disabled={!form.name.trim() || !form.phone.trim()} onClick={() => void run(async () => {
            const { customer } = await apiFetch<{ customer: Customer }>("/api/customers", { method: "POST", body: JSON.stringify({ name: form.name, phone: form.phone, typeId: form.typeId || null, notes: form.notes }) });
            setForm({ name: "", phone: "", typeId: "", notes: "" }); await search(); await open(customer.id);
          }, "Customer added.")}>Add</button>
        </fieldset>
        {status}
      </div>
      {selected && <CustomerDetail key={selected.customer.id} detail={selected} types={types} isAdmin={isAdmin} onChanged={async () => { await open(selected.customer.id); await search(); }} />}
    </div>
    {isAdmin && <><CustomerTypes types={types} onChanged={loadTypes} /><LoyaltySettingsCard /></>}
  </section>;
}

function CustomerDetail({ detail, types, isAdmin, onChanged }: { detail: Detail; types: CustomerType[]; isAdmin: boolean; onChanged: () => Promise<void> }) {
  const c = detail.customer;
  const [edit, setEdit] = useState({ name: c.name, phone: c.phone, typeId: c.typeId ?? "", notes: c.notes });
  const [adjust, setAdjust] = useState({ points: "", note: "" });
  const { busy, run, status } = useRun();
  return <div className="panel">
    <h3>{c.name} <small className="muted">{c.phone}</small></h3>
    <p><strong>{c.pointsBalance}</strong> points{c.typeName ? ` · ${c.typeName}` : ""}</p>
    <fieldset disabled={busy} className="cash-drawer-form">
      <label>Name <input value={edit.name} maxLength={80} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></label>
      <label>Mobile <input value={edit.phone} maxLength={16} onChange={(e) => setEdit({ ...edit, phone: e.target.value })} /></label>
      <label>Type <select value={edit.typeId} onChange={(e) => setEdit({ ...edit, typeId: e.target.value })}><option value="">None</option>{types.map((t) => <option key={t.id} value={t.id}>{t.name}{t.isActive ? "" : " (off)"}</option>)}</select></label>
      <label>Notes <input value={edit.notes} maxLength={500} onChange={(e) => setEdit({ ...edit, notes: e.target.value })} /></label>
      <button onClick={() => void run(async () => {
        await apiFetch(`/api/customers/${c.id}`, { method: "PATCH", body: JSON.stringify({ name: edit.name, phone: edit.phone, typeId: edit.typeId || null, notes: edit.notes }) });
        await onChanged();
      })}>Save</button>
    </fieldset>
    {isAdmin && <fieldset disabled={busy} className="cash-drawer-form">
      <legend>Adjust points</legend>
      <label>Points (+/−) <input type="number" step="1" value={adjust.points} onChange={(e) => setAdjust({ ...adjust, points: e.target.value })} /></label>
      <label>Reason <input maxLength={200} value={adjust.note} onChange={(e) => setAdjust({ ...adjust, note: e.target.value })} /></label>
      <button disabled={!adjust.points || !adjust.note.trim()} onClick={() => void run(async () => {
        await apiFetch(`/api/customers/${c.id}/loyalty-adjustments`, { method: "POST", body: JSON.stringify({ clientRef: uuid(), points: Number(adjust.points), note: adjust.note }) });
        setAdjust({ points: "", note: "" }); await onChanged();
      }, "Points adjusted.")}>Adjust</button>
    </fieldset>}
    {status}
    <h4>Points history</h4>
    <table className="customer-ledger"><tbody>{detail.ledger.map((l) => <tr key={l.id}>
      <td>{new Date(l.createdAt).toLocaleDateString()}</td><td>{KIND[l.kind]}</td><td className="pos-money">{l.points > 0 ? `+${l.points}` : l.points}</td>
      <td>{l.billNo ? `Bill #${l.billNo}` : ""}{l.note ? ` ${l.note}` : ""}</td>
    </tr>)}{!detail.ledger.length && <tr><td className="muted">No points yet.</td></tr>}</tbody></table>
    <h4>Recent bills</h4>
    <table className="customer-ledger"><tbody>{detail.bills.map((b) => <tr key={b.id}>
      <td>#{b.billNo}</td><td>{new Date(b.createdAt).toLocaleDateString()}</td><td className="pos-money">₹{paiseToRupees(b.totalPaise)}</td><td>{b.status}</td>
    </tr>)}{!detail.bills.length && <tr><td className="muted">No bills yet.</td></tr>}</tbody></table>
  </div>;
}

/** Slabs edited as text rows: minimum bill (₹), percent, optional from/to dates. */
function CustomerTypes({ types, onChanged }: { types: CustomerType[]; onChanged: () => Promise<void> }) {
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
    <h3>Customer types and discount slabs</h3>
    <p>Give a type of customer (for example Regular or Staff) a percent off. A slab applies from a minimum bill, optionally only between two dates. The best slab a bill qualifies for is applied automatically and is not counted against staff discount limits.</p>
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

function LoyaltySettingsCard() {
  const [form, setForm] = useState<{ enabled: boolean; pointsPer100: string; pointValue: string; minRedeemPoints: string } | null>(null);
  const { busy, run, status } = useRun();
  const accept = (s: LoyaltySettings) => setForm({ enabled: s.enabled, pointsPer100: String(s.pointsPer100), pointValue: paiseToRupees(s.pointValuePaise), minRedeemPoints: String(s.minRedeemPoints) });
  useEffect(() => { void apiFetch<{ settings: LoyaltySettings }>("/api/loyalty-settings").then((r) => accept(r.settings)).catch(() => undefined); }, []);
  if (!form) return null;
  return <section className="panel" aria-label="Loyalty points">
    <h3>Loyalty points</h3>
    <p>Customers earn points on every bill with their number on it, and can spend them as a discount on a later bill. Voids take the points back.</p>
    <fieldset disabled={busy} className="cash-drawer-form">
      <label><input type="checkbox" checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} /> Loyalty points on</label>
      <label>Points per ₹100 spent <input type="number" min="1" max="100" value={form.pointsPer100} onChange={(e) => setForm({ ...form, pointsPer100: e.target.value })} /></label>
      <label>Value of 1 point (₹) <input type="number" min="0.01" step="0.01" value={form.pointValue} onChange={(e) => setForm({ ...form, pointValue: e.target.value })} /></label>
      <label>Minimum points to redeem <input type="number" min="0" value={form.minRedeemPoints} onChange={(e) => setForm({ ...form, minRedeemPoints: e.target.value })} /></label>
      <button className="primary" onClick={() => void run(async () => {
        const pointValuePaise = rupeesToPaise(form.pointValue);
        if (!pointValuePaise) throw new Error("Enter the value of a point in rupees");
        const { settings } = await apiFetch<{ settings: LoyaltySettings }>("/api/loyalty-settings", { method: "PUT", body: JSON.stringify({
          enabled: form.enabled, pointsPer100: Number(form.pointsPer100), pointValuePaise, minRedeemPoints: Number(form.minRedeemPoints) }) });
        accept(settings);
      }, "Loyalty settings saved.")}>Save loyalty settings</button>
    </fieldset>
    {status}
  </section>;
}
