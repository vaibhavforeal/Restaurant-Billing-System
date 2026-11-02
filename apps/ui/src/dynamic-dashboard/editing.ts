import {
  GRID_COLUMNS, WidgetOptions, compact, widgetDef,
  type DashboardItemValue, type DashboardWidgetId, type WidgetOptionsValue,
} from "@masalapos/domain/dashboard";

/** Puts a new widget at the left edge below everything else, at its default size and options. */
export function addWidget(items: DashboardItemValue[], widget: DashboardWidgetId, key: string): DashboardItemValue[] {
  const bottom = items.reduce((lowest, item) => Math.max(lowest, item.y + item.h), 0);
  const { w, h } = widgetDef(widget).defaultSize;
  return compact([...items, { key, widget, x: 0, y: bottom, w: Math.min(w, GRID_COLUMNS), h, options: WidgetOptions.parse({}) }]);
}

export function removeWidget(items: DashboardItemValue[], key: string): DashboardItemValue[] {
  return compact(items.filter((item) => item.key !== key));
}

/** Changes the options of one widget; the other items are returned as they were. */
export function updateOptions(items: DashboardItemValue[], key: string, options: Partial<WidgetOptionsValue>): DashboardItemValue[] {
  return items.map((item) => item.key === key ? { ...item, options: { ...item.options, ...options } } : item);
}
