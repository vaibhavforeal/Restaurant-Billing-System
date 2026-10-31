import { useState, type FormEvent } from "react";
import type { Colleague, LeadDetail, LeadInput, LeadSource, LeadStage, LeadSummary, StaffUser } from "../../../licensing-worker/src/portal/api-types";
import { GST_STATES, parseRupees, PLAN_NAMES } from "../../../licensing-worker/src/portal/shared";
import { api, patch, post, query } from "../api";
import { date, money, plural } from "../format";
import { Link, navigate } from "../router";
import { Dialog, EmptyRow, Field, LoadError, PageHead, Person, Pill, Tabs, useData, useRun } from "../ui";
import { AddFollowUp, Due, FollowUpRows } from "./FollowUps";

export const STAGE_NAMES: Record<LeadStage, string> = { new: "New", contacted: "Contacted", demo_scheduled: "Demo booked", demo_done: "Demo given", proposal: "Proposal sent", won: "Won", lost: "Lost" };
const OPEN_STAGES: LeadStage[] = ["new", "contacted", "demo_scheduled", "demo_done", "proposal"];
export const SOURCE_NAMES: Record<LeadSource, string> = { walk_in: "Walk-in", referral: "Referral", website: "Website", call: "Phone call", partner: "Partner", event: "Event", other: "Other" };

type Filter = "open" | LeadStage;

export function Leads({ me }: { me: StaffUser }) {
  const [filter, setFilter] = useState<Filter>("open");
  const [text, setText] = useState("");
  const [adding, setAdding] = useState(false);
  const key = query({ stage: filter, q: text.trim() });
  const { data, error, reload } = useData(() => api<{ leads: LeadSummary[]; total: number; counts: Record<string, number> }>(`/leads${key}`), key);
  const staff = useData(() => api<{ staff: Colleague[] }>("/staff"), "staff");
  const count = (s: string) => data?.counts[s] ?? 0;
  const open = OPEN_STAGES.reduce((sum, s) => sum + count(s), 0);
  const pipeline = (data?.leads ?? []).reduce((sum, l) => sum + (l.estimatedValuePaise ?? 0), 0);
  return <>
    <PageHead title="Leads" sub={data ? `${plural(open, "open lead")}${me.role === "sales" ? " of yours" : ""}${filter === "open" && pipeline ? `, worth about ${money(pipeline)}` : ""}` : "Loading leads…"}
      actions={<button className="primary" onClick={() => setAdding(true)}>Add lead</button>} />
    <div className="list-controls">
    <Tabs label="Pipeline stage" value={filter} onChange={setFilter} tabs={[
      { id: "open", label: <>Open<span className="count">{open}</span></> },
      ...OPEN_STAGES.map((s) => ({ id: s, label: <>{STAGE_NAMES[s]}<span className="count">{count(s)}</span></> })),
      { id: "won", label: <>Won<span className="count">{count("won")}</span></> }, { id: "lost", label: <>Lost<span className="count">{count("lost")}</span></> },
    ]} />
    <div className="toolbar"><input type="search" className="search-box" aria-label="Search leads" placeholder="Name, contact, phone or city" value={text} onChange={(e) => setText(e.target.value)} /></div>
    </div>
    {error && <LoadError message={error} retry={reload} />}
    <div className="table-wrap"><table className="data stack-phone">
      <thead><tr><th>Lead</th><th className="phone-hide">Stage</th><th className="phone-hide">Source</th><th className="num phone-hide">Worth</th><th className="num">Next follow-up</th>{me.role !== "sales" && <th className="phone-hide">Rep</th>}</tr></thead>
      <tbody>
        {data?.leads.map((l) => <tr key={l.id} className="clickable" onClick={() => navigate(`/leads/${l.id}`)}>
          <td><Link className="name" to={`/leads/${l.id}`} onClick={(e) => e.stopPropagation()}>{l.businessName}</Link><span className="sub">{[l.contactName, l.city].filter(Boolean).join(", ") || "—"}</span></td>
          <td className="phone-hide">{l.stage === "won" ? <Pill tone="positive">Won</Pill> : l.stage === "lost" ? <Pill>Lost</Pill> : STAGE_NAMES[l.stage]}<span className="sub">since {date(l.stageChangedAt)}</span></td>
          <td className="phone-hide muted">{SOURCE_NAMES[l.source]}</td>
          <td className="num phone-hide">{l.estimatedValuePaise ? money(l.estimatedValuePaise) : "—"}{l.expectedOutlets && <span className="sub">{plural(l.expectedOutlets, "outlet")}{l.expectedPlan ? `, ${PLAN_NAMES[l.expectedPlan]}` : ""}</span>}</td>
          <td className="num">{l.nextFollowUpAt ? <Due at={l.nextFollowUpAt} /> : <span className="muted">{OPEN_STAGES.includes(l.stage) ? "None planned" : "—"}</span>}</td>
          {me.role !== "sales" && <td className="phone-hide">{l.owner ? <Person name={l.owner.name} id={l.owner.id} /> : <span className="muted">Not assigned</span>}</td>}
        </tr>)}
        {data && data.leads.length === 0 && <EmptyRow columns={me.role === "sales" ? 5 : 6}>{text ? `No lead matches “${text}”.` : "No leads here."}</EmptyRow>}
      </tbody>
    </table></div>
    {adding && <LeadDialog me={me} staff={staff.data?.staff ?? []} onClose={() => setAdding(false)} onSaved={(l) => navigate(`/leads/${l.id}`)} />}
  </>;
}

export function Lead({ id, me }: { id: string; me: StaffUser }) {
  const { data, error, reload, setData } = useData(() => api<{ lead: LeadDetail }>(`/leads/${id}`), id);
  const staff = useData(() => api<{ staff: Colleague[] }>("/staff"), "staff");
  const [dialog, setDialog] = useState<"edit" | "followup" | "lost" | null>(null);
  const { busy, run, status } = useRun();
  if (error) return <><PageHead title="Lead" back={<Link to="/leads">Leads</Link>} /><LoadError message={error} retry={reload} /></>;
  const l = data?.lead;
  if (!l) return <PageHead title="Loading…" back={<Link to="/leads">Leads</Link>} />;
  const closed = l.stage === "won" || l.stage === "lost";
  const moveTo = (stage: LeadStage) => run(async () => setData(await post<{ lead: LeadDetail }>(`/leads/${l.id}/stage`, { stage })));
  return <>
    <PageHead back={<Link to="/leads">Leads</Link>} title={l.businessName}
      sub={<>{l.stage === "won" ? <>Won, now customer <Link to={`/customers/${l.customerId}`}>{l.businessName}</Link></> : l.stage === "lost" ? `Lost: ${l.lostReason}` : `${STAGE_NAMES[l.stage]} since ${date(l.stageChangedAt)}`}. {SOURCE_NAMES[l.source]}</>}
      actions={<><button className="secondary" onClick={() => setDialog("edit")}>Edit</button>
        {!closed && <button className="secondary" onClick={() => setDialog("followup")}>Add follow-up</button>}
        {!closed && <button className="primary" disabled={busy} onClick={() => void run(async () => {
          const { customerId } = await post<{ customerId: string }>(`/leads/${l.id}/convert`);
          navigate(`/customers/${customerId}`);
        })}>Convert to customer</button>}</>} />
    {status}
    <div className="grid-main record-workspace">
      <div className="stack">
    {!closed && <div className="toolbar stage-controls" role="group" aria-label="Stage">
      {OPEN_STAGES.map((s) => <button key={s} type="button" className={s === l.stage ? "primary small" : "secondary small"} aria-pressed={s === l.stage} disabled={busy || s === l.stage} onClick={() => void moveTo(s)}>{STAGE_NAMES[s]}</button>)}
      <button type="button" className="ghost small" disabled={busy} onClick={() => setDialog("lost")}>Mark lost…</button>
    </div>}
      <section><div className="panel-head"><h2>Follow-ups</h2></div>
        <FollowUpRows items={l.followUps} showAbout={false} onChanged={() => void reload()} /></section>
      </div>
      <aside className="rail"><h2>Details</h2><dl className="kv">
        <dt>Contact</dt><dd>{l.contactName ?? "—"}</dd>
        <dt>Phone</dt><dd>{l.phone ? <span className="link-cluster"><a href={`tel:${l.phone.replace(/\s/g, "")}`}>{l.phone}</a><a href={`https://wa.me/${whatsapp(l.phone)}`} target="_blank" rel="noopener noreferrer">WhatsApp</a></span> : "—"}</dd>
        <dt>Email</dt><dd>{l.email ? <a href={`mailto:${l.email}`}>{l.email}</a> : "—"}</dd>
        <dt>Place</dt><dd>{[l.city, l.stateCode && GST_STATES[l.stateCode]].filter(Boolean).join(", ") || "—"}</dd>
        <dt>Interested in</dt><dd>{[l.expectedPlan && PLAN_NAMES[l.expectedPlan], l.expectedOutlets && plural(l.expectedOutlets, "outlet")].filter(Boolean).join(", ") || "—"}</dd>
        <dt>Worth about</dt><dd>{l.estimatedValuePaise ? money(l.estimatedValuePaise) : "—"}</dd>
        <dt>Sales rep</dt><dd>{l.owner ? <Person name={l.owner.name} id={l.owner.id} /> : "Not assigned"}</dd>
        <dt>Added</dt><dd>{date(l.createdAt)}</dd>
      </dl>{l.notes && <div className="record-notes"><h2>Notes</h2><p>{l.notes}</p></div>}</aside>
    </div>
    {dialog === "edit" && <LeadDialog me={me} staff={staff.data?.staff ?? []} lead={l} onClose={() => setDialog(null)} onSaved={(next) => { setDialog(null); setData({ lead: next }); }} />}
    {dialog === "followup" && <AddFollowUp about={{ leadId: l.id }} me={me} onClose={() => setDialog(null)} onSaved={() => { setDialog(null); void reload(); }} />}
    {dialog === "lost" && <LostDialog lead={l} onClose={() => setDialog(null)} onSaved={(next) => { setDialog(null); setData({ lead: next }); }} />}
  </>;
}

const whatsapp = (phone: string) => { const digits = phone.replace(/\D/g, ""); return digits.length === 10 ? `91${digits}` : digits; };

function LostDialog({ lead, onClose, onSaved }: { lead: LeadDetail; onClose: () => void; onSaved: (l: LeadDetail) => void }) {
  const [reason, setReason] = useState("");
  const { busy, run, status } = useRun();
  return <Dialog title={`Mark ${lead.businessName} as lost?`} onClose={onClose}>
    <form className="stack" onSubmit={(e) => { e.preventDefault(); void run(async () => onSaved((await post<{ lead: LeadDetail }>(`/leads/${lead.id}/stage`, { stage: "lost", lostReason: reason })).lead)); }}>
      <p>Its open follow-ups are dropped. The reason feeds the lead report.</p>
      <Field label="Why"><input required autoFocus maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Chose another POS, too expensive, closed down" disabled={busy} /></Field>
      {status}
      <div className="form-actions"><button type="button" className="secondary" onClick={onClose}>Cancel</button><button className="danger" disabled={busy}>Mark lost</button></div>
    </form>
  </Dialog>;
}

function LeadDialog({ me, staff, lead, onClose, onSaved }: { me: StaffUser; staff: Colleague[]; lead?: LeadDetail; onClose: () => void; onSaved: (l: LeadDetail) => void }) {
  const [form, setForm] = useState({
    businessName: lead?.businessName ?? "", contactName: lead?.contactName ?? "", phone: lead?.phone ?? "", email: lead?.email ?? "", city: lead?.city ?? "",
    stateCode: lead?.stateCode ?? "", source: lead?.source ?? "walk_in" as LeadSource, expectedPlan: lead?.expectedPlan ?? "", expectedOutlets: lead?.expectedOutlets ? String(lead.expectedOutlets) : "",
    worth: lead?.estimatedValuePaise ? String(lead.estimatedValuePaise / 100) : "", notes: lead?.notes ?? "", ownerId: lead?.owner?.id ?? me.id,
  });
  const { busy, run, status, setError } = useRun();
  const set = (key: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [key]: e.target.value });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const worth = form.worth.trim() ? parseRupees(form.worth) : null;
    if (form.worth.trim() && worth === null) { setError("Check the amount it's worth."); return; }
    const body: LeadInput = {
      businessName: form.businessName, contactName: form.contactName, phone: form.phone, email: form.email, city: form.city, stateCode: form.stateCode, source: form.source,
      expectedPlan: form.expectedPlan === "basic" || form.expectedPlan === "pro" ? form.expectedPlan : null, expectedOutlets: form.expectedOutlets ? Number(form.expectedOutlets) : null,
      estimatedValuePaise: worth, notes: form.notes, ...(me.role === "admin" ? { ownerId: form.ownerId || null } : {}),
    };
    void run(async () => onSaved((lead ? await patch<{ lead: LeadDetail }>(`/leads/${lead.id}`, body) : await post<{ lead: LeadDetail }>("/leads", body)).lead));
  };
  return <Dialog title={lead ? `Edit ${lead.businessName}` : "Add lead"} onClose={onClose} wide>
    <form className="form-grid" onSubmit={submit}>
      <Field label="Restaurant" wide><input required autoFocus maxLength={120} value={form.businessName} onChange={set("businessName")} disabled={busy} /></Field>
      <Field label="Contact person"><input maxLength={80} value={form.contactName} onChange={set("contactName")} disabled={busy} /></Field>
      <Field label="Phone"><input type="tel" maxLength={20} value={form.phone} onChange={set("phone")} disabled={busy} /></Field>
      <Field label="Email"><input type="email" maxLength={254} value={form.email} onChange={set("email")} disabled={busy} /></Field>
      <Field label="How they found us"><select value={form.source} onChange={set("source")} disabled={busy}>{Object.entries(SOURCE_NAMES).map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select></Field>
      <Field label="City"><input maxLength={80} value={form.city} onChange={set("city")} disabled={busy} /></Field>
      <Field label="State"><select value={form.stateCode} onChange={set("stateCode")} disabled={busy}><option value="">Choose a state</option>
        {Object.entries(GST_STATES).map(([code, name]) => <option key={code} value={code}>{name}</option>)}</select></Field>
      <Field label="Interested in"><select value={form.expectedPlan} onChange={set("expectedPlan")} disabled={busy}><option value="">Not sure yet</option><option value="pro">Pro</option><option value="basic">Basic</option></select></Field>
      <Field label="Outlets"><input type="number" min={1} max={500} value={form.expectedOutlets} onChange={set("expectedOutlets")} disabled={busy} /></Field>
      <Field label="Worth about (Rs.)" hint="A year's licences, before GST."><input inputMode="decimal" value={form.worth} onChange={set("worth")} disabled={busy} /></Field>
      {me.role === "admin" && <Field label="Sales rep"><select value={form.ownerId} onChange={set("ownerId")} disabled={busy}><option value="">Not assigned</option>
        {staff.filter((s) => s.role === "sales" || s.role === "admin").map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>}
      <Field label="Notes" wide><textarea rows={3} maxLength={2000} value={form.notes} onChange={set("notes")} disabled={busy} /></Field>
      <div className="wide">{status}</div>
      <div className="form-actions wide"><button type="button" className="secondary" onClick={onClose}>Cancel</button><button className="primary" disabled={busy}>{lead ? "Save" : "Add lead"}</button></div>
    </form>
  </Dialog>;
}
