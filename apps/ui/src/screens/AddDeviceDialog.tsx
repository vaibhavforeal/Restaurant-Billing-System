import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { JOIN_CODE_TTL_MS, type DeviceHistory, type DeviceInfo, type DeviceKind, type DeviceList, type JoinCodeIssued } from "@masalapos/domain/devices";
import { apiFetch } from "../api";
import { KIND_LABELS, canAddNew, joinEvent, newestEventId } from "../devices-model";
import { useIntegrations } from "../integrations";
import { countdown } from "../join-code";
import { WorkspaceDialog } from "../WorkspaceDialog";
import { ConnectionHelp } from "./ConnectionHelp";

/** How often the dialog asks whether the device has joined, besides each time the device list reloads. */
const JOIN_CHECK_MS = 5000;
/** How long "has joined" stays on screen before the dialog closes itself. */
const CLOSE_AFTER_JOIN_MS = 3000;

/**
 * Adds a device, or moves an existing one to another browser. Three steps: choose what the code is for; the code, its
 * countdown and how to connect a device of that kind; and a confirmation once the device has joined.
 * `replace` opens on replacing that device. `changes` goes up each time the device list is read again.
 */
export function AddDeviceDialog({ list, replace, changes, onClose }: { list: DeviceList; replace?: DeviceInfo | undefined; changes: number; onClose: () => void }) {
  const kitchenDisplay = useIntegrations().isEnabled("kds");
  const [mode, setMode] = useState<"new" | "replace">(replace ? "replace" : "new");
  const [kind, setKind] = useState<DeviceKind>("counter");
  const [name, setName] = useState("");
  const [replaces, setReplaces] = useState(replace?.id ?? "");
  const [issued, setIssued] = useState<JoinCodeIssued | null>(null);
  // The countdown runs from when the code arrived, on this device's own clock, so a wrong clock here cannot shorten or stretch it.
  const [until, setUntil] = useState(0);
  const [left, setLeft] = useState(JOIN_CODE_TTL_MS);
  const [joined, setJoined] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  /** The newest device event and the devices there were when the code was made: what a join is told apart from. */
  const before = useRef<{ eventId: number; ids: ReadonlySet<string> }>({ eventId: 0, ids: new Set() });

  const kinds = (Object.keys(KIND_LABELS) as DeviceKind[]).filter((k) => k !== "kitchen" || kitchenDisplay);
  const addNew = canAddNew(list);
  // A device chosen for replacement may be removed while this dialog is open.
  const target = list.devices.find((d) => d.id === replaces);
  const expired = issued !== null && !joined && left <= 0;

  useEffect(() => {
    if (!issued || joined) return;
    const tick = () => setLeft(until - Date.now());
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [issued, joined, until]);

  const checkJoined = useCallback(async () => {
    if (!issued) return;
    try {
      const { events } = await apiFetch<DeviceHistory>("/api/devices/events");
      if (joinEvent(issued, events, before.current.eventId, before.current.ids)) setJoined(true);
    } catch { /* The next check asks again. */ }
  }, [issued]);
  useEffect(() => {
    if (!issued || joined || expired) return;
    void checkJoined();
    const timer = setInterval(() => { void checkJoined(); }, JOIN_CHECK_MS);
    return () => clearInterval(timer);
  }, [issued, joined, expired, changes, checkJoined]);
  useEffect(() => {
    if (!joined) return;
    const timer = setTimeout(onClose, CLOSE_AFTER_JOIN_MS);
    return () => clearTimeout(timer);
  }, [joined, onClose]);

  async function create(e: FormEvent) {
    e.preventDefault();
    if (lock.current) return;
    lock.current = true; setBusy(true); setError("");
    try {
      const { events } = await apiFetch<DeviceHistory>("/api/devices/events");
      before.current = { eventId: newestEventId(events), ids: new Set(list.devices.map((d) => d.id)) };
      const body = mode === "new" ? { kind, name: name.trim() } : { replacesDeviceId: target!.id };
      const code = await apiFetch<JoinCodeIssued>("/api/devices/join-codes", { method: "POST", body: JSON.stringify(body) });
      setLeft(JOIN_CODE_TTL_MS); setUntil(Date.now() + JOIN_CODE_TTL_MS); setJoined(false); setIssued(code);
    } catch (err) { setError(err instanceof Error ? err.message : "Could not create a join code"); }
    finally { lock.current = false; setBusy(false); }
  }

  const title = issued ? `Join code for ${issued.name}` : replace ? `Replace ${replace.name}` : "Add device";
  return <WorkspaceDialog open title={title} className="add-device-dialog" busy={busy} onClose={onClose}>
    {issued ? <div className="add-device-body">
      {joined ? <>
        <p role="status" className="add-device-joined">{issued.name} has joined.</p>
        <button type="button" className="primary" onClick={onClose}>Done</button>
      </> : expired ? <>
        <p role="status" className="devices-error">This code has expired. Create a new one.</p>
        <button type="button" onClick={() => setIssued(null)}>Create a new code</button>
      </> : <>
        <p className="add-device-code" aria-label={`Join code ${issued.code.split("").join(" ")}`}>{issued.code}</p>
        <p role="timer" className="devices-note">Valid for {countdown(left)}. It works once.{issued.replacesDeviceId ? " The device's old browser is signed out when the new one joins." : ""}</p>
        <p role="status" className="muted devices-note">Waiting for the device to join…</p>
        <ConnectionHelp kind={issued.kind} issued={issued} />
      </>}
    </div> : <form className="add-device-body" onSubmit={(e) => { void create(e); }}>
      <div className="add-device-modes" role="radiogroup" aria-label="What the code is for">
        <label><input type="radio" name="add-device-mode" checked={mode === "new"} disabled={busy} onChange={() => { setMode("new"); setError(""); }} /> New device</label>
        <label><input type="radio" name="add-device-mode" checked={mode === "replace"} disabled={busy} onChange={() => { setMode("replace"); setError(""); }} /> Replace an existing device</label>
      </div>
      {mode === "new" ? <>
        {!addNew.allowed && <p className="devices-error">{addNew.reason}</p>}
        <label>Type<select value={kind} disabled={busy || !addNew.allowed} onChange={(e) => setKind(e.target.value as DeviceKind)}>
          {kinds.map((k) => <option key={k} value={k}>{KIND_LABELS[k]}</option>)}</select></label>
        <label>Device name<input maxLength={80} value={name} placeholder="Counter 2" disabled={busy || !addNew.allowed} onChange={(e) => setName(e.target.value)} /></label>
        <button className="primary" disabled={busy || !addNew.allowed || !name.trim()}>Create join code</button>
      </> : <>
        <p className="muted devices-note">The new browser takes over this device's name and place. Its old browser is signed out.</p>
        <label>Device<select value={target?.id ?? ""} disabled={busy} onChange={(e) => setReplaces(e.target.value)}>
          <option value="">Choose a device</option>
          {list.devices.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select></label>
        <button className="primary" disabled={busy || !target}>Create join code</button>
      </>}
      {error && <p role="alert" className="devices-error">{error}</p>}
    </form>}
  </WorkspaceDialog>;
}
