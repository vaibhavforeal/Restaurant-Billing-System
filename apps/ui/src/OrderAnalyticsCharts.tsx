import { useEffect, useId, useRef, useState } from "react";
import type { OrderAnalyticsReport } from "@forkflow/domain/operational-reports";
import { reportMoney } from "./sales-report";

const shortDate = (date: string) => new Date(`${date}T12:00:00`).toLocaleDateString("en-IN", { day: "numeric", month: "short" });

export function OrderTrend({ report }: { report: OrderAnalyticsReport }) {
  const id = useId();
  const [selected, setSelected] = useState<number | null>(null);
  const figure = useRef<HTMLElement>(null);
  const [width, setWidth] = useState(640);
  useEffect(() => {
    const element = figure.current;
    if (!element) return;
    const measure = () => setWidth(Math.max(240, element.clientWidth));
    measure();
    const observer = new ResizeObserver(measure); observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const points = report.daily;
  const index = Math.max(0, Math.min(selected ?? points.length - 1, points.length - 1));
  const day = points[index]!;
  const max = Math.max(1, ...points.flatMap((row) => [row.takeawayOrders, row.tableOrders]));
  const plotWidth = width - 64;
  const x = (i: number) => points.length === 1 ? 42 + plotWidth / 2 : 42 + i * plotWidth / (points.length - 1);
  const y = (value: number) => 158 - value / max * 136;
  const line = (key: "takeawayOrders" | "tableOrders") => points.map((row, i) => `${i ? "L" : "M"}${x(i)},${y(row[key])}`).join(" ");
  const ticks = [...new Set(Array.from({ length: Math.min(3, points.length) }, (_, i) => Math.round(i * (points.length - 1) / Math.max(1, Math.min(3, points.length) - 1))))];
  return <section className="sales-chart-panel analytics-trend" aria-label="Daily order trend">
    <header><h3>Daily order trend</h3><small>Billed orders</small></header>
    <div className="sales-legend"><span><i />Quick takeaway</span><span><i className="collections" />Table orders</span></div>
    <figure ref={figure} className="sales-chart" tabIndex={0} aria-label="Daily orders. Use arrow keys, Home or End to explore dates." onKeyDown={(event) => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      setSelected(event.key === "Home" ? 0 : event.key === "End" ? points.length - 1 : Math.max(0, Math.min(points.length - 1, index + (event.key === "ArrowRight" ? 1 : -1))));
    }}>
      <svg viewBox={`0 0 ${width} 186`} role="img" aria-labelledby={`${id}-title ${id}-desc`} onPointerMove={(event) => {
        const rect = event.currentTarget.getBoundingClientRect();
        setSelected(Math.max(0, Math.min(points.length - 1, Math.round(((event.clientX - rect.left) / rect.width * width - 42) / plotWidth * (points.length - 1)))));
      }}>
        <title id={`${id}-title`}>Quick takeaway and table orders by bill date</title>
        <desc id={`${id}-desc`}>{report.from} to {report.to}. {report.totals.orderCount} billed orders. Focus this chart to explore exact daily counts.</desc>
        {[0, max].map((value) => <g key={value}><line className="chart-grid" x1={42} x2={width - 22} y1={y(value)} y2={y(value)} /><text x={32} y={y(value) + 4} textAnchor="end">{value}</text></g>)}
        {ticks.map((i) => <text key={i} x={x(i)} y={181} textAnchor={i === 0 ? "start" : i === points.length - 1 ? "end" : "middle"}>{shortDate(points[i]!.date)}</text>)}
        <path className="chart-sales" d={line("takeawayOrders")} /><path className="chart-collections" d={line("tableOrders")} />
        <line className="chart-focus" x1={x(index)} x2={x(index)} y1={18} y2={158} />
        <circle className="chart-sales-dot" cx={x(index)} cy={y(day.takeawayOrders)} r={4} /><circle className="chart-collection-dot" cx={x(index)} cy={y(day.tableOrders)} r={3} />
      </svg>
      <figcaption className="sales-chart-detail" aria-live="polite"><strong>{day.date}</strong><span>Takeaway <strong>{day.takeawayOrders}</strong></span><span>Tables <strong>{day.tableOrders}</strong></span><span>Sales <strong>{reportMoney(day.totalPaise)}</strong></span></figcaption>
    </figure>
  </section>;
}

export function BusyHours({ report }: { report: OrderAnalyticsReport }) {
  const peak = report.hourly.reduce((best, row) => row.orderCount > best.orderCount ? row : best, report.hourly[0]!);
  const [selected, setSelected] = useState<number | null>(null);
  const hour = report.hourly[selected ?? peak.hour]!;
  const max = Math.max(1, peak.orderCount);
  return <section className="sales-chart-panel" aria-label="Busy hours">
    <header><h3>Busy hours</h3><small>By local bill hour</small></header>
    <div className="analytics-hours" role="group" aria-label="Hourly billed orders">{report.hourly.map((row) => <button key={row.hour} className={`analytics-hour${row.hour === hour.hour ? " selected" : ""}`} aria-pressed={row.hour === hour.hour}
      aria-label={`${String(row.hour).padStart(2, "0")}:00: ${row.orderCount} billed orders, ${reportMoney(row.totalPaise)}`} title={`${String(row.hour).padStart(2, "0")}:00 · ${row.orderCount} orders`}
      onClick={() => setSelected(row.hour)}><span className="analytics-hour-track" aria-hidden="true"><span style={{ height: `${row.orderCount / max * 100}%` }} /></span><small>{row.hour % 3 === 0 ? String(row.hour).padStart(2, "0") : ""}</small></button>)}</div>
    <p className="sales-chart-detail" aria-live="polite"><strong>{String(hour.hour).padStart(2, "0")}:00–{String(hour.hour).padStart(2, "0")}:59</strong><span>{hour.orderCount} orders</span><span>{reportMoney(hour.totalPaise)}</span></p>
    <p className="sales-chart-note">{peak.orderCount ? `Peak hour: ${String(peak.hour).padStart(2, "0")}:00 with ${peak.orderCount} orders. Select a bar for details.` : "No billed orders in this period."}</p>
  </section>;
}
