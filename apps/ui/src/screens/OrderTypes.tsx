import { InfoTip } from "../InfoTip";
import { useEffect, useState } from "react";
import { ApiError, apiFetch } from "../api";
import type { OrderTypeInfo } from "../types";

const KIND_LABEL: Record<OrderTypeInfo["kind"], string> = { dine_in: "Dine-in", takeaway: "Takeaway", delivery: "Delivery", aggregator: "Aggregator" };

/** Order types: the built-in ones can be renamed; the restaurant adds its own takeaway and delivery types. */
export function OrderTypes() {
  const [types, setTypes] = useState<OrderTypeInfo[]>([]);
  const [name, setName] = useState("");
  const [kind, setKind] = useState<"takeaway" | "delivery">("delivery");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  const reload = async () => setTypes((await apiFetch<{ orderTypes: OrderTypeInfo[] }>("/api/order-types")).orderTypes);
  useEffect(() => { reload().catch(() => setError("Failed to load order types")); }, []);

  async function run(action: () => Promise<unknown>, done: string) {
    if (busy) return;
    setBusy(true); setError(""); setMessage("");
    try { await action(); await reload(); setMessage(done); }
    catch (e) { setError(e instanceof ApiError ? e.message : "Request failed"); }
    finally { setBusy(false); }
  }
  const patch = (id: string, body: Partial<Pick<OrderTypeInfo, "name" | "isActive">>, done: string) =>
    void run(() => apiFetch(`/api/order-types/${id}`, { method: "PATCH", body: JSON.stringify(body) }), done);

  return <section className="panel" aria-label="Order types">
    <h3>Order types <InfoTip>Add your own takeaway and delivery types, such as Home delivery or Counter pickup. Staff choose the type on a takeaway order; it prints on the kitchen ticket and the bill, and the Order type sales report groups sales by it. Built-in types can be renamed but not turned off.</InfoTip></h3>
    <fieldset disabled={busy} style={{ border: 0, padding: 0, minWidth: 0 }}>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead><tr style={{ textAlign: "left" }}><th>Name</th><th>Kind</th><th>Status</th><th></th></tr></thead>
        <tbody>{types.map((t) => <tr key={t.id} style={{ opacity: t.isActive ? 1 : 0.5 }}>
          <td>{t.name}{t.isSystem && <small className="muted"> (built-in)</small>}</td>
          <td>{KIND_LABEL[t.kind]}</td>
          <td>{t.isActive ? "On" : "Off"}</td>
          <td style={{ display: "flex", gap: 4, padding: 4 }}>
            <button onClick={() => { const next = window.prompt(`Rename ${t.name}`, t.name)?.trim(); if (next && next !== t.name) patch(t.id, { name: next }, "Order type renamed."); }}>Rename</button>
            {!t.isSystem && <button onClick={() => patch(t.id, { isActive: !t.isActive }, t.isActive ? "Order type turned off." : "Order type turned on.")}>{t.isActive ? "Turn off" : "Turn on"}</button>}
          </td>
        </tr>)}</tbody>
      </table>
      <p style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "end" }}>
        <label>Name <input value={name} maxLength={40} placeholder="Home delivery" onChange={(e) => setName(e.target.value)} /></label>
        <label>Kind <select value={kind} onChange={(e) => setKind(e.target.value as "takeaway" | "delivery")}><option value="delivery">Delivery</option><option value="takeaway">Takeaway</option></select></label>
        <button className="primary" disabled={!name.trim()} onClick={() => void run(async () => {
          await apiFetch("/api/order-types", { method: "POST", body: JSON.stringify({ name: name.trim(), kind }) });
          setName("");
        }, "Order type added.")}>Add order type</button>
      </p>
    </fieldset>
    {error && <p role="alert">{error}</p>}
    {message && <p role="status">{message}</p>}
  </section>;
}
