import { useEffect, useState } from "react";
import { ApiError, apiFetch } from "../api";

import type { AdminUser } from "../types";

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
    <StaffLimits />
    {error && <p role="alert">{error}</p>}
    {message && <p role="status">{message}</p>}
  </section>;
}

function StaffLimits() {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [selected, setSelected] = useState("");
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  useEffect(() => {
    apiFetch<{ users: AdminUser[] }>("/api/users").then(({ users }) =>
      setUsers(users.filter((user) => user.role !== "admin"))
    ).catch(() => setError("Failed to load staff discount limits"));
  }, []);

  async function save() {
    const limit = value === "" ? null : Number(value);
    setBusy(true);
    setMessage("");
    setError("");
    try {
      await apiFetch(`/api/users/${selected}`, { method: "PATCH", body: JSON.stringify({ maxDiscountPercent: limit }) });
      setUsers((rows) => rows.map((row) => row.id === selected ? { ...row, maxDiscountPercent: limit } : row));
      setMessage("Staff limit saved.");
    } catch (e) { setError(e instanceof ApiError ? e.message : "Could not save staff limit"); }
    finally { setBusy(false); }
  }

  return <fieldset className="bill-settings-group" disabled={busy}>
    <legend>Individual staff limits</legend>
    <label>Staff member <select value={selected} onChange={(event) => {
      const id = event.target.value;
      setSelected(id);
      setValue(String(users.find((user) => user.id === id)?.maxDiscountPercent ?? ""));
      setMessage("");
      setError("");
    }}>
      <option value="">Choose staff member</option>
      {users.map((user) => <option key={user.id} value={user.id}>{user.name} ({user.username || LABELS[user.role]})</option>)}
    </select></label>
    {selected && <>
      <label>Discount limit (%) <input type="number" min="0" max="100" step="any" placeholder="Role default" value={value} onChange={(event) => { setValue(event.target.value); setMessage(""); }} /></label>
      <button type="button" disabled={Number(value) < 0 || Number(value) > 100} onClick={() => void save()}>Save staff limit</button>
    </>}
    {error && <p role="alert">{error}</p>}
    {message && <p role="status">{message}</p>}
  </fieldset>;
}
