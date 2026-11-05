import type { IconName } from "./Icon";

export type SettingsSectionId = "profile" | "bill" | "tables" | "ai-suggestions" | "order-types" | "printers" | "jobs" | "backups" | "plan" | "updates" | "shortcuts" | "support";

export const SETTINGS_SECTIONS: ReadonlyArray<{ id: SettingsSectionId; title: string; blurb: string; icon: IconName }> = [
  { id: "profile", title: "Restaurant profile", blurb: "Name, address, GSTIN and FSSAI", icon: "marketplace" },
  { id: "bill", title: "Bill settings", blurb: "Tax, printed bill and order handling", icon: "note" },
  { id: "tables", title: "Table Settings", blurb: "Manage tables and table QR codes", icon: "tables" },
  { id: "ai-suggestions", title: "AI suggestions", blurb: "Popular items, pairings and the AI assistant", icon: "reports" },
  { id: "order-types", title: "Order types", blurb: "Takeaway and delivery types", icon: "bag" },
  { id: "printers", title: "Printers", blurb: "Printers, print profiles and KOT stations", icon: "printer" },
  { id: "jobs", title: "Print jobs", blurb: "Check, retry or confirm printed copies", icon: "bills" },
  { id: "backups", title: "Backups & connections", blurb: "Backups, devices and cloud", icon: "cloud" },
  { id: "plan", title: "Plan & devices", blurb: "Licence, plan and registered devices", icon: "badge" },
  { id: "updates", title: "Updates", blurb: "Version, update channel and installing", icon: "refresh" },
  { id: "shortcuts", title: "Keyboard shortcuts", blurb: "Counter hotkeys", icon: "keyboard" },
  { id: "support", title: "Help & support", blurb: "Chat with MasalaPOS, remote access", icon: "help" },
];

/** The card grid is the landing view; only a deep link (e.g. from Marketplace) opens a section directly. */
export function initialSettingsSection(requested?: "plan"): SettingsSectionId | null {
  return requested ?? null;
}
