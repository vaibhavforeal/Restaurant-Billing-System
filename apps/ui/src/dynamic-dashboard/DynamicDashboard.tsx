import { useEffect, useMemo, useState } from "react";
import {
  COMPARE_LABELS, DASHBOARD_LIMITS, PERIOD_LABELS, compact, widgetDef, widgetVisible,
  type DashboardData, type DashboardItemValue, type DashboardWidgetId, type WidgetOptionsValue,
} from "@masalapos/domain/dashboard";
import { updatedLabel } from "../dashboard-view";
import { useModules } from "../modules";
import { useCan } from "../permissions";
import { useAction } from "../use-action";
import { useMediaQuery } from "../use-media-query";
import { useNow } from "../useDashboard";
import { DashboardGrid } from "./DashboardGrid";
import { WidgetBody } from "./widgets";
import { WidgetCatalogue } from "./WidgetCatalogue";
import { WidgetSettings } from "./WidgetSettings";
import { addWidget, removeWidget, updateOptions } from "./editing";
import { useDashboardData } from "./useDashboardData";
import { useDashboardLayout } from "./useDashboardLayout";

const newKey = () => typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
  ? crypto.randomUUID()
  : Date.now().toString(36) + Math.random().toString(36).slice(2);

const shortDate = (key: string) => {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y!, m! - 1, d!).toLocaleDateString("en-IN", { day: "numeric", month: "short" });
};

function rangeText(data: DashboardData | null, key: string): string {
  const result = data?.results[key];
  if (!result?.ok || !result.range) return "";
  const { from, to } = result.range;
  return from === to ? shortDate(from) : `${shortDate(from)} – ${shortDate(to)}`;
}

/** The customisable Home dashboard. Calls `onUnavailable` when the server says the feature is off or not allowed. */
export function DynamicDashboard({ onUnavailable }: { onUnavailable(): void }) {
  const can = useCan();
  const modules = useModules();
  const narrow = !useMediaQuery("(min-width: 720px)");
  const now = useNow(60_000);
  const { layout, error: loadError, unavailable: layoutOff, save, reset } = useDashboardLayout();
  const [draft, setDraft] = useState<DashboardItemValue[] | null>(null);
  const [catalogue, setCatalogue] = useState(false);
  const [settingsKey, setSettingsKey] = useState<string | null>(null);
  const action = useAction();
  const editing = draft !== null;

  // Widgets the user can no longer see (permission or module changed) are left out of the screen and of any save.
  const savedItems = useMemo(
    () => (layout?.items ?? []).filter((i) => widgetVisible(widgetDef(i.widget), can, modules.isActive)),
    [layout, can, modules.isActive],
  );
  const items = draft ?? savedItems;
  const { data, error: dataError, unavailable: dataOff, refresh } = useDashboardData(items);

  useEffect(() => { if (layoutOff || dataOff) onUnavailable(); }, [layoutOff, dataOff, onUnavailable]);

  const { setError } = action;
  const stopEditing = () => { setDraft(null); setCatalogue(false); setSettingsKey(null); setError(""); };
  // The window shrinking below the editing width cancels the draft.
  useEffect(() => {
    if (narrow) { setDraft(null); setCatalogue(false); setSettingsKey(null); setError(""); }
  }, [narrow, setError]);

  const onSave = () => draft && void action.run(async () => {
    if (!layout) return;
    await save({ ...layout, items: draft });
    stopEditing();
  }, "Could not save the dashboard");
  const onReset = () => {
    if (!window.confirm("Reset the dashboard to the default layout? Your changes will be lost.")) return;
    void action.run(async () => { await reset(); stopEditing(); }, "Could not reset the dashboard");
  };
  const pick = (widget: DashboardWidgetId) => { setDraft((d) => d && addWidget(d, widget, newKey())); setCatalogue(false); };
  const settingsItem = draft?.find((i) => i.key === settingsKey) ?? null;

  const header = (item: DashboardItemValue) => {
    const def = widgetDef(item.widget);
    const meta = def.options.period
      ? [PERIOD_LABELS[item.options.period], rangeText(data, item.key)].filter(Boolean).join(" · ")
      : "Live";
    return <header className="dd-widget-header">
      {!editing && <h3>{def.title}</h3>}
      <span className="dd-widget-meta">{meta}</span>
    </header>;
  };

  if (!layout) return loadError
    ? <p className="alert" role="alert">{loadError}</p>
    : <p className="dd-empty" role="status">Loading dashboard…</p>;

  const full = (draft?.length ?? 0) >= DASHBOARD_LIMITS.items;
  return <div className="dd-screen">
    {!narrow && <div className="dd-toolbar">
      {draft ? <>
        <button type="button" disabled={full || action.busy} title={full ? "Your dashboard is full" : undefined} onClick={() => setCatalogue(true)}>+ Add widget</button>
        <button type="button" disabled={action.busy} onClick={onReset}>Reset to default</button>
        <button type="button" disabled={action.busy} onClick={stopEditing}>Cancel</button>
        <button type="button" className="primary" disabled={action.busy} onClick={onSave}>{action.busy ? "Saving…" : "Save"}</button>
      </> : <button type="button" onClick={() => setDraft(compact(savedItems))}>Customise</button>}
    </div>}
    {action.error && <p className="alert" role="alert">{action.error}</p>}
    {!editing && dataError && <p className="alert" role="status">{dataError}</p>}
    {items.length === 0 && <p className="dd-empty">{editing ? "No widgets yet. Add one to get started." : "Your dashboard is empty. Use Customise to add widgets."}</p>}
    <DashboardGrid
      items={items} editing={editing} narrow={narrow}
      onChange={(next) => setDraft(next)}
      renderItem={(item) => <div className="dd-widget">
        {header(item)}
        <WidgetBody def={widgetDef(item.widget)} result={data?.results[item.key]} onRetry={refresh} compareLabel={COMPARE_LABELS[item.options.compare]} />
      </div>}
      renderTools={(item) => {
        const def = widgetDef(item.widget);
        const configurable = Object.values(def.options).some(Boolean);
        return <>
          {configurable && <button type="button" aria-label={`${def.title} settings`} onClick={() => setSettingsKey(item.key)}>Settings</button>}
          <button type="button" aria-label={`Remove ${def.title}`} onClick={() => setDraft((d) => d && removeWidget(d, item.key))}>Remove</button>
        </>;
      }}
    />
    {!editing && <p className="dd-footer" role="status">{updatedLabel(data?.generatedAt ?? null, now)}</p>}
    <WidgetCatalogue open={catalogue} onPick={pick} onClose={() => setCatalogue(false)} />
    <WidgetSettings item={settingsItem} onChange={(options: Partial<WidgetOptionsValue>) => settingsKey && setDraft((d) => d && updateOptions(d, settingsKey, options))} onClose={() => setSettingsKey(null)} />
  </div>;
}
