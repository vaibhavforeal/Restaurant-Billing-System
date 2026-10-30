import { useEffect, useState, type FormEvent } from "react";
import type { PortalSettingsData, PriceRow } from "../../../licensing-worker/src/portal/api-types";
import { formatPaise, GST_STATES, parseRupees } from "../../../licensing-worker/src/portal/shared";
import { api, put } from "../api";
import { useLeaveGuard } from "../router";
import { Field, LoadError, PageHead, useData, useRun } from "../ui";

const TERMS = [1, 3, 6, 12, 24, 36];
const rupees = (paise: number) => formatPaise(paise, "").replace(/\.00$/, "");

export function Settings() {
  const { data, error, reload } = useData(() => api<{ settings: PortalSettingsData }>("/settings"), "settings");
  return <>
    <PageHead title="Settings" sub="The seller details and wording on every GST invoice, and the prices new orders start from." />
    {error && <LoadError message={error} retry={reload} />}
    {data && <SettingsForm initial={data.settings} />}
  </>;
}

function SettingsForm({ initial }: { initial: PortalSettingsData }) {
  const [s, setS] = useState(initial);
  const [prices, setPrices] = useState(() => priceTable(initial.prices));
  const [extraDevice, setExtraDevice] = useState(rupees(initial.extraDevicePaise));
  const [saved, setSaved] = useState(JSON.stringify(initial));
  const { busy, run, status, setError } = useRun();
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
  const submit = (e: FormEvent) => {
    e.preventDefault();
    let next: PortalSettingsData;
    try { next = current(); } catch (err) { setError((err as Error).message); return; }
    void run(async () => {
      const { settings } = await put<{ settings: PortalSettingsData }>("/settings", next);
      setS(settings); setPrices(priceTable(settings.prices)); setExtraDevice(rupees(settings.extraDevicePaise)); setSaved(JSON.stringify(settings));
    }, "Settings saved.");
  };
  return <form onSubmit={submit}>
    <section className="settings-section">
      <div><h2>Seller on invoices</h2><p>ForkFlow's legal name, GSTIN and address as printed on every tax invoice. The state decides CGST and SGST or IGST.</p></div>
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
    <section className="settings-section">
      <div><h2>Invoice wording</h2><p>Numbers read {s.invoice.prefix || "FF"}/26-27/000001 and restart each financial year. The SAC and rate apply to licence lines.</p></div>
      <div className="settings-panel form-grid">
        <Field label="Number prefix" hint="1 to 4 letters or digits"><input maxLength={4} value={s.invoice.prefix} onChange={invoice("prefix")} /></Field>
        <Field label="SAC for licences" hint="997331: licensing the right to use software"><input maxLength={8} inputMode="numeric" value={s.invoice.sac} onChange={invoice("sac")} /></Field>
        <Field label="GST rate"><select value={s.invoice.gstRateBp} onChange={(e) => setS({ ...s, invoice: { ...s.invoice, gstRateBp: Number(e.target.value) } })}>
          {[0, 500, 1200, 1800, 2800].map((bp) => <option key={bp} value={bp}>{bp / 100}%</option>)}</select></Field>
        <Field label="Bank details" wide hint="Printed under the totals, for customers paying by bank transfer."><textarea rows={3} maxLength={500} value={s.invoice.bankDetails} onChange={invoice("bankDetails")} /></Field>
        <Field label="Terms" wide><textarea rows={3} maxLength={1000} value={s.invoice.terms} onChange={invoice("terms")} /></Field>
      </div>
    </section>
    <section className="settings-section">
      <div><h2>Price list</h2><p>Price per outlet before GST. New orders start from these; staff can change the price on an order. Leave a term blank if it isn't sold.</p></div>
      <div className="settings-panel">
        <table className="data"><thead><tr><th>Term</th><th className="num">Basic (₹)</th><th className="num">Pro (₹)</th></tr></thead>
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
    <div className="form-actions" style={{ justifyContent: "flex-start", alignItems: "center" }}>
      <button className="primary" disabled={busy || !dirty}>{busy ? "Saving…" : "Save settings"}</button>
      {!dirty && !status && <span className="muted">All changes saved.</span>}
    </div>
    {status}
  </form>;
}

function priceTable(rows: PriceRow[]): Record<string, string> {
  return Object.fromEntries(rows.map((r) => [`${r.plan}:${r.termMonths}`, rupees(r.pricePaise)]));
}
const label = (key: string) => { const [plan, months] = key.split(":"); return `${plan === "pro" ? "Pro" : "Basic"}, ${months} months`; };
