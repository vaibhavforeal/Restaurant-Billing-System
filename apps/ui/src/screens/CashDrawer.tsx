import "../cash-drawer.css";
import { useEffect, useRef, useState } from "react";
import { businessToday } from "../sales-report";
import { ApiError, apiFetch } from "../api";
import { paiseToRupees, rupeesToPaise } from "../money";
import { refFor, type RequestRef } from "../request-ref";

import { shiftCacheKey } from "../retry-queue";
import { isUnreachable } from "../offline-cache";

function rememberShift(shift: Shift | null) {
  const key = shiftCacheKey();
  if (key) {
    if (shift && !shift.handover) localStorage.setItem(key, shift.id);
    else localStorage.removeItem(key);
  }
}
export async function currentCashShift() {
  const { shift } = await apiFetch<{ shift: Shift | null }>("/api/shifts/current");
  rememberShift(shift);
  return shift;
}
export async function cashShiftForPayment() {
  try {
    const shift = await currentCashShift();
    return shift && !shift.handover ? shift.id : null;
  } catch (error) {
    if (!isUnreachable(error)) throw error;
    const key = shiftCacheKey();
    return key && localStorage.getItem(key);
  }
}

interface DrawerState {
  occupied?: {drawerName:string;cashierName:string}[];
  drawers: {id:string;name:string}[];
  recipients: {id:string;name:string;role:string}[];
  pending: Shift[]; userId:string; admin:boolean;
}
export interface Shift {
  drawerName?:string;
  history?: Array<{seq:number;state:string;counted:number;received:number|null;at:number;note:string;actorName:string}>;
  handover?: { seq:number; state:string; recipient:string; recipientName:string; counted:number; expected:number; note:string; received:number|null };
  id: string; cashierName: string; openedAt: number; openingFloatPaise: number;
  cashSalesPaise: number; cashRefundsPaise: number; payInPaise: number; payOutPaise: number; expectedCashPaise: number;
  closedAt: number | null; closedByName: string | null; countedCashPaise: number | null; variancePaise: number | null; note: string | null;
  movements: Array<{ id: string; kind: "pay_in" | "pay_out"; amountPaise: number; reason: string; createdAt: number; createdByName: string }>;
}
interface DayCloseState {
  date: string;
  close: { closedAt: number; closedByName: string; note: string | null } | null;
  blockers: { openShifts: string[]; openOrders: number; unpaidBills: number } | null;
}

const money = (paise: number) => `₹${paiseToRupees(paise)}`;
const signed = (paise: number) => paise === 0 ? "₹0.00 (exact)" : paise > 0 ? `+${money(paise)} over` : `-${money(-paise)} short`;
const time = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/** Cash drawer shift for the signed-in cashier, the day's shifts, and (admin) closing the business date. */
export function CashDrawer({ canSettle, canCloseDay, canReadReports = true, onOpened }: { onOpened?: () => void; canSettle: boolean; canCloseDay: boolean; canReadReports?:boolean }) {
  const [date, setDate] = useState(() => businessToday());
  const [mine, setMine] = useState<Shift | null>(null);
  const [shifts, setShifts] = useState<Shift[]>([]);
  const [day, setDay] = useState<DayCloseState | null>(null);
  const [custody,setCustody] = useState<DrawerState>();
  const [drawer,setDrawer] = useState("");
  const [drawerName,setDrawerName] = useState("");
  const [recipient,setRecipient] = useState("");
  const [finalReceipt,setFinalReceipt] = useState(false);
  const [receipts,setReceipts] = useState<Record<string,string>>({});
  const [float, setFloat] = useState("");
  const [movement, setMovement] = useState({ kind: "pay_out" as "pay_in" | "pay_out", amount: "", reason: "" });
  const [counted, setCounted] = useState("");
  const [closeNote, setCloseNote] = useState("");
  const [dayNote, setDayNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const openRef = useRef<RequestRef>(null), movementRef = useRef<RequestRef>(null), closeRef = useRef<RequestRef>(null), dayRef = useRef<RequestRef>(null);
  /** Only the newest load may show its result: a slower reply for an earlier date is dropped. */
  const loadId = useRef(0);

  async function reload() {
    const id = ++loadId.current;
    const [current, list, state, custodyState] = await Promise.all([
      canSettle ? apiFetch<{ shift: Shift | null }>("/api/shifts/current") : Promise.resolve({ shift: null }),
      canReadReports ? apiFetch<{ shifts: Shift[] }>(`/api/shifts?from=${date}&to=${date}`) : {shifts:[]},
      canReadReports ? apiFetch<DayCloseState>(`/api/day-close?date=${date}`) : null,
      canSettle ? apiFetch<DrawerState>("/api/drawers") : undefined,
    ]);
    if (id !== loadId.current) return;
    if (canSettle) rememberShift(current.shift);
    setCustody(custodyState); setMine(current.shift); setShifts(list.shifts); setDay(state);
  }
  useEffect(() => { reload().catch((e: unknown) => setError(e instanceof Error ? e.message : "Failed to load cash drawer")); }, [date, canSettle, canReadReports]);

  async function run(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true); setError(""); setMessage("");
    try { await action(); await reload(); }
    catch (e) { if (e instanceof ApiError && e.status === 409) await reload().catch(() => {}); setError(e instanceof ApiError || e instanceof Error ? e.message : "Request failed"); }
    finally { setBusy(false); }
  }
  const amount = (value: string, label: string) => {
    const paise = rupeesToPaise(value);
    if (paise === null) throw new Error(`Enter ${label} in rupees`);
    return paise;
  };
  async function handover(shift:Shift, change:object) {
    const payload = {revision:shift.handover?.seq ?? 0, change};
    await apiFetch(`/api/shifts/${shift.id}/handover`, {method:"POST",body:JSON.stringify({...payload,clientRef:refFor(closeRef,{id:shift.id,...payload})})});
    closeRef.current = null;
  }
  const available = custody?.drawers ?? [];
  const drawerId = available.some(d => d.id === drawer) ? drawer : (available.length === 1 ? available[0]?.id : undefined);
  const countedPaise = rupeesToPaise(counted);

  return <section className="panel cash-drawer" aria-label="Cash drawer and day close">
    {canSettle && <>
      <div className="cash-drawer-toolbar">
        <div>
          {mine ? <h3>{mine.drawerName}</h3> : canReadReports && <h3>My cash drawer</h3>}
          {mine && <p className="muted">Opened {time(mine.openedAt)}</p>}
        </div>
        <button type="button" className="text-button" disabled={busy} onClick={() => void run(async () => {})}>Refresh</button>
      </div>
      {custody?.pending.map(s => {
        const h = s.handover!;
        return <fieldset key={s.id} disabled={busy} className="cash-drawer-form"><legend>{s.drawerName} · {s.cashierName} → {h.recipientName}</legend>
          <p>{h.state} · Counted {money(h.counted)} · {signed(h.counted-h.expected)} {h.note}</p>
          {custody.admin && h.state === "awaiting approval" && <button onClick={()=>void run(()=>handover(s,{action:"approve"}))}>Approve difference</button>}
          {h.recipient === custody.userId && h.state === "awaiting receipt" && <>
            <label>Cash received (₹) <input type="number" min="0" step="0.01" value={receipts[s.id] ?? ""} onChange={e=>setReceipts({...receipts,[s.id]:e.target.value})}/></label>
            <button disabled={!receipts[s.id]?.trim()} onClick={()=>void run(async()=>{
              await handover(s,{action:"receive",received:amount(receipts[s.id]!, "the received cash")});
              setReceipts({...receipts,[s.id]:""});
            })}>Confirm received count</button></>}
        </fieldset>;
      })}
      {!mine ? <fieldset disabled={busy} className="cash-drawer-form">
        <label>Available drawer <select value={drawerId ?? ""} onChange={e=>setDrawer(e.target.value)}>
          {available.length > 1 && <option value="">Select drawer</option>}
          {!available.length && <option value="">No available drawers</option>}
          {available.map(d=><option key={d.id} value={d.id}>{d.name}</option>)}</select></label>
        {!available.length && custody?.occupied?.map(d => <p key={d.drawerName}>{d.drawerName} · {d.cashierName}</p>)}
        <label>Opening cash (₹) <input type="number" min="0" step="0.01" value={float} onChange={(e) => setFloat(e.target.value)} /></label>
        <button className="primary" disabled={!drawerId || !float.trim() || rupeesToPaise(float) === null} onClick={() => void run(async () => {
          const {shift} = await apiFetch<{shift:Shift}>("/api/shifts", { method: "POST", body: JSON.stringify({ clientRef: refFor(openRef, { float,drawerId }), drawerId, openingFloatPaise: amount(float, "the opening float") }) });
          openRef.current = null;
          rememberShift(shift); setMessage("Shift opened."); onOpened?.();
        })}>Open day cash</button>
      </fieldset> : <>
        <div className="cash-drawer-balance">
          <span>Expected in drawer</span>
          <strong>{money(mine.expectedCashPaise)}</strong>
        </div>
        {mine.handover && <p className="muted">{mine.handover.state} · {mine.handover.recipientName}
          {mine.handover.state === "recount" && mine.handover.received !== null && ` · Recipient counted ${money(mine.handover.received)}`}
        </p>}
        {mine.handover && mine.handover.state !== "recount" && <button disabled={busy} onClick={()=>void run(()=>handover(mine,{action:"recount"}))}>Revise handover</button>}
        <dl className="cash-drawer-totals">
          <dt>Opening float</dt><dd>{money(mine.openingFloatPaise)}</dd>
          <dt>Cash sales you settled</dt><dd>{money(mine.cashSalesPaise)}</dd>
          <dt>Cash refunds</dt><dd>-{money(mine.cashRefundsPaise)}</dd>
          <dt>Pay-ins</dt><dd>{money(mine.payInPaise)}</dd>
          <dt>Pay-outs</dt><dd>-{money(mine.payOutPaise)}</dd>
        </dl>
        <fieldset disabled={busy || !!mine.handover} className="cash-drawer-form cash-drawer-movement">
          <legend>Pay-in / pay-out</legend>
          <label>Type <select value={movement.kind} onChange={(e) => setMovement({ ...movement, kind: e.target.value as "pay_in" | "pay_out" })}>
            <option value="pay_out">Pay-out</option><option value="pay_in">Pay-in</option>
          </select></label>
          <label>Amount (₹) <input type="number" min="0" step="0.01" value={movement.amount} onChange={(e) => setMovement({ ...movement, amount: e.target.value })} /></label>
          <label>Reason <input maxLength={200} value={movement.reason} onChange={(e) => setMovement({ ...movement, reason: e.target.value })} /></label>
          <button onClick={() => void run(async () => {
            await apiFetch(`/api/shifts/${mine.id}/cash-movements`, { method: "POST", body: JSON.stringify({ clientRef: refFor(movementRef, { shift: mine.id, ...movement }), kind: movement.kind, amountPaise: amount(movement.amount, "the amount"), reason: movement.reason }) });
            movementRef.current = null;
            setMovement({ ...movement, amount: "", reason: "" }); setMessage("Saved.");
          })}>Record</button>
        </fieldset>
        <fieldset disabled={busy || (!!mine.handover && mine.handover.state !== "recount")} className="cash-drawer-form">
          <legend>Settle and hand over</legend>
          <label><input type="checkbox" checked={finalReceipt} onChange={e=>{setFinalReceipt(e.target.checked);setRecipient("");}}/> Final handover to admin</label>
          <label>Recipient <select value={recipient} onChange={e=>setRecipient(e.target.value)}><option value="">Choose recipient</option>
            {custody?.recipients.filter(u=>finalReceipt ? u.role==="admin" : u.id!==custody.userId).map(u=><option key={u.id} value={u.id}>{u.name}</option>)}</select></label>
          <label>Cash counted in drawer (₹) <input type="number" min="0" step="0.01" value={counted} onChange={(e) => setCounted(e.target.value)} /></label>
          {countedPaise !== null && counted.trim() !== "" && <p>Difference: <strong>{signed(countedPaise - mine.expectedCashPaise)}</strong></p>}
          <label>{countedPaise !== null && countedPaise !== mine.expectedCashPaise ? "Reason for difference" : "Note"} <input maxLength={200} value={closeNote} onChange={(e) => setCloseNote(e.target.value)} /></label>
          <button className="primary" disabled={!recipient || counted.trim() === "" || (countedPaise !== mine.expectedCashPaise && !closeNote.trim())} onClick={() => void run(async () => {
            await handover(mine,{action:"submit",recipient,final:finalReceipt,counted:amount(counted,"the counted cash"),note:closeNote});
            setCounted(""); setCloseNote(""); setMessage("Count submitted.");
          })}>Submit handover</button>
        </fieldset>
      </>}
      {custody?.admin && <details className="cash-drawer-setup"><summary>Drawer setup</summary><fieldset disabled={busy} className="cash-drawer-form">
        <label>New drawer name <input value={drawerName} maxLength={80} onChange={e=>setDrawerName(e.target.value)} /></label>
        <button disabled={!drawerName.trim()} onClick={()=>void run(async()=>{
          await apiFetch("/api/drawers",{method:"POST",body:JSON.stringify({name:drawerName})}); setDrawerName("");
        })}>Add drawer</button>
      </fieldset></details>}
    </>}

    {canReadReports && <><header className="report-toolbar"><h3>Shifts and day close</h3>
      <label>Date <input type="date" value={date} max={businessToday()} onChange={(e) => e.target.value && setDate(e.target.value)} /></label>
    </header>
    <div className="sales-report-table" role="region" aria-label="Shifts" tabIndex={0}>
      <table>
        <thead><tr><th>Drawer</th><th>Cashier</th><th>Handover</th><th>Opened</th><th>Closed</th><th>Float</th><th>Cash sales</th><th>Refunds</th><th>Pay-in / out</th><th>Expected</th><th>Counted</th><th>Difference</th></tr></thead>
        <tbody>{shifts.length ? shifts.map((s) => <tr key={s.id}>
          <td>{s.drawerName ?? "—"}</td><td>{s.cashierName}</td><td>{s.handover ? `${s.handover.state} · ${s.handover.recipientName}` : "—"}
            {!!s.history?.length && <details><summary>History</summary><ul>{s.history.map(e=><li key={e.seq}>
              {time(e.at)} · {e.actorName} · {e.state} · {money(e.received ?? e.counted)} {e.note}</li>)}</ul></details>}</td><td>{time(s.openedAt)}</td><td>{s.closedAt ? time(s.closedAt) : "Open"}</td>
          <td>{money(s.openingFloatPaise)}</td><td>{money(s.cashSalesPaise)}</td><td>{money(s.cashRefundsPaise)}</td>
          <td>{money(s.payInPaise)} / {money(s.payOutPaise)}</td><td>{money(s.expectedCashPaise)}</td>
          <td>{s.countedCashPaise === null ? "—" : money(s.countedCashPaise)}</td>
          <td>{s.variancePaise === null ? "—" : signed(s.variancePaise)}{s.note && <small className="muted"> · {s.note}</small>}</td>
        </tr>) : <tr><td colSpan={12}>No shifts on this date.</td></tr>}</tbody>
      </table>
    </div>

    </>}
    {day && (day.close ? <p role="status">{day.date} was closed by {day.close.closedByName} at {new Date(day.close.closedAt).toLocaleString()}.{day.close.note ? ` Note: ${day.close.note}` : ""}</p>
      : <div className="cash-drawer-form">
        {day.blockers && (day.blockers.openShifts.length || day.blockers.openOrders || day.blockers.unpaidBills) ? <ul>
          {day.blockers.openShifts.length > 0 && <li>Open shifts: {day.blockers.openShifts.join(", ")}</li>}
          {day.blockers.openOrders > 0 && <li>{day.blockers.openOrders} open order(s) to bill or cancel</li>}
          {day.blockers.unpaidBills > 0 && <li>{day.blockers.unpaidBills} unpaid bill(s) to settle</li>}
        </ul> : <p>Ready to close {day.date}.</p>}
        {canCloseDay && <fieldset disabled={busy} className="cash-drawer-form">
          <label>Note <input maxLength={200} value={dayNote} onChange={(e) => setDayNote(e.target.value)} /></label>
          <button className="primary" onClick={() => void run(async () => {
            if (!window.confirm(`Close ${day.date}? The day-end report is saved as it is now.`)) return;
            await apiFetch("/api/day-close", { method: "POST", body: JSON.stringify({ clientRef: refFor(dayRef, { date: day.date, dayNote }), date: day.date, note: dayNote }) });
            dayRef.current = null;
            setDayNote(""); setMessage(`${day.date} closed.`);
          })}>Close day</button>
        </fieldset>}
      </div>)}
    {error && <p role="alert">{error}</p>}
    {message && <p role="status">{message}</p>}
  </section>;
}
