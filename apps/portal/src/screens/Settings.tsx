import { useEffect, useRef, useState, type FormEvent } from "react";
import type { PortalSettingsData, PriceRow } from "../../../licensing-worker/src/portal/api-types";
import { formatPaise, GST_STATES, parseRupees } from "../../../licensing-worker/src/portal/shared";
import { api, put } from "../api";
import { useLeaveGuard } from "../router";
import { Field, LoadError, PageHead, useData, useRun } from "../ui";
import { Icon } from "../icons";

const TERMS = [1, 3, 6, 12, 24, 36];
const rupees = (paise: number) => formatPaise(paise, "").replace(/\.00$/, "");
const SECTIONS = [
  { id: "seller", title: "Seller on invoices", blurb: "Legal name, GSTIN, address and contact details", icon: "customers" },
  { id: "invoice", title: "Invoice wording", blurb: "Numbering, tax rate, bank details and terms", icon: "invoices" },
  { id: "prices", title: "Price list", blurb: "Plan prices, extra devices and trial length", icon: "orders" },
] as const;
type SectionId = typeof SECTIONS[number]["id"];
type SettingsControl = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

export function Settings() {
  const { data, error, reload } = useData(() => api<{ settings: PortalSettingsData }>("/settings"), "settings");
  return <div className="portal-settings-page">
    <PageHead title="Settings" />
    {error && <LoadError message={error} retry={reload} />}
    {data && <SettingsForm initial={data.settings} />}
  </div>;
}

function SettingsForm({ initial }: { initial: PortalSettingsData }) {
  const [active, setActive] = useState<SectionId | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const cards = useRef<Partial<Record<SectionId, HTMLButtonElement | null>>>({});
  const returnToCard = useRef<SectionId | null>(null);
  const invalidControl = useRef<SettingsControl | null>(null);
  const [s, setS] = useState(initial);
  const [prices, setPrices] = useState(() => priceTable(initial.prices));
  const [extraDevice, setExtraDevice] = useState(rupees(initial.extraDevicePaise));
  const [saved, setSaved] = useState(JSON.stringify(initial));
  const { busy, run, status, setError, setMessage } = useRun();
  useEffect(() => {
    if (invalidControl.current) {
      invalidControl.current.reportValidity();
      invalidControl.current = null;
    } else if (active) heading.current?.focus();
    else if (returnToCard.current) cards.current[returnToCard.current]?.focus();
  }, [active]);
  const current = () => {
    const rows: PriceRow[] = [];
    for (const [key, text] of Object.entries(prices)) {
      if (!text.trim()) continue;
      const pricePaise = parseRupees(text);
      if (pricePaise === null) throw new Error(`Check the price for ${label(key)}.`);
      const [plan, months] = key.split(":") as ["basic" | "pro", string];
      rows.push({ plan, termMonths: Number(months), pricePaise });
    }
    const extraDevicePaise = parseRupees(extraDevice || "0");
    if (extraDevicePaise === null) throw new Error("Check the extra device price.");
    return { ...s, prices: rows, extraDevicePaise };
  };
  let dirty = false;
  try { dirty = JSON.stringify(current()) !== saved; } catch { dirty = true; }
  useLeaveGuard(() => !dirty || window.confirm("Leave without saving the settings?"));
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener("beforeunload", warn); return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  const seller = (key: keyof PortalSettingsData["seller"]) => (e: { target: { value: string } }) => setS({ ...s, seller: { ...s.seller, [key]: e.target.value } });
  const invoice = (key: "prefix" | "sac" | "bankDetails" | "terms") => (e: { target: { value: string } }) => setS({ ...s, invoice: { ...s.invoice, [key]: e.target.value } });
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (busy) return;
    // A draft can span sections. Reveal invalid hidden fields before asking the browser to focus them.
    const invalid = Array.from(e.currentTarget.querySelectorAll<SettingsControl>("input, select, textarea"))
      .find((field) => field.willValidate && !field.validity.valid);
    if (invalid) {
      const section = invalid.closest<HTMLElement>("[data-settings-section]")?.dataset["settingsSection"] as SectionId;
      setError(invalid.validationMessage);
      if (section === active) invalid.reportValidity();
      else { invalidControl.current = invalid; setActive(section); }
      return;
    }
    let next: PortalSettingsData;
    try { next = current(); } catch (err) { setActive("prices"); setError((err as Error).message); return; }
    void run(async () => {
      const { settings } = await put<{ settings: PortalSettingsData }>("/settings", next);
      setS(settings); setPrices(priceTable(settings.prices)); setExtraDevice(rupees(settings.extraDevicePaise)); setSaved(JSON.stringify(settings));
    }, "Settings saved.");
  };
  return <form onSubmit={submit} onChange={() => { setError(""); setMessage(""); }} noValidate>
    {active === null ? <ul className="portal-settings-cards" aria-label="Settings sections">
      {SECTIONS.map(({ id, title, blurb, icon }) => <li key={id}>
        <button type="button" className="portal-settings-card" ref={(node) => { cards.current[id] = node; }} disabled={busy}
          onClick={() => { returnToCard.current = id; setActive(id); }}>
          <span className="portal-settings-card-icon"><Icon name={icon} /></span>
          <span className="portal-settings-card-title">{title}</span>
          <span className="portal-settings-card-blurb">{blurb}</span>
        </button>
      </li>)}
    </ul> : <div className="portal-settings-detail-head">
      <button type="button" className="secondary" disabled={busy} onClick={() => { returnToCard.current = active; setActive(null); }}><Icon name="arrowLeft" />All settings</button>
      <h2 id="portal-settings-heading" ref={heading} tabIndex={-1}>{SECTIONS.find((section) => section.id === active)?.title}</h2>
    </div>}
    <fieldset className="portal-settings-fields" disabled={busy}>
    <section className="portal-settings-section" data-settings-section="seller" hidden={active !== "seller"} aria-labelledby="portal-settings-heading">
      <p>MasalaPOS's legal name, GSTIN and address as printed on every tax invoice. The state decides CGST and SGST or IGST.</p>
      <div className="settings-panel form-grid">
        <Field label="Legal name" wide><input maxLength={120} value={s.seller.legalName} onChange={seller("legalName")} /></Field>
        <Field label="GSTIN"><input maxLength={15} value={s.seller.gstin} onChange={seller("gstin")} placeholder="27AAAAA0000A1Z5" /></Field>
        <Field label="State"><select value={s.seller.stateCode} onChange={seller("stateCode")}><option value="">Choose a state</option>
          {Object.entries(GST_STATES).map(([code, name]) => <option key={code} value={code}>{code} {name}</option>)}</select></Field>
        <Field label="Address" wide><textarea rows={2} maxLength={300} value={s.seller.address} onChange={seller("address")} /></Field>
        <Field label="City"><input maxLength={80} value={s.seller.city} onChange={seller("city")} /></Field>
        <Field label="PIN code"><input maxLength={6} inputMode="numeric" value={s.seller.pincode} onChange={seller("pincode")} /></Field>
        <Field label="Email"><input type="email" maxLength={254} value={s.seller.email} onChange={seller("email")} /></Field>
        <Field label="Phone"><input type="tel" maxLength={20} value={s.seller.phone} onChange={seller("phone")} /></Field>
      </div>
    </section>
    <section className="portal-settings-section" data-settings-section="invoice" hidden={active !== "invoice"} aria-labelledby="portal-settings-heading">
      <p>Numbers read {s.invoice.prefix || "FF"}/26-27/000001 and restart each financial year. The SAC and rate apply to licence lines.</p>
      <div className="settings-panel form-grid">
        <Field label="Number prefix" hint="1 to 4 letters or digits"><input maxLength={4} value={s.invoice.prefix} onChange={invoice("prefix")} /></Field>
        <Field label="SAC for licences" hint="997331: licensing the right to use software"><input maxLength={8} inputMode="numeric" value={s.invoice.sac} onChange={invoice("sac")} /></Field>
        <Field label="GST rate"><select value={s.invoice.gstRateBp} onChange={(e) => setS({ ...s, invoice: { ...s.invoice, gstRateBp: Number(e.target.value) } })}>
          {[0, 500, 1200, 1800, 2800].map((bp) => <option key={bp} value={bp}>{bp / 100}%</option>)}</select></Field>
        <Field label="Bank details" wide hint="Printed under the totals, for customers paying by bank transfer."><textarea rows={3} maxLength={500} value={s.invoice.bankDetails} onChange={invoice("bankDetails")} /></Field>
        <Field label="Terms" wide><textarea rows={3} maxLength={1000} value={s.invoice.terms} onChange={invoice("terms")} /></Field>
      </div>
    </section>
    <section className="portal-settings-section" data-settings-section="prices" hidden={active !== "prices"} aria-labelledby="portal-settings-heading">
      <p>Price per outlet before GST. New orders start from these; staff can change the price on an order. Leave a term blank if it isn't sold.</p>
      <div className="settings-panel">
        <table className="data portal-settings-prices"><thead><tr><th>Term</th><th className="num">Basic (₹)</th><th className="num">Pro (₹)</th></tr></thead>
          <tbody>{TERMS.map((months) => <tr key={months}><td>{months === 1 ? "1 month" : `${months} months`}</td>
            {(["basic", "pro"] as const).map((plan) => <td key={plan} className="num"><input aria-label={`${plan === "pro" ? "Pro" : "Basic"}, ${months} months`} inputMode="decimal" style={{ maxWidth: 140, textAlign: "right" }}
              value={prices[`${plan}:${months}`] ?? ""} onChange={(e) => setPrices({ ...prices, [`${plan}:${months}`]: e.target.value })} /></td>)}</tr>)}</tbody></table>
        <div className="form-grid" style={{ marginTop: 16 }}>
          <Field label="Each extra device (₹)" hint="Per outlet, for the order's whole term, beyond the plan's devices."><input inputMode="decimal" value={extraDevice} onChange={(e) => setExtraDevice(e.target.value)} /></Field>
          <Field label="Trial length"><select value={s.trialDays} onChange={(e) => setS({ ...s, trialDays: Number(e.target.value) })}>
            {[7, 10, 14, 30].map((d) => <option key={d} value={d}>{d} days</option>)}</select></Field>
        </div>
      </div>
    </section>
    </fieldset>
    <div className="portal-settings-save" hidden={active === null && !dirty}>
      <button className="primary" disabled={busy || !dirty}>{busy ? "Saving…" : "Save settings"}</button>
      {dirty ? <span className="muted">Unsaved changes</span> : !status && <span className="muted">All changes saved.</span>}
    </div>
    {status}
  </form>;
}

function priceTable(rows: PriceRow[]): Record<string, string> {
  return Object.fromEntries(rows.map((r) => [`${r.plan}:${r.termMonths}`, rupees(r.pricePaise)]));
}
const label = (key: string) => { const [plan, months] = key.split(":"); return `${plan === "pro" ? "Pro" : "Basic"}, ${months} months`; };
