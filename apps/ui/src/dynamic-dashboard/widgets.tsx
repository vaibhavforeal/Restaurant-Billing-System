import type { WidgetDef, WidgetResult, WidgetValue } from "@masalapos/domain/dashboard";
import { percentChange } from "@masalapos/domain/dashboard";
import { Button } from "@board/components/base/buttons/button";
import { Chip } from "@board/components/base/badges/chip";
import { Skeleton } from "@board/components/base/skeleton/skeleton";
import { formatValue } from "./charts";
import { BreakdownChart, TimeChart } from "./DashboardCharts";

export interface WidgetBodyProps {
  def: WidgetDef;
  /** Undefined while the data is loading. */
  result: WidgetResult | undefined;
  onRetry(): void;
  /** Name of the comparison period, shown after "vs" in the change chip. */
  compareLabel?: string;
}

function Change({ current, previous, label }: { current: number; previous: number; label: string }) {
  const change = percentChange(current, previous);
  if (change === null) return <Chip variant="caption" color="neutral" className="dd-change dd-change-none" title="No comparison available">—</Chip>;
  if (change === 0) return <Chip variant="caption" color="neutral" className="dd-change dd-change-flat">0% vs {label}</Chip>;
  const up = change > 0;
  return <Chip variant="caption" color={up ? "lime" : "rose"} className={`dd-change ${up ? "dd-change-up" : "dd-change-down"}`}>
    <span aria-hidden="true">{up ? "▲" : "▼"} </span>{Math.abs(change)}% <span className="dd-sr">{up ? "up" : "down"} </span>vs {label}
  </Chip>;
}

const BIG_NUMBER = "dd-kpi-value text-title-2-semibold text-text-primary tabular-nums [overflow-wrap:anywhere]";

function Value({ def, value, compare, compareLabel }: { def: WidgetDef; value: WidgetValue; compare: WidgetValue | null; compareLabel: string }) {
  switch (value.kind) {
    case "number":
      return <div className="dd-kpi">
        <strong className={BIG_NUMBER}>{formatValue(value.format, value.value)}</strong>
        {compare?.kind === "number"
          ? <Change current={value.value} previous={compare.value} label={compareLabel} />
          : <Chip variant="caption" color="neutral" className="dd-change dd-change-none" title="No comparison available">—</Chip>}
      </div>;
    case "series": {
      const other = compare?.kind === "series" ? compare.points : undefined;
      return def.id === "dailyTrend" || def.id === "hourlySales"
        ? <TimeChart points={value.points} format={value.format} compare={other} title={def.title} compareLabel={compareLabel} hourly={def.id === "hourlySales"} />
        : <BreakdownChart points={value.points} format={value.format} compare={other} title={def.title} compareLabel={compareLabel} />;
    }
    case "ranking":
      return value.rows.length
        ? <ol className="dd-ranking text-body-regular text-text-primary">{value.rows.map((row, i) => <li key={`${row.label}-${i}`}>
          <span className="dd-rank-label">{row.label}</span><span className="dd-rank-qty text-caption-1-regular text-text-secondary">{row.qty.toLocaleString("en-IN")} sold</span><strong>{formatValue("money", row.value)}</strong>
        </li>)}</ol>
        : <p className="dd-empty text-body-regular text-text-secondary">Nothing sold in this period.</p>;
    case "status":
      return <div className="dd-status">
        <strong className={BIG_NUMBER}>{value.count.toLocaleString("en-IN")}</strong>
        {value.amountPaise !== undefined && <span className="dd-status-amount text-body-medium text-text-secondary tabular-nums">{formatValue("money", value.amountPaise)}</span>}
        {value.detail.length > 0 && <ul className="dd-status-detail text-caption-1-regular text-text-secondary">{value.detail.map((line, i) => <li key={i}>{line}</li>)}</ul>}
      </div>;
  }
}

export function WidgetBody({ def, result, onRetry, compareLabel = "Previous period" }: WidgetBodyProps) {
  if (!result) return <div className="dd-skeleton" aria-busy="true" aria-label={`Loading ${def.title}`}><Skeleton className="h-full min-h-11 w-full" /></div>;
  if (!result.ok) return <div className="dd-error" role="alert"><p className="text-body-regular text-text-error-primary">{result.error}</p><Button variant="secondary" size="small" onClick={onRetry}>Retry</Button></div>;
  return <Value def={def} value={result.current} compare={result.compare} compareLabel={compareLabel} />;
}
