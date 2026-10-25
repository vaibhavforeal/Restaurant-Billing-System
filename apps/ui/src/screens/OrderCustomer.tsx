import { useEffect, useState } from "react";
import { ApiError, apiFetch } from "../api";
import type { Customer, Order } from "../types";

/**
 * The customer on an open order: find them by mobile number or name, or (cashier/admin) add them. Their customer-type
 * discount applies at billing, and with loyalty on they earn and can spend points.
 */
export function OrderCustomer({ order, canAdd, disabled, onSaved }: { order: Order; canAdd: boolean; disabled: boolean; onSaved: (order: Order) => void }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Customer[]>([]);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const customer = order.customer;

  useEffect(() => {
    if (!open || query.trim().length < 3) { setResults([]); return; }
    let active = true;
    const t = setTimeout(() => {
      apiFetch<{ customers: Customer[] }>(`/api/customers?q=${encodeURIComponent(query.trim())}`)
        .then((r) => { if (active) setResults(r.customers); }).catch(() => { if (active) setResults([]); });
    }, 250);
    return () => { active = false; clearTimeout(t); };
  }, [open, query]);

  async function attach(customerId: string | null) {
    if (busy) return;
    setBusy(true); setError("");
    try {
      const { order: saved } = await apiFetch<{ order: Order }>(`/api/orders/${order.id}/customer`, { method: "PATCH", body: JSON.stringify({ customerId }) });
      onSaved(saved); setOpen(false); setQuery(""); setName("");
    } catch (e) { setError(e instanceof ApiError ? e.message : "Could not save the customer"); }
    finally { setBusy(false); }
  }
  async function addAndAttach() {
    if (busy) return;
    setBusy(true); setError("");
    let created: Customer;
    try { created = (await apiFetch<{ customer: Customer }>("/api/customers", { method: "POST", body: JSON.stringify({ name, phone: query }) })).customer; }
    catch (e) { setError(e instanceof ApiError ? e.message : "Could not add the customer"); setBusy(false); return; }
    setBusy(false);
    await attach(created.id);
  }

  if (order.status !== "open" || order.type === "zomato") return customer ? <p className="muted">Customer: {customer.name}</p> : null;
  return <div className="order-captain-picker order-customer">
    <span>Customer</span>
    {customer && !open ? <>
      <span><strong>{customer.name}</strong> · {customer.phone}{customer.typeName ? ` · ${customer.typeName}` : ""} · {customer.pointsBalance} pts</span>
      <button type="button" disabled={disabled || busy} onClick={() => setOpen(true)}>Change</button>
      <button type="button" disabled={disabled || busy} aria-label="Remove customer" onClick={() => void attach(null)}>×</button>
    </> : !open ? <button type="button" disabled={disabled} onClick={() => setOpen(true)}>Add customer</button> : <>
      <input type="search" autoFocus aria-label="Customer mobile or name" placeholder="Mobile or name" value={query} onChange={(e) => setQuery(e.target.value)} />
      {results.map((c) => <button type="button" key={c.id} disabled={busy} onClick={() => void attach(c.id)}>{c.name} · {c.phone}</button>)}
      {canAdd && query.replace(/\D/g, "").length >= 10 && !results.length && <>
        <input aria-label="New customer name" placeholder="Name" maxLength={80} value={name} onChange={(e) => setName(e.target.value)} />
        <button type="button" className="primary" disabled={busy || !name.trim()} onClick={() => void addAndAttach()}>Add</button>
      </>}
      <button type="button" onClick={() => { setOpen(false); setError(""); }}>Cancel</button>
    </>}
    {error && <span role="alert" className="danger-text">{error}</span>}
  </div>;
}
