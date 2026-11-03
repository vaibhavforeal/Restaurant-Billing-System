import {
  COMPARE_LABELS, DASHBOARD_COMPARES, DASHBOARD_PERIODS, PERIOD_LABELS, widgetDef,
  type DashboardCompare, type DashboardItemValue, type DashboardPeriod, type WidgetOptionsValue,
} from "@masalapos/domain/dashboard";
import { Button } from "@board/components/base/buttons/button";
import { Drawer, DrawerBody, DrawerHeader } from "@board/components/base/drawer/drawer";
import { SegmentedControl, SegmentedControlItem } from "@board/components/base/segmented-control/segmented-control";
import { Select, SelectItem } from "@board/components/base/select/select";
import { useModules } from "../modules";
import { useMediaQuery } from "../use-media-query";

export const ORDER_TYPES: Array<{ value: WidgetOptionsValue["orderType"]; label: string }> = [
  { value: "all", label: "All" },
  { value: "parcel", label: "Takeaway" },
  { value: "dine_in", label: "Dine-in" },
  { value: "zomato", label: "Zomato" },
];

const TOP_N_CHOICES = [3, 5, 10, 15, 20];
/** The fixed choices, plus the stored value when it is not one of them, so it still shows correctly. */
export const topNChoices = (current: number): number[] => (TOP_N_CHOICES.includes(current) ? TOP_N_CHOICES : [...TOP_N_CHOICES, current].sort((a, b) => a - b));

/** The options one widget supports, applied as they change. Only supported options are shown. */
export function WidgetSettingsForm({ item, zomatoActive, onChange, onDone }: {
  item: DashboardItemValue;
  zomatoActive: boolean;
  onChange(options: Partial<WidgetOptionsValue>): void;
  onDone(): void;
}) {
  const def = widgetDef(item.widget);
  const { options } = item;
  const orderTypes = ORDER_TYPES.filter((type) => type.value !== "zomato" || zomatoActive);
  return <div className="dd-settings flex flex-col gap-6">
    {def.options.period && <Select label="Period" className="w-full" triggerClassName="h-11" selectedKey={options.period}
      onSelectionChange={(key) => onChange({ period: key as DashboardPeriod })}>
      {DASHBOARD_PERIODS.map((p) => <SelectItem key={p} id={p} textValue={PERIOD_LABELS[p]}>{PERIOD_LABELS[p]}</SelectItem>)}
    </Select>}
    {def.options.compare && <Select label="Compare with" className="w-full" triggerClassName="h-11" selectedKey={options.compare}
      onSelectionChange={(key) => onChange({ compare: key as DashboardCompare })}>
      {DASHBOARD_COMPARES.map((c) => <SelectItem key={c} id={c} textValue={COMPARE_LABELS[c]}>{COMPARE_LABELS[c]}</SelectItem>)}
    </Select>}
    {def.options.orderType && <div className="flex flex-col gap-2">
      <span className="text-body-medium text-text-primary" id={`${item.key}-order-type`}>Order type</span>
      <SegmentedControl aria-labelledby={`${item.key}-order-type`} className="w-full" selectedKeys={new Set([options.orderType])}
        onSelectionChange={(keys) => { const [key] = [...keys]; if (key) onChange({ orderType: key as WidgetOptionsValue["orderType"] }); }}>
        {orderTypes.map((type) => <SegmentedControlItem key={type.value} id={type.value} className="min-h-11 flex-1">{type.label}</SegmentedControlItem>)}
      </SegmentedControl>
    </div>}
    {def.options.topN && <Select label="How many items" className="w-full" triggerClassName="h-11" selectedKey={String(options.topN)}
      onSelectionChange={(key) => onChange({ topN: Number(key) })}>
      {topNChoices(options.topN).map((n) => <SelectItem key={n} id={String(n)} textValue={String(n)}>{n}</SelectItem>)}
    </Select>}
    <Button variant="primary" className="h-11" onClick={onDone}>Done</Button>
  </div>;
}

/** Settings for one widget in a drawer (a bottom sheet on tablets), so the widget stays visible and updates as options change. */
export function WidgetSettings({ item, onChange, onClose }: { item: DashboardItemValue | null; onChange(options: Partial<WidgetOptionsValue>): void; onClose(): void }) {
  const modules = useModules();
  const wide = useMediaQuery("(min-width: 1024px)");
  const def = item ? widgetDef(item.widget) : null;
  return <Drawer key={wide ? "end" : "bottom"} isOpen={!!item} onOpenChange={(next) => { if (!next) onClose(); }} placement={wide ? "end" : "bottom"} size="sm">
    <DrawerHeader title={def ? `${def.title} settings` : "Widget settings"} />
    <DrawerBody>
      {item && <WidgetSettingsForm item={item} zomatoActive={modules.isActive("zomato")} onChange={onChange} onDone={onClose} />}
    </DrawerBody>
  </Drawer>;
}
