import { z } from "zod";
import type { Feature } from "./licensing.js";
import type { IntegrationId } from "./integrations.js";
import { StaffOverrides } from "./staff-permissions.js";

export interface FeatureDefinition {
  id: string;
  name: string;
  description: string;
  category: "Core" | "Service" | "Inventory" | "Guests" | "Reporting" | "Integrations";
  configurable: boolean;
  defaultEnabled: boolean;
  dependencies: readonly string[];
  entitlement?: Feature;
  integration?: IntegrationId;
}
export const FEATURES: readonly FeatureDefinition[] = [
  { id: "billing", name: "Billing & payments", description: "Orders, KOTs, payments, refunds and bill history remain available.", category: "Core", configurable: false, defaultEnabled: true, dependencies: [] },
  { id: "administration", name: "Administration & recovery", description: "Catalog, staff, settings, backups and feature controls remain available.", category: "Core", configurable: false, defaultEnabled: true, dependencies: [] },
  { id: "takeaway", name: "Takeaway", description: "Create new takeaway orders. Existing orders can always be completed.", category: "Service", configurable: true, defaultEnabled: true, dependencies: [] },
  { id: "reservations", name: "Reservations", description: "Create and edit reservations. Existing reservations can still be reviewed, seated or cancelled.", category: "Service", configurable: true, defaultEnabled: true, dependencies: [] },
  { id: "inventory", name: "Inventory", description: "Manage stock items, purchases and adjustments. Sale accounting and historical records are preserved.", category: "Inventory", configurable: true, defaultEnabled: true, dependencies: [] },
  { id: "recipes", name: "Recipes", description: "Manage ingredients and stock links for menu items. Saved recipes continue to account for sales.", category: "Inventory", configurable: true, defaultEnabled: true, dependencies: ["inventory"] },
  { id: "costing", name: "Dish costing", description: "Manage ingredient costs and view dish margins and profit reports.", category: "Inventory", configurable: true, defaultEnabled: true, dependencies: ["inventory", "recipes"], entitlement: "recipes" },
  { id: "qrOrdering", name: "Guest ordering", description: "Accept new orders through table QR menus. Menu browsing and existing request recovery remain available.", category: "Guests", configurable: true, defaultEnabled: true, dependencies: [], entitlement: "qrOrdering" },
  { id: "guestServices", name: "Guest assistance", description: "Guests can call staff or request their bill. Existing calls remain available to resolve.", category: "Guests", configurable: true, defaultEnabled: true, dependencies: ["qrOrdering"], entitlement: "qrOrdering" },
  { id: "dashboard", name: "Sales dashboard", description: "Show the financial dashboard on the home screen.", category: "Reporting", configurable: true, defaultEnabled: true, dependencies: ["reports"] },
  { id: "reports", name: "Reports & analytics", description: "View sales, collections, day-end and operational reports. Bill history remains available.", category: "Reporting", configurable: true, defaultEnabled: true, dependencies: [] },
  { id: "zomato", name: "Zomato", description: "Receive delivery orders. Existing orders and reconciliation remain available when disabled.", category: "Integrations", configurable: true, defaultEnabled: false, dependencies: [], integration: "zomato" },
  { id: "swiggy", name: "Swiggy", description: "Delivery integration coming soon.", category: "Integrations", configurable: true, defaultEnabled: false, dependencies: [], integration: "swiggy" },
  { id: "kds", name: "Kitchen Display", description: "Display KOTs on kitchen screens and tablets.", category: "Integrations", configurable: true, defaultEnabled: false, dependencies: [], integration: "kds", entitlement: "kds" },
];
export interface FeatureInfo extends FeatureDefinition {
  enabled: boolean;
  active: boolean;
  licensed: boolean;
  available: boolean;
  reason: string | null;
  updatedAt: number | null;
}
export interface FeatureCatalog { revision: number; features: FeatureInfo[] }
export const FeatureToggle = z.object({ enabled: z.boolean() }).strict();

export const RestaurantFeaturePolicy = z.object({
  kind: z.literal("restaurant-features"), version: z.literal(1),
  installationId: z.string().uuid(), organizationId: z.string().uuid(), outletId: z.string().uuid(),
  revision: z.number().int().nonnegative().safe(),
  enabled: z.record(z.string(), z.boolean()).refine(values => Object.keys(values).every(id => FEATURES.some(f => f.id === id && f.configurable)), "Unknown or required feature"),
  staffPermissions: z.record(z.string().uuid(), StaffOverrides).optional(),
}).strict();
export type RestaurantFeaturePolicy = z.infer<typeof RestaurantFeaturePolicy>;
