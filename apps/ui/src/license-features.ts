import { MODULES, type ModuleMap } from "@forkflow/domain/modules";

/** Which modules a licence includes, in catalogue order, e.g. for the active plan or a licence preview. */
export function moduleSummary(modules: ModuleMap): string {
  const included = MODULES.filter((m) => modules[m.id]).map((m) => m.name);
  const excluded = MODULES.filter((m) => !modules[m.id]).map((m) => m.name);
  return [included.length ? `Included: ${included.join(", ")}.` : "No modules included.", excluded.length ? `Not included: ${excluded.join(", ")}.` : ""].filter(Boolean).join(" ");
}
