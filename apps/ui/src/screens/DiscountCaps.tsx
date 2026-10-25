import { useEffect, useState } from "react";
import { ApiError, apiFetch } from "../api";

type CapRole = "cashier" | "waiter" | "kitchen";
interface Cap { role: string; maxPercent: number | null }
const LABELS: Record<string, string> = { cashier: "Cashier", waiter: "Captain / waiter", kitchen: "Kitchen" };

/** Discount limit per role. A discount above a person's limit needs an admin PIN at billing; an individual limit is set in the staff list. */
export function DiscountCaps() {
  const [caps, setCaps] = useState<Cap[]>([]);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  function accept(next: Cap[]) {
    setCaps(next);
    setDraft(Object.fromEntries(next.map((c) => [c.role, c.maxPercent === null ? "" : String(c.maxPercent)])));
  }
  useEffect(() => {
    apiFetch<{ caps: Cap[] }>("/api/discount-caps").then((r) => accept(r.caps)).catch(() => setError("Failed to load discount limits"));
  }, []);

  async function save() {
    if (busy) return;
    const edited: Array<{ role: CapRole; maxPercent: number | null }> = [];
    for (const cap of caps) {
      if (cap.role === "admin") continue;
      const raw = (draft[cap.role] ?? "").trim();
      const value = raw === "" ? null : Number(raw);
      if (value !== null && (!Number.isFinite(value) || value < 0 || value > 100)) { setError(`${LABELS[cap.role]}: enter 0 to 100, or leave blank for no limit`); return; }
      edited.push({ role: cap.role as CapRole, maxPercent: value });
    }
    setBusy(true); setError(""); setMessage("");
    try {
      accept((await apiFetch<{ caps: Cap[] }>("/api/discount-caps", { method: "PUT", body: JSON.stringify({ caps: edited }) })).caps);
      setMessage("Discount limits saved.");
    } catch (e) { setError(e instanceof ApiError ? e.message : "Request failed"); }
    finally { setBusy(false); }
  }

  if (!caps.length) return error ? <p role="alert">{error}</p> : null;
  return <section aria-label="Discount limits" className="panel">
    <h3>Discount limits</h3>
    <p>The most a role can discount on a bill, as a percent of the subtotal. Above it, billing asks for an admin PIN. Leave blank for no limit. Admins have no limit.</p>
    <fieldset disabled={busy} style={{ border: 0, padding: 0, minWidth: 0 }}>
      {caps.filter((c) => c.role !== "admin").map((c) => <p key={c.role}>
        <label>{LABELS[c.role]} (%) <input type="number" min={0} max={100} step="0.5" style={{ width: 80 }} value={draft[c.role] ?? ""} onChange={(e) => setDraft({ ...draft, [c.role]: e.target.value })} /></label>
      </p>)}
      <button className="primary" onClick={() => void save()}>Save discount limits</button>
    </fieldset>
    {error && <p role="alert">{error}</p>}
    {message && <p role="status">{message}</p>}
  </section>;
}
