import type { orderStats } from "./dashboard-data";

/** Successful and cancelled counts are for the selected day; in progress is the live count of open orders now. */
export function OrderStatistics({ stats }: { stats: ReturnType<typeof orderStats> | null }) {
  const items = [
    { key: "successful", label: "Successful", value: stats?.successful, note: "Bills issued" },
    { key: "cancelled", label: "Cancelled", value: stats?.cancelled, note: "Orders cancelled" },
    { key: "in-progress", label: "In progress", value: stats?.inProgress, note: "Open now" },
  ];
  return <section className="dash-panel dash-stats" aria-label="Order statistics">
    <header className="dash-panel-head"><h3>Order Statistics</h3></header>
    <dl className="dash-stat-list">
      {items.map((item) => <div key={item.key} className={`dash-stat dash-stat-${item.key}`}>
        <dt>{item.label}</dt><dd><strong>{item.value ?? "—"}</strong><small>{item.note}</small></dd>
      </div>)}
    </dl>
  </section>;
}
