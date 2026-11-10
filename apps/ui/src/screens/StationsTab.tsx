import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "../api";
import { useCan } from "../permissions";
import type { PrinterInfo, StationInfo } from "../types";
import { useAction } from "../use-action";

/** Settings → Devices → Kitchen stations: where each station's kitchen tickets print. */
export function StationsTab() {
  const manage = useCan()("printers.manage");
  const [stations, setStations] = useState<StationInfo[] | null>(null);
  const [printers, setPrinters] = useState<PrinterInfo[]>([]);
  const [name, setName] = useState("");
  const { busy, error, setError, run } = useAction();

  const load = useCallback(async () => {
    try {
      const [s, p] = await Promise.all([apiFetch<{ stations: StationInfo[] }>("/api/kot-stations"), apiFetch<{ printers: PrinterInfo[] }>("/api/printers")]);
      setStations(s.stations); setPrinters(p.printers);
    } catch { setError("Could not load the kitchen stations"); }
  }, [setError]);
  useEffect(() => { void load(); }, [load]);

  /** Runs a change and reloads afterwards, also when it failed: the list on screen may be out of date. */
  async function change(action: () => Promise<unknown>, fallback: string) {
    await run(action, fallback);
    await load();
  }
  function add() {
    const trimmed = name.trim();
    if (!trimmed) return setError("Station name is required");
    void change(async () => { await apiFetch("/api/kot-stations", { method: "POST", body: JSON.stringify({ name: trimmed }) }); setName(""); }, "Failed to add station");
  }
  const patch = (id: string, body: object, fallback: string) => void change(() => apiFetch(`/api/kot-stations/${id}`, { method: "PATCH", body: JSON.stringify(body) }), fallback);
  const activePrinters = printers.filter((p) => p.isActive);
  const printerName = (id: string | null) => id === null ? "No printer" : printers.find((p) => p.id === id)?.name ?? "No printer";

  return <div className="panel devices-panel" role="region" aria-label="Kitchen stations">
    {error && <p role="alert" className="devices-error">{error}</p>}
    {stations === null && !error && <p role="status">Loading kitchen stations…</p>}
    {stations?.length === 0 && <p className="muted">No kitchen stations yet.</p>}
    {!!stations?.length && <table className="devices-table">
      <thead><tr><th>Station</th><th>Printer</th><th>Active</th>{manage && <th><span className="sr-only">Actions</span></th>}</tr></thead>
      <tbody>{stations.map((s) => <tr key={s.id} className={s.isActive ? undefined : "devices-inactive"}>
        <td>{s.name}</td>
        <td>{manage ? <select aria-label={`Printer for ${s.name}`} value={s.printerId ?? ""} disabled={!s.isActive || busy}
          onChange={(e) => patch(s.id, { printerId: e.target.value || null }, "Failed to update station")}>
          <option value="">No printer</option>
          {activePrinters.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select> : printerName(s.printerId)}</td>
        <td>{s.isActive ? "✓" : "—"}</td>
        {manage && <td className="devices-actions"><button onClick={() => patch(s.id, { isActive: !s.isActive }, "Failed to toggle station")} disabled={busy}>{s.isActive ? "Deactivate" : "Activate"}</button></td>}
      </tr>)}</tbody>
    </table>}
    {manage && <div className="devices-add-row">
      <input placeholder="Station name" aria-label="Station name" value={name} onChange={(e) => setName(e.target.value)} />
      <button onClick={add} disabled={busy}>Add station</button>
    </div>}
  </div>;
}
