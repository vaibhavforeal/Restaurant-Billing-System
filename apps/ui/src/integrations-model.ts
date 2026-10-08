import type { IntegrationId, IntegrationInfo } from "@forkflow/domain/integrations";
import type { User } from "./api";

export function isEnabled(list: IntegrationInfo[], id: IntegrationId): boolean {
  return list.some((info) => info.id === id && info.enabled);
}

export function statusLabel(info: IntegrationInfo): "Enabled" | "Disabled" | "Coming soon" {
  if (info.status === "coming_soon") return "Coming soon";
  return info.enabled ? "Enabled" : "Disabled";
}

export function canToggle(info: IntegrationInfo, role: User["role"]): boolean {
  return role === "admin" && info.status === "available";
}

/** List to show after a fetch: the fresh list on success; on failure, the last known list once one has loaded, else empty (fail closed). */
export function nextList(prev: IntegrationInfo[], result: IntegrationInfo[] | null, loadedOnce: boolean): IntegrationInfo[] {
  return result ?? (loadedOnce ? prev : []);
}
