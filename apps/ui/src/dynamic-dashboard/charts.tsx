import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import type { ValueFormat } from "@masalapos/domain/dashboard";
import { paiseToRupees } from "../money";
import "./charts.css";

export interface ChartPoint { label: string; value: number }

/** Money is integer paise. A negative amount gets a leading minus before the rupee sign. */
export function formatValue(format: ValueFormat, value: number): string {
  if (format === "count") return Math.round(value).toLocaleString("en-IN");
  return `${value < 0 ? "-" : ""}₹${paiseToRupees(Math.abs(value))}`;
}

/** The largest value across every series; never zero or negative so scaling cannot divide by zero. */
function scaleMax(...series: Array<ChartPoint[] | undefined>): { raw: number; max: number } {
  const raw = Math.max(0, ...series.flatMap((s) => (s ?? []).map((p) => p.value)));
  return { raw, max: raw > 0 ? raw : 1 };
}

function Legend({ names }: { names: [string, string] }) {
  return <div className="sales-legend dd-legend"><span><i />{names[0]}</span><span><i className="collections" />{names[1]}</span></div>;
}

export interface LineChartProps {
  points: ChartPoint[];
  format: ValueFormat;
  /** Secondary series drawn as a muted dashed line, matched to `points` by position. */
  compare?: ChartPoint[] | undefined;
  /** Legend names; pass `false` to hide the legend. Shown only when there is a compare series. */
  legend?: [string, string] | false;
  title?: string;
  description?: string;
  /** Label for the focusable chart. */
  label?: string;
  className?: string;
  /** Replaces the line of exact values under the chart. */
  renderDetail?: (index: number, point: ChartPoint, comparePoint: ChartPoint | undefined) => ReactNode;
}

export function LineChart({ points, format, compare, legend, title, description, label, className, renderDetail }: LineChartProps) {
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
  if (!points.length) return <p className="dd-empty">No data for this period.</p>;
  const index = Math.max(0, Math.min(selected ?? points.length - 1, points.length - 1));
  const point = points[index]!;
  const other = compare?.[index];
  const { raw, max } = scaleMax(points, compare);
  const left = format === "money" ? 64 : 42;
  const plotWidth = width - left - 22;
  const x = (i: number) => points.length === 1 ? left + plotWidth / 2 : left + i * plotWidth / (points.length - 1);
  const y = (value: number) => 158 - Math.max(0, value) / max * 136;
  const line = (series: ChartPoint[]) => series.map((p, i) => `${i ? "L" : "M"}${x(i)},${y(p.value)}`).join(" ");
  const ticks = [...new Set(Array.from({ length: Math.min(3, points.length) }, (_, i) => Math.round(i * (points.length - 1) / Math.max(1, Math.min(3, points.length) - 1))))];
  const yTicks = raw > 0 || format === "count" ? [0, max] : [0];
  const names = legend === false ? null : compare ? legend ?? ["This period", "Comparison"] : null;
  return <>
    {names && <Legend names={names} />}
    <figure ref={figure} className={`sales-chart${className ? ` ${className}` : ""}`} tabIndex={0} aria-label={label ?? "Chart. Use arrow keys, Home or End to explore points."} onKeyDown={(event) => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      setSelected(event.key === "Home" ? 0 : event.key === "End" ? points.length - 1 : Math.max(0, Math.min(points.length - 1, index + (event.key === "ArrowRight" ? 1 : -1))));
    }}>
      <svg viewBox={`0 0 ${width} 186`} role="img" aria-labelledby={`${id}-title ${id}-desc`} onPointerMove={(event) => {
        const rect = event.currentTarget.getBoundingClientRect();
        setSelected(Math.max(0, Math.min(points.length - 1, Math.round(((event.clientX - rect.left) / rect.width * width - left) / plotWidth * (points.length - 1)))));
      }}>
        <title id={`${id}-title`}>{title ?? "Values over time"}</title>
        <desc id={`${id}-desc`}>{description ?? "Focus this chart to explore exact values."}</desc>
        {yTicks.map((value) => <g key={value}><line className="chart-grid" x1={left} x2={width - 22} y1={y(value)} y2={y(value)} /><text x={left - 10} y={y(value) + 4} textAnchor="end">{formatValue(format, value)}</text></g>)}
        {ticks.map((i) => <text key={i} x={x(i)} y={181} textAnchor={i === 0 ? "start" : i === points.length - 1 ? "end" : "middle"}>{points[i]!.label}</text>)}
        <path className="chart-sales" d={line(points)} />
        {compare && <path className="chart-collections" d={line(compare)} />}
        <line className="chart-focus" x1={x(index)} x2={x(index)} y1={18} y2={158} />
        <circle className="chart-sales-dot" cx={x(index)} cy={y(point.value)} r={4} />
        {other && <circle className="chart-collection-dot" cx={x(index)} cy={y(other.value)} r={3} />}
      </svg>
      <figcaption className="sales-chart-detail" aria-live="polite">{renderDetail
        ? renderDetail(index, point, other)
        : <><strong>{point.label}</strong><span>{formatValue(format, point.value)}</span>{other && <span>Compared {formatValue(format, other.value)}</span>}</>}</figcaption>
    </figure>
  </>;
}

export interface BarChartClasses { root: string; bar: string; track: string }

export interface BarChartProps {
  points: ChartPoint[];
  format: ValueFormat;
  /** Secondary bars drawn beside each bar in a muted colour. */
  compare?: ChartPoint[] | undefined;
  legend?: [string, string] | false;
  label?: string;
  /** Class names for the container, each bar and each bar's track. The defaults use the dashboard styles. */
  classes?: BarChartClasses;
  /** Show a label under every Nth bar. Defaults to about eight labels across the chart. */
  labelEvery?: number;
  /** When set, bars are buttons and this is called with the bar's position. */
  onSelect?: (index: number) => void;
  selected?: number;
  /** Spoken description of a bar. Defaults to the label and the value. */
  describe?: (index: number, point: ChartPoint) => string;
  /** Hover text for a bar. Defaults to the spoken description. */
  tooltip?: (index: number, point: ChartPoint) => string;
}

const DEFAULT_CLASSES: BarChartClasses = { root: "dd-bars", bar: "dd-bar", track: "dd-bar-track" };

export function BarChart({ points, format, compare, legend, label, classes = DEFAULT_CLASSES, labelEvery, onSelect, selected, describe, tooltip }: BarChartProps) {
  const buttons = useRef<Array<HTMLButtonElement | null>>([]);
  if (!points.length) return <p className="dd-empty">No data for this period.</p>;
  const { max } = scaleMax(points, compare);
  const every = labelEvery ?? Math.max(1, Math.ceil(points.length / 8));
  const names = legend === false ? null : compare ? legend ?? ["This period", "Comparison"] : null;
  const bars = points.map((point, i) => {
    const other = compare?.[i];
    const height = (value: number) => ({ height: `${Math.max(0, value) / max * 100}%`, width: other ? "50%" : "100%" });
    const spoken = describe ? describe(i, point) : `${point.label}: ${formatValue(format, point.value)}${other ? `, compared ${formatValue(format, other.value)}` : ""}`;
    const inner = <>
      <span className={classes.track} aria-hidden="true"><span style={height(point.value)} />{other && <span className="dd-bar-compare" style={height(other.value)} />}</span>
      <small style={{ width: `${Math.min(every, points.length - i) * 100}%` }}>{i % every === 0 ? point.label : ""}</small>
    </>;
    const common = { className: `${classes.bar}${selected === i ? " selected" : ""}`, "aria-label": spoken, title: tooltip ? tooltip(i, point) : spoken };
    return onSelect
      ? <button key={i} type="button" {...common} aria-pressed={selected === i}
        ref={(element) => { buttons.current[i] = element; }}
        tabIndex={i === (selected ?? 0) ? 0 : -1}
        onFocus={() => onSelect(i)} onClick={() => onSelect(i)}
        onKeyDown={(event) => {
          if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
          event.preventDefault();
          const next = event.key === "Home" ? 0 : event.key === "End" ? points.length - 1
            : Math.max(0, Math.min(points.length - 1, i + (event.key === "ArrowRight" ? 1 : -1)));
          buttons.current[next]?.focus();
        }}>{inner}</button>
      : <div key={i} {...common} role="img">{inner}</div>;
  });
  return <>
    {names && <Legend names={names} />}
    <div className={classes.root} role="group" aria-label={label ?? "Bar chart"}>{bars}</div>
  </>;
}
