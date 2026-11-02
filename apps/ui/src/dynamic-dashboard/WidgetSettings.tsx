import {
  COMPARE_LABELS, DASHBOARD_COMPARES, DASHBOARD_PERIODS, PERIOD_LABELS, widgetDef,
  type DashboardItemValue, type WidgetOptionsValue,
} from "@masalapos/domain/dashboard";
import { useModules } from "../modules";
import { WorkspaceDialog } from "../WorkspaceDialog";

const ORDER_TYPES: Array<{ value: WidgetOptionsValue["orderType"]; label: string }> = [
  { value: "all", label: "All" },
  { value: "parcel", label: "Takeaway" },
  { value: "dine_in", label: "Dine-in" },
  { value: "zomato", label: "Zomato" },
];

/** Settings for one widget. Only the options that widget supports are shown. */
export function WidgetSettings({ item, onChange, onClose }: { item: DashboardItemValue | null; onChange(options: Partial<WidgetOptionsValue>): void; onClose(): void }) {
  const modules = useModules();
  const def = item ? widgetDef(item.widget) : null;
  const options = item?.options;
  return <WorkspaceDialog open={!!item} title={def ? `${def.title} settings` : "Widget settings"} onClose={onClose} className="dd-dialog">
    {def && options && <div className="dd-settings">
      {def.options.period && <label>Period
        <select value={options.period} onChange={(e) => onChange({ period: e.target.value as WidgetOptionsValue["period"] })}>
          {DASHBOARD_PERIODS.map((p) => <option key={p} value={p}>{PERIOD_LABELS[p]}</option>)}
        </select></label>}
      {def.options.compare && <label>Compare with
        <select value={options.compare} onChange={(e) => onChange({ compare: e.target.value as WidgetOptionsValue["compare"] })}>
          {DASHBOARD_COMPARES.map((c) => <option key={c} value={c}>{COMPARE_LABELS[c]}</option>)}
        </select></label>}
      {def.options.orderType && <label>Order type
        <select value={options.orderType} onChange={(e) => onChange({ orderType: e.target.value as WidgetOptionsValue["orderType"] })}>
          {ORDER_TYPES.filter((t) => t.value !== "zomato" || modules.isActive("zomato")).map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
        </select></label>}
      {def.options.topN && <label>How many items (3 to 20)
        <input type="number" min={3} max={20} step={1} value={options.topN}
          onChange={(e) => { const n = Math.round(Number(e.target.value)); if (Number.isFinite(n)) onChange({ topN: Math.min(20, Math.max(3, n)) }); }} /></label>}
      <button type="button" className="primary" onClick={onClose}>Done</button>
    </div>}
  </WorkspaceDialog>;
}
