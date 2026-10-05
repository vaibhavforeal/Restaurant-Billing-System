import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "../api";
import type { PrintProfile } from "../types";

export const DEFAULT_PRINT_PROFILE: PrintProfile = { copies: 1, feedLines: 3, autoCut: true };

export function PrintProfileControls({ title, value, onChange, disabled }: {
  title: string; value: PrintProfile; onChange: (value: PrintProfile) => void; disabled: boolean;
}) {
  return <fieldset className="print-profile-controls" disabled={disabled} style={{ display: "grid", gap: 8, minWidth: 0 }}>
    <legend>{title}</legend>
    <label>Copies <input type="number" min={1} max={5} step={1} value={value.copies}
      onChange={event => onChange({ ...value, copies: Number(event.target.value) })} /></label>
    <label>Feed lines <input type="number" min={0} max={10} step={1} value={value.feedLines}
      onChange={event => onChange({ ...value, feedLines: Number(event.target.value) })} /></label>
    <label><input type="checkbox" checked={value.autoCut}
      onChange={event => onChange({ ...value, autoCut: event.target.checked })} /> Auto-cut paper</label>
  </fieldset>;
}

interface FoundPrinter { name: string; driver: string; port: string; isDefault: boolean }

export function WindowsPrinterPicker({ value, onChange, disabled }: {
  value: string; onChange: (value: string) => void; disabled: boolean;
}) {
  const [printers, setPrinters] = useState<FoundPrinter[]>([]);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [manual, setManual] = useState(false);
  const refresh = useCallback(async () => {
    setLoading(true); setMessage("");
    try {
      const result = await apiFetch<{ supported: boolean; printers: FoundPrinter[] }>("/api/printers/discover");
      setPrinters(result.printers);
      if (!result.supported) setMessage("Printer discovery requires a Windows POS computer.");
      else if (!result.printers.length) setMessage("No Windows printers found. Install the printer on the POS computer, then refresh.");
    } catch (error) { setMessage(error instanceof Error ? error.message : "Could not list printers"); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  const known = printers.some(printer => printer.name === value);
  return <div className="windows-printer-picker" style={{ display: "grid", gap: 6 }}>
    <label>Printer on POS computer
      <select aria-label="Installed Windows printer" disabled={disabled || loading} value={known ? value : ""}
        onChange={event => { onChange(event.target.value); setManual(false); }}>
        <option value="">{loading ? "Finding printers…" : "Select a printer"}</option>
        {printers.map(printer => <option key={printer.name} value={printer.name}>{printer.name}{printer.isDefault ? " (Windows default)" : ""}</option>)}
      </select>
    </label>
    <button type="button" disabled={disabled || loading} onClick={() => void refresh()}>Refresh printers</button>
    <label><input type="checkbox" disabled={disabled} checked={manual} onChange={event => setManual(event.target.checked)} /> Enter name manually</label>
    {(manual || (!!value && !known)) && <label>Windows printer name<input value={value} disabled={disabled}
      onChange={event => onChange(event.target.value)} /></label>}
    {message && <p role="status">{message}</p>}
    <small>Choose an ESC/POS thermal printer. Use View receipt for A4, laser printers or PDF.</small>
  </div>;
}
