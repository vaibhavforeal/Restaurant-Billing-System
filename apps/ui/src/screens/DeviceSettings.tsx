import { useEffect, useState } from "react";
import { useModules } from "../modules";
import { QrNotificationControls } from "../QrNotifications";
import { readTheme, saveTheme, THEME_EVENT, type Theme } from "../theme";

/**
 * Settings → This device: the theme and the QR order alerts, both kept in this browser. The device's bill printer and
 * starting payment method are kept on the main PC and set under Settings → Devices.
 */
export function DeviceSettings() {
  const { isActive } = useModules();
  const [theme, setTheme] = useState<Theme>(readTheme);

  useEffect(() => {
    const sync = () => setTheme(readTheme());
    window.addEventListener(THEME_EVENT, sync);
    return () => window.removeEventListener(THEME_EVENT, sync);
  }, []);
  return <div className="panel settings-form">
    <p className="muted" style={{ gridColumn: "1 / -1", margin: 0 }}>Theme and QR alerts are saved in this browser. An administrator sets this device's bill printer and starting payment method under Settings, Devices.</p>

    <fieldset className="bill-settings-group">
      <legend>Theme</legend>
      {(["light", "dark"] as const).map((value) => <label key={value} style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <input type="radio" name="device-theme" checked={theme === value} onChange={() => { saveTheme(value); setTheme(value); }} />
        {value === "light" ? "Light" : "Dark"}
      </label>)}
    </fieldset>

    <fieldset className="bill-settings-group">
      <legend>QR order alerts</legend>
      {isActive("qrOrdering") ? <QrNotificationControls /> : <p className="muted">QR guest ordering is off. Turn it on in the Marketplace to get alerts for QR orders.</p>}
    </fieldset>
  </div>;
}
