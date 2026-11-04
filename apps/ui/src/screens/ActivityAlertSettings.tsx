import { useEffect, useState } from "react";
import type { ActivityThresholds } from "@masalapos/domain";
import { ApiError, apiFetch } from "../api";

type Form = Record<keyof ActivityThresholds, string>;
const toForm = (t: ActivityThresholds): Form => ({ cashShortPaise: String(t.cashShortPaise / 100), discountPercent: String(t.discountPercent),
  payOutPaise: String(t.payOutPaise / 100), multiplier: String(t.multiplier), minEvents: String(t.minEvents) });
const FIELDS: Array<{ key: keyof ActivityThresholds; label: string; hint: string; step: string }> = [
  { key: "cashShortPaise", label: "Cash short at shift close (₹)", hint: "Flag a drawer short by this much or more.", step: "1" },
  { key: "discountPercent", label: "Discount (% of bill)", hint: "Flag a discount of this share of the bill or more.", step: "0.5" },
  { key: "payOutPaise", label: "Single pay-out (₹)", hint: "Flag a pay-out from the drawer over this amount.", step: "1" },
  { key: "multiplier", label: "Unusual at (× normal)", hint: "Flag a person doing something this many times their usual daily rate...", step: "0.5" },
  { key: "minEvents", label: "Minimum events", hint: "...and at least this many times in the chosen dates.", step: "1" },
];

/** Settings → Restaurant profile → Staff activity alerts: the limits the Staff activity report flags at. */
export function ActivityAlertSettings() {
  const [form, setForm] = useState<Form | null>(null);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    apiFetch<{ thresholds: ActivityThresholds }>("/api/settings/activity-alerts").then((r) => setForm(toForm(r.thresholds)))
      .catch(() => setStatus({ ok: false, text: "Could not load the staff activity limits." }));
  }, []);
  async function save() {
    if (!form || busy) return;
    setBusy(true); setStatus(null);
    try {
      const body: ActivityThresholds = { cashShortPaise: Math.round(Number(form.cashShortPaise) * 100), discountPercent: Number(form.discountPercent),
        payOutPaise: Math.round(Number(form.payOutPaise) * 100), multiplier: Number(form.multiplier), minEvents: Number(form.minEvents) };
      const saved = await apiFetch<{ thresholds: ActivityThresholds }>("/api/settings/activity-alerts", { method: "PUT", body: JSON.stringify(body) });
      setForm(toForm(saved.thresholds)); setStatus({ ok: true, text: "Saved ✓" });
    } catch (e) { setStatus({ ok: false, text: e instanceof ApiError && e.status === 400 ? "Check the limits: amounts can't be negative, the discount is 0–100%, and 'Unusual at' is at least 1×." : "Could not save the limits." }); }
    finally { setBusy(false); }
  }
  return <fieldset className="activity-alert-settings" style={{ display: "grid", gap: 10, marginTop: 20, border: "1px solid var(--line)", borderRadius: "var(--radius-panel, 6px)", padding: 14 }}>
    <legend style={{ fontWeight: 650, padding: "0 6px" }}>Staff activity alerts</legend>
    <p className="muted" style={{ margin: 0, fontSize: 12 }}>Limits for Reports → Staff activity. A flag is a prompt to look, not proof of wrongdoing.</p>
    {form && FIELDS.map(({ key, label, hint, step }) => <label key={key} style={{ display: "grid", gap: 4, maxWidth: 360 }}>{label}
      <input type="number" min="0" step={step} inputMode="decimal" value={form[key]} disabled={busy} onChange={(e) => { setForm({ ...form, [key]: e.target.value }); setStatus(null); }} />
      <small className="muted">{hint}</small></label>)}
    <div><button type="button" className="primary" disabled={!form || busy} onClick={() => void save()}>Save limits</button></div>
    {status && <div role={status.ok ? "status" : "alert"} style={{ color: status.ok ? "var(--success-text, green)" : "var(--danger-text, crimson)" }}>{status.text}</div>}
  </fieldset>;
}
