import { useEffect, useState } from "react";
import { ApiError, apiFetch } from "../api";
import { occasionNote, todayKey } from "../crm";
import type { Customer, Order } from "../types";
import { WorkspaceDialog } from "../WorkspaceDialog";
import { Icon } from "../Icon";

/**
 * The customer on an open order: find them by mobile number or name, or (cashier/admin) add them. Their customer-type
 * discount applies at billing, and with loyalty on they earn and can spend points.
 */
export function OrderCustomer({ order, canAdd, disabled, onSaved, compact = false, onBusyChange }: { order: Order; canAdd: boolean; disabled: boolean; onSaved: (order: Order) => void | Promise<void>; compact?: boolean; onBusyChange?: (busy: boolean) => void }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Customer[]>([]);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const customer = order.customer;
  const occasion = customer ? occasionNote(customer, todayKey()) : null;
  function working(value: boolean) { setBusy(value); onBusyChange?.(value); }

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
    working(true); setError("");
    try {
      const { order: saved } = await apiFetch<{ order: Order }>(`/api/orders/${order.id}/customer`, { method: "PATCH", body: JSON.stringify({ customerId }) });
      await onSaved(saved); setOpen(false); setQuery(""); setName("");
    } catch (e) { setError(e instanceof ApiError ? e.message : "Could not save the customer"); }
    finally { working(false); }
  }
  async function addAndAttach() {
    if (busy) return;
    working(true); setError("");
    let created: Customer;
    try { created = (await apiFetch<{ customer: Customer }>("/api/customers", { method: "POST", body: JSON.stringify({ name, phone: query }) })).customer; }
    catch (e) { setError(e instanceof ApiError ? e.message : "Could not add the customer"); working(false); return; }
    setBusy(false);
    await attach(created.id);
  }

  const searchFields = <>
    <label>Customer mobile or name<input type="search" autoFocus aria-label="Customer mobile or name" placeholder="Mobile or name" value={query} disabled={disabled || busy} onChange={(e) => setQuery(e.target.value)} /></label>
    {query.trim().length > 0 && query.trim().length < 3 && <small>Enter at least 3 characters to search.</small>}
    {results.map((c) => <button type="button" key={c.id} disabled={disabled || busy} onClick={() => void attach(c.id)}>{c.name} · {c.phone}{c.tier ? ` · ${c.tier.name}` : ""}</button>)}
    {canAdd && query.replace(/\D/g, "").length >= 10 && !results.length && <>
      <label>New customer name<input aria-label="New customer name" placeholder="Name" maxLength={80} disabled={disabled || busy} value={name} onChange={(e) => setName(e.target.value)} /></label>
      <button type="button" className="primary" disabled={disabled || busy || !name.trim()} onClick={() => void addAndAttach()}>Add</button>
    </>}
    {customer && compact && <button type="button" disabled={disabled || busy} onClick={() => void attach(null)}>Remove customer</button>}
    <button type="button" disabled={busy} onClick={() => { setOpen(false); setError(""); }}>Cancel</button>
  </>;

  if (compact) return <div className="table-summary-customer">
    <button type="button" disabled={disabled || busy || order.status !== "open"} onClick={() => setOpen(true)}><Icon name="users" size={18} /><span>{customer ? <><strong>{customer.name}</strong><small>{customer.phone}</small></> : "Search or add customer"}</span></button>
    <WorkspaceDialog open={open} title="Search or add customer" busy={busy} onClose={() => setOpen(false)} className="table-summary-dialog">
      <div className="table-summary-customer-search">{searchFields}{error && <p role="alert" className="danger-text">{error}</p>}</div>
    </WorkspaceDialog>
  </div>;
  if (order.status !== "open" || order.type === "zomato") return customer ? <p className="muted">Customer: {customer.name}</p> : null;
  return <div className="order-captain-picker order-customer">
    <span>Customer</span>
    {customer && !open ? <>
      <span><strong>{customer.name}</strong> · {customer.phone}{customer.typeName ? ` · ${customer.typeName}` : ""}{customer.tier ? ` · ${customer.tier.name}` : ""} · {customer.pointsBalance} pts</span>
      {occasion && <span className="crm-occasion">🎂 {occasion}</span>}
      <button type="button" disabled={disabled || busy} onClick={() => setOpen(true)}>Change</button>
      <button type="button" disabled={disabled || busy} aria-label="Remove customer" onClick={() => void attach(null)}>×</button>
    </> : !open ? <button type="button" disabled={disabled} onClick={() => setOpen(true)}>Add customer</button> : searchFields}
    {error && <span role="alert" className="danger-text">{error}</span>}
  </div>;
}
