import { useEffect, useId, useRef, useState } from "react";
import { reportMoney, salesTrend, type SalesReport } from "./sales-report";

const axisMoney = (paise: number) => new Intl.NumberFormat("en-IN", { notation: "compact", maximumFractionDigits: 1 }).format(paise / 100);
const shortDate = (date: string) => new Date(`${date}T12:00:00`).toLocaleDateString("en-IN", { day: "numeric", month: "short" });

export function SalesTrend({ report }: { report: SalesReport }) {
  const id = useId();
  const [selected, setSelected] = useState<number | null>(null);
  const figure = useRef<HTMLElement>(null);
  const [width, setWidth] = useState(720);
  useEffect(() => {
    const element = figure.current;
    if (!element) return;
    const measure = () => setWidth(Math.max(240, element.clientWidth));
    measure(); const observer = new ResizeObserver(measure); observer.observe(element);
    return () => observer.disconnect();
  }, []);
  // Sales are net of credit notes, collections net of refunds; either can dip below zero on a day of refunds.
  const { points, min, max } = salesTrend(report);
  const index = Math.max(0, Math.min(selected ?? points.length - 1, points.length - 1));
  const day = points[index]!;
  const plotWidth = width - 74;
  const x = (i: number) => points.length === 1 ? 58 + plotWidth / 2 : 58 + i * plotWidth / (points.length - 1);
  const y = (value: number) => 174 - (value - min) / (max - min) * 152;
  const line = (series: "salesPaise" | "collectionsPaise") => points.map((p, i) => `${i ? "L" : "M"}${x(i)},${y(p[series])}`).join(" ");
  const labelIndices = Array.from({ length: Math.min(5, points.length, Math.max(2, Math.floor(width / 120))) }, (_, i) => i);
  const ticks = labelIndices.map((i) => labelIndices.length === 1 ? 0 : Math.round(i * (points.length - 1) / (labelIndices.length - 1)));
  return <section className="sales-chart-panel" aria-label="Sales and collections trend">
    <header><h3>Sales & collections</h3><small>Daily totals · INR</small></header>
    <div className="sales-legend"><span><i />Net sales</span><span><i className="collections" />Collections (net)</span>{!report.sales.billCount && !report.collections.totalPaise && !report.creditNotePaise && <span>No activity in this period</span>}</div>
    <figure ref={figure} className="sales-chart" tabIndex={0} aria-label="Daily sales and collections. Use left and right arrows to explore dates." onKeyDown={(event) => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault(); setSelected(event.key === "Home" ? 0 : event.key === "End" ? points.length - 1 : Math.max(0, Math.min(points.length - 1, index + (event.key === "ArrowRight" ? 1 : -1))));
    }}>
      <svg viewBox={`0 0 ${width} 208`} role="img" aria-labelledby={`${id}-title ${id}-description`} onPointerMove={(event) => {
        const rect = event.currentTarget.getBoundingClientRect();
        setSelected(Math.max(0, Math.min(points.length - 1, Math.round((((event.clientX - rect.left) / rect.width * width) - 58) / plotWidth * (points.length - 1)))));
      }}>
        <title id={`${id}-title`}>Daily net sales and net payment collections</title>
        <desc id={`${id}-description`}>From {report.from} to {report.to}. Net sales {reportMoney(report.netTotalPaise)} (gross {reportMoney(report.sales.totalPaise)} less credit notes {reportMoney(report.creditNotePaise)}); collections after refunds {reportMoney(report.collections.totalPaise)}. Exact daily values are available in Sales and Collections reports.</desc>
        {[0, .5, 1].map((fraction) => { const value = min + (max - min) * fraction; return <g key={fraction}><line className="chart-grid" x1={58} x2={width - 16} y1={y(value)} y2={y(value)} /><text x={48} y={y(value) + 4} textAnchor="end">{axisMoney(value)}</text></g>; })}
        {ticks.map((i) => <text key={i} x={x(i)} y={199} textAnchor={i === 0 ? "start" : i === points.length - 1 ? "end" : "middle"}>{shortDate(points[i]!.date)}</text>)}
        <path className="chart-sales" d={line("salesPaise")} /><path className="chart-collections" d={line("collectionsPaise")} />
        <line className="chart-focus" x1={x(index)} x2={x(index)} y1={18} y2={174} />
        <circle className="chart-sales-dot" cx={x(index)} cy={y(day.salesPaise)} r={4} />
        <circle className="chart-collection-dot" cx={x(index)} cy={y(day.collectionsPaise)} r={3} />
      </svg>
      <figcaption className="sales-chart-detail" aria-live="polite"><strong>{day.date}</strong><span>Net sales <strong>{reportMoney(day.salesPaise)}</strong></span><span>Collections <strong>{reportMoney(day.collectionsPaise)}</strong></span></figcaption>
    </figure>
  </section>;
}

export function PaymentBreakdown({ report }: { report: SalesReport }) {
  const total = report.collections.totalPaise;
  return <section className="sales-chart-panel" aria-label="Collections by payment method">
    <header><h3>Payment collections</h3><small>{report.collections.billCount} bills with payments</small></header>
    <div className="payment-bars">{([{ key: "cashPaise", label: "Cash (net)" }, { key: "upiPaise", label: "UPI (net)" }, { key: "cardPaise", label: "Card (net)" }] as const).map(({ key, label }) => {
      const value = report.collections[key], percent = total > 0 ? value / total * 100 : 0;
      return <div key={key}><div className="payment-bar-label"><span>{label} <small>{percent.toFixed(1)}%</small></span><strong>{reportMoney(value)}</strong></div><div className="payment-bar-track" aria-hidden="true"><div className="payment-bar-fill" style={{ width: `${Math.min(100, Math.max(0, percent))}%` }} /></div></div>;
    })}</div>
    <div className="payment-bar-label"><span>Total received (net)</span><strong>{reportMoney(total)}</strong></div>
    <p className="sales-chart-note">Payments received in this period, including older bills, less refunds paid out{report.collections.refundPaise ? ` (${reportMoney(report.collections.refundPaise)})` : ""}.</p>
  </section>;
}
