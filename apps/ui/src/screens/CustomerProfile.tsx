import { useState } from "react";
import { apiFetch } from "../api";
import { formatOccasion, joinOccasion, occasionNote, parseTags, splitOccasion, stars, todayKey } from "../crm";
import { paiseToRupees } from "../money";
import { uuid } from "../uuid";
import type { Customer } from "../types";
import { useRun, type CustomerType } from "./customer-shared";

type LedgerKind = "earn" | "redeem" | "reverse" | "adjust" | "expire";
interface Bill { id: string; billNo: number; createdAt: number; totalPaise: number; status: string }
interface Feedback { id: string; overall: number; food: number | null; service: number | null; ambience: number | null; comment: string | null; source: "qr" | "staff"; createdAt: number; billNo: number }
export interface CustomerDetail {
  customer: Customer;
  stats: { visits: number; firstVisitAt: number | null; lastVisitAt: number | null; spendPaise: number; averageBillPaise: number; favourites: Array<{ name: string; qty: number }> };
  tier: { name: string; earnMultiplier: number; windowSpendPaise: number; next: { name: string; minSpendPaise: number } | null } | null;
  expiringSoon: { points: number; firstAt: number | null };
  ledger: Array<{ id: string; kind: LedgerKind; points: number; note: string | null; createdAt: number; expiresAt: number | null; billNo: number | null; createdByName: string }>;
  bills: Bill[];
  moreBills: boolean;
  feedback: Feedback[];
}
const KIND: Record<LedgerKind, string> = { earn: "Earned", redeem: "Redeemed", reverse: "Reversed", adjust: "Adjusted", expire: "Expired" };
const day = (ms: number | null) => ms ? new Date(ms).toLocaleDateString() : "—";
const SECTIONS = ["Bills", "Points", "Feedback", "Edit"] as const;

/** One customer: who they are, how often they come and what they spend, their points and tier, and their feedback. */
export function CustomerProfile({ detail, types, isAdmin, onChanged }: { detail: CustomerDetail; types: CustomerType[]; isAdmin: boolean; onChanged: () => Promise<void> }) {
  const c = detail.customer;
  const [section, setSection] = useState<typeof SECTIONS[number]>("Bills");
  const [bills, setBills] = useState({ list: detail.bills, more: detail.moreBills });
  const { busy, run, status } = useRun();
  const note = occasionNote(c, todayKey());
  const loadMore = () => run(async () => {
    const last = bills.list[bills.list.length - 1];
    const next = await apiFetch<CustomerDetail>(`/api/customers/${c.id}?billsBefore=${last?.createdAt ?? ""}`);
    setBills({ list: [...bills.list, ...next.bills], more: next.moreBills });
  }, "");

  return <div className="panel customer-profile">
    <header className="crm-profile-head">
      <div>
        <h3>{c.name} {!c.isActive && <span className="crm-badge crm-badge--muted">Inactive</span>}</h3>
        <p className="muted">{c.phone}{c.email ? ` · ${c.email}` : ""}{c.typeName ? ` · ${c.typeName}` : ""}</p>
        {note && <p className="crm-occasion">🎂 {note}</p>}
        {c.tags.length > 0 && <p className="crm-tags">{c.tags.map((t) => <span key={t} className="crm-tag">{t}</span>)}</p>}
      </div>
      <div className="crm-points">
        {c.tier && <span className="crm-badge">{c.tier.name}{c.tier.earnMultiplier > 1 ? ` · ${c.tier.earnMultiplier}× points` : ""}</span>}
        <strong>{c.pointsBalance}</strong><span>points</span>
        {detail.expiringSoon.points > 0 && <small className="crm-warning">{detail.expiringSoon.points} expire by {day(detail.expiringSoon.firstAt)}</small>}
      </div>
    </header>

    <dl className="crm-tiles">
      <div><dt>Visits</dt><dd>{detail.stats.visits}</dd></div>
      <div><dt>Total spend</dt><dd>₹{paiseToRupees(detail.stats.spendPaise)}</dd></div>
      <div><dt>Average bill</dt><dd>₹{paiseToRupees(detail.stats.averageBillPaise)}</dd></div>
      <div><dt>Last visit</dt><dd>{day(detail.stats.lastVisitAt)}</dd></div>
      <div><dt>Customer since</dt><dd>{day(detail.stats.firstVisitAt ?? c.createdAt)}</dd></div>
      {c.birthDate && <div><dt>Birthday</dt><dd>{formatOccasion(c.birthDate)}</dd></div>}
      {c.anniversaryDate && <div><dt>Anniversary</dt><dd>{formatOccasion(c.anniversaryDate)}</dd></div>}
    </dl>
    {detail.tier?.next && <p className="muted">₹{paiseToRupees(Math.max(0, detail.tier.next.minSpendPaise - detail.tier.windowSpendPaise))} more to reach {detail.tier.next.name}.</p>}
    {detail.stats.favourites.length > 0 && <p><strong>Usually orders:</strong> {detail.stats.favourites.map((f) => `${f.name} ×${f.qty}`).join(", ")}</p>}
    {c.notes && <p><strong>Notes:</strong> {c.notes}</p>}

    <div className="tabs" role="group" aria-label="Customer sections">
      {SECTIONS.map((s) => <button key={s} type="button" aria-pressed={section === s} onClick={() => setSection(s)}>{s}</button>)}
    </div>
    {status}

    {section === "Bills" && <>
      <table className="customer-ledger"><thead><tr><th scope="col">Bill</th><th scope="col">Date</th><th scope="col" className="pos-money">Amount</th><th scope="col">Status</th></tr></thead><tbody>{bills.list.map((b) => <tr key={b.id}>
        <td>#{b.billNo}</td><td>{day(b.createdAt)}</td><td className="pos-money">₹{paiseToRupees(b.totalPaise)}</td><td>{b.status}</td>
      </tr>)}{!bills.list.length && <tr><td colSpan={4} className="muted">No bills yet.</td></tr>}</tbody></table>
      {bills.more && <button type="button" disabled={busy} onClick={() => void loadMore()}>Load older bills</button>}
    </>}

    {section === "Points" && <>
      {isAdmin && <AdjustPoints customerId={c.id} onChanged={onChanged} />}
      <table className="customer-ledger"><thead><tr><th scope="col">Date</th><th scope="col">Activity</th><th scope="col" className="pos-money">Points</th><th scope="col">Details</th></tr></thead><tbody>{detail.ledger.map((l) => <tr key={l.id}>
        <td>{day(l.createdAt)}</td><td>{KIND[l.kind]}</td><td className="pos-money">{l.points > 0 ? `+${l.points}` : l.points}</td>
        <td>{l.billNo ? `Bill #${l.billNo}` : ""}{l.note ? ` ${l.note}` : ""}{l.expiresAt ? <small className="muted"> · expires {day(l.expiresAt)}</small> : null}</td>
      </tr>)}{!detail.ledger.length && <tr><td colSpan={4} className="muted">No points yet.</td></tr>}</tbody></table>
    </>}

    {section === "Feedback" && <>
      <RecordFeedback bills={bills.list.filter((b) => b.status !== "void" && !detail.feedback.some((f) => f.billNo === b.billNo))} onChanged={onChanged} />
      <ul className="crm-feedback-list">{detail.feedback.map((f) => <li key={f.id} className={f.overall <= 2 ? "crm-low" : ""}>
        <span className="crm-stars" aria-label={`${f.overall} out of 5`}>{stars(f.overall)}</span> Bill #{f.billNo} · {day(f.createdAt)} · {f.source === "qr" ? "QR" : "Staff"}
        {f.comment && <p>{f.comment}</p>}
      </li>)}{!detail.feedback.length && <li className="muted">No feedback yet.</li>}</ul>
    </>}

    {section === "Edit" && <EditCustomer customer={c} types={types} onChanged={onChanged} />}
  </div>;
}

function EditCustomer({ customer: c, types, onChanged }: { customer: Customer; types: CustomerType[]; onChanged: () => Promise<void> }) {
  const birth = splitOccasion(c.birthDate), anniversary = splitOccasion(c.anniversaryDate);
  const [edit, setEdit] = useState({
    name: c.name, phone: c.phone, email: c.email ?? "", typeId: c.typeId ?? "", notes: c.notes, gender: c.gender ?? "",
    birthDay: birth.day, birthYear: birth.year, anniversaryDay: anniversary.day, anniversaryYear: anniversary.year,
    tags: c.tags.join(", "), marketingOptIn: c.marketingOptIn, isActive: c.isActive,
  });
  const { busy, run, status } = useRun();
  const set = (patch: Partial<typeof edit>) => setEdit({ ...edit, ...patch });
  return <fieldset disabled={busy} className="cash-drawer-form crm-edit">
    <label>Name <input value={edit.name} maxLength={80} onChange={(e) => set({ name: e.target.value })} /></label>
    <label>Mobile <input value={edit.phone} inputMode="tel" maxLength={16} onChange={(e) => set({ phone: e.target.value })} /></label>
    <label>Email <input type="email" value={edit.email} maxLength={120} onChange={(e) => set({ email: e.target.value })} /></label>
    <OccasionInput label="Birthday" day={edit.birthDay} year={edit.birthYear} onChange={(d, y) => set({ birthDay: d, birthYear: y })} />
    <OccasionInput label="Anniversary" day={edit.anniversaryDay} year={edit.anniversaryYear} onChange={(d, y) => set({ anniversaryDay: d, anniversaryYear: y })} />
    <label>Gender <select value={edit.gender} onChange={(e) => set({ gender: e.target.value })}><option value="">Not given</option><option value="female">Female</option><option value="male">Male</option><option value="other">Other</option></select></label>
    <label>Type <select value={edit.typeId} onChange={(e) => set({ typeId: e.target.value })}><option value="">None</option>{types.map((t) => <option key={t.id} value={t.id}>{t.name}{t.isActive ? "" : " (off)"}</option>)}</select></label>
    <label>Tags <input value={edit.tags} placeholder="Vegan, Office lunch" onChange={(e) => set({ tags: e.target.value })} /></label>
    <label>Notes <input value={edit.notes} maxLength={500} onChange={(e) => set({ notes: e.target.value })} /></label>
    <label className="crm-check"><input type="checkbox" checked={edit.marketingOptIn} onChange={(e) => set({ marketingOptIn: e.target.checked })} /> Happy to receive offers</label>
    <label className="crm-check"><input type="checkbox" checked={edit.isActive} onChange={(e) => set({ isActive: e.target.checked })} /> Active</label>
    <button className="primary" onClick={() => void run(async () => {
      await apiFetch(`/api/customers/${c.id}`, { method: "PATCH", body: JSON.stringify({
        name: edit.name, phone: edit.phone, email: edit.email, typeId: edit.typeId || null, notes: edit.notes, gender: edit.gender || null,
        birthDate: joinOccasion(edit.birthDay, edit.birthYear), anniversaryDate: joinOccasion(edit.anniversaryDay, edit.anniversaryYear),
        tags: parseTags(edit.tags), marketingOptIn: edit.marketingOptIn, isActive: edit.isActive,
      }) });
      await onChanged();
    })}>Save</button>
    {status}
  </fieldset>;
}

/** A day of the year from a date picker, and whether the year is known. */
export function OccasionInput({ label, day, year, onChange }: { label: string; day: string; year: string; onChange: (day: string, year: string) => void }) {
  const value = day ? `${year || "2000"}-${day}` : "";
  return <span className="crm-occasion-input">
    <label>{label} <input type="date" value={value} onChange={(e) => {
      const v = e.target.value;
      if (!v) return onChange("", "");
      onChange(v.slice(5), year ? v.slice(0, 4) : "");
    }} /></label>
    {day && <label className="crm-check"><input type="checkbox" checked={!!year} onChange={(e) => onChange(day, e.target.checked ? value.slice(0, 4) : "")} /> Year known</label>}
  </span>;
}

function AdjustPoints({ customerId, onChanged }: { customerId: string; onChanged: () => Promise<void> }) {
  const [adjust, setAdjust] = useState({ points: "", note: "" });
  const { busy, run, status } = useRun();
  return <fieldset disabled={busy} className="cash-drawer-form">
    <legend>Adjust points</legend>
    <label>Points (+/−) <input type="number" step="1" value={adjust.points} onChange={(e) => setAdjust({ ...adjust, points: e.target.value })} /></label>
    <label>Reason <input maxLength={200} value={adjust.note} onChange={(e) => setAdjust({ ...adjust, note: e.target.value })} /></label>
    <button disabled={!adjust.points || !adjust.note.trim()} onClick={() => void run(async () => {
      await apiFetch(`/api/customers/${customerId}/loyalty-adjustments`, { method: "POST", body: JSON.stringify({ clientRef: uuid(), points: Number(adjust.points), note: adjust.note }) });
      setAdjust({ points: "", note: "" }); await onChanged();
    }, "Points adjusted.")}>Adjust</button>
    {status}
  </fieldset>;
}

function RecordFeedback({ bills, onChanged }: { bills: Bill[]; onChanged: () => Promise<void> }) {
  const [form, setForm] = useState({ billId: "", overall: "5", comment: "" });
  const { busy, run, status } = useRun();
  if (!bills.length) return null;
  return <fieldset disabled={busy} className="cash-drawer-form">
    <legend>Record a rating</legend>
    <label>Bill <select value={form.billId} onChange={(e) => setForm({ ...form, billId: e.target.value })}><option value="">Choose…</option>{bills.map((b) => <option key={b.id} value={b.id}>#{b.billNo} · {day(b.createdAt)}</option>)}</select></label>
    <label>Rating <select value={form.overall} onChange={(e) => setForm({ ...form, overall: e.target.value })}>{[5, 4, 3, 2, 1].map((n) => <option key={n} value={n}>{stars(n)}</option>)}</select></label>
    <label>Comment <input maxLength={1000} value={form.comment} onChange={(e) => setForm({ ...form, comment: e.target.value })} /></label>
    <button disabled={!form.billId} onClick={() => void run(async () => {
      await apiFetch(`/api/bills/${form.billId}/feedback`, { method: "POST", body: JSON.stringify({ overall: Number(form.overall), comment: form.comment }) });
      setForm({ billId: "", overall: "5", comment: "" }); await onChanged();
    }, "Rating saved.")}>Save rating</button>
    {status}
  </fieldset>;
}
