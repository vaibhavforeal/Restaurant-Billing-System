import type { IntegrationId, IntegrationInfo } from "@forkflow/domain/integrations";
import type { User } from "./api";
import type { Page } from "./NavBar";

export function isEnabled(list: IntegrationInfo[], id: IntegrationId): boolean {
  return list.some((info) => info.id === id && info.enabled && info.licensed);
}

/** `licensed` is whether ForkFlow allows the add-on for this restaurant (from the licence). */
export function statusLabel(info: IntegrationInfo): "Enabled" | "Disabled" | "Coming soon" | "Not included" {
  if (info.status === "coming_soon") return "Coming soon";
  if (!info.licensed) return "Not included";
  return info.enabled ? "Enabled" : "Disabled";
}

/** Admins may switch an available integration; without the licence they may only switch it off (a downgrade can leave it on). */
export function canToggle(info: IntegrationInfo, role: User["role"]): boolean {
  return role === "admin" && info.status === "available" && (info.licensed || info.enabled);
}

const TAB_INTEGRATION: Partial<Record<Page["name"], IntegrationId>> = { kitchen: "kds", customers: "crm" };

/** Pages that belong to an integration show only while it is on (the kitchen board and Customers). The kitchen role cannot read integrations, so its only tab always shows and the board explains when the Kitchen Display is off. */
export function navTabVisible(page: Page["name"], role: User["role"], isEnabled: (id: IntegrationId) => boolean): boolean {
  const integration = TAB_INTEGRATION[page];
  if (!integration || (page === "kitchen" && role === "kitchen")) return true;
  return isEnabled(integration);
}

/** List to show after a fetch: the fresh list on success; on failure, the last known list once one has loaded, else empty (fail closed). */
export function nextList(prev: IntegrationInfo[], result: IntegrationInfo[] | null, loadedOnce: boolean): IntegrationInfo[] {
  return result ?? (loadedOnce ? prev : []);
}
