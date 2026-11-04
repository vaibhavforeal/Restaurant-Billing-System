import { DASHBOARD_WIDGETS, widgetVisible, type DashboardWidgetId, type WidgetDef, type WidgetKind } from "@masalapos/domain/dashboard";
import { Drawer, DrawerBody, DrawerHeader } from "@board/components/base/drawer/drawer";
import { useModules } from "../modules";
import { useCan } from "../permissions";
import { useMediaQuery } from "../use-media-query";

const GROUPS: Array<{ kind: WidgetKind; title: string }> = [
  { kind: "kpi", title: "Numbers" },
  { kind: "chart", title: "Charts" },
  { kind: "status", title: "Live service" },
];

/** The widgets grouped by kind. A widget already on the dashboard can be added again. */
export function CatalogueList({ defs, onPick }: { defs: readonly WidgetDef[]; onPick(widget: DashboardWidgetId): void }) {
  if (defs.length === 0) return <p className="dd-empty text-body-regular text-text-secondary">No widgets are available for your account.</p>;
  return <div className="flex flex-col gap-6">
    {GROUPS.map((group) => {
      const inGroup = defs.filter((def) => def.kind === group.kind);
      if (!inGroup.length) return null;
      return <section key={group.kind} className="dd-catalogue-group flex flex-col gap-2">
        <h3 className="text-body-semibold text-text-primary">{group.title}</h3>
        <ul className="flex list-none flex-col gap-2 p-0">
          {inGroup.map((def) => <li key={def.id}>
            <button type="button" onClick={() => onPick(def.id)}
              className="dd-catalogue-item flex min-h-14 w-full cursor-pointer flex-col items-start gap-0.5 rounded-xl border border-border-button-default bg-background-primary-default px-4 py-3 text-start outline-none hover:bg-background-primary-hover focus-visible:ring-2 focus-visible:ring-border-focus-ring">
              <strong className="text-body-medium text-text-primary">{def.title}</strong>
              <span className="text-caption-1-regular text-text-secondary">{def.description}</span>
            </button>
          </li>)}
        </ul>
      </section>;
    })}
  </div>;
}

/** Side drawer on wide screens, bottom sheet on tablets. Keyed by placement: switching it while open (rotating a tablet)
 * would otherwise leave the old drawer stuck in its exit state with an invisible overlay over the page. */
export function WidgetCatalogue({ open, onPick, onClose }: { open: boolean; onPick(widget: DashboardWidgetId): void; onClose(): void }) {
  const can = useCan();
  const modules = useModules();
  const wide = useMediaQuery("(min-width: 1024px)");
  const visible = DASHBOARD_WIDGETS.filter((def) => widgetVisible(def, can, modules.isActive));
  return <Drawer key={wide ? "end" : "bottom"} isOpen={open} onOpenChange={(next) => { if (!next) onClose(); }} placement={wide ? "end" : "bottom"} size="md">
    <DrawerHeader title="Add widget" description="Pick something to put on your dashboard." />
    <DrawerBody><CatalogueList defs={visible} onPick={onPick} /></DrawerBody>
  </Drawer>;
}
