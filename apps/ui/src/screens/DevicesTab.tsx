import { useCallback, useEffect, useRef, useState } from "react";
import type { DeviceHistory, DeviceInfo, DeviceList } from "@masalapos/domain/devices";
import { apiFetch } from "../api";
import { KIND_LABELS, billPrinterText, deviceBadges, presenceText, slotsText, withPresence } from "../devices-model";
import { connectWs } from "../ws";
import { AddDeviceDialog } from "./AddDeviceDialog";
import { DeviceDialog } from "./DeviceDialog";
import { useLicense } from "./LicenseSettings";

type ActivePrinter = { id: string; name: string };
const WARNING_BADGES = new Set(["Over limit", "Printer inactive"]);

/**
 * Settings → Devices → Devices: every counter, kitchen display and captain tablet of the restaurant, whether each is
 * connected now, where its bills print, and what happened to devices. A row opens the device.
 * `recovery` is the licence recovery screen: the list, renaming, removing and the history only.
 */
export function DevicesTab({ recovery = false }: { recovery?: boolean }) {
  const timezone = useLicense().status?.timezone;
  const [list, setList] = useState<DeviceList | null>(null);
  const [printers, setPrinters] = useState<ActivePrinter[]>([]);
  const [history, setHistory] = useState<DeviceHistory | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  /** The Add device dialog: closed, open for a new device, or open on replacing one. */
  const [adding, setAdding] = useState<{ replace?: DeviceInfo } | null>(null);
  /** Goes up each time the list is read again, so the Add device dialog looks for the device it is waiting for. */
  const [changes, setChanges] = useState(0);
  const sequence = useRef(0);
  /** The last device list that loaded; `list` itself is emptied when a reload fails, so no stale row can be acted on. */
  const lastList = useRef<DeviceList | null>(null);

  const load = useCallback(async () => {
    const request = ++sequence.current;
    try {
      const [devices, events, active] = await Promise.all([
        apiFetch<DeviceList>("/api/devices"),
        apiFetch<DeviceHistory>("/api/devices/events"),
        // The printers only name a device's bill printer; the list is worth showing without them.
        recovery ? { printers: [] } : apiFetch<{ printers: ActivePrinter[] }>("/api/billing-printers").catch(() => ({ printers: [] })),
      ]);
      if (request !== sequence.current) return;
      lastList.current = devices;
      setList(devices); setHistory(events); setPrinters(active.printers); setError(""); setChanges((n) => n + 1);
    } catch (e) {
      if (request !== sequence.current) return;
      setList(null); setHistory(null); setError(e instanceof Error ? e.message : "Could not load the devices");
    }
  }, [recovery]);

  useEffect(() => {
    void load();
    const changed = () => { void load(); };
    // A device joining, being replaced, renamed or removed is announced as a licence change.
    window.addEventListener("masalapos:license-changed", changed);
    const dispose = connectWs({
      onEvent: (event, data) => {
        if (event === "devices.changed") void load();
        else if (event === "devices.presence") setList((current) => current && { ...current, devices: withPresence(current.devices, data as { deviceId: string; online: boolean }) });
      },
      onStatus: (connected) => { if (connected) void load(); },
    });
    return () => { sequence.current++; window.removeEventListener("masalapos:license-changed", changed); dispose(); };
  }, [load]);

  const open = openId === null ? undefined : list?.devices.find((d) => d.id === openId);
  // The device on screen was removed by someone else.
  useEffect(() => {
    if (openId !== null && list && !list.devices.some((d) => d.id === openId)) { setOpenId(null); setNotice("That device was removed."); }
  }, [openId, list]);

  async function loadOlder() {
    if (!history?.nextBefore || loadingOlder) return;
    setLoadingOlder(true);
    try {
      const page = await apiFetch<DeviceHistory>(`/api/devices/events?before=${history.nextBefore}`);
      setHistory((old) => old ? { events: [...old.events, ...page.events.filter((e) => !old.events.some((o) => o.id === e.id))], nextBefore: page.nextBefore } : page);
    } catch (e) { setError(e instanceof Error ? e.message : "Could not load older changes"); }
    finally { setLoadingOlder(false); }
  }
  const replaceDevice = (device: DeviceInfo) => { setOpenId(null); setNotice(""); setAdding({ replace: device }); };
  const slots = list ? slotsText(list) : null;

  return <div className="panel devices-panel">
    <div className="devices-toolbar">
      <p className="devices-note">{slots ?? "Every counter, kitchen display and captain tablet joins with a code from here."}</p>
      {!recovery && <button type="button" className="primary" disabled={list === null} onClick={() => { setNotice(""); setAdding({}); }}>Add device</button>}
    </div>
    {error && <p role="alert" className="devices-error">{error} <button type="button" onClick={() => void load()}>Retry</button></p>}
    {notice && <p role="status" className="devices-note">{notice}</p>}
    {list === null && !error && <p role="status">Loading devices…</p>}
    {list && <div className="printer-table-scroll" role="region" aria-label="Devices" tabIndex={0}>
      <table className="devices-table">
        <thead><tr><th>Name</th><th>Type</th><th>Status</th><th>Bill printer</th></tr></thead>
        <tbody>{list.devices.map((device) => <tr key={device.id} className="device-row" onClick={() => { setNotice(""); setOpenId(device.id); }}>
          <td>
            <button type="button" className="device-open" aria-label={`Open ${device.name}`}>{device.name}</button>
            {deviceBadges(device, list.maxDevices !== null).map((badge) => <span key={badge} className={WARNING_BADGES.has(badge) ? "device-badge warning" : "device-badge"}>{badge}</span>)}
          </td>
          <td>{KIND_LABELS[device.kind]}</td>
          <td><span className={device.online ? "device-dot online" : "device-dot"} aria-hidden="true" />{presenceText(device, timezone)}</td>
          <td>{billPrinterText(device, printers)}</td>
        </tr>)}</tbody>
      </table>
    </div>}

    {history && <section className="device-history" aria-label="Device history">
      <h3>Device history</h3>
      {history.events.length === 0 && <p className="muted">No changes recorded yet.</p>}
      <ol>{history.events.map((event) => <li key={event.id}><strong>{event.summary}</strong>
        <small>{new Date(event.occurredAt).toLocaleString("en-IN", { timeZone: timezone })} / {event.actorName}</small></li>)}</ol>
      {history.nextBefore !== null && <button type="button" disabled={loadingOlder} onClick={() => void loadOlder()}>Load older changes</button>}
    </section>}

    {open && <DeviceDialog key={open.id} device={open} printers={printers} recovery={recovery}
      onChanged={(device) => { setList((current) => current && { ...current, devices: current.devices.map((d) => d.id === device.id ? device : d) }); void load(); }}
      onRemoved={() => { setOpenId(null); setNotice("Device removed."); void load(); }}
      onReplace={replaceDevice} onFailed={() => void load()} onClose={() => setOpenId(null)} />}
    {/* Stays open on the last list that loaded, so a join code on screen is not lost when a reload fails. */}
    {adding && lastList.current && <AddDeviceDialog list={list ?? lastList.current} replace={adding.replace} changes={changes} onClose={() => { setAdding(null); void load(); }} />}
  </div>;
}
