import { useState } from "react";
import type { InstallationDetail, InstallationSummary, OrderSummary, StaffUser } from "../../../licensing-worker/src/portal/api-types";
import { PLAN_NAMES, roleCan } from "../../../licensing-worker/src/portal/shared";
import { api, patch, post, query } from "../api";
import { date, dateTime, isoDay, relativeDay, startOfIsoDay } from "../format";
import { CopyButton, Dialog, Field, Pill, useData, useRun } from "../ui";

export const counterName = (c: Pick<InstallationSummary, "outletName" | "id">) => c.outletName ?? `Counter ${c.id.slice(0, 8)}`;

/** Where a counter's licence stands, in words and one status mark. */
export function LicenceState({ counter }: { counter: InstallationSummary }) {
  const l = counter.licence;
  if (!l) return <span className="muted">No licence</span>;
  if (l.state === "expired") return <Pill tone="negative">Ended {date(l.graceUntil)}</Pill>;
  if (l.state === "grace") return <Pill tone="warning">In grace until {date(l.graceUntil)}</Pill>;
  return <>{l.trial ? "Trial until " : "Until "}{date(l.expiresAt)}</>;
}

/**
 * The portal's own element: every outlet's licence as a bar on one shared timeline, from activation to its end date (the grace period
 * lighter), with today marked, so a glance shows which outlet ends first and which is on a trial.
 */
export function SeatStrip({ counters, onOpen }: { counters: InstallationSummary[]; onOpen: (c: InstallationSummary) => void }) {
  const now = Date.now();
  const withLicence = counters.filter((c) => c.licence);
  if (!withLicence.length) return null;
  const start = Math.min(now - 30 * 86_400_000, ...withLicence.map((c) => c.activatedAt ?? c.createdAt));
  const end = Math.max(now + 60 * 86_400_000, ...withLicence.map((c) => c.licence!.graceUntil));
  const x = (t: number) => `${(((t - start) / (end - start)) * 100).toFixed(2)}%`;
  const width = (a: number, b: number) => `${Math.max(0.6, ((b - a) / (end - start)) * 100).toFixed(2)}%`;
  return <div className="seats" aria-label="Licences on a timeline">
    {withLicence.map((c) => {
      const l = c.licence!, from = c.activatedAt ?? c.createdAt;
      return <div className="seat" key={c.id}>
        <button type="button" className="link" style={{ textAlign: "left", textDecoration: "none" }} onClick={() => onOpen(c)}>{counterName(c)}
          <span className="sub muted small" style={{ display: "block", fontWeight: 400 }}>{PLAN_NAMES[l.plan]}{l.trial ? " trial" : ""} · {c.order?.code ?? "No seat"}</span></button>
        <div className="seat-track" title={`${date(from)} to ${date(l.expiresAt)}`}>
          <div className={`seat-fill${l.trial ? " trial" : ""}`} style={{ left: x(from), width: width(from, l.expiresAt) }} />
          {l.graceUntil > l.expiresAt && <div className="seat-fill grace" style={{ left: x(l.expiresAt), width: width(l.expiresAt, l.graceUntil) }} />}
          <div className="seat-today" style={{ left: x(now) }} title="Today" />
        </div>
        <span className="num"><LicenceState counter={c} /></span>
      </div>;
    })}
    <p className="muted small">The line marks today. A lighter end is the grace period, when billing still works but the licence is due.</p>
  </div>;
}

/** One counter: its licence, what it reports, its modules, and the support and admin actions on it. */
export function CounterDialog({ id, me, onClose, onChanged }: { id: string; me: StaffUser; onClose: () => void; onChanged: () => void }) {
  const { data, setData, error } = useData(() => api<{ installation: InstallationDetail }>(`/installations/${id}`), id);
  const c = data?.installation;
  const { busy, run, status } = useRun();
  const act = (action: () => Promise<{ installation: InstallationDetail }>, done: string) =>
    run(async () => { setData(await action()); onChanged(); }, done);
  const admin = roleCan(me.role, "licences.manage"), support = roleCan(me.role, "installations.support");
  return <Dialog title={c ? counterName(c) : "Counter"} onClose={onClose} wide>
    {error && <p className="notice negative">{error}</p>}
    {c && <div className="stack">
      <dl className="kv">
        <dt>Licence</dt><dd>{c.licence ? <>{PLAN_NAMES[c.licence.plan]}{c.licence.trial ? " trial" : ""}, {c.licence.maxDevices} devices · <LicenceState counter={c} /></> : "None yet"}</dd>
        <dt>Revision</dt><dd>{c.licence ? <>{c.licence.revision} {c.licence.delivered ? <span className="muted">· on the counter</span> : <Pill tone="warning">Waiting for its next check-in</Pill>}</> : "—"}</dd>
        <dt>Order</dt><dd>{c.order ? <span className="mono">{c.order.code}</span> : <span className="muted">No seat (released)</span>}{c.licence?.orderCode && c.licence.orderCode !== c.order?.code && <span className="muted"> · licence from {c.licence.orderCode}</span>}</dd>
        <dt>Last seen</dt><dd>{c.lastSeenAt ? `${dateTime(c.lastSeenAt)}${c.appVersion ? ` · ForkFlow ${c.appVersion}` : ""}` : "Never online"}</dd>
        <dt>Activated</dt><dd>{dateTime(c.activatedAt)}</dd>
        <dt>Installation ID</dt><dd className="code-row"><span className="mono">{c.id}</span><CopyButton text={c.id} /></dd>
        <dt>Pairing</dt><dd>{c.paired ? "Paired with its computer" : <Pill tone="warning">Waiting for the computer to claim it</Pill>}</dd>
      </dl>
      {status}
      {(admin || support) && <div className="actions">
        {support && <button className="secondary" disabled={busy} onClick={() => void run(async () => {
          const { license, fileName } = await api<{ license: string; fileName: string }>(`/installations/${c.id}/licence`);
          download(license, fileName);
        })}>Download licence file</button>}
        {support && c.enrolled && <button className="secondary" disabled={busy} onClick={() => {
          if (window.confirm(`Release ${counterName(c)}'s seat? Its order can then activate another computer. This computer's licence keeps working offline until it ends.`)) void act(() => post(`/installations/${c.id}/release`), "Seat released.");
        }}>Release seat</button>}
        {support && c.paired && <button className="secondary" disabled={busy} onClick={() => {
          if (window.confirm("Reset the pairing? The next computer that checks in with this installation ID claims it. Do this only after the restaurant restored or reinstalled ForkFlow.")) void act(() => post(`/installations/${c.id}/reset-pairing`), "Pairing reset.");
        }}>Reset pairing</button>}
      </div>}
      {admin && c.customer && <MoveCounter counter={c} onMoved={(next) => { setData({ installation: next }); onChanged(); }} />}
      {admin && c.licence && <LicenceForm counter={c} onSaved={(next) => { setData({ installation: next }); onChanged(); }} />}
      <Modules counter={c} editable={admin} onSaved={(next) => { setData({ installation: next }); onChanged(); }} />
    </div>}
  </Dialog>;
}

function Modules({ counter, editable, onSaved }: { counter: InstallationDetail; editable: boolean; onSaved: (c: InstallationDetail) => void }) {
  const [choices, setChoices] = useState<Record<string, boolean | null>>(() => Object.fromEntries(counter.modules.map((m) => [m.id, m.override])));
  const { busy, run, status } = useRun();
  const changed = counter.modules.filter((m) => (choices[m.id] ?? null) !== m.override);
  return <section>
    <div className="panel-head"><h2>Modules</h2>{editable && <button className="primary small" disabled={busy || !changed.length} onClick={() => void run(async () => {
      const res = await patch<{ installation: InstallationDetail; issuedRevision: number | null }>(`/installations/${counter.id}/modules`, {
        modules: Object.fromEntries(changed.map((m) => [m.id, choices[m.id] ?? null])), expectedUpdatedAt: counter.modulesUpdatedAt,
      });
      onSaved(res.installation);
    }, "Saved. The counter gets the change at its next check-in, within the hour.")}>Save modules</button>}</div>
    {status}
    <div className="table-wrap counter-modules"><table className="data"><thead><tr><th>Module</th><th>In the plan</th><th>For this counter</th></tr></thead><tbody>
      {counter.modules.map((m) => <tr key={m.id}><td>{m.name}<span className="sub">{m.description}</span></td><td data-label="In the plan">{m.inPlan ? "Included" : <span className="muted">Not included</span>}</td>
        <td data-label="For this counter">{editable ? <select aria-label={`${m.name} for this counter`} value={choices[m.id] === null || choices[m.id] === undefined ? "" : String(choices[m.id])} disabled={busy}
          onChange={(e) => setChoices({ ...choices, [m.id]: e.target.value === "" ? null : e.target.value === "true" })} style={{ width: 170 }}>
          <option value="">Follow the plan</option><option value="true">Allow</option><option value="false">Block</option></select>
          : m.allowed ? "Allowed" : <span className="muted">Blocked</span>}</td></tr>)}
    </tbody></table></div>
    {counter.moduleEvents.length > 0 && <details style={{ marginTop: 12 }}><summary>Module changes</summary><ul className="stack" style={{ marginTop: 8 }}>
      {counter.moduleEvents.map((e) => <li key={e.id}>{counter.modules.find((m) => m.id === e.moduleId)?.name ?? e.moduleId}: {e.allowed === null ? "follows the plan" : e.allowed ? "allowed" : "blocked"}
        <span className="muted"> · {dateTime(e.at)}{e.actorName ? ` · ${e.actorName}` : ""}{e.revision ? ` · revision ${e.revision}` : ""}</span></li>)}</ul></details>}
  </section>;
}

function LicenceForm({ counter, onSaved }: { counter: InstallationDetail; onSaved: (c: InstallationDetail) => void }) {
  const l = counter.licence!;
  const [plan, setPlan] = useState(l.plan);
  const [endDay, setEndDay] = useState(isoDay(l.expiresAt));
  const [devices, setDevices] = useState(String(l.maxDevices));
  const [note, setNote] = useState("");
  const { busy, run, status } = useRun();
  return <details className="panel"><summary><strong>Change this licence</strong> <span className="muted">plan, end date or devices, for a goodwill extension or a correction</span></summary>
    <form className="form-grid" style={{ marginTop: 16 }} onSubmit={(e) => { e.preventDefault(); void run(async () => {
      const body: Record<string, unknown> = { note };
      if (plan !== l.plan) body["plan"] = plan;
      if (endDay !== isoDay(l.expiresAt)) body["expiresAt"] = startOfIsoDay(endDay) + 23 * 3_600_000 + 59 * 60_000;
      if (Number(devices) !== l.maxDevices) body["maxDevices"] = Number(devices);
      onSaved((await post<{ installation: InstallationDetail }>(`/installations/${counter.id}/licence`, body)).installation);
      setNote("");
    }, "Signed. The counter gets it at its next check-in."); }}>
      <Field label="Plan"><select value={plan} onChange={(e) => setPlan(e.target.value as "basic" | "pro")} disabled={busy}><option value="basic">Basic</option><option value="pro">Pro</option></select></Field>
      <Field label="Ends on" hint={`Now ${relativeDay(l.expiresAt).toLowerCase()}`}><input type="date" value={endDay} onChange={(e) => setEndDay(e.target.value)} disabled={busy} /></Field>
      <Field label="Devices"><input type="number" min={1} max={100} value={devices} onChange={(e) => setDevices(e.target.value)} disabled={busy} /></Field>
      <Field label="Why" hint="Goes into the activity log."><input required minLength={3} maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} disabled={busy} /></Field>
      <div className="wide">{status}</div>
      <div className="form-actions wide"><button className="primary" disabled={busy}>Sign the new licence</button></div>
    </form>
  </details>;
}

function MoveCounter({ counter, onMoved }: { counter: InstallationDetail; onMoved: (c: InstallationDetail) => void }) {
  const orders = useData(() => api<{ orders: OrderSummary[] }>(`/orders${query({ customerId: counter.customer!.id })}`), counter.customer!.id);
  const options = (orders.data?.orders ?? []).filter((o) => o.kind !== "renewal" && o.id !== counter.order?.id && (o.status === "paid" || o.status === "confirmed") && o.seatsUsed < o.outlets);
  const [orderId, setOrderId] = useState("");
  const { busy, run, status } = useRun();
  if (!options.length) return null;
  return <form className="panel" onSubmit={(e) => { e.preventDefault(); void run(async () => onMoved((await post<{ installation: InstallationDetail }>(`/installations/${counter.id}/move`, { orderId })).installation), "Moved."); }}>
    <div className="panel-head"><h2>Move to another order</h2></div>
    <p className="muted" style={{ marginBottom: 12 }}>For example when this trial becomes the paid order. The counter takes a seat there and its term starts today.</p>
    <div className="toolbar"><select aria-label="Order" required value={orderId} onChange={(e) => setOrderId(e.target.value)} style={{ width: 320 }} disabled={busy}>
      <option value="">Choose an order</option>{options.map((o) => <option key={o.id} value={o.id}>{o.code} · {PLAN_NAMES[o.plan]} · {o.outlets - o.seatsUsed} of {o.outlets} free</option>)}</select>
      <button className="secondary" disabled={busy || !orderId}>Move counter</button></div>
    {status}
  </form>;
}

export function download(text: string, fileName: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url; a.download = fileName; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
