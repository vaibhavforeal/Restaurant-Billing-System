import { useState } from "react";
import { DEVICES_TABS, devicesTabs, type DevicesTabId } from "../devices-model";
import { useCan } from "../permissions";
import { DevicesTab } from "./DevicesTab";
import { PrintersTab } from "./PrintersTab";
import { PrintJobsTab } from "./PrintJobsTab";
import { StationsTab } from "./StationsTab";
import "../devices.css";
import "../printer-settings.css";

/**
 * Settings → Devices. The Devices tab is for whoever manages settings; printers, kitchen stations and print jobs are
 * for whoever may see printers. `initialTab` opens a tab directly, e.g. Printers from Bill settings.
 */
export function DevicesSettings({ initialTab }: { initialTab?: DevicesTabId | undefined }) {
  const can = useCan();
  const tabs = devicesTabs(can);
  const [chosen, setChosen] = useState<DevicesTabId | undefined>(initialTab);
  const tab = chosen && tabs.includes(chosen) ? chosen : tabs[0];
  if (!tab) return <p className="panel muted">You do not have access to devices or printers.</p>;
  return <div className="devices-settings">
    <div className="tabs" role="group" aria-label="Devices sections">
      {DEVICES_TABS.filter(({ id }) => tabs.includes(id)).map(({ id, label }) =>
        <button key={id} type="button" className={tab === id ? "selected" : ""} aria-pressed={tab === id} onClick={() => setChosen(id)}>{label}</button>)}
    </div>
    {tab === "devices" && <DevicesTab />}
    {tab === "printers" && <PrintersTab />}
    {tab === "stations" && <StationsTab />}
    {tab === "jobs" && <PrintJobsTab />}
  </div>;
}
