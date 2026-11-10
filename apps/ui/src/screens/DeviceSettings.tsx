import { useEffect, useState } from "react";
import type { DeviceSettings as SavedDeviceSettings, PaymentStart } from "@masalapos/domain/devices";
import { apiFetch } from "../api";
import { useDeviceSettings } from "../device-settings";
import { InfoTip } from "../InfoTip";
import { useModules } from "../modules";
import { useCan } from "../permissions";
import { QrNotificationControls } from "../QrNotifications";
import { readTheme, saveTheme, THEME_EVENT, type Theme } from "../theme";

const field = { display: "grid", gap: 4 } as const;
const PAYMENT_STARTS: Array<{ value: PaymentStart; label: string }> = [
  { value: "last", label: "The method used last" },
  { value: "cash", label: "Cash" },
  { value: "card", label: "Card" },
  { value: "upi", label: "UPI" },
];

/**
 * Settings → This device. Theme and QR alerts are kept in this browser. The bill printer and the starting payment method
 * are kept on the main PC for this device, and only an administrator changes them.
 */
export function DeviceSettings() {
  const { isActive } = useModules();
  const can = useCan();
  const [theme, setTheme] = useState<Theme>(readTheme);
  const [printers, setPrinters] = useState<Array<{ id: string; name: string }> | null>(null);
  const device = useDeviceSettings();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const sync = () => setTheme(readTheme());
    window.addEventListener(THEME_EVENT, sync);
    return () => window.removeEventListener(THEME_EVENT, sync);
  }, []);
  useEffect(() => {
    apiFetch<{ printers: Array<{ id: string; name: string }> }>("/api/billing-printers")
      .then((r) => setPrinters(r.printers))
      .catch(() => setError("Could not load the printers"));
  }, []);

  const joined = device.deviceId !== null;
  const allowed = can("settings.manage");
  const locked = !joined || !allowed || saving;

  async function save(change: Partial<SavedDeviceSettings>) {
    if (device.deviceId === null) return;
    setSaving(true); setError("");
    try {
      await apiFetch(`/api/devices/${device.deviceId}/settings`, { method: "PATCH", body: JSON.stringify({ version: device.version, ...change }) });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save this device's settings");
    } finally {
      // Also after a failure: another administrator may have changed this device in the meantime.
      await device.reload();
      setSaving(false);
    }
  }

  return <div className="panel settings-form">
    <p className="muted" style={{ gridColumn: "1 / -1", margin: 0 }}>Theme and QR alerts are saved in this browser. The bill printer and starting payment method are saved on the main PC for this device.</p>

    <fieldset className="bill-settings-group">
      <legend>Theme</legend>
      {(["light", "dark"] as const).map((value) => <label key={value} style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <input type="radio" name="device-theme" checked={theme === value} onChange={() => { saveTheme(value); setTheme(value); }} />
        {value === "light" ? "Light" : "Dark"}
      </label>)}
    </fieldset>

    <fieldset className="bill-settings-group">
      <legend>Billing at this counter</legend>
      {!joined && <p className="muted" style={{ margin: 0 }}>This browser has not joined as a device, so it has no saved printer.</p>}
      {joined && !allowed && <p className="muted" style={{ margin: 0 }}>Only an administrator can change these.</p>}
      <label style={field}>
        <span>Bill printer <InfoTip id="device-printer-help">The printer a new bill uses on this device. Staff can still pick another printer on the bill.</InfoTip></span>
        <select value={device.settings.billPrinterId ?? ""} disabled={locked || printers === null} aria-describedby="device-printer-help"
          onChange={(e) => void save({ billPrinterId: e.target.value || null })}>
          <option value="">Browser / A4 receipt</option>
          {printers?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </label>
      <label style={field}>
        <span>Payment method a new bill starts on</span>
        <select value={device.settings.paymentStart} disabled={locked} onChange={(e) => void save({ paymentStart: e.target.value as PaymentStart })}>
          {PAYMENT_STARTS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </label>
      {error && <small role="alert">{error}</small>}
    </fieldset>

    <fieldset className="bill-settings-group">
      <legend>QR order alerts</legend>
      {isActive("qrOrdering") ? <QrNotificationControls /> : <p className="muted">QR guest ordering is off. Turn it on in the Marketplace to get alerts for QR orders.</p>}
    </fieldset>
  </div>;
}
