import { useEffect, useId, useRef, useState } from "react";
import type { ValueFormat } from "@masalapos/domain/dashboard";
import { formatValue, type ChartPoint } from "./charts";

interface Props {
  points: ChartPoint[];
  compare?: ChartPoint[] | undefined;
  format: ValueFormat;
  title: string;
  compareLabel: string;
}

export function plotRange(points: ChartPoint[], compare?: ChartPoint[]) {
  const values = [...points, ...(compare ?? [])].map((point) => point.value);
  const low = Math.min(0, ...values);
  const high = Math.max(0, ...values);
  const extent = Math.max(Math.abs(low), high);
  const step = extent ? 10 ** Math.floor(Math.log10(extent)) / 2 : 1;
  return { min: Math.floor(low / step) * step, max: high === low ? 1 : Math.ceil(high / step) * step };
}

function ChartKey({ compareLabel, marker = false }: { compareLabel?: string | undefined; marker?: boolean }) {
  return <div className="dd-chart-key"><span><i />This period</span>{compareLabel && <span><i className={marker ? "dd-key-marker" : "dd-key-compare"} />{compareLabel}</span>}</div>;
}

export function TimeChart({ points, compare, format, title, compareLabel, hourly = false }: Props & { hourly?: boolean }) {
  const stage = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 500, height: 120 });
  const [selected, setSelected] = useState<number | null>(null);
  const id = useId();
  useEffect(() => {
    const element = stage.current;
    if (!element) return;
    const measure = () => setSize({ width: Math.max(180, element.clientWidth), height: Math.max(96, element.clientHeight) });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [points.length > 0]);
  if (!points.length) return <p className="dd-empty">No sales recorded for this period.</p>;
  const peak = points.reduce((best, point, index) => point.value > points[best]!.value ? index : best, 0);
  const index = Math.min(selected ?? (hourly ? peak : points.length - 1), points.length - 1);
  const point = points[index]!;
  const other = compare?.[index];
  const { min, max } = plotRange(points, compare);
  const hasValues = points.some((p) => p.value !== 0) || compare?.some((p) => p.value !== 0);
  const { width, height } = size;
  const left = 48, right = width - 10, top = 8, bottom = height - 24;
  const pitch = (right - left) / points.length;
  const x = (i: number) => left + pitch * (i + 0.5);
  const y = (value: number) => bottom - (value - min) / (max - min) * (bottom - top);
  const path = (series: ChartPoint[]) => series.slice(0, points.length).map((p, i) => `${i ? "L" : "M"}${x(i)},${y(p.value)}`).join(" ");
  const tickCount = width < 360 ? 3 : 5;
  const ticks = hourly && points.length === 24 ? (width < 360 ? [0, 12, 23] : [0, 6, 12, 18, 23])
    : [...new Set(Array.from({ length: Math.min(tickCount, points.length) }, (_, i) => Math.round(i * (points.length - 1) / Math.max(1, Math.min(tickCount, points.length) - 1))))];
  const label = (p: ChartPoint) => {
    if (hourly) return `${p.label}:00`;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(p.label)) return p.label;
    const [year, month, day] = p.label.split("-").map(Number);
    return new Date(year!, month! - 1, day!).toLocaleDateString("en-IN", { day: "numeric", month: "short" });
  };
  const axisValue = (value: number) => `${format === "money" ? "₹" : ""}${(format === "money" ? value / 100 : value).toLocaleString("en-IN", { notation: "compact", maximumFractionDigits: 1 })}`;
  const selectAt = (clientX: number) => {
    const rect = stage.current?.getBoundingClientRect();
    if (rect) setSelected(Math.max(0, Math.min(points.length - 1, Math.floor((clientX - rect.left - left) / pitch))));
  };
  return <div className="dd-timeseries">
    <ChartKey compareLabel={compare ? compareLabel : undefined} />
    <div ref={stage} className="dd-time-stage" role="group" tabIndex={0}
      aria-label={`${title}. Use Left, Right, Home and End for exact values.`}
      onKeyDown={(event) => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        setSelected(event.key === "Home" ? 0 : event.key === "End" ? points.length - 1 : Math.max(0, Math.min(points.length - 1, index + (event.key === "ArrowRight" ? 1 : -1))));
      }}
      onPointerMove={(event) => { if (event.pointerType === "mouse") selectAt(event.clientX); }}
      onPointerDown={(event) => selectAt(event.clientX)}>
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-labelledby={`${id}-title ${id}-description`}>
        <title id={`${id}-title`}>{title}</title>
        <desc id={`${id}-description`}>{points.map((p, i) => `${label(p)}: ${formatValue(format, p.value)}${compare?.[i] ? `; ${compareLabel}: ${formatValue(format, compare[i]!.value)}` : ""}`).join(". ")}</desc>
        {(hasValues ? [max, (min + max) / 2, min] : [0]).map((value) => <g key={value} className="dd-axis">
          <line x1={left} x2={right} y1={y(value)} y2={y(value)} />
          <text x={left - 8} y={y(value) + 3} textAnchor="end">{axisValue(value)}</text>
        </g>)}
        {min < 0 && <line className="dd-zero" x1={left} x2={right} y1={y(0)} y2={y(0)} />}
        {hourly ? points.map((p, i) => <rect key={i} className={`dd-time-bar${i === index ? " dd-time-selected" : ""}`}
          x={x(i) - Math.min(14, pitch * 0.6) / 2} width={Math.min(14, pitch * 0.6)}
          y={Math.min(y(0), y(p.value))} height={Math.abs(y(0) - y(p.value))} rx={2} />)
          : <path className="dd-time-line" d={path(points)} />}
        {compare && <path className="dd-time-compare" d={path(compare)} />}
        <line className="dd-time-cursor" x1={x(index)} x2={x(index)} y1={top} y2={bottom} />
        <circle className="dd-time-dot" cx={x(index)} cy={y(point.value)} r={3.5} />
        {ticks.map((i) => <text className="dd-time-label" key={i} x={x(i)} y={height - 4} textAnchor={i === 0 ? "start" : i === points.length - 1 ? "end" : "middle"}>{label(points[i]!)}</text>)}
        {!hasValues && <text className="dd-time-label" x={(left + right) / 2} y={(top + bottom) / 2} textAnchor="middle">No sales recorded</text>}
      </svg>
    </div>
    <div className="dd-time-detail">
      <div aria-live="polite" aria-atomic="true"><span>{label(point)}</span><strong>{formatValue(format, point.value)}</strong>{other && <small>{compareLabel}: {formatValue(format, other.value)}</small>}</div>
      <div className="dd-time-nav">
        <button type="button" aria-label={`Previous ${title} value`} disabled={index === 0} onClick={() => setSelected(index - 1)}>‹</button>
        <button type="button" aria-label={`Next ${title} value`} disabled={index === points.length - 1} onClick={() => setSelected(index + 1)}>›</button>
      </div>
    </div>
  </div>;
}

export function BreakdownChart({ points, compare, format, title, compareLabel }: Props) {
  if (!points.length) return <p className="dd-empty">No sales recorded for this period.</p>;
  const { min, max } = plotRange(points, compare);
  const position = (value: number) => (value - min) / (max - min) * 100;
  return <div className="dd-breakdown" role="group" aria-label={title}>
    <ChartKey compareLabel={compare ? compareLabel : undefined} marker />
    <ul>{points.map((point, index) => {
      const other = compare?.[index];
      return <li key={`${point.label}-${index}`}>
        <div className="dd-breakdown-heading"><span>{point.label}</span><div>
          {other && <small title={compareLabel}><span className="dd-sr">{compareLabel}: </span>{formatValue(format, other.value)}</small>}
          <strong>{formatValue(format, point.value)}</strong>
        </div></div>
        <div className="dd-breakdown-track" aria-hidden="true">
          <span style={{ left: `${Math.min(position(0), position(point.value))}%`, width: `${Math.abs(position(point.value) - position(0))}%` }} />
          {other && <i style={{ left: `${position(other.value)}%` }} />}
        </div>
      </li>;
    })}</ul>
  </div>;
}
