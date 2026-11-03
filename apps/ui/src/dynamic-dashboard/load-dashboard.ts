import { useEffect, type ComponentType } from "react";

type DashboardProps = { onUnavailable(): void };

/** Stands in for the dashboard when its lazy chunk cannot be fetched, so Home falls back to the fixed Sales dashboard
 * instead of the whole POS showing a crash screen (for example after a server update replaced the hashed chunk). */
export function DashboardLoadFailed({ onUnavailable }: DashboardProps) {
  useEffect(() => { onUnavailable(); }, [onUnavailable]);
  return null;
}

/** For React.lazy: the dashboard component from the loaded module, or `DashboardLoadFailed` when the import rejects. */
export async function loadDashboard(importer: () => Promise<{ DynamicDashboard: ComponentType<DashboardProps> }>): Promise<{ default: ComponentType<DashboardProps> }> {
  try {
    return { default: (await importer()).DynamicDashboard };
  } catch {
    return { default: DashboardLoadFailed };
  }
}
