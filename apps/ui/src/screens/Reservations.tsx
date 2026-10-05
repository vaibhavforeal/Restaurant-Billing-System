import { useCallback, useEffect, useRef, useState } from "react";
import type { Reservation, ReservationInput, ReservationList } from "@forkflow/domain";
import { apiFetch, session, type User } from "../api";
import type { Order, TableInfo } from "../types";
import { connectWs } from "../ws";
import { uuid } from "../uuid";
import { WorkspaceDialog } from "../WorkspaceDialog";
import "../reservations.css";

interface Editor { id: string | null; version: number; clientRef: string; input: ReservationInput; original: string }
const statusText = { booked: "Booked", seated: "Seated", cancelled: "Cancelled", no_show: "No-show" };

export function Reservations({ user, tables, initialTableId, onClose, onOpenOrder, onChanged, onBusyChange, onDirtyChange }: {
  user: User; tables: TableInfo[]; initialTableId: string | null; onClose: () => void;
  onOpenOrder: (id: string) => void; onChanged: () => void;
  onBusyChange: (busy: boolean) => void; onDirtyChange: (dirty: boolean) => void;
}) {
  const canManage = user.role === "admin" || user.role === "cashier";
  const [date, setDate] = useState("");
  const [tableFilter, setTableFilter] = useState(initialTableId ?? "");
  const [data, setData] = useState<ReservationList | null>(null);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [error, setError] = useState("");
  const [loadError, setLoadError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const lock = useRef(false), sequence = useRef(0);
  const mounted = useRef(true);
  const dirty = editor !== null && JSON.stringify(editor.input) !== editor.original;

  useEffect(() => { onDirtyChange(dirty); return () => onDirtyChange(false); }, [dirty, onDirtyChange]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; sequence.current++; }; }, []);
  const reload = useCallback(async () => {
    const request = ++sequence.current;
    setLoading(true);
    try {
      const result = await apiFetch<ReservationList>(`/api/reservations${date ? `?date=${encodeURIComponent(date)}` : ""}`);
      if (mounted.current && request === sequence.current) {
        setData(result); setDate((value) => value || result.date); setLoadError("");
      }
    } catch (e) {
      if (mounted.current && request === sequence.current) {
        setData(null); setLoadError(e instanceof Error ? e.message : "Could not load reservations");
      }
    } finally { if (mounted.current && request === sequence.current) setLoading(false); }
  }, [date]);
  useEffect(() => {
    void reload();
    const dispose = connectWs({ onEvent: (event) => { if (["reservation.changed", "order.updated", "table.changed"].includes(event)) void reload(); },
      onStatus: (connected) => { if (connected) void reload(); }, onAuthFail: () => session.clear() });
    const timer = window.setInterval(() => { void reload(); }, 30000);
    return () => { sequence.current++; dispose(); window.clearInterval(timer); };
  }, [reload]);

  async function run(action: () => Promise<{ orderId?: string; date?: string } | void>) {
    if (lock.current) return;
    lock.current = true; setBusy(true); onBusyChange(true); setError(""); setMessage("");
    let orderId: string | undefined;
    try {
      const result = await action();
      orderId = result?.orderId;
      onChanged();
      if (result?.date && result.date !== date) { sequence.current++; setDate(result.date); }
      else if (!orderId) await reload();
    }
    catch (e) { setError(e instanceof Error ? e.message : "Reservation request failed"); }
    finally { lock.current = false; setBusy(false); onBusyChange(false); }
    if (orderId) { onDirtyChange(false); onOpenOrder(orderId); }
  }
  function close() {
    if (lock.current || (dirty && !window.confirm("Discard the unsaved reservation changes?"))) return;
    onDirtyChange(false); onClose();
  }
  function startEditor(reservation?: Reservation) {
    const nowLocal = data?.nowLocal ?? `${date}T19:00`;
    const input: ReservationInput = reservation ? {
      tableId: reservation.tableId, customerName: reservation.customerName, phone: reservation.phone,
      partySize: reservation.partySize, startsLocal: reservation.startsLocal, durationMinutes: reservation.durationMinutes, notes: reservation.notes,
    } : { tableId: tableFilter || tables.find((t) => t.isActive)?.id || "", customerName: "", phone: "", partySize: 2,
      startsLocal: date === nowLocal.slice(0, 10) ? nowLocal : `${date}T19:00`, durationMinutes: 90, notes: "" };
    setEditor({ id: reservation?.id ?? null, version: reservation?.version ?? 1, clientRef: uuid(), input, original: JSON.stringify(input) });
    setError(""); setMessage("");
  }
  function field<K extends keyof ReservationInput>(key: K, value: ReservationInput[K]) {
    setEditor((old) => old ? { ...old, input: { ...old.input, [key]: value } } : null);
  }
  function save() {
    if (!editor) return;
    void run(async () => {
      const { reservation } = await apiFetch<{ reservation: Reservation }>(editor.id ? `/api/reservations/${editor.id}` : "/api/reservations", {
        method: editor.id ? "PATCH" : "POST", body: JSON.stringify({ ...editor.input, ...(editor.id ? { version: editor.version } : { clientRef: editor.clientRef }) }),
      });
      setEditor(null); onDirtyChange(false); setTableFilter((value) => value ? reservation.tableId : "");
      setMessage(`Reservation saved for ${reservation.customerName} at ${reservation.tableName}.`);
      return { date: reservation.startsLocal.slice(0, 10) };
    });
  }
  function changeStatus(reservation: Reservation, status: "cancelled" | "no_show") {
    if (!window.confirm(`${status === "cancelled" ? "Cancel the reservation" : "Mark as a no-show"} for ${reservation.customerName} at ${reservation.tableName}?`)) return;
    void run(async () => {
      await apiFetch(`/api/reservations/${reservation.id}/status`, { method: "POST", body: JSON.stringify({ version: reservation.version, status }) });
      setMessage(`Reservation ${status === "cancelled" ? "cancelled" : "marked as a no-show"}.`);
    });
  }
  const visible = (data?.date === date ? data.reservations : []).filter((r) => !tableFilter || r.tableId === tableFilter);
  const time = (ms: number) => new Date(ms).toLocaleTimeString("en-IN", { timeZone: data?.timezone, hour: "2-digit", minute: "2-digit" });
  const now = data?.now ?? Date.now();

  return <WorkspaceDialog open title="Reservations" onClose={close} busy={busy} className="reservations-dialog">
    <p className="reservation-help">{data ? `Restaurant time: ${data.timezone}. ` : ""}Bookings hold a table for the selected time. Seat the party to open its bill.</p>
    {error && <p className="error-message" role="alert">{error}</p>}
    {loadError && <p className="error-message" role="alert">{loadError}</p>}
    {message && <p role="status">{message}</p>}
    {editor ? <form className="reservation-form" onSubmit={(event) => { event.preventDefault(); save(); }}>
      <h3>{editor.id ? "Edit reservation" : "Reserve a table"}</h3>
      <label>Guest name<input required maxLength={100} disabled={busy} value={editor.input.customerName} onChange={(e) => field("customerName", e.target.value)} /></label>
      <label>Phone (optional)<input type="tel" maxLength={30} disabled={busy} value={editor.input.phone} onChange={(e) => field("phone", e.target.value)} /></label>
      <label>Party size<input type="number" min={1} max={99} required disabled={busy} value={editor.input.partySize} onChange={(e) => field("partySize", Number(e.target.value))} /></label>
      <label>Table<select required disabled={busy} value={editor.input.tableId} onChange={(e) => field("tableId", e.target.value)}>
        <option value="">Choose a table</option>{tables.filter((t) => t.isActive).map((t) => <option key={t.id} value={t.id}>{t.name}{t.area ? ` · ${t.area}` : ""}</option>)}
      </select></label>
      <label>Date and time<input type="datetime-local" required disabled={busy} value={editor.input.startsLocal} onChange={(e) => field("startsLocal", e.target.value)} /></label>
      <label>Duration (minutes)<input type="number" min={15} max={480} required disabled={busy} value={editor.input.durationMinutes} onChange={(e) => field("durationMinutes", Number(e.target.value))} /></label>
      <label className="reservation-wide">Notes (optional)<textarea rows={2} maxLength={500} disabled={busy} value={editor.input.notes} onChange={(e) => field("notes", e.target.value)} /></label>
      <p className="reservation-help reservation-wide">Check the chosen table has enough seats for the party. Overlapping reservations are blocked.</p>
      <div className="reservation-actions reservation-wide"><button className="primary" disabled={busy}>{busy ? "Saving…" : "Save reservation"}</button>
        <button type="button" disabled={busy} onClick={() => { if (!dirty || window.confirm("Discard the unsaved reservation changes?")) { setEditor(null); onDirtyChange(false); setError(""); } }}>Back to reservations</button></div>
    </form> : <>
      <div className="reservation-toolbar">
        <label>Reservation date<input type="date" value={date} disabled={busy} onChange={(e) => { if (e.target.value) { setDate(e.target.value); setError(""); setMessage(""); } }} /></label>
        <label>Show table<select value={tableFilter} disabled={busy} onChange={(e) => setTableFilter(e.target.value)}><option value="">All tables</option>{tables.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></label>
        <button disabled={busy} onClick={() => { void run(async () => {}); }}>Refresh</button>
        {canManage && <button className="primary" disabled={busy || loading || !data || !tables.some((t) => t.isActive)} onClick={() => startEditor()}>New reservation</button>}
      </div>
      {loading && <p role="status">Updating reservations…</p>}
      {!canManage && <p className="reservation-help">An admin or cashier can create, change or seat a reservation.</p>}
      {!loading && !loadError && !visible.length && <p className="reservation-empty">No reservations for this date{tableFilter ? " and table" : ""}.</p>}
      <div className="reservation-list">{visible.map((r) => <article key={r.id} className={`reservation-card ${r.status}`}>
        <div className="reservation-card-top"><strong>{time(r.startsAt)} – {time(r.endsAt)}{r.startsLocal.slice(0, 10) !== date ? " (starts previous day)" : ""}</strong><span className="reservation-status">{statusText[r.status]}</span></div>
        <h3>{r.customerName}</h3><p>{r.tableName}{r.area ? ` · ${r.area}` : ""} · {r.partySize} {r.partySize === 1 ? "guest" : "guests"}</p>
        {r.phone && <p>{r.phone}</p>}{r.notes && <p className="reservation-notes">{r.notes}</p>}
        {r.status === "booked" && r.endsAt <= now && <p className="reservation-help">Booking time has ended. Reschedule or mark as a no-show.</p>}
        <div className="reservation-actions">
          {canManage && r.status === "booked" && <>
            <button className="primary" disabled={busy || now < r.startsAt - 30 * 60000 || now >= r.endsAt} title="Available from 30 minutes before the reservation until its end" onClick={() => { void run(async () => {
              const result = await apiFetch<{ order: Order }>(`/api/reservations/${r.id}/seat`, { method: "POST", body: JSON.stringify({ version: r.version }) });
              return { orderId: result.order.id };
            }); }}>Seat & open bill</button>
            <button disabled={busy} onClick={() => startEditor(r)}>Edit</button>
            <button disabled={busy || now < r.startsAt} onClick={() => changeStatus(r, "no_show")}>No-show</button>
            <button disabled={busy} onClick={() => changeStatus(r, "cancelled")}>Cancel reservation</button>
          </>}
          {r.status === "seated" && r.orderId && <button disabled={busy} onClick={() => onOpenOrder(r.orderId!)}>Open order{r.orderStatus === "settled" ? " (settled)" : ""}</button>}
        </div>
      </article>)}</div>
    </>}
  </WorkspaceDialog>;
}
