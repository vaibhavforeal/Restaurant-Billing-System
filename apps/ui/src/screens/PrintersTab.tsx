import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "../api";
import { usedByText } from "../devices-model";
import { InfoTip } from "../InfoTip";
import { useCan } from "../permissions";
import type { PrinterInfo } from "../types";
import { useAction } from "../use-action";
import { DEFAULT_PRINT_PROFILE, PrintProfileControls, WindowsPrinterPicker } from "./PrinterControls";

type PrinterKind = PrinterInfo["kind"];
type NewPrinter = Omit<PrinterInfo, "id" | "isActive" | "usedBy">;
const EMPTY_PRINTER: NewPrinter = { name: "", kind: "network", connection: "", paperWidth: 80,
  receiptProfile: DEFAULT_PRINT_PROFILE, kotProfile: DEFAULT_PRINT_PROFILE };
const KIND_NAMES: Record<PrinterKind, string> = { network: "Network", windows: "Windows", bluetooth: "Bluetooth" };

function connectionPlaceholder(kind: PrinterKind): string {
  if (kind === "network") return "IP address (e.g. 192.168.1.50)";
  if (kind === "windows") return "Windows printer name";
  return "COM port (e.g. COM3)";
}

function KindOptions() {
  return <>
    <option value="network">Network (WiFi/LAN)</option>
    <option value="windows">USB (Windows driver)</option>
    <option value="bluetooth">Bluetooth (COM port)</option>
  </>;
}

/** Settings → Devices → Printers: the printers the main PC can reach, who prints to each, and adding or changing one. */
export function PrintersTab() {
  const manage = useCan()("printers.manage");
  const [printers, setPrinters] = useState<PrinterInfo[] | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [edit, setEdit] = useState<Partial<PrinterInfo>>({});
  const [added, setAdded] = useState<NewPrinter>(EMPTY_PRINTER);
  const { busy, error, setError, run } = useAction();

  const load = useCallback(async () => {
    try { setPrinters((await apiFetch<{ printers: PrinterInfo[] }>("/api/printers")).printers); }
    catch { setError("Could not load the printers"); }
  }, [setError]);
  useEffect(() => { void load(); }, [load]);

  /** Runs a change and reloads the list afterwards, also when it failed: the list on screen may be out of date. */
  async function change(action: () => Promise<unknown>, fallback: string) {
    const saved = await run(action, fallback);
    await load();
    return saved;
  }
  function add() {
    if (!added.name.trim() || !added.connection.trim()) return setError("Printer name and connection are required");
    void change(async () => {
      await apiFetch("/api/printers", { method: "POST", body: JSON.stringify(added) });
      setAdded(EMPTY_PRINTER);
    }, "Failed to add printer");
  }
  function startEdit(p: PrinterInfo) {
    setEditingId(p.id);
    setEdit({ name: p.name, kind: p.kind, connection: p.connection, paperWidth: p.paperWidth, receiptProfile: p.receiptProfile, kotProfile: p.kotProfile });
  }
  const save = (id: string) => void change(async () => {
    await apiFetch(`/api/printers/${id}`, { method: "PATCH", body: JSON.stringify(edit) });
    setEditingId(null);
  }, "Failed to update printer");
  const toggle = (p: PrinterInfo) => void change(() => apiFetch(`/api/printers/${p.id}`, { method: "PATCH", body: JSON.stringify({ isActive: !p.isActive }) }), "Failed to toggle printer");
  const testPrint = (id: string, profile: "receipt" | "kot") => void run(() => apiFetch(`/api/printers/${id}/test-print`, { method: "POST", body: JSON.stringify({ profile }) }), "Test print failed");

  return <div className="panel devices-panel">
    <p className="muted devices-note">Printers must be reachable from the main PC: on the network, installed in Windows on the main PC, or paired to it by Bluetooth.</p>
    {error && <p role="alert" className="devices-error">{error}</p>}
    {printers === null && !error && <p role="status">Loading printers…</p>}
    {printers?.length === 0 && <p className="muted">No printers yet.</p>}
    {!!printers?.length && <div className="printer-table-scroll" role="region" aria-label="Configured printers" tabIndex={0}>
      <table className="devices-table">
        <thead><tr><th>Name</th><th>Kind</th><th>Connection</th><th>Paper</th><th>Used by</th><th>Active</th>{manage && <th><span className="sr-only">Actions</span></th>}</tr></thead>
        <tbody>
          {printers.map((p) => editingId === p.id ? <tr key={p.id}>
            <td><input aria-label="Printer name" value={edit.name ?? ""} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></td>
            <td><select aria-label="Printer connection type" value={edit.kind ?? "network"} onChange={(e) => setEdit({ ...edit, kind: e.target.value as PrinterKind, connection: "" })}><KindOptions /></select></td>
            <td>{edit.kind === "windows"
              ? <WindowsPrinterPicker value={edit.connection ?? ""} onChange={(connection) => setEdit((previous) => ({ ...previous, connection }))} disabled={busy} />
              : <input aria-label="Printer address or connection" value={edit.connection ?? ""} placeholder={connectionPlaceholder(edit.kind ?? "network")} onChange={(e) => setEdit({ ...edit, connection: e.target.value })} />}</td>
            <td><select aria-label="Paper width" value={edit.paperWidth ?? 80} onChange={(e) => setEdit({ ...edit, paperWidth: Number(e.target.value) as 58 | 80 })}>
              <option value={80}>80mm</option><option value={58}>58mm</option></select></td>
            <td>{usedByText(p.usedBy)}</td>
            <td>{p.isActive ? "✓" : "—"}</td>
            <td className="devices-actions"><button onClick={() => save(p.id)} disabled={busy}>Save</button><button onClick={() => setEditingId(null)} disabled={busy}>Cancel</button></td>
          </tr> : <tr key={p.id} className={p.isActive ? undefined : "devices-inactive"}>
            <td>{p.name}</td>
            <td>{KIND_NAMES[p.kind]}</td>
            <td>{p.connection}</td>
            <td>{p.paperWidth}mm</td>
            <td>{usedByText(p.usedBy)}</td>
            <td>{p.isActive ? "✓" : "—"}</td>
            {manage && <td className="devices-actions">
              <button onClick={() => testPrint(p.id, "receipt")} disabled={busy || !p.isActive}>Test print</button>
              <button onClick={() => testPrint(p.id, "kot")} disabled={busy || !p.isActive}>Test KOT</button>
              <button onClick={() => startEdit(p)} disabled={busy}>Edit</button>
              <button onClick={() => toggle(p)} disabled={busy}>{p.isActive ? "Deactivate" : "Activate"}</button>
            </td>}
          </tr>)}
        </tbody>
      </table>
    </div>}

    {manage && editingId && <div className="printer-profiles">
      <PrintProfileControls title="Bill profile" value={edit.receiptProfile ?? DEFAULT_PRINT_PROFILE} disabled={busy}
        onChange={(receiptProfile) => setEdit((previous) => ({ ...previous, receiptProfile }))} />
      <PrintProfileControls title="KOT and cancellation profile" value={edit.kotProfile ?? DEFAULT_PRINT_PROFILE} disabled={busy}
        onChange={(kotProfile) => setEdit((previous) => ({ ...previous, kotProfile }))} />
      <div className="info-action-row"><button disabled={busy} onClick={() => save(editingId)}>Save printer and profiles</button><InfoTip>Test prints use the saved profile and its copy count.</InfoTip></div>
    </div>}

    {manage && <div className="printer-form">
      <div className="printer-form-row">
        <input className="printer-form-wide" placeholder="Printer name" aria-label="New printer name" value={added.name} onChange={(e) => setAdded({ ...added, name: e.target.value })} />
        <select aria-label="New printer connection type" value={added.kind} onChange={(e) => setAdded({ ...added, kind: e.target.value as PrinterKind, connection: "" })}><KindOptions /></select>
      </div>
      <div className="printer-form-row">
        {added.kind === "windows"
          ? <WindowsPrinterPicker value={added.connection} onChange={(connection) => setAdded((previous) => ({ ...previous, connection }))} disabled={busy} />
          : <input className="printer-form-wide" aria-label="New printer address or connection" placeholder={connectionPlaceholder(added.kind)} value={added.connection} onChange={(e) => setAdded({ ...added, connection: e.target.value })} />}
        <select aria-label="New printer paper width" value={added.paperWidth} onChange={(e) => setAdded({ ...added, paperWidth: Number(e.target.value) as 58 | 80 })}>
          <option value={80}>80mm</option><option value={58}>58mm</option></select>
        <PrintProfileControls title="New bill profile" value={added.receiptProfile} disabled={busy} onChange={(receiptProfile) => setAdded((previous) => ({ ...previous, receiptProfile }))} />
        <PrintProfileControls title="New KOT and cancellation profile" value={added.kotProfile} disabled={busy} onChange={(kotProfile) => setAdded((previous) => ({ ...previous, kotProfile }))} />
        <button onClick={add} disabled={busy}>Add printer</button>
      </div>
    </div>}
  </div>;
}
