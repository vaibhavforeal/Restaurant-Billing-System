import type { WidgetDef, WidgetResult, WidgetValue } from "@masalapos/domain/dashboard";
import { percentChange } from "@masalapos/domain/dashboard";
import { BarChart, LineChart, formatValue } from "./charts";

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
  if (change === null) return <span className="dd-change dd-change-none" title="No comparison available">—</span>;
  if (change === 0) return <span className="dd-change dd-change-flat">0% vs {label}</span>;
  const up = change > 0;
  return <span className={`dd-change ${up ? "dd-change-up" : "dd-change-down"}`}>
    <span aria-hidden="true">{up ? "▲" : "▼"} </span>{Math.abs(change)}% <span className="dd-sr">{up ? "up" : "down"} </span>vs {label}
  </span>;
}

function Value({ def, value, compare, compareLabel }: { def: WidgetDef; value: WidgetValue; compare: WidgetValue | null; compareLabel: string }) {
  switch (value.kind) {
    case "number":
      return <div className="dd-kpi">
        <strong className="dd-kpi-value">{formatValue(value.format, value.value)}</strong>
        {compare?.kind === "number"
          ? <Change current={value.value} previous={compare.value} label={compareLabel} />
          : <span className="dd-change dd-change-none" title="No comparison available">—</span>}
      </div>;
    case "series": {
      const other = compare?.kind === "series" ? compare.points : undefined;
      return def.id === "dailyTrend"
        ? <LineChart points={value.points} format={value.format} compare={other} legend={["This period", compareLabel]} title={def.title} description={def.description} label={`${def.title}. Use arrow keys, Home or End to explore points.`} />
        : <BarChart points={value.points} format={value.format} compare={other} legend={["This period", compareLabel]} label={def.title} />;
    }
    case "ranking":
      return value.rows.length
        ? <ol className="dd-ranking">{value.rows.map((row, i) => <li key={`${row.label}-${i}`}>
          <span className="dd-rank-label">{row.label}</span><span className="dd-rank-qty">{row.qty.toLocaleString("en-IN")} sold</span><strong>{formatValue("money", row.value)}</strong>
        </li>)}</ol>
        : <p className="dd-empty">Nothing sold in this period.</p>;
    case "status":
      return <div className="dd-status">
        <strong className="dd-kpi-value">{value.count.toLocaleString("en-IN")}</strong>
        {value.amountPaise !== undefined && <span className="dd-status-amount">{formatValue("money", value.amountPaise)}</span>}
        {value.detail.length > 0 && <ul className="dd-status-detail">{value.detail.map((line, i) => <li key={i}>{line}</li>)}</ul>}
      </div>;
  }
}

export function WidgetBody({ def, result, onRetry, compareLabel = "Previous period" }: WidgetBodyProps) {
  if (!result) return <div className="dd-skeleton" aria-busy="true" aria-label={`Loading ${def.title}`} />;
  if (!result.ok) return <div className="dd-error" role="alert"><p>{result.error}</p><button type="button" onClick={onRetry}>Retry</button></div>;
  return <Value def={def} value={result.current} compare={result.compare} compareLabel={compareLabel} />;
}
