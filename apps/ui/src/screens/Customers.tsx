import { useEffect, useRef, useState } from "react";
import { apiFetch } from "../api";
import { joinOccasion, parseTags } from "../crm";
import type { Customer } from "../types";
import { CustomerProfile, OccasionInput, type CustomerDetail } from "./CustomerProfile";
import { CustomerSegments } from "./CustomerSegments";
import { CustomerFeedback } from "./CustomerFeedback";
import { CrmInsights } from "./CrmInsights";
import { useRun, type CustomerType, type LoyaltyTier } from "./customer-shared";
import "../customers.css";

const TABS = ["Customers", "Segments", "Feedback", "Insights"] as const;
type Tab = typeof TABS[number];

/** CRM and loyalty: customer profiles, segments, feedback and insights. The programme's settings are in Settings → Loyalty and Discounts & limits. */
export function Customers({ isAdmin, canExport, onOpenSettings }: { isAdmin: boolean; canExport: boolean; onOpenSettings?: (section: "loyalty" | "discounts") => void }) {
  const [tab, setTab] = useState<Tab>("Customers");
  const [types, setTypes] = useState<CustomerType[]>([]);
  const [tiers, setTiers] = useState<LoyaltyTier[]>([]);
  const loadTypes = async () => setTypes((await apiFetch<{ customerTypes: CustomerType[] }>("/api/customer-types")).customerTypes);
  const loadTiers = async () => setTiers((await apiFetch<{ tiers: LoyaltyTier[] }>("/api/loyalty-tiers")).tiers);
  useEffect(() => { void loadTypes().catch(() => undefined); void loadTiers().catch(() => undefined); }, []);

  return <section className="screen customers">
    <div className="page-header crm-header">
      <div><h1>Customers &amp; loyalty</h1><p className="muted">Know your guests. Make every visit more personal.</p></div>
      <div className="tabs" role="group" aria-label="CRM sections">
        {TABS.map((t) => <button key={t} type="button" aria-pressed={tab === t} onClick={() => setTab(t)}>{t}</button>)}
      </div>
      {isAdmin && onOpenSettings && <p className="muted" style={{ margin: 0 }}>
        Set up in Settings: <button type="button" className="link-button" onClick={() => onOpenSettings("loyalty")}>Loyalty →</button>{" "}
        <button type="button" className="link-button" onClick={() => onOpenSettings("discounts")}>Customer-type discounts →</button>
      </p>}
    </div>
    {tab === "Customers" && <CustomerDirectory types={types} isAdmin={isAdmin} />}
    {tab === "Segments" && <CustomerSegments types={types} tiers={tiers} canExport={canExport} />}
    {tab === "Feedback" && <CustomerFeedback />}
    {tab === "Insights" && <CrmInsights />}
  </section>;
}

const EMPTY_FORM = { name: "", phone: "", typeId: "", birthDay: "", birthYear: "", tags: "", marketingOptIn: false };

function CustomerDirectory({ types, isAdmin }: { types: CustomerType[]; isAdmin: boolean }) {
  const [adding, setAdding] = useState(false);
  const [loading, setLoading] = useState(true);
  const [searchError, setSearchError] = useState("");
  const requestVersion = useRef(0);
  const profileVersion = useRef(0);
  const [opening, setOpening] = useState(false);
  const [query, setQuery] = useState("");
  const [showInactive, setShowInactive] = useState(false);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [selected, setSelected] = useState<CustomerDetail | null>(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const { busy, run, status } = useRun();

  const search = async () => {
    const version = ++requestVersion.current;
    setLoading(true); setSearchError("");
    try {
      const result = await apiFetch<{ customers: Customer[] }>(`/api/customers?q=${encodeURIComponent(query)}&inactive=${showInactive ? 1 : 0}`);
      if (version === requestVersion.current) setCustomers(result.customers);
    } catch (error) {
      if (version === requestVersion.current) setSearchError(error instanceof Error ? error.message : "Could not load customers.");
    } finally { if (version === requestVersion.current) setLoading(false); }
  };
  const open = async (id: string) => {
    const version = ++profileVersion.current;
    setOpening(true);
    try {
      const detail = await apiFetch<CustomerDetail>(`/api/customers/${id}`);
      if (version === profileVersion.current) { setSelected(detail); setAdding(false); }
    } finally { if (version === profileVersion.current) setOpening(false); }
  };
  useEffect(() => {
    ++requestVersion.current;
    setLoading(true);
    const t = setTimeout(() => void search(), 250);
    return () => { clearTimeout(t); ++requestVersion.current; };
  }, [query, showInactive]);

  return <>
    <div className="customer-toolbar">
      <div><h2>Guest directory</h2><p className="muted">Contact details, visit history and rewards in one place.</p></div>
      <button type="button" className="primary" disabled={busy} onClick={() => { ++profileVersion.current; setOpening(false); setAdding(true); }}>+ Add customer</button>
    </div>
    <div className="customers-layout">
      <section className="panel customer-directory" aria-label="Guest directory">
        <div className="customer-search">
          <label htmlFor="customer-search">Find a guest</label>
          <input id="customer-search" type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search name or mobile number" />
          <div className="customer-list-meta"><span aria-live="polite">{loading ? "Searching…" : `${customers.length} ${customers.length === 1 ? "result" : "results"}`}</span><label className="crm-check"><input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} /> Include inactive</label></div>
        </div>
        {searchError ? <div className="customer-list-message" role="alert">{searchError} <button onClick={() => void search()}>Try again</button></div> :
        <ul className="customer-list" aria-label="Customers" aria-busy={loading} tabIndex={0}>{customers.map((c) => {
          return <li key={c.id}>
            <button aria-pressed={!adding && selected?.customer.id === c.id} onClick={() => void run(() => open(c.id), "")}>
              <span className="customer-identity"><strong title={c.name}>{c.name}</strong><small>{c.phone}</small></span>
            </button>
          </li>;
        })}{!loading && !customers.length && <li className="customer-list-message"><strong>{query ? "No matching guests" : "Your guest list starts here"}</strong><p>{query ? "Try a different name or mobile number." : "Add your first customer to keep their visits and rewards together."}</p></li>}</ul>}
      </section>
      <div className="customer-detail-area" aria-busy={opening}>
        {status}
        {opening && <p role="status" className="muted">Opening customer…</p>}
        {adding ? <section className="panel customer-create" aria-label="Add customer">
          <div className="customer-create-heading"><div><h2>Add customer</h2><p className="muted">Start with a name and mobile number. Add the personal touches below.</p></div><button type="button" disabled={busy} onClick={() => setAdding(false)}>Cancel</button></div>
      <fieldset disabled={busy} className="cash-drawer-form">
        <legend className="sr-only">Customer details</legend>
        <label>Name <input autoFocus value={form.name} maxLength={80} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
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
        }, "Customer added.")}>Create customer</button>
      </fieldset>
        </section> : selected
          ? <CustomerProfile key={selected.customer.id} detail={selected} types={types} isAdmin={isAdmin} onChanged={async () => { await open(selected.customer.id); await search(); }} />
          : <section className="panel customer-welcome">
              <div className="customer-welcome-mark" aria-hidden="true">◉</div>
              <h2>A little familiarity goes a long way.</h2>
              <p className="muted">Select a guest to see their story with your restaurant.</p>
              <dl><div><dt>Visits &amp; favourites</dt><dd>Remember what brings them back.</dd></div><div><dt>Points &amp; rewards</dt><dd>Keep their next reward in sight.</dd></div><div><dt>Details &amp; feedback</dt><dd>Give every visit a personal touch.</dd></div></dl>
            </section>}
      </div>
    </div>
  </>;
}
