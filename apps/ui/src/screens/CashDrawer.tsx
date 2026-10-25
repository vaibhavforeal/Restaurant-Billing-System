import { useEffect, useState } from "react";
import { localDay } from "../sales-report";
import { ApiError, apiFetch } from "../api";
import { paiseToRupees, rupeesToPaise } from "../money";
import { uuid } from "../uuid";

export interface Shift {
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
export function CashDrawer({ canSettle, canCloseDay }: { canSettle: boolean; canCloseDay: boolean }) {
  const [date, setDate] = useState(() => localDay());
  const [mine, setMine] = useState<Shift | null>(null);
  const [shifts, setShifts] = useState<Shift[]>([]);
  const [day, setDay] = useState<DayCloseState | null>(null);
  const [float, setFloat] = useState("0");
  const [movement, setMovement] = useState({ kind: "pay_out" as "pay_in" | "pay_out", amount: "", reason: "" });
  const [counted, setCounted] = useState("");
  const [closeNote, setCloseNote] = useState("");
  const [dayNote, setDayNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  async function reload() {
    const [current, list, state] = await Promise.all([
      canSettle ? apiFetch<{ shift: Shift | null }>("/api/shifts/current") : Promise.resolve({ shift: null }),
      apiFetch<{ shifts: Shift[] }>(`/api/shifts?from=${date}&to=${date}`),
      apiFetch<DayCloseState>(`/api/day-close?date=${date}`),
    ]);
    setMine(current.shift); setShifts(list.shifts); setDay(state);
  }
  useEffect(() => { reload().catch((e: unknown) => setError(e instanceof Error ? e.message : "Failed to load cash drawer")); }, [date, canSettle]);

  async function run(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true); setError(""); setMessage("");
    try { await action(); await reload(); }
    catch (e) { setError(e instanceof ApiError || e instanceof Error ? e.message : "Request failed"); }
    finally { setBusy(false); }
  }
  const amount = (value: string, label: string) => {
    const paise = rupeesToPaise(value);
    if (paise === null) throw new Error(`Enter ${label} in rupees`);
    return paise;
  };
  const countedPaise = rupeesToPaise(counted);

  return <section className="panel cash-drawer" aria-label="Cash drawer and day close">
    {canSettle && <>
      <h3>My cash drawer</h3>
      {!mine ? <fieldset disabled={busy} className="cash-drawer-form">
        <p>Open a shift before taking cash. Count the change in the drawer and enter it as the opening float.</p>
        <label>Opening float (₹) <input type="number" min="0" step="0.01" value={float} onChange={(e) => setFloat(e.target.value)} /></label>
        <button className="primary" onClick={() => void run(async () => {
          await apiFetch("/api/shifts", { method: "POST", body: JSON.stringify({ clientRef: uuid(), openingFloatPaise: amount(float, "the opening float") }) });
          setMessage("Shift opened.");
        })}>Open shift</button>
      </fieldset> : <>
        <p className="muted">Open since {time(mine.openedAt)}</p>
        <dl className="pos-totals">
          <dt>Opening float</dt><dd>{money(mine.openingFloatPaise)}</dd>
          <dt>Cash sales you settled</dt><dd>{money(mine.cashSalesPaise)}</dd>
          <dt>Cash refunds</dt><dd>-{money(mine.cashRefundsPaise)}</dd>
          <dt>Pay-ins</dt><dd>{money(mine.payInPaise)}</dd>
          <dt>Pay-outs</dt><dd>-{money(mine.payOutPaise)}</dd>
          <dt><strong>Expected in drawer</strong></dt><dd><strong>{money(mine.expectedCashPaise)}</strong></dd>
        </dl>
        <fieldset disabled={busy} className="cash-drawer-form">
          <legend>Pay-in / pay-out</legend>
          <select aria-label="Movement" value={movement.kind} onChange={(e) => setMovement({ ...movement, kind: e.target.value as "pay_in" | "pay_out" })}>
            <option value="pay_out">Pay-out (cash taken out)</option><option value="pay_in">Pay-in (cash added)</option>
          </select>
          <label>Amount (₹) <input type="number" min="0" step="0.01" value={movement.amount} onChange={(e) => setMovement({ ...movement, amount: e.target.value })} /></label>
          <label>Reason <input maxLength={200} value={movement.reason} placeholder="Milk, change from bank…" onChange={(e) => setMovement({ ...movement, reason: e.target.value })} /></label>
          <button onClick={() => void run(async () => {
            await apiFetch(`/api/shifts/${mine.id}/cash-movements`, { method: "POST", body: JSON.stringify({ clientRef: uuid(), kind: movement.kind, amountPaise: amount(movement.amount, "the amount"), reason: movement.reason }) });
            setMovement({ ...movement, amount: "", reason: "" }); setMessage("Saved.");
          })}>Record</button>
        </fieldset>
        <fieldset disabled={busy} className="cash-drawer-form">
          <legend>Close shift</legend>
          <label>Cash counted in drawer (₹) <input type="number" min="0" step="0.01" value={counted} onChange={(e) => setCounted(e.target.value)} /></label>
          {countedPaise !== null && counted.trim() !== "" && <p>Difference: <strong>{signed(countedPaise - mine.expectedCashPaise)}</strong></p>}
          <label>Note <input maxLength={200} value={closeNote} onChange={(e) => setCloseNote(e.target.value)} /></label>
          <button className="primary" disabled={counted.trim() === ""} onClick={() => void run(async () => {
            const { shift } = await apiFetch<{ shift: Shift }>(`/api/shifts/${mine.id}/close`, { method: "POST", body: JSON.stringify({ clientRef: uuid(), countedCashPaise: amount(counted, "the counted cash"), note: closeNote }) });
            setCounted(""); setCloseNote(""); setMessage(`Shift closed. Difference: ${signed(shift.variancePaise ?? 0)}.`);
          })}>Close shift</button>
        </fieldset>
      </>}
    </>}

    <div className="page-header"><h3>Shifts and day close</h3>
      <label>Date <input type="date" value={date} max={localDay()} onChange={(e) => e.target.value && setDate(e.target.value)} /></label>
    </div>
    <div className="sales-report-table" role="region" aria-label="Shifts" tabIndex={0}>
      <table>
        <thead><tr><th>Cashier</th><th>Opened</th><th>Closed</th><th>Float</th><th>Cash sales</th><th>Refunds</th><th>Pay-in / out</th><th>Expected</th><th>Counted</th><th>Difference</th></tr></thead>
        <tbody>{shifts.length ? shifts.map((s) => <tr key={s.id}>
          <td>{s.cashierName}</td><td>{time(s.openedAt)}</td><td>{s.closedAt ? time(s.closedAt) : "Open"}</td>
          <td>{money(s.openingFloatPaise)}</td><td>{money(s.cashSalesPaise)}</td><td>{money(s.cashRefundsPaise)}</td>
          <td>{money(s.payInPaise)} / {money(s.payOutPaise)}</td><td>{money(s.expectedCashPaise)}</td>
          <td>{s.countedCashPaise === null ? "—" : money(s.countedCashPaise)}</td>
          <td>{s.variancePaise === null ? "—" : signed(s.variancePaise)}{s.note && <small className="muted"> · {s.note}</small>}</td>
        </tr>) : <tr><td colSpan={10}>No shifts on this date.</td></tr>}</tbody>
      </table>
    </div>

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
            await apiFetch("/api/day-close", { method: "POST", body: JSON.stringify({ clientRef: uuid(), date: day.date, note: dayNote }) });
            setDayNote(""); setMessage(`${day.date} closed.`);
          })}>Close day</button>
        </fieldset>}
      </div>)}
    {error && <p role="alert">{error}</p>}
    {message && <p role="status">{message}</p>}
  </section>;
}
