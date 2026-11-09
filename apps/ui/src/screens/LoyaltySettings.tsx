import { useEffect, useState } from "react";
import { apiFetch } from "../api";
import { InfoTip } from "../InfoTip";
import { paiseToRupees, rupeesToPaise } from "../money";
import { useRun, type LoyaltySettings as LoyaltySettingsData, type LoyaltyTier } from "./customer-shared";
import "../customers.css";

/** Settings → Loyalty: the points programme and its tiers (CRM & Loyalty add-on). The feedback QR switch is in Bill settings. */
export function LoyaltySettings() {
  const [tiers, setTiers] = useState<LoyaltyTier[]>([]);
  const loadTiers = async () => setTiers((await apiFetch<{ tiers: LoyaltyTier[] }>("/api/loyalty-tiers")).tiers);
  useEffect(() => { void loadTiers().catch(() => undefined); }, []);
  return <>
    <LoyaltySettingsCard />
    <TiersCard tiers={tiers} onChanged={loadTiers} />
  </>;
}

interface SettingsForm {
  enabled: boolean; pointsPer100: string; pointValue: string; minRedeemPoints: string; expiryMonths: string;
  tiersEnabled: boolean; tierWindowMonths: string; maxRedeemPercent: string;
}
function LoyaltySettingsCard() {
  const [form, setForm] = useState<SettingsForm | null>(null);
  const { busy, run, status } = useRun();
  const accept = (s: LoyaltySettingsData) => setForm({
    enabled: s.enabled, pointsPer100: String(s.pointsPer100), pointValue: paiseToRupees(s.pointValuePaise), minRedeemPoints: String(s.minRedeemPoints),
    expiryMonths: String(s.expiryMonths), tiersEnabled: s.tiersEnabled, tierWindowMonths: String(s.tierWindowMonths),
    maxRedeemPercent: String(s.maxRedeemPercent),
  });
  useEffect(() => { void apiFetch<{ settings: LoyaltySettingsData }>("/api/loyalty-settings").then((r) => accept(r.settings)).catch(() => undefined); }, []);
  if (!form) return null;
  const set = (patch: Partial<SettingsForm>) => setForm({ ...form, ...patch });
  return <section className="panel" aria-label="Loyalty points">
    <h3>Loyalty points <InfoTip>Customers earn points on every bill with their number on it, and can spend them as a discount on a later bill. Voids take the points back.</InfoTip></h3>
    <fieldset disabled={busy} className="cash-drawer-form">
      <label className="crm-check"><input type="checkbox" checked={form.enabled} onChange={(e) => set({ enabled: e.target.checked })} /> Loyalty points on</label>
      <label>Points per ₹100 spent <input type="number" min="1" max="100" value={form.pointsPer100} onChange={(e) => set({ pointsPer100: e.target.value })} /></label>
      <label>Value of 1 point (₹) <input type="number" min="0.01" step="0.01" value={form.pointValue} onChange={(e) => set({ pointValue: e.target.value })} /></label>
      <label>Minimum points to redeem <input type="number" min="0" value={form.minRedeemPoints} onChange={(e) => set({ minRedeemPoints: e.target.value })} /></label>
      <label>Points can pay up to (% of bill) <input type="number" min="1" max="100" value={form.maxRedeemPercent} onChange={(e) => set({ maxRedeemPercent: e.target.value })} /></label>
      <label><span>Points expire after (months, 0 = never) <InfoTip>A new expiry period applies to points earned from now on.</InfoTip></span><input type="number" min="0" max="120" value={form.expiryMonths} onChange={(e) => set({ expiryMonths: e.target.value })} /></label>
      <label className="crm-check"><input type="checkbox" checked={form.tiersEnabled} onChange={(e) => set({ tiersEnabled: e.target.checked })} /> Use tiers</label>
      {form.tiersEnabled && <label>Tier from spend in the last (months) <input type="number" min="1" max="60" value={form.tierWindowMonths} onChange={(e) => set({ tierWindowMonths: e.target.value })} /></label>}
      <button className="primary" onClick={() => void run(async () => {
        const pointValuePaise = rupeesToPaise(form.pointValue);
        if (!pointValuePaise) throw new Error("Enter the value of a point in rupees");
        const { settings } = await apiFetch<{ settings: LoyaltySettingsData }>("/api/loyalty-settings", { method: "PUT", body: JSON.stringify({
          enabled: form.enabled, pointsPer100: Number(form.pointsPer100), pointValuePaise, minRedeemPoints: Number(form.minRedeemPoints),
          expiryMonths: Number(form.expiryMonths), tiersEnabled: form.tiersEnabled, tierWindowMonths: Number(form.tierWindowMonths),
          maxRedeemPercent: Number(form.maxRedeemPercent),
        }) });
        accept(settings);
      }, "Loyalty settings saved.")}>Save loyalty settings</button>
    </fieldset>

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
    <h3>Tiers <InfoTip>With "Use tiers" on, a customer's tier comes from what they spent recently, and the tier multiplies the points they earn. With it off, everyone earns points the same way.</InfoTip></h3>
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
