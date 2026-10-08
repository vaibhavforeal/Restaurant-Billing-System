import { useEffect, useState } from "react";
import { Icon } from "./Icon";
import { DASHBOARD_MIN_DATE, pickedDate, updatedLabel } from "./dashboard-view";
import { useNow } from "./useDashboard";

export function DashboardStrip({ date, today, updatedAt, loading, onDate, onRefresh }: {
  date: string; today: string; updatedAt: number | null; loading: boolean; onDate: (date: string) => void; onRefresh: () => void;
}) {
  const now = useNow(60_000);
  // The input keeps what is being typed; only a usable date reaches the dashboard. Rejecting a partial year through a
  // controlled `value={date}` would make React reset the field mid-keystroke.
  const [draft, setDraft] = useState(date);
  useEffect(() => setDraft(date), [date]);
  return <div className="dash-strip" aria-label="Dashboard status">
    <p className="dash-strip-status" aria-live="polite"><Icon name="clock" size={16} /><span>{loading && updatedAt === null ? "Loading…" : updatedLabel(updatedAt, Math.max(now, updatedAt ?? 0))}</span></p>
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
