import { useEffect, useId, useRef, useState, type PointerEvent } from "react";
import type { SlotBar } from "./dashboard-data";
import { perBarLabelsFit, slotScale } from "./dashboard-view";
import { reportMoney } from "./sales-report";

const SHORT_LABELS = ["1–5am", "5–9am", "9am–1pm", "1–5pm", "5–9pm", "9pm–1am"];
const compact = (paise: number) => `${paise < 0 ? "-" : ""}₹${new Intl.NumberFormat("en-IN", { notation: "compact", maximumFractionDigits: 1 }).format(Math.abs(paise) / 100)}`;
const HEIGHT = 236, TOP = 28, BOTTOM = 192, LEFT = 52, RIGHT = 12;

/** Sales per four-hour slot, dine-in and takeaway side by side. Values are net of credit notes and can be negative. */
export function SlotChart({ bars }: { bars: SlotBar[] }) {
  const id = useId();
  const figure = useRef<HTMLElement>(null);
  const [width, setWidth] = useState(640);
  const [selected, setSelected] = useState<number | null>(null);
  useEffect(() => {
    const element = figure.current;
    if (!element) return;
    const measure = () => setWidth(Math.max(260, element.clientWidth));
    measure(); const observer = new ResizeObserver(measure); observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const { min, max } = slotScale(bars);
  // A negative bar carries its label below it, so leave room above the slot labels.
  const plotBottom = min < 0 ? BOTTOM - 16 : BOTTOM;
  const y = (value: number) => TOP + (max - value) / (max - min) * (plotBottom - TOP);
  const zero = y(0);
  const group = (width - LEFT - RIGHT) / Math.max(1, bars.length);
  const barWidth = Math.max(6, Math.min(36, group * 0.32));
  const gap = Math.min(6, group * 0.05);
  const perBarLabels = perBarLabelsFit(barWidth + gap, bars.flatMap((bar) => [bar.dineInPaise, bar.takeawayPaise]).filter((value) => value !== 0).map(compact));
  const index = selected === null ? null : Math.max(0, Math.min(bars.length - 1, selected));
  const detail = index === null ? null : bars[index];
  const empty = bars.every((bar) => !bar.dineInPaise && !bar.takeawayPaise);
  const ticks = empty ? [0] : [...new Set([max, 0, min])];
  const select = (next: number) => setSelected(Math.max(0, Math.min(bars.length - 1, next)));
  const pick = (event: PointerEvent<SVGSVGElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const x = (event.clientX - rect.left) / rect.width * width;
    if (x >= LEFT && x <= width - RIGHT) select(Math.floor((x - LEFT) / group));
  };

  return <section className="dash-panel dash-slots" aria-label="Sales by time slot">
    <header className="dash-panel-head"><h3>Sales</h3><small>By four-hour slot · net of credit notes</small></header>
    <div className="dash-legend"><span><i className="dash-swatch dine-in" />Dine In</span><span><i className="dash-swatch takeaway" />Takeaway</span>{empty && <span>No sales on this day</span>}</div>
    <figure ref={figure} className="dash-slot-chart" tabIndex={0} aria-label="Sales by time slot. Use left and right arrows to explore slots." onKeyDown={(event) => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const last = bars.length - 1, forward = event.key === "ArrowRight";
      select(event.key === "Home" ? 0 : event.key === "End" ? last : index === null ? (forward ? 0 : last) : index + (forward ? 1 : -1));
    }} onBlur={() => setSelected(null)}>
      <svg viewBox={`0 0 ${width} ${HEIGHT}`} role="img" aria-labelledby={`${id}-title ${id}-desc`} onPointerLeave={(event) => { if (event.pointerType === "mouse") setSelected(null); }} onPointerMove={pick} onPointerDown={pick}>
        <title id={`${id}-title`}>Sales by four-hour slot, dine in and takeaway</title>
        <desc id={`${id}-desc`}>{bars.map((bar) => `${bar.label}: dine in ${reportMoney(bar.dineInPaise)}, takeaway ${reportMoney(bar.takeawayPaise)}`).join("; ")}.</desc>
        {ticks.map((value) => <g key={value}>
          <line className={value === 0 ? "dash-axis-zero" : "dash-grid"} x1={LEFT} x2={width - RIGHT} y1={y(value)} y2={y(value)} />
          <text className="dash-axis-label" x={LEFT - 8} y={y(value) + 4} textAnchor="end">{compact(value)}</text>
        </g>)}
        {bars.map((bar, i) => {
          const center = LEFT + group * (i + 0.5);
          const series = [
            { key: "dine-in", value: bar.dineInPaise, x: center - gap / 2 - barWidth },
            { key: "takeaway", value: bar.takeawayPaise, x: center + gap / 2 },
          ];
          const nonZero = series.filter((item) => item.value !== 0);
          const groupTop = Math.min(zero, ...nonZero.map((item) => y(item.value)));
          const groupBottom = Math.max(zero, ...nonZero.map((item) => y(item.value)));
          const allNegative = nonZero.length > 0 && nonZero.every((item) => item.value < 0);
          return <g key={bar.label}>
            {index === i && <rect className="dash-slot-focus" x={LEFT + group * i + 2} y={TOP - 22} width={group - 4} height={BOTTOM - TOP + 22} rx={4} />}
            {series.map((item) => {
              const top = Math.min(y(item.value), zero), height = Math.abs(y(item.value) - zero);
              return <g key={item.key}>
                {item.value !== 0 && <rect className={`dash-bar ${item.key}`} x={item.x} y={top} width={barWidth} height={Math.max(1, height)} rx={2} />}
                {perBarLabels && item.value !== 0 && <text className="dash-bar-label" x={item.x + barWidth / 2} y={item.value > 0 ? top - 6 : top + height + 13} textAnchor="middle">{compact(item.value)}</text>}
              </g>;
            })}
            {!perBarLabels && nonZero.length > 0 && <text className="dash-bar-label" x={center} y={allNegative ? groupBottom + 13 : groupTop - 6} textAnchor="middle">{compact(bar.dineInPaise + bar.takeawayPaise)}</text>}
            <text className="dash-axis-label" x={center} y={BOTTOM + 20} textAnchor="middle">{group >= 112 ? bar.label : SHORT_LABELS[i] ?? bar.label}</text>
          </g>;
        })}
      </svg>
      <figcaption className="dash-slot-detail" aria-live="polite">{detail
        ? <><strong>{detail.label}</strong><span>Dine In <strong>{reportMoney(detail.dineInPaise)}</strong></span><span>Takeaway <strong>{reportMoney(detail.takeawayPaise)}</strong></span></>
        : <span>{perBarLabels ? "Hover or use arrow keys for exact values." : "Labels show each slot's total. Tap a slot for exact values."}</span>}</figcaption>
    </figure>
  </section>;
}
