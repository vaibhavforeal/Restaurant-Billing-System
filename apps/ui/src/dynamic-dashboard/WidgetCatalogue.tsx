import { DASHBOARD_WIDGETS, widgetVisible, type DashboardWidgetId, type WidgetKind } from "@masalapos/domain/dashboard";
import { useModules } from "../modules";
import { useCan } from "../permissions";
import { WorkspaceDialog } from "../WorkspaceDialog";

const GROUPS: Array<{ kind: WidgetKind; title: string }> = [
  { kind: "kpi", title: "Numbers" },
  { kind: "chart", title: "Charts" },
  { kind: "status", title: "Live service" },
];

/** The widgets this user can add, grouped by kind. A widget already on the dashboard can be added again. */
export function WidgetCatalogue({ open, onPick, onClose }: { open: boolean; onPick(widget: DashboardWidgetId): void; onClose(): void }) {
  const can = useCan();
  const modules = useModules();
  const visible = DASHBOARD_WIDGETS.filter((def) => widgetVisible(def, can, modules.isActive));
  return <WorkspaceDialog open={open} title="Add widget" onClose={onClose} className="dd-dialog">
    {GROUPS.map((group) => {
      const defs = visible.filter((def) => def.kind === group.kind);
      if (!defs.length) return null;
      return <section key={group.kind} className="dd-catalogue-group">
        <h3>{group.title}</h3>
        <ul>
          {defs.map((def) => <li key={def.id}>
            <button type="button" className="dd-catalogue-item" onClick={() => onPick(def.id)}>
              <strong>{def.title}</strong>
              <span>{def.description}</span>
            </button>
          </li>)}
        </ul>
      </section>;
    })}
    {visible.length === 0 && <p className="dd-empty">No widgets are available for your account.</p>}
  </WorkspaceDialog>;
}
