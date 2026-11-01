import { z } from "zod";

/**
 * The parts of the POS that MasalaPOS (the vendor) can allow or withhold per restaurant. The owner's choices travel in the
 * signed licence as a complete `modules` map; within that, the restaurant's admin can switch an allowed module off and on
 * again. Billing, tables, the catalogue, staff and settings are core and always on, so they are not listed here.
 */
export const MODULE_IDS = [
  "takeaway", "reservations", "qrOrdering", "guestServices",
  "inventory", "recipes", "costing", "reports", "dashboard",
  "zomato", "kds", "crm",
] as const;
export type ModuleId = typeof MODULE_IDS[number];
export type ModuleGroup = "addon" | "service" | "backoffice";

export interface ModuleDef {
  id: ModuleId;
  name: string;
  group: ModuleGroup;
  description: string;
  /** Modules that must be active for this one to work. */
  dependsOn: readonly ModuleId[];
  /** Whether each plan includes it when the owner has not decided otherwise. */
  plans: { basic: boolean; pro: boolean };
}

export const MODULES: readonly ModuleDef[] = [
  { id: "takeaway", name: "Takeaway", group: "service", dependsOn: [], plans: { basic: true, pro: true },
    description: "Start takeaway and parcel orders. Open takeaway orders can always be finished and billed." },
  { id: "reservations", name: "Reservations", group: "service", dependsOn: [], plans: { basic: true, pro: true },
    description: "Book tables ahead. Existing reservations can still be seated or cancelled." },
  { id: "qrOrdering", name: "QR guest ordering", group: "service", dependsOn: [], plans: { basic: false, pro: true },
    description: "Guests order from a QR menu at the table; staff accept the requests." },
  { id: "guestServices", name: "Guest assistance", group: "service", dependsOn: ["qrOrdering"], plans: { basic: false, pro: true },
    description: "Guests call a waiter or ask for the bill from the QR menu." },
  { id: "inventory", name: "Inventory", group: "backoffice", dependsOn: [], plans: { basic: true, pro: true },
    description: "Stock items, purchases and adjustments. Sales keep deducting stock while it is off." },
  { id: "recipes", name: "Recipes", group: "backoffice", dependsOn: ["inventory"], plans: { basic: false, pro: true },
    description: "Link menu items to the ingredients they use. Saved recipes keep deducting stock while it is off." },
  { id: "costing", name: "Dish costing", group: "backoffice", dependsOn: ["recipes"], plans: { basic: false, pro: true },
    description: "Ingredient costs, dish margins and the profit report." },
  { id: "reports", name: "Reports & analytics", group: "backoffice", dependsOn: [], plans: { basic: true, pro: true },
    description: "Sales, collections, item, analytics and custom reports. Bills and the day-end GST summary stay available." },
  { id: "dashboard", name: "Sales dashboard", group: "backoffice", dependsOn: ["reports"], plans: { basic: true, pro: true },
    description: "The sales dashboard on the home screen." },
  { id: "zomato", name: "Zomato", group: "addon", dependsOn: [], plans: { basic: true, pro: true },
    description: "Receive Zomato delivery orders, review them and bill them from the counter." },
  { id: "kds", name: "Kitchen Display (KDS)", group: "addon", dependsOn: [], plans: { basic: false, pro: true },
    description: "Show KOTs on kitchen screens and tablets so the kitchen can mark tickets done." },
  { id: "crm", name: "CRM & Loyalty", group: "addon", dependsOn: [], plans: { basic: true, pro: true },
    description: "Customer profiles, loyalty points and tiers, customer-type discounts, feedback, segments and insights." },
];

export const isModuleId = (id: string): id is ModuleId => (MODULE_IDS as readonly string[]).includes(id);
export const moduleDef = (id: ModuleId) => MODULES.find((m) => m.id === id)!;

/** The allowed map: true for each module the restaurant may use. */
export type ModuleMap = Record<ModuleId, boolean>;
/** The owner's per-restaurant choices; a module left out follows the plan. */
export type ModuleOverrides = { [K in ModuleId]?: boolean | undefined };

/** Every module, as the licence carries it: all keys present. */
export const ModuleMapSchema = z.object(Object.fromEntries(MODULE_IDS.map((id) => [id, z.boolean()])) as Record<ModuleId, z.ZodBoolean>).strict();
export const ModuleOverridesSchema = z.object(Object.fromEntries(MODULE_IDS.map((id) => [id, z.boolean().optional()])) as Record<ModuleId, z.ZodOptional<z.ZodBoolean>>).strict();

export function planModules(plan: "basic" | "pro"): ModuleMap {
  return Object.fromEntries(MODULES.map((m) => [m.id, m.plans[plan]])) as ModuleMap;
}

/** The plan's defaults with the owner's choices applied. */
export function resolveModules(plan: "basic" | "pro", overrides: ModuleOverrides = {}): ModuleMap {
  const map = planModules(plan);
  for (const id of MODULE_IDS) if (overrides[id] !== undefined) map[id] = overrides[id]!;
  return map;
}

/** Every module allowed: development builds, which have no licence. */
export const allModules = (): ModuleMap => Object.fromEntries(MODULE_IDS.map((id) => [id, true])) as ModuleMap;

export interface ModuleInfo extends ModuleDef {
  /** The owner allows it for this restaurant (from the licence). */
  allowed: boolean;
  /** The restaurant has not switched it off. */
  enabled: boolean;
  /** Allowed, enabled and every module it depends on is active: the module works. */
  active: boolean;
  /** Why it is not active, in plain words; null when active. */
  reason: string | null;
  updatedAt: number | null;
}

/**
 * Works out each module's state. A module is active when the owner allows it, the restaurant has not switched it off and
 * the modules it depends on are active.
 */
export function resolveModuleStates(allowed: ModuleMap, enabled: (id: ModuleId) => boolean, updatedAt: (id: ModuleId) => number | null = () => null): ModuleInfo[] {
  const done = new Map<ModuleId, ModuleInfo>();
  const resolve = (id: ModuleId): ModuleInfo => {
    const known = done.get(id);
    if (known) return known;
    const def = moduleDef(id);
    const isAllowed = allowed[id];
    const isEnabled = enabled(id);
    const blocker = def.dependsOn.map(resolve).find((d) => !d.active);
    const reason = !isAllowed ? "Not included for this restaurant" : !isEnabled ? "Turned off" : blocker ? `Needs ${blocker.name}` : null;
    const info: ModuleInfo = { ...def, allowed: isAllowed, enabled: isEnabled, active: reason === null, reason, updatedAt: updatedAt(id) };
    done.set(id, info);
    return info;
  };
  return MODULES.map((m) => resolve(m.id));
}

export const ModuleToggle = z.object({ enabled: z.boolean() }).strict();
