import { useEffect, useState } from "react";
import { apiFetch } from "../api";
import { InfoTip } from "../InfoTip";
import { useModules } from "../modules";
import { readPreference, savePreference } from "../pos-shortcuts";
import { QrNotificationControls } from "../QrNotifications";
import { readPaymentStart, RECEIPT_PRINTER_KEY, savePaymentStart, type PaymentStart } from "../device-preferences";
import { readTheme, saveTheme, THEME_EVENT, type Theme } from "../theme";

const field = { display: "grid", gap: 4 } as const;
const PAYMENT_STARTS: Array<{ value: PaymentStart; label: string }> = [
  { value: "last", label: "The method used last" },
  { value: "cash", label: "Cash" },
  { value: "card", label: "Card" },
  { value: "upi", label: "UPI" },
];

/** Settings → This device: preferences kept in this browser only, so each counter, tablet or kitchen screen can differ. */
export function DeviceSettings() {
  const { isActive } = useModules();
  const [theme, setTheme] = useState<Theme>(readTheme);
  const [printers, setPrinters] = useState<Array<{ id: string; name: string }> | null>(null);
  const [printerId, setPrinterId] = useState(() => readPreference(RECEIPT_PRINTER_KEY));
  const [paymentStart, setPaymentStart] = useState<PaymentStart>(readPaymentStart);
  const [printerError, setPrinterError] = useState("");

  useEffect(() => {
    const sync = () => setTheme(readTheme());
    window.addEventListener(THEME_EVENT, sync);
    return () => window.removeEventListener(THEME_EVENT, sync);
  }, []);
  useEffect(() => {
    apiFetch<{ printers: Array<{ id: string; name: string }> }>("/api/billing-printers")
      .then((r) => setPrinters(r.printers))
      .catch(() => setPrinterError("Could not load the printers"));
  }, []);

  const savedPrinterGone = printers !== null && printerId !== "" && !printers.some((p) => p.id === printerId);

  return <div className="panel settings-form">
    <p className="muted" style={{ gridColumn: "1 / -1", margin: 0 }}>These choices are saved on this device only. Set them on each counter, tablet or kitchen screen.</p>

    <fieldset className="bill-settings-group">
      <legend>Theme</legend>
      {(["light", "dark"] as const).map((value) => <label key={value} style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <input type="radio" name="device-theme" checked={theme === value} onChange={() => { saveTheme(value); setTheme(value); }} />
        {value === "light" ? "Light" : "Dark"}
      </label>)}
    </fieldset>

    <fieldset className="bill-settings-group">
      <legend>Billing at this counter</legend>
      <label style={field}>
        <span>Bill printer <InfoTip id="device-printer-help">The printer a new bill uses on this device. Staff can still pick another printer on the bill.</InfoTip></span>
        <select value={savedPrinterGone ? "" : printerId} disabled={printers === null} aria-describedby="device-printer-help"
          onChange={(e) => { setPrinterId(e.target.value); savePreference(RECEIPT_PRINTER_KEY, e.target.value); }}>
          <option value="">Browser / A4 receipt</option>
          {printers?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        {savedPrinterGone && <small role="status">The printer saved here is no longer active. Bills use the browser receipt until you choose another.</small>}
        {printerError && <small role="alert">{printerError}</small>}
      </label>
      <label style={field}>
        <span>Payment method a new bill starts on</span>
        <select value={paymentStart} onChange={(e) => { const next = e.target.value as PaymentStart; setPaymentStart(next); savePaymentStart(next); }}>
          {PAYMENT_STARTS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </label>
    </fieldset>

    <fieldset className="bill-settings-group">
      <legend>QR order alerts</legend>
      {isActive("qrOrdering") ? <QrNotificationControls /> : <p className="muted">QR guest ordering is off. Turn it on in the Marketplace to get alerts for QR orders.</p>}
    </fieldset>
  </div>;
}
