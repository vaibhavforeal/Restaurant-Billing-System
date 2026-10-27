import { useEffect, useState } from "react";
import { apiFetch } from "../api";
import { joinOccasion, occasionNote, parseTags, todayKey } from "../crm";
import { paiseToRupees, rupeesToPaise } from "../money";
import type { Customer } from "../types";
import { CustomerProfile, OccasionInput, type CustomerDetail } from "./CustomerProfile";
import { CustomerSegments } from "./CustomerSegments";
import { CustomerFeedback } from "./CustomerFeedback";
import { CrmInsights } from "./CrmInsights";
import { useRun, type CustomerType, type LoyaltySettings, type LoyaltyTier } from "./customer-shared";
import "../customers.css";

const TABS = ["Customers", "Segments", "Feedback", "Insights", "Settings"] as const;
type Tab = typeof TABS[number];

/** CRM and loyalty: customer profiles, segments, feedback, insights and (admin) the loyalty programme's settings. */
export function Customers({ isAdmin }: { isAdmin: boolean }) {
  const [tab, setTab] = useState<Tab>("Customers");
  const [types, setTypes] = useState<CustomerType[]>([]);
  const [tiers, setTiers] = useState<LoyaltyTier[]>([]);
  const loadTypes = async () => setTypes((await apiFetch<{ customerTypes: CustomerType[] }>("/api/customer-types")).customerTypes);
  const loadTiers = async () => setTiers((await apiFetch<{ tiers: LoyaltyTier[] }>("/api/loyalty-tiers")).tiers);
  useEffect(() => { void loadTypes().catch(() => undefined); void loadTiers().catch(() => undefined); }, []);
  const tabs = TABS.filter((t) => t !== "Settings" || isAdmin);

  return <section className="screen customers">
    <div className="page-header crm-header">
      <h2>Customers &amp; loyalty</h2>
      <div className="tabs" role="group" aria-label="CRM sections">
        {tabs.map((t) => <button key={t} type="button" aria-pressed={tab === t} onClick={() => setTab(t)}>{t}</button>)}
      </div>
    </div>
    {tab === "Customers" && <CustomerDirectory types={types} isAdmin={isAdmin} />}
    {tab === "Segments" && <CustomerSegments types={types} tiers={tiers} canExport={isAdmin} />}
    {tab === "Feedback" && <CustomerFeedback />}
    {tab === "Insights" && <CrmInsights />}
    {tab === "Settings" && isAdmin && <>
      <LoyaltySettingsCard />
      <TiersCard tiers={tiers} onChanged={loadTiers} />
      <CustomerTypes types={types} onChanged={loadTypes} />
    </>}
  </section>;
}

const EMPTY_FORM = { name: "", phone: "", typeId: "", birthDay: "", birthYear: "", tags: "", marketingOptIn: false };

function CustomerDirectory({ types, isAdmin }: { types: CustomerType[]; isAdmin: boolean }) {
  const [query, setQuery] = useState("");
  const [showInactive, setShowInactive] = useState(false);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [selected, setSelected] = useState<CustomerDetail | null>(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const { busy, run, status } = useRun();
  const today = todayKey();

  const search = async () => setCustomers((await apiFetch<{ customers: Customer[] }>(`/api/customers?q=${encodeURIComponent(query)}&inactive=${showInactive ? 1 : 0}`)).customers);
  const open = async (id: string) => setSelected(await apiFetch<CustomerDetail>(`/api/customers/${id}`));
  useEffect(() => { const t = setTimeout(() => void search().catch(() => undefined), 250); return () => clearTimeout(t); }, [query, showInactive]);

  return <div className="customers-layout">
    <div className="panel">
      <label>Search by mobile or name <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="98765…" /></label>
      <label className="crm-check"><input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} /> Show inactive</label>
      <ul className="customer-list">{customers.map((c) => {
        const note = occasionNote(c, today);
        return <li key={c.id}>
          <button aria-pressed={selected?.customer.id === c.id} onClick={() => void open(c.id)}>
            <strong>{c.name}{note ? " 🎂" : ""}</strong><span>{c.phone}</span>
            {c.tier && <small className="crm-badge">{c.tier.name}</small>}
            {c.typeName && <small>{c.typeName}</small>}
            {!c.isActive && <small>Inactive</small>}
            <small>{c.pointsBalance} pts</small>
          </button>
        </li>;
      })}{!customers.length && <li className="muted">No customers found.</li>}</ul>
      <fieldset disabled={busy} className="cash-drawer-form">
        <legend>Add customer</legend>
        <label>Name <input value={form.name} maxLength={80} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
        <label>Mobile <input value={form.phone} inputMode="tel" maxLength={16} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></label>
        <label>Type <select value={form.typeId} onChange={(e) => setForm({ ...form, typeId: e.target.value })}><option value="">None</option>{types.filter((t) => t.isActive).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></label>
        <OccasionInput label="Birthday" day={form.birthDay} year={form.birthYear} onChange={(d, y) => setForm({ ...form, birthDay: d, birthYear: y })} />
        <label>Tags <input value={form.tags} placeholder="Vegan, Office lunch" onChange={(e) => setForm({ ...form, tags: e.target.value })} /></label>
        <label className="crm-check"><input type="checkbox" checked={form.marketingOptIn} onChange={(e) => setForm({ ...form, marketingOptIn: e.target.checked })} /> Happy to receive offers</label>
        <button className="primary" disabled={!form.name.trim() || !form.phone.trim()} onClick={() => void run(async () => {
          const { customer } = await apiFetch<{ customer: Customer }>("/api/customers", { method: "POST", body: JSON.stringify({
            name: form.name, phone: form.phone, typeId: form.typeId || null, birthDate: joinOccasion(form.birthDay, form.birthYear),
            tags: parseTags(form.tags), marketingOptIn: form.marketingOptIn,
          }) });
          setForm(EMPTY_FORM); await search(); await open(customer.id);
        }, "Customer added.")}>Add</button>
      </fieldset>
      {status}
    </div>
    {selected
      ? <CustomerProfile key={selected.customer.id} detail={selected} types={types} isAdmin={isAdmin} onChanged={async () => { await open(selected.customer.id); await search(); }} />
      : <div className="panel muted">Choose a customer to see their visits, spend, points and feedback.</div>}
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

interface SettingsForm {
  enabled: boolean; pointsPer100: string; pointValue: string; minRedeemPoints: string; expiryMonths: string;
  tiersEnabled: boolean; tierWindowMonths: string; maxRedeemPercent: string; feedbackEnabled: boolean;
}
function LoyaltySettingsCard() {
  const [form, setForm] = useState<SettingsForm | null>(null);
  const { busy, run, status } = useRun();
  const accept = (s: LoyaltySettings) => setForm({
    enabled: s.enabled, pointsPer100: String(s.pointsPer100), pointValue: paiseToRupees(s.pointValuePaise), minRedeemPoints: String(s.minRedeemPoints),
    expiryMonths: String(s.expiryMonths), tiersEnabled: s.tiersEnabled, tierWindowMonths: String(s.tierWindowMonths),
    maxRedeemPercent: String(s.maxRedeemPercent), feedbackEnabled: s.feedbackEnabled,
  });
  useEffect(() => { void apiFetch<{ settings: LoyaltySettings }>("/api/loyalty-settings").then((r) => accept(r.settings)).catch(() => undefined); }, []);
  if (!form) return null;
  const set = (patch: Partial<SettingsForm>) => setForm({ ...form, ...patch });
  return <section className="panel" aria-label="Loyalty points">
    <h3>Loyalty points</h3>
    <p>Customers earn points on every bill with their number on it, and can spend them as a discount on a later bill. Voids take the points back.</p>
    <fieldset disabled={busy} className="cash-drawer-form">
      <label className="crm-check"><input type="checkbox" checked={form.enabled} onChange={(e) => set({ enabled: e.target.checked })} /> Loyalty points on</label>
      <label>Points per ₹100 spent <input type="number" min="1" max="100" value={form.pointsPer100} onChange={(e) => set({ pointsPer100: e.target.value })} /></label>
      <label>Value of 1 point (₹) <input type="number" min="0.01" step="0.01" value={form.pointValue} onChange={(e) => set({ pointValue: e.target.value })} /></label>
      <label>Minimum points to redeem <input type="number" min="0" value={form.minRedeemPoints} onChange={(e) => set({ minRedeemPoints: e.target.value })} /></label>
      <label>Points can pay up to (% of bill) <input type="number" min="1" max="100" value={form.maxRedeemPercent} onChange={(e) => set({ maxRedeemPercent: e.target.value })} /></label>
      <label>Points expire after (months, 0 = never) <input type="number" min="0" max="120" value={form.expiryMonths} onChange={(e) => set({ expiryMonths: e.target.value })} /></label>
      <label className="crm-check"><input type="checkbox" checked={form.tiersEnabled} onChange={(e) => set({ tiersEnabled: e.target.checked })} /> Use tiers</label>
      {form.tiersEnabled && <label>Tier from spend in the last (months) <input type="number" min="1" max="60" value={form.tierWindowMonths} onChange={(e) => set({ tierWindowMonths: e.target.value })} /></label>}
      <label className="crm-check"><input type="checkbox" checked={form.feedbackEnabled} onChange={(e) => set({ feedbackEnabled: e.target.checked })} /> Print a "Rate your visit" QR code on bills</label>
      <button className="primary" onClick={() => void run(async () => {
        const pointValuePaise = rupeesToPaise(form.pointValue);
        if (!pointValuePaise) throw new Error("Enter the value of a point in rupees");
        const { settings } = await apiFetch<{ settings: LoyaltySettings }>("/api/loyalty-settings", { method: "PUT", body: JSON.stringify({
          enabled: form.enabled, pointsPer100: Number(form.pointsPer100), pointValuePaise, minRedeemPoints: Number(form.minRedeemPoints),
          expiryMonths: Number(form.expiryMonths), tiersEnabled: form.tiersEnabled, tierWindowMonths: Number(form.tierWindowMonths),
          maxRedeemPercent: Number(form.maxRedeemPercent), feedbackEnabled: form.feedbackEnabled,
        }) });
        accept(settings);
      }, "Loyalty settings saved.")}>Save loyalty settings</button>
    </fieldset>
    <p className="muted">A new expiry period applies to points earned from now on. The feedback QR code links to this computer on the restaurant's network, so guests scan it on the restaurant Wi-Fi.</p>
    {status}
  </section>;
}

/** Tiers by spend: each has a minimum spend in the tier window and a points multiplier. Shown even with tiers off, so they can be set up first. */
function TiersCard({ tiers, onChanged }: { tiers: LoyaltyTier[]; onChanged: () => Promise<void> }) {
  const [form, setForm] = useState({ name: "", minSpend: "", multiplier: "1" });
  const [editing, setEditing] = useState<{ id: string; minSpend: string; multiplier: string } | null>(null);
  const { busy, run, status } = useRun();
  const paise = (rupees: string) => {
    const value = rupeesToPaise(rupees || "0");
    if (value === null) throw new Error("Enter the minimum spend in rupees");
    return value;
  };
  return <section className="panel" aria-label="Loyalty tiers">
    <h3>Tiers</h3>
    <p>With "Use tiers" on, a customer's tier comes from what they spent recently, and the tier multiplies the points they earn. With it off, everyone earns points the same way.</p>
    <fieldset disabled={busy} className="cash-drawer-form">
      {tiers.map((t) => <div key={t.id} className="customer-type">
        <strong>{t.name}</strong>{!t.isActive && <small className="muted"> (off)</small>}
        {editing?.id === t.id ? <>
          <label>From spend (₹) <input type="number" min="0" step="0.01" value={editing.minSpend} onChange={(e) => setEditing({ ...editing, minSpend: e.target.value })} /></label>
          <label>Points × <input type="number" min="1" max="10" step="0.25" value={editing.multiplier} onChange={(e) => setEditing({ ...editing, multiplier: e.target.value })} /></label>
          <button className="primary" onClick={() => void run(async () => {
            await apiFetch(`/api/loyalty-tiers/${t.id}`, { method: "PATCH", body: JSON.stringify({ minSpendPaise: paise(editing.minSpend), earnMultiplier: Number(editing.multiplier) }) });
            setEditing(null); await onChanged();
          }, "Tier saved.")}>Save</button>
        </> : <>
          <span className="muted">from ₹{paiseToRupees(t.minSpendPaise)} · {t.earnMultiplier}× points</span>
          <button onClick={() => setEditing({ id: t.id, minSpend: paiseToRupees(t.minSpendPaise), multiplier: String(t.earnMultiplier) })}>Edit</button>
        </>}
        <button onClick={() => void run(async () => { await apiFetch(`/api/loyalty-tiers/${t.id}`, { method: "PATCH", body: JSON.stringify({ isActive: !t.isActive }) }); await onChanged(); })}>{t.isActive ? "Turn off" : "Turn on"}</button>
      </div>)}
      {!tiers.length && <p className="muted">No tiers yet: points only.</p>}
      <label>New tier <input value={form.name} maxLength={30} placeholder="Gold" onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
      <label>From spend (₹) <input type="number" min="0" step="0.01" value={form.minSpend} onChange={(e) => setForm({ ...form, minSpend: e.target.value })} /></label>
      <label>Points × <input type="number" min="1" max="10" step="0.25" value={form.multiplier} onChange={(e) => setForm({ ...form, multiplier: e.target.value })} /></label>
      <button disabled={!form.name.trim()} onClick={() => void run(async () => {
        await apiFetch("/api/loyalty-tiers", { method: "POST", body: JSON.stringify({ name: form.name, minSpendPaise: paise(form.minSpend), earnMultiplier: Number(form.multiplier) }) });
        setForm({ name: "", minSpend: "", multiplier: "1" }); await onChanged();
      }, "Tier added.")}>Add tier</button>
    </fieldset>
    {status}
  </section>;
}
