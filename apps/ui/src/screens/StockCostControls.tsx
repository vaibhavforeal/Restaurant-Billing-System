import { useRef, useState } from "react";
import type { StockItem } from "@forkflow/domain";
import { apiFetch } from "../api";
import { formatUnitCost, perUnitHint, rupeesPerUnitToMilliPaise } from "../stock-costs";
import { uuid } from "../uuid";

const formStyle = { display: "flex", flexWrap: "wrap", alignItems: "end", gap: "var(--space-4, 12px)", marginTop: "var(--space-6, 24px)" } as const;
const fieldStyle = { display: "grid", gap: "var(--space-2, 6px)" };

/** Live "= ₹34.00/kg" line under the Receive stock form; blank until an amount paid is typed. */
export function PerUnitHint({ amountPaid, quantity, unit }: { amountPaid: string; quantity: string; unit: StockItem["unit"] }) {
  const hint = perUnitHint(amountPaid, quantity, unit);
  return hint ? <p aria-live="polite">{hint}</p> : null;
}

/** Admin-only form to set an item's unit cost directly (opening cost or correction). */
export function SetUnitCostForm({ item, onSaved, onNotice }: { item: StockItem; onSaved: (item: StockItem) => void; onNotice: (text: string) => void }) {
  const [cost, setCost] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const request = useRef<{ fingerprint: string; ref: string } | null>(null);
  async function submit() {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError("");
    try {
      const unitCostMilliPaise = rupeesPerUnitToMilliPaise(cost);
      if (unitCostMilliPaise === null) throw new Error("Enter a cost above zero, in rupees, with up to 4 decimal places");
      const body = { expectedVersion: item.version, unitCostMilliPaise, note };
      const fingerprint = JSON.stringify(body);
      if (request.current?.fingerprint !== fingerprint) request.current = { fingerprint, ref: uuid() };
      const { item: next } = await apiFetch<{ item: StockItem }>(`/api/stock-items/${item.id}/unit-cost`, { method: "POST", body: JSON.stringify({ ...body, clientRef: request.current.ref }) });
      request.current = null; setCost(""); setNote("");
      onNotice(`Unit cost for ${next.name} set to ${formatUnitCost(unitCostMilliPaise, next.unit)}.`);
      onSaved(next);
    } catch (e) { setError(e instanceof Error ? e.message : "Could not set the unit cost"); }
    finally { lock.current = false; setBusy(false); }
  }
  return <form style={formStyle} aria-label="Set unit cost" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
    <label style={fieldStyle}>Set unit cost (₹ per {item.unit})<input type="text" inputMode="decimal" required placeholder="0.00" value={cost} onChange={(e) => setCost(e.target.value)} disabled={busy} /></label>
    <label style={fieldStyle}>Reason / reference<input required maxLength={200} value={note} onChange={(e) => setNote(e.target.value)} disabled={busy} /></label>
    <button disabled={busy}>Set unit cost</button>
    <p role="alert" style={{ color: "var(--danger-text, crimson)", flexBasis: "100%", margin: 0 }}>{error}</p>
  </form>;
}
