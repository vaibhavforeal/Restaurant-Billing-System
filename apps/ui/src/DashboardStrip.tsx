import { useEffect, useState, type ReactNode } from "react";
import { Icon } from "./Icon";
import { DASHBOARD_MIN_DATE, pickedDate } from "./dashboard-view";

export function DashboardStrip({ date, today, orderActions, loading, onDate, onRefresh }: {
  date: string; today: string; orderActions: ReactNode; loading: boolean; onDate: (date: string) => void; onRefresh: () => void;
}) {
  // The input keeps what is being typed; only a usable date reaches the dashboard. Rejecting a partial year through a
  // controlled `value={date}` would make React reset the field mid-keystroke.
  const [draft, setDraft] = useState(date);
  useEffect(() => setDraft(date), [date]);
  return <div className="dash-strip" aria-label="Dashboard controls">
    {orderActions}
    <div className="dash-strip-controls">
      <label className="dash-date"><span className="dash-sr-only">Dashboard date</span>
        <input type="date" value={draft} min={DASHBOARD_MIN_DATE} max={today} required onBlur={() => setDraft(date)} onChange={(event) => {
          setDraft(event.target.value);
          const picked = pickedDate(event.target.value, today);
          if (picked) onDate(picked);
        }} />
      </label>
      <button type="button" className="dash-icon-button" onClick={onRefresh} disabled={loading} aria-label={loading ? "Refreshing dashboard" : "Refresh dashboard"} title="Refresh dashboard"><Icon name="refresh" size={18} /></button>
    </div>
  </div>;
}
