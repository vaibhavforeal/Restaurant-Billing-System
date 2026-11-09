import type { IconName } from "./Icon";

export type SettingsSectionId = "profile" | "bill" | "discounts" | "loyalty" | "tables" | "ai-suggestions" | "order-types" | "printers" | "device" | "backups" | "plan" | "updates" | "shortcuts" | "support";

export const SETTINGS_SECTIONS: ReadonlyArray<{ id: SettingsSectionId; title: string; blurb: string; icon: IconName }> = [
  { id: "profile", title: "Restaurant profile", blurb: "Name, address, GSTIN and FSSAI", icon: "marketplace" },
  { id: "bill", title: "Bill settings", blurb: "Tax, printed bill and order handling", icon: "note" },
  { id: "discounts", title: "Discounts & limits", blurb: "Staff discount limits and customer-type discounts", icon: "bills" },
  { id: "loyalty", title: "Loyalty", blurb: "Points, redeeming and tiers", icon: "customers" },
  { id: "tables", title: "Table Settings", blurb: "Manage tables and table QR codes", icon: "tables" },
  { id: "ai-suggestions", title: "AI suggestions", blurb: "Popular items, pairings and the AI assistant", icon: "reports" },
  { id: "order-types", title: "Order types", blurb: "Takeaway and delivery types", icon: "bag" },
  { id: "printers", title: "Printers", blurb: "Printers, KOT stations and print jobs", icon: "printer" },
  { id: "device", title: "This device", blurb: "Theme, alerts, bill printer and payment method here", icon: "monitor" },
  { id: "backups", title: "Backups & connections", blurb: "Backups, devices and cloud", icon: "cloud" },
  { id: "plan", title: "Plan & devices", blurb: "Licence, plan and registered devices", icon: "badge" },
  { id: "shortcuts", title: "Keyboard shortcuts", blurb: "Counter hotkeys", icon: "keyboard" },
  { id: "support", title: "Help & support", blurb: "Updates, chat with MasalaPOS and remote access", icon: "help" },
];

/** The cards this person sees: Tables needs table rights, and Loyalty belongs to the CRM & Loyalty add-on. */
export function visibleSettingsSections({ canManageTables, crmActive }: { canManageTables: boolean; crmActive: boolean }) {
  return SETTINGS_SECTIONS.filter((s) => (s.id !== "tables" || canManageTables) && (s.id !== "loyalty" || crmActive));
}

/** The card grid is the landing view; only a deep link (e.g. from Marketplace or Customers) opens a section directly. */
export function initialSettingsSection(requested?: SettingsSectionId): SettingsSectionId | null {
  return requested === "updates" ? "support" : requested ?? null;
}
