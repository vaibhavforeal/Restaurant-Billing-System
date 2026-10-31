import { useState, type FormEvent } from "react";
import type { Colleague, CustomerDetail, CustomerInput, CustomerSummary, StaffUser } from "../../../licensing-worker/src/portal/api-types";
import { GST_STATES, roleCan } from "../../../licensing-worker/src/portal/shared";
import { api, patch, post, query } from "../api";
import { daysFromToday, plural, relativeDay } from "../format";
import { Link, navigate, useLocation } from "../router";
import { Dialog, EmptyRow, Field, LoadError, PageHead, Person, Pill, useData, useRun } from "../ui";

export function Customers({ me }: { me: StaffUser }) {
  const { search } = useLocation();
  const [text, setText] = useState(search.get("q") ?? "");
  const [owner, setOwner] = useState("");
  const [offset, setOffset] = useState(0);
  const [adding, setAdding] = useState(false);
  const key = query({ q: text.trim(), ownerId: owner, offset });
  const { data, error, reload } = useData(() => api<{ customers: CustomerSummary[]; total: number; pageSize: number }>(`/customers${key}`), key);
  const staff = useData(() => api<{ staff: Colleague[] }>("/staff"), "staff");
  const own = me.role === "sales";
  return <>
    <PageHead title="Customers" sub={data ? `${plural(data.total, "customer")}${own ? " assigned to you" : ""}` : "Loading customers…"}
      actions={roleCan(me.role, "customers.write") && <button className="primary" onClick={() => setAdding(true)}>Add customer</button>} />
    <div className="toolbar">
      <input type="search" className="search-box" aria-label="Search customers" placeholder="Name, phone, email, GSTIN or Customer ID" value={text}
        onChange={(e) => { setText(e.target.value); setOffset(0); }} />
      {!own && <select aria-label="Sales rep" value={owner} onChange={(e) => { setOwner(e.target.value); setOffset(0); }} style={{ width: 200 }}>
        <option value="">Every rep</option><option value="none">Not assigned</option>
        {staff.data?.staff.filter((s) => s.role === "sales" || s.role === "admin").map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
      </select>}
    </div>
    {error && <LoadError message={error} retry={reload} />}
    <div className="table-wrap"><table className="data stack-phone">
      <thead><tr><th>Customer</th><th className="phone-hide">Place</th><th className="num">Outlets</th><th className="num">Next renewal</th>{!own && <th className="phone-hide">Rep</th>}</tr></thead>
      <tbody>
        {data?.customers.map((c) => <tr key={c.id} className="clickable" onClick={() => navigate(`/customers/${c.id}`)}>
          <td><Link className="name" to={`/customers/${c.id}`} onClick={(e) => e.stopPropagation()}>{c.businessName}</Link>
            <span className="sub"><span className="mono">{c.code}</span>{c.contactName && ` · ${c.contactName}`}{c.status === "inactive" && " · Inactive"}</span></td>
          <td className="phone-hide muted">{[c.city, c.stateCode && GST_STATES[c.stateCode]].filter(Boolean).join(", ") || "—"}</td>
          <td className="num">{c.outlets}</td>
          <td className="num"><Renewal at={c.nextRenewalAt} /></td>
          {!own && <td className="phone-hide">{c.owner ? <Person name={c.owner.name} id={c.owner.id} /> : <span className="muted">Not assigned</span>}</td>}
        </tr>)}
        {data && data.customers.length === 0 && <EmptyRow columns={own ? 4 : 5}>{text ? `No customer matches “${text}”.` : "No customers yet. Add one, or convert a lead."}</EmptyRow>}
      </tbody>
    </table></div>
    {data && data.total > data.pageSize && <div className="more"><span className="muted">{offset + 1}to{Math.min(offset + data.pageSize, data.total)} of {data.total}</span>
      <button className="secondary small" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - data.pageSize))}>Previous</button>
      <button className="secondary small" disabled={offset + data.pageSize >= data.total} onClick={() => setOffset(offset + data.pageSize)}>Next</button></div>}
    {adding && <CustomerDialog me={me} staff={staff.data?.staff ?? []} onClose={() => setAdding(false)} onSaved={(c) => navigate(`/customers/${c.id}`)} />}
  </>;
}

/** The licence end date that matters, coloured only when it needs attention. */
export function Renewal({ at }: { at: number | null }) {
  if (at === null) return <span className="muted">Not set</span>;
  const days = daysFromToday(at);
  return days < 0 ? <Pill tone="negative">Ended {relativeDay(at).toLowerCase()}</Pill> : days <= 30 ? <Pill tone="warning">{relativeDay(at)}</Pill> : <>{relativeDay(at)}</>;
}

const EMPTY: CustomerInput = { businessName: "", contactName: "", phone: "", email: "", gstin: "", address: "", city: "", stateCode: "", pincode: "", notes: "" };

export function CustomerDialog({ me, staff, customer, initial, onClose, onSaved }: {
  me: StaffUser; staff: Colleague[]; customer?: CustomerDetail; initial?: Partial<CustomerInput>; onClose: () => void; onSaved: (c: CustomerDetail) => void;
}) {
  const [form, setForm] = useState<CustomerInput>(() => customer ? {
    businessName: customer.businessName, contactName: customer.contactName ?? "", phone: customer.phone ?? "", email: customer.email ?? "", gstin: customer.gstin ?? "",
    address: customer.address ?? "", city: customer.city ?? "", stateCode: customer.stateCode ?? "", pincode: customer.pincode ?? "", notes: customer.notes ?? "",
    ownerId: customer.owner?.id ?? null, status: customer.status,
  } : { ...EMPTY, ...initial, ...(me.role === "admin" ? { ownerId: me.id } : {}) });
  const { busy, run, status } = useRun();
  const set = (key: keyof CustomerInput) => (e: { target: { value: string } }) => setForm({ ...form, [key]: e.target.value });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const body = me.role === "admin" ? form : (({ ownerId, ...rest }) => { void ownerId; return rest; })(form);
    void run(async () => onSaved((customer ? await patch<{ customer: CustomerDetail }>(`/customers/${customer.id}`, body) : await post<{ customer: CustomerDetail }>("/customers", body)).customer));
  };
  return <Dialog title={customer ? `Edit ${customer.businessName}` : "Add customer"} onClose={onClose} wide>
    <form onSubmit={submit} className="form-grid">
      <Field label="Business name" wide><input required maxLength={120} autoFocus value={form.businessName} onChange={set("businessName")} disabled={busy} /></Field>
      <Field label="Contact person"><input maxLength={80} value={form.contactName} onChange={set("contactName")} disabled={busy} /></Field>
      <Field label="Phone"><input type="tel" maxLength={20} value={form.phone} onChange={set("phone")} disabled={busy} /></Field>
      <Field label="Email" hint="Razorpay sends payment links here."><input type="email" maxLength={254} value={form.email} onChange={set("email")} disabled={busy} /></Field>
      <Field label="GSTIN" hint="Leave blank for a restaurant without GST registration."><input maxLength={15} value={form.gstin} onChange={set("gstin")} disabled={busy} /></Field>
      <Field label="Address" wide><input maxLength={300} value={form.address} onChange={set("address")} disabled={busy} /></Field>
      <Field label="City"><input maxLength={80} value={form.city} onChange={set("city")} disabled={busy} /></Field>
      <Field label="State" hint="Decides CGST and SGST or IGST on invoices."><select value={form.stateCode} onChange={set("stateCode")} disabled={busy}>
        <option value="">Choose a state</option>{Object.entries(GST_STATES).map(([code, name]) => <option key={code} value={code}>{name}</option>)}</select></Field>
      <Field label="PIN code"><input maxLength={6} inputMode="numeric" value={form.pincode} onChange={set("pincode")} disabled={busy} /></Field>
      {me.role === "admin" && <Field label="Sales rep"><select value={form.ownerId ?? ""} onChange={(e) => setForm({ ...form, ownerId: e.target.value || null })} disabled={busy}>
        <option value="">Not assigned</option>{staff.filter((s) => s.role === "sales" || s.role === "admin").map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>}
      {customer && <Field label="Status"><select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value as "active" | "inactive" })} disabled={busy}>
        <option value="active">Active</option><option value="inactive">Inactive (no longer a customer)</option></select></Field>}
      <Field label="Notes" wide><textarea rows={3} maxLength={2000} value={form.notes} onChange={set("notes")} disabled={busy} /></Field>
      <div className="wide">{status}</div>
      <div className="form-actions wide"><button type="button" className="secondary" onClick={onClose}>Cancel</button><button className="primary" disabled={busy}>{customer ? "Save" : "Add customer"}</button></div>
    </form>
  </Dialog>;
}
