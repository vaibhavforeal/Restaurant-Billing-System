import { useState, type FormEvent } from "react";
import type { Colleague, FollowUp, FollowUpKind, StaffUser } from "../../../licensing-worker/src/portal/api-types";
import { api, patch, post, query } from "../api";
import { daysFromToday, isoDay, relativeDay, startOfIsoDay, timeOfDay } from "../format";
import { Link } from "../router";
import { Dialog, EmptyRow, Field, LoadError, PageHead, Person, Pill, Tabs, useData, useRun } from "../ui";

export const KIND_NAMES: Record<FollowUpKind, string> = { call: "Call", visit: "Visit", demo: "Demo", whatsapp: "WhatsApp", email: "Email", renewal: "Renewal", payment: "Payment", other: "Other" };

/** When a follow-up is due, coloured only when it is late. */
export function Due({ at, open = true }: { at: number; open?: boolean }) {
  const late = open && at < Date.now();
  const text = `${relativeDay(at)}${daysFromToday(at) === 0 || Math.abs(daysFromToday(at)) <= 1 ? `, ${timeOfDay(at)}` : ""}`;
  return late ? <Pill tone="negative">{daysFromToday(at) < 0 ? `Overdue · ${text}` : `Late · ${text}`}</Pill> : <>{text}</>;
}

/** Follow-ups as rows: what, about whom, when; done or moved from the row. */
export function FollowUpRows({ items, showAbout = true, onChanged, loaded = true }: { items: FollowUp[]; showAbout?: boolean; onChanged: () => void; loaded?: boolean }) {
  const [closing, setClosing] = useState<FollowUp | null>(null);
  const columns = showAbout ? 4 : 3;
  return <>
    <div className="table-wrap"><table className="data stack-phone">
      <thead><tr><th>To do</th>{showAbout && <th>About</th>}<th className="num">Due</th><th className="num phone-hide"></th></tr></thead>
      <tbody>
        {items.map((f) => <tr key={f.id}>
          <td>{f.note}<span className="sub">{KIND_NAMES[f.kind]}{f.status === "done" ? ` · done${f.outcome ? `: ${f.outcome}` : ""}` : f.status === "cancelled" ? " · dropped" : ""}{!showAbout ? "" : ` · ${f.owner.name}`}</span></td>
          {showAbout && <td>{f.lead ? <Link to={`/leads/${f.lead.id}`}>{f.lead.name}</Link> : f.customer ? <Link to={`/customers/${f.customer.id}`}>{f.customer.name}</Link> : "—"}
            {f.phone && <span className="sub"><a href={`tel:${f.phone.replace(/\s/g, "")}`}>{f.phone}</a></span>}</td>}
          <td className="num">{f.status === "open" ? <Due at={f.dueAt} /> : <span className="muted">{relativeDay(f.doneAt ?? f.dueAt)}</span>}</td>
          <td className="num phone-hide">{f.status === "open" && <button className="secondary small" onClick={() => setClosing(f)}>Done…</button>}</td>
        </tr>)}
        {loaded && items.length === 0 && <EmptyRow columns={columns}>Nothing to follow up.</EmptyRow>}
      </tbody>
    </table></div>
    {closing && <CloseFollowUp followUp={closing} onClose={() => setClosing(null)} onSaved={() => { setClosing(null); onChanged(); }} />}
  </>;
}

function CloseFollowUp({ followUp, onClose, onSaved }: { followUp: FollowUp; onClose: () => void; onSaved: () => void }) {
  const [outcome, setOutcome] = useState("");
  const [day, setDay] = useState(isoDay(Date.now() + 86_400_000));
  const { busy, run, status } = useRun();
  const save = (body: Record<string, unknown>, done: string) => run(async () => { await patch(`/follow-ups/${followUp.id}`, body); onSaved(); }, done);
  return <Dialog title={followUp.note} onClose={onClose}>
    <div className="stack">
      <Field label="What happened"><input autoFocus maxLength={500} value={outcome} onChange={(e) => setOutcome(e.target.value)} placeholder="e.g. Paying by NEFT on Monday" disabled={busy} /></Field>
      <div className="actions"><button className="primary" disabled={busy} onClick={() => void save({ status: "done", outcome }, "Done.")}>Mark done</button>
        <button className="ghost" disabled={busy} onClick={() => void save({ status: "cancelled", outcome }, "Dropped.")}>Drop it</button></div>
      <div className="settings-section" style={{ paddingBottom: 0 }}><div><h2>Not yet?</h2><p>Move it to another day.</p></div>
        <div className="toolbar"><input type="date" aria-label="New date" value={day} min={isoDay(Date.now())} onChange={(e) => setDay(e.target.value)} disabled={busy} style={{ width: 180 }} />
          <button className="secondary" disabled={busy} onClick={() => void save({ dueAt: startOfIsoDay(day) + 10 * 3_600_000, ...(outcome ? { outcome } : {}) }, "Moved.")}>Move</button></div></div>
      {status}
    </div>
  </Dialog>;
}

/** A follow-up about one lead or one customer; an admin may give it to a colleague. */
export function AddFollowUp({ about, me, kind = "call", onClose, onSaved }: {
  about: { leadId: string } | { customerId: string }; me: StaffUser; kind?: FollowUpKind; onClose: () => void; onSaved: () => void;
}) {
  const [form, setForm] = useState({ kind, note: "", day: isoDay(Date.now() + 86_400_000), time: "11:00", ownerId: me.id });
  const staff = useData(() => me.role === "admin" ? api<{ staff: Colleague[] }>("/staff") : Promise.resolve({ staff: [] as Colleague[] }), "staff");
  const { busy, run, status } = useRun();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const [h, m] = form.time.split(":").map(Number) as [number, number];
    void run(async () => {
      await post("/follow-ups", { ...about, kind: form.kind, note: form.note, dueAt: startOfIsoDay(form.day) + (h * 60 + m) * 60_000, ...(form.ownerId !== me.id ? { ownerId: form.ownerId } : {}) });
      onSaved();
    });
  };
  return <Dialog title="Add a follow-up" onClose={onClose}>
    <form className="form-grid" onSubmit={submit}>
      <Field label="What to do" wide><input required autoFocus maxLength={500} value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} placeholder="e.g. Call to book the demo" disabled={busy} /></Field>
      <Field label="Kind"><select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value as FollowUpKind })} disabled={busy}>
        {Object.entries(KIND_NAMES).map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select></Field>
      {me.role === "admin" && <Field label="Who"><select value={form.ownerId} onChange={(e) => setForm({ ...form, ownerId: e.target.value })} disabled={busy}>
        <option value={me.id}>Me</option>{staff.data?.staff.filter((s) => s.id !== me.id).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>}
      <Field label="Day"><input type="date" required value={form.day} onChange={(e) => setForm({ ...form, day: e.target.value })} disabled={busy} /></Field>
      <Field label="Time"><input type="time" required value={form.time} onChange={(e) => setForm({ ...form, time: e.target.value })} disabled={busy} /></Field>
      <div className="wide">{status}</div>
      <div className="form-actions wide"><button type="button" className="secondary" onClick={onClose}>Cancel</button><button className="primary" disabled={busy}>Add follow-up</button></div>
    </form>
  </Dialog>;
}

/** Everything this person has to follow up, overdue first; admins can look at a colleague's list. */
export function FollowUps({ me }: { me: StaffUser }) {
  const [tab, setTab] = useState<"open" | "done">("open");
  const [owner, setOwner] = useState("");
  const key = query({ status: tab === "open" ? "open" : "done", ownerId: owner });
  const { data, error, reload } = useData(() => api<{ followUps: FollowUp[] }>(`/follow-ups${key}`), key);
  const staff = useData(() => me.role === "admin" ? api<{ staff: Colleague[] }>("/staff") : Promise.resolve({ staff: [] as Colleague[] }), "staff");
  const items = data?.followUps ?? [];
  const overdue = items.filter((f) => f.status === "open" && f.dueAt < Date.now()).length;
  return <>
    <PageHead title="Follow-ups" sub={tab === "open" && data ? (overdue ? `${overdue} overdue, ${items.length - overdue} coming up` : `${items.length} coming up, none overdue`) : "Calls, visits and demos you've noted for later."} />
    <Tabs label="Follow-ups" value={tab} onChange={setTab} tabs={[{ id: "open", label: "To do" }, { id: "done", label: "Done" }]} />
    {me.role === "admin" && <div className="toolbar"><select aria-label="Whose" value={owner} onChange={(e) => setOwner(e.target.value)} style={{ width: 220 }}>
      <option value="">Mine</option><option value="all">Everyone's</option>{staff.data?.staff.filter((s) => s.id !== me.id).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></div>}
    {error && <LoadError message={error} retry={reload} />}
    <FollowUpRows items={items} loaded={!!data} onChanged={() => void reload()} />
    {owner && <p className="muted small" style={{ marginTop: 8 }}>{owner === "all" ? "Everyone's follow-ups" : <>Follow-ups of <Person name={staff.data?.staff.find((s) => s.id === owner)?.name ?? ""} /></>}</p>}
  </>;
}
