import { useState, type FormEvent } from "react";
import type { DeviceInfo, DeviceSettings, PaymentStart } from "@masalapos/domain/devices";
import { apiFetch } from "../api";
import { KIND_LABELS } from "../devices-model";
import { InfoTip } from "../InfoTip";
import { useAction } from "../use-action";
import { WorkspaceDialog } from "../WorkspaceDialog";

const PAYMENT_STARTS: Array<{ value: PaymentStart; label: string }> = [
  { value: "last", label: "The method used last" },
  { value: "cash", label: "Cash" },
  { value: "card", label: "Card" },
  { value: "upi", label: "UPI" },
];

/**
 * One device: its name, where its bills print, the payment method a new bill starts on, and replacing or removing it.
 * Every save is made against the device's version, so a change someone else made in the meantime is refused, not
 * overwritten. `recovery` is the licence recovery screen, where only renaming and removing are available.
 */
export function DeviceDialog({ device, printers, recovery, onChanged, onRemoved, onReplace, onFailed, onClose }: {
  device: DeviceInfo; printers: ReadonlyArray<{ id: string; name: string }>; recovery: boolean;
  onChanged: (device: DeviceInfo) => void; onRemoved: () => void; onReplace: (device: DeviceInfo) => void;
  /** A save was refused; the list is read again, since someone else may have changed the device. */
  onFailed: () => void; onClose: () => void;
}) {
  const [name, setName] = useState(device.name);
  const { busy, error, run } = useAction();
  const billing = !recovery && device.kind !== "kitchen";

  async function save(request: () => Promise<{ device: DeviceInfo }>, fallback: string) {
    let saved: DeviceInfo | undefined;
    if (await run(async () => { saved = (await request()).device; }, fallback) && saved) onChanged(saved);
    else onFailed();
  }
  function rename(e: FormEvent) {
    e.preventDefault();
    void save(() => apiFetch(`/api/devices/${device.id}`, { method: "PATCH", body: JSON.stringify({ name: name.trim(), version: device.version }) }), "Could not rename the device");
  }
  const saveSettings = (change: Partial<DeviceSettings>) =>
    void save(() => apiFetch(`/api/devices/${device.id}/settings`, { method: "PATCH", body: JSON.stringify({ version: device.version, ...change }) }), "Could not save the device's settings");
  async function remove() {
    if (!window.confirm(`Remove ${device.name}? ${device.current ? "You will be signed out of this browser." : "Staff on that device will be signed out."}`)) return;
    if (await run(() => apiFetch(`/api/devices/${device.id}`, { method: "DELETE", body: JSON.stringify({ version: device.version }) }), "Could not remove the device")) onRemoved();
    else onFailed();
  }

  return <WorkspaceDialog open title={device.name} className="device-dialog" busy={busy} onClose={onClose}>
    <div className="device-dialog-body">
      <p className="muted device-dialog-kind">{KIND_LABELS[device.kind]}{device.isMain ? " · Main counter" : ""}{device.current ? " · This device" : ""}</p>
      {error && <p role="alert" className="devices-error">{error}</p>}

      <form className="device-dialog-row" onSubmit={rename}>
        <label>Name<input required maxLength={80} value={name} disabled={busy} onChange={(e) => setName(e.target.value)} /></label>
        <button disabled={busy || !name.trim() || name.trim() === device.name}>Save name</button>
      </form>

      {billing && <>
        <label>
          <span>Bill printer <InfoTip id="device-dialog-printer-help">The printer a new bill uses on this device. Staff can still pick another printer on the bill.</InfoTip></span>
          <select value={device.printerInactive ? "" : device.settings.billPrinterId ?? ""} disabled={busy} aria-describedby="device-dialog-printer-help"
            onChange={(e) => saveSettings({ billPrinterId: e.target.value || null })}>
            <option value="">Browser / A4 receipt</option>
            {printers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>
        {device.printerInactive && <p role="status" className="device-dialog-note">
          The printer saved for the device is switched off. Its bills use the browser receipt until the printer is switched on again or you choose another.
          {" "}<button type="button" disabled={busy} onClick={() => saveSettings({ billPrinterId: null })}>Forget that printer</button>
        </p>}
        <label>
          <span>Payment method a new bill starts on</span>
          <select value={device.settings.paymentStart} disabled={busy} onChange={(e) => saveSettings({ paymentStart: e.target.value as PaymentStart })}>
            {PAYMENT_STARTS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </label>
      </>}

      <div className="device-dialog-actions">
        {!recovery && <button type="button" disabled={busy} onClick={() => onReplace(device)}>Replace</button>}
        {!device.isMain && <button type="button" disabled={busy} onClick={() => void remove()}>Remove</button>}
      </div>
      {!recovery && <p className="muted device-dialog-note">Replace moves this device to another browser, PC or tablet. Its name, settings and place are kept.</p>}
      {device.isMain && <p className="muted device-dialog-note">The main counter can't be removed.</p>}
    </div>
  </WorkspaceDialog>;
}
