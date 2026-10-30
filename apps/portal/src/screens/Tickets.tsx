import { useState, type FormEvent } from "react";
import type { Colleague, CustomerSummary, InstallationSummary, StaffUser, TicketCategory, TicketDetail, TicketPriority, TicketStatus, TicketSummary } from "../../../licensing-worker/src/portal/api-types";
import { roleCan } from "../../../licensing-worker/src/portal/shared";
import { api, patch, post, query } from "../api";
import { dateTime, plural, relativeDay } from "../format";
import { Link, navigate } from "../router";
import { Dialog, EmptyRow, Field, LoadError, PageHead, Person, Pill, Tabs, useData, useRun, type Tone } from "../ui";
import { counterName } from "./Counter";

export const STATUS_NAMES: Record<TicketStatus, string> = { open: "New", in_progress: "Working on it", waiting: "Waiting on the customer", resolved: "Resolved", closed: "Closed" };
const PRIORITY: Record<TicketPriority, [string, Tone | null]> = { urgent: ["Urgent", "negative"], high: ["High", "warning"], normal: ["Normal", null], low: ["Low", null] };
const CATEGORY_NAMES: Record<TicketCategory, string> = { activation: "Activation", licence: "Licence or plan", billing: "Billing and invoices", printing: "Printing",
  hardware: "Hardware", training: "Training", bug: "Something broken", other: "Other" };

export const PriorityMark = ({ priority }: { priority: TicketPriority }) => { const [name, tone] = PRIORITY[priority]; return tone ? <Pill tone={tone}>{name}</Pill> : <span className="muted">{name}</span>; };

type Filter = "active" | "mine" | "resolved" | "all";

export function Tickets({ me, customerId }: { me: StaffUser; customerId?: string }) {
  const [filter, setFilter] = useState<Filter>(me.role === "support" ? "mine" : "active");
  const [text, setText] = useState("");
  const [opening, setOpening] = useState(false);
  const key = query({ status: filter === "mine" ? "active" : filter === "resolved" ? "resolved" : filter, assigneeId: filter === "mine" ? "me" : null, q: text.trim(), customerId });
  const { data, error, reload } = useData(() => api<{ tickets: TicketSummary[]; counts: Record<string, number> }>(`/tickets${key}`), key);
  const active = data ? (data.counts["open"] ?? 0) + (data.counts["in_progress"] ?? 0) + (data.counts["waiting"] ?? 0) : 0;
  const canWrite = roleCan(me.role, "tickets.write");
  const list = <>
    <div className="toolbar"><input type="search" className="search-box" aria-label="Search tickets" placeholder="T-1001, subject or customer" value={text} onChange={(e) => setText(e.target.value)} />
      {customerId && canWrite && <><span className="spacer" /><button className="secondary" onClick={() => setOpening(true)}>New ticket</button></>}</div>
    {error && <LoadError message={error} retry={reload} />}
    <TicketRows tickets={data?.tickets ?? []} loaded={!!data} hideCustomer={!!customerId} />
    {opening && <NewTicket me={me} {...(customerId ? { customerId } : {})} onClose={() => setOpening(false)} onSaved={(t) => navigate(`/tickets/${t.id}`)} />}
  </>;
  if (customerId) return list;
  return <>
    <PageHead title="Support" sub={data ? `${plural(active, "ticket")} open${me.role === "sales" ? " for your customers" : ""}` : "Loading tickets…"}
      actions={canWrite && <button className="primary" onClick={() => setOpening(true)}>New ticket</button>} />
    <Tabs label="Tickets" value={filter} onChange={setFilter} tabs={[
      ...(me.role === "support" || me.role === "admin" ? [{ id: "mine" as const, label: "Mine and unassigned" }] : []),
      { id: "active", label: <>Open<span className="count">{active}</span></> }, { id: "resolved", label: "Resolved" }, { id: "all", label: "All" },
    ]} />
    {list}
  </>;
}

export function TicketRows({ tickets, loaded, hideCustomer }: { tickets: TicketSummary[]; loaded: boolean; hideCustomer?: boolean }) {
  return <div className="table-wrap"><table className="data stack-phone">
    <thead><tr><th>Ticket</th>{!hideCustomer && <th>Customer</th>}<th className="phone-hide">Priority</th><th className="phone-hide">Status</th><th className="phone-hide">With</th><th className="num">Opened</th></tr></thead>
    <tbody>
      {tickets.map((t) => <tr key={t.id} className="clickable" onClick={() => navigate(`/tickets/${t.id}`)}>
        <td><Link className="name" to={`/tickets/${t.id}`} onClick={(e) => e.stopPropagation()}>{t.subject}</Link><span className="sub">T-{t.number} · {CATEGORY_NAMES[t.category]}</span></td>
        {!hideCustomer && <td>{t.customer.name}</td>}
        <td className="phone-hide"><PriorityMark priority={t.priority} /></td>
        <td className="phone-hide">{STATUS_NAMES[t.status]}</td>
        <td className="phone-hide">{t.assignee ? <Person name={t.assignee.name} id={t.assignee.id} /> : <span className="muted">Nobody yet</span>}</td>
        <td className="num muted">{relativeDay(t.createdAt)}</td>
      </tr>)}
      {loaded && tickets.length === 0 && <EmptyRow columns={hideCustomer ? 5 : 6}>No tickets here.</EmptyRow>}
    </tbody>
  </table></div>;
}

export function Ticket({ id, me }: { id: string; me: StaffUser }) {
  const { data, error, reload, setData } = useData(() => api<{ ticket: TicketDetail }>(`/tickets/${id}`), id);
  const staff = useData(() => api<{ staff: Colleague[] }>("/staff"), "staff");
  const [note, setNote] = useState("");
  const { busy, run, status } = useRun();
  if (error) return <><PageHead title="Ticket" back={<Link to="/tickets">Support</Link>} /><LoadError message={error} retry={reload} /></>;
  const t = data?.ticket;
  if (!t) return <PageHead title="Loading…" back={<Link to="/tickets">Support</Link>} />;
  const canWrite = roleCan(me.role, "tickets.write");
  const change = (body: Partial<{ status: TicketStatus; priority: TicketPriority; assigneeId: string | null; category: TicketCategory }>, done = "") =>
    run(async () => setData(await patch<{ ticket: TicketDetail }>(`/tickets/${t.id}`, body)), done);
  return <>
    <PageHead back={<><Link to="/tickets">Support</Link> / <Link to={`/customers/${t.customer.id}`}>{t.customer.name}</Link></>} title={t.subject}
      sub={<>T-{t.number} · {CATEGORY_NAMES[t.category]} · opened {dateTime(t.createdAt)}{t.createdBy ? ` by ${t.createdBy.name}` : ""}</>}
      actions={canWrite && <>{t.status !== "resolved" && t.status !== "closed" ? <button className="primary" disabled={busy} onClick={() => void change({ status: "resolved" }, "Resolved.")}>Resolve</button>
        : <button className="secondary" disabled={busy} onClick={() => void change({ status: "open" }, "Reopened.")}>Reopen</button>}</>} />
    {status}
    <div className="grid-main">
      <div className="stack">
        {t.description && <p style={{ whiteSpace: "pre-wrap" }}>{t.description}</p>}
        <section><h2 className="section-title" style={{ marginBottom: 8 }}>Notes</h2>
          {t.comments.length === 0 ? <p className="empty-block">No notes yet. Write down what you checked and what you told the customer.</p>
            : <ol className="stack" style={{ listStyle: "none", padding: 0 }}>{t.comments.map((c) => <li key={c.id} className="panel" style={{ padding: 14 }}>
              <div className="muted small" style={{ marginBottom: 4 }}>{c.author?.name ?? "Former staff"} · {dateTime(c.createdAt)}</div><p style={{ whiteSpace: "pre-wrap" }}>{c.body}</p></li>)}</ol>}
          {canWrite && <form className="stack" style={{ marginTop: 12 }} onSubmit={(e) => { e.preventDefault(); void run(async () => { setData(await post<{ ticket: TicketDetail }>(`/tickets/${t.id}/comments`, { body: note })); setNote(""); }); }}>
            <Field label="Add a note"><textarea rows={3} maxLength={4000} required value={note} onChange={(e) => setNote(e.target.value)} disabled={busy} /></Field>
            <div><button className="secondary" disabled={busy || !note.trim()}>Add note</button></div></form>}
        </section>
      </div>
      <aside className="rail"><h2>Ticket</h2><dl className="kv">
        <dt>Status</dt><dd>{canWrite ? <select aria-label="Status" value={t.status} disabled={busy} onChange={(e) => void change({ status: e.target.value as TicketStatus })}>
          {Object.entries(STATUS_NAMES).map(([s, name]) => <option key={s} value={s}>{name}</option>)}</select> : STATUS_NAMES[t.status]}</dd>
        <dt>Priority</dt><dd>{canWrite ? <select aria-label="Priority" value={t.priority} disabled={busy} onChange={(e) => void change({ priority: e.target.value as TicketPriority })}>
          {Object.entries(PRIORITY).map(([p, [name]]) => <option key={p} value={p}>{name}</option>)}</select> : <PriorityMark priority={t.priority} />}</dd>
        <dt>With</dt><dd>{canWrite ? <select aria-label="Assigned to" value={t.assignee?.id ?? ""} disabled={busy} onChange={(e) => void change({ assigneeId: e.target.value || null })}>
          <option value="">Nobody yet</option>{staff.data?.staff.filter((s) => s.role === "support" || s.role === "admin").map((s) => <option key={s.id} value={s.id}>{s.name}{s.id === me.id ? " (me)" : ""}</option>)}</select>
          : t.assignee?.name ?? "Nobody yet"}</dd>
        <dt>Customer</dt><dd><Link to={`/customers/${t.customer.id}`}>{t.customer.name}</Link></dd>
        <dt>Counter</dt><dd>{t.installation?.name ?? "—"}</dd>
        {t.resolvedAt && <><dt>Resolved</dt><dd>{dateTime(t.resolvedAt)}</dd></>}
        <dt>Last change</dt><dd>{dateTime(t.updatedAt)}</dd>
      </dl></aside>
    </div>
  </>;
}

export function NewTicket({ me, customerId, onClose, onSaved }: { me: StaffUser; customerId?: string; onClose: () => void; onSaved: (t: TicketDetail) => void }) {
  const [form, setForm] = useState({ customerId: customerId ?? "", installationId: "", subject: "", description: "", category: "other" as TicketCategory, priority: "normal" as TicketPriority, assigneeId: me.role === "support" ? me.id : "" });
  const [find, setFind] = useState("");
  const customers = useData(() => customerId ? Promise.resolve({ customers: [] as CustomerSummary[] }) : api<{ customers: CustomerSummary[] }>(`/customers${query({ q: find.trim() })}`), `${customerId ?? ""}:${find}`);
  const counters = useData(() => form.customerId ? api<{ installations: InstallationSummary[] }>(`/customers/${form.customerId}/installations`) : Promise.resolve({ installations: [] as InstallationSummary[] }), form.customerId);
  const staff = useData(() => api<{ staff: Colleague[] }>("/staff"), "staff");
  const { busy, run, status, setError } = useRun();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!form.customerId) { setError("Choose the customer."); return; }
    void run(async () => onSaved((await post<{ ticket: TicketDetail }>("/tickets", { ...form, installationId: form.installationId || null, assigneeId: form.assigneeId || null })).ticket));
  };
  return <Dialog title="New support ticket" onClose={onClose} wide>
    <form className="form-grid" onSubmit={submit}>
      {!customerId && <Field label="Customer" wide>
        <input type="search" placeholder="Find by name, phone or Customer ID" value={find} onChange={(e) => { setFind(e.target.value); setForm({ ...form, customerId: "", installationId: "" }); }} disabled={busy} />
        <select aria-label="Customer" required value={form.customerId} onChange={(e) => setForm({ ...form, customerId: e.target.value, installationId: "" })} disabled={busy}>
          <option value="">Choose the customer</option>{customers.data?.customers.slice(0, 20).map((c) => <option key={c.id} value={c.id}>{c.businessName} · {c.code}</option>)}</select></Field>}
      <Field label="What's wrong" wide><input required autoFocus maxLength={160} value={form.subject} onChange={(e) => setForm({ ...form, subject: e.target.value })} placeholder="e.g. KOT printer prints blank slips" disabled={busy} /></Field>
      <Field label="Details" wide><textarea rows={4} maxLength={4000} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} disabled={busy} /></Field>
      <Field label="Kind"><select value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value as TicketCategory })} disabled={busy}>
        {Object.entries(CATEGORY_NAMES).map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select></Field>
      <Field label="Priority" hint="Urgent: the restaurant can't bill."><select value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value as TicketPriority })} disabled={busy}>
        {Object.entries(PRIORITY).map(([p, [name]]) => <option key={p} value={p}>{name}</option>)}</select></Field>
      <Field label="Counter"><select value={form.installationId} onChange={(e) => setForm({ ...form, installationId: e.target.value })} disabled={busy || !form.customerId}>
        <option value="">Not about one counter</option>{counters.data?.installations.map((i) => <option key={i.id} value={i.id}>{counterName(i)}</option>)}</select></Field>
      <Field label="With"><select value={form.assigneeId} onChange={(e) => setForm({ ...form, assigneeId: e.target.value })} disabled={busy}>
        <option value="">Nobody yet</option>{staff.data?.staff.filter((s) => s.role === "support" || s.role === "admin").map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>
      <div className="wide">{status}</div>
      <div className="form-actions wide"><button type="button" className="secondary" onClick={onClose}>Cancel</button><button className="primary" disabled={busy}>Open ticket</button></div>
    </form>
  </Dialog>;
}
