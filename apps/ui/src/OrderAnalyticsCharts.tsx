import { useState } from "react";
import type { OrderAnalyticsReport } from "@masalapos/domain/operational-reports";
import { reportMoney } from "./sales-report";
import { BarChart, LineChart } from "./dynamic-dashboard/charts";

const shortDate = (date: string) => new Date(`${date}T12:00:00`).toLocaleDateString("en-IN", { day: "numeric", month: "short" });

export function OrderTrend({ report }: { report: OrderAnalyticsReport }) {
  const days = report.daily;
  const takeaway = days.map((row) => ({ label: shortDate(row.date), value: row.takeawayOrders }));
  const tables = days.map((row) => ({ label: shortDate(row.date), value: row.tableOrders }));
  return <section className="sales-chart-panel analytics-trend" aria-label="Daily order trend">
    <header><h3>Daily order trend</h3><small>Billed orders</small></header>
    <div className="sales-legend"><span><i />Quick takeaway</span><span><i className="collections" />Table orders</span></div>
    <LineChart points={takeaway} compare={tables} format="count" legend={false} label="Daily orders. Use arrow keys, Home or End to explore dates."
      title="Quick takeaway and table orders by bill date"
      description={`${report.from} to ${report.to}. ${report.totals.orderCount} billed orders. Focus this chart to explore exact daily counts.`}
      renderDetail={(index) => {
        const day = days[index]!;
        return <><strong>{day.date}</strong><span>Takeaway <strong>{day.takeawayOrders}</strong></span><span>Tables <strong>{day.tableOrders}</strong></span><span>Net sales <strong>{reportMoney(day.totalPaise)}</strong></span></>;
      }} />
  </section>;
}

export function BusyHours({ report }: { report: OrderAnalyticsReport }) {
  const peak = report.hourly.reduce((best, row) => row.orderCount > best.orderCount ? row : best, report.hourly[0]!);
  const [selected, setSelected] = useState<number | null>(null);
  const hour = report.hourly[selected ?? peak.hour]!;
  const max = Math.max(1, peak.orderCount);
  return <section className="sales-chart-panel" aria-label="Busy hours">
    <header><h3>Busy hours</h3><small>By local bill hour</small></header>
    <BarChart format="count" points={report.hourly.map((row) => ({ label: String(row.hour).padStart(2, "0"), value: row.orderCount }))}
      classes={{ root: "analytics-hours", bar: "analytics-hour", track: "analytics-hour-track" }} label="Hourly billed orders" labelEvery={3}
      selected={report.hourly.indexOf(hour)} onSelect={(i) => setSelected(report.hourly[i]!.hour)}
      describe={(i) => { const row = report.hourly[i]!; return `${String(row.hour).padStart(2, "0")}:00: ${row.orderCount} billed orders, ${reportMoney(row.totalPaise)}`; }}
      tooltip={(i) => { const row = report.hourly[i]!; return `${String(row.hour).padStart(2, "0")}:00 · ${row.orderCount} orders`; }} />
    <p className="sales-chart-detail" aria-live="polite"><strong>{String(hour.hour).padStart(2, "0")}:00–{String(hour.hour).padStart(2, "0")}:59</strong><span>{hour.orderCount} orders</span><span>{reportMoney(hour.totalPaise)}</span></p>
    <p className="sales-chart-note">{peak.orderCount ? `Peak hour: ${String(peak.hour).padStart(2, "0")}:00 with ${peak.orderCount} orders. Select a bar for details.` : "No billed orders in this period."}</p>
  </section>;
}
