import { z } from "zod";
import { ModuleMapSchema, type ModuleMap } from "./modules.js";

export const PLANS = {
  basic: { name: "Basic", maxDevices: 2, features: { recipes: false, qrOrdering: false, kds: false } },
  pro: { name: "Pro", maxDevices: 5, features: { recipes: true, qrOrdering: true, kds: true } },
} as const;
export type Plan = keyof typeof PLANS;
export type Feature = keyof typeof PLANS.basic.features;

/** The older plan flags, kept in step with the module map they now come from. */
export const featuresFromModules = (modules: ModuleMap) => ({ recipes: modules.recipes, qrOrdering: modules.qrOrdering, kds: modules.kds });

// Signed grants contain resolved entitlements so later price/plan changes do not
// silently change an already-issued offline subscription.
export const LicenseClaims = z.object({
  version: z.literal(1),
  licenseId: z.string().uuid(),
  organizationId: z.string().uuid(),
  outletId: z.string().uuid(),
  installationId: z.string().uuid(),
  revision: z.number().int().positive().safe(),
  plan: z.enum(["basic", "pro"]),
  maxDevices: z.number().int().min(1).max(100),
  features: z.object({ recipes: z.boolean(), qrOrdering: z.boolean().default(false), kds: z.boolean().default(false) }).strict(),
  /** What the MasalaPOS owner allows this restaurant to use: the plan's defaults with the owner's choices applied. */
  modules: ModuleMapSchema,
  issuedAt: z.number().int().nonnegative().max(8_640_000_000_000_000),
  expiresAt: z.number().int().positive().max(8_640_000_000_000_000),
  graceUntil: z.number().int().positive().max(8_640_000_000_000_000),
  trial: z.boolean().optional(),
  /** The MasalaPOS Portal's Customer ID and the Order ID these terms come from, shown on the counter for support calls. */
  customerCode: z.string().min(1).max(20).optional(),
  orderCode: z.string().min(1).max(20).optional(),
}).strict().refine((c) => c.issuedAt < c.expiresAt && c.expiresAt <= c.graceUntil,
  "License dates must be ordered: issued, expires, grace");
export type LicenseClaims = z.infer<typeof LicenseClaims>;

export interface LicenseStatus {
  mode: "development" | "commercial";
  state: "development" | "unactivated" | "active" | "grace" | "expired" | "invalid" | "clock_error";
  installationId: string | null;
  plan: Plan | null;
  maxDevices: number | null;
  features: { recipes: boolean; qrOrdering: boolean; kds: boolean };
  /** Modules the licence allows; every module in development builds. */
  modules: ModuleMap;
  expiresAt: number | null;
  graceUntil: number | null;
  deviceRegistered: boolean;
  canOperate: boolean;
  message: string;
  serverTime: number;
  timezone: string;
  revision: number | null;
  registeredDevices: number;
  trial: boolean;
  /** The MasalaPOS Portal's Customer ID and Order ID from the installed licence, for support calls. */
  customerCode: string | null;
  orderCode: string | null;
  /** Whether this build talks to the licensing service, so it can activate with a Customer ID and Order ID and check for renewals. */
  onlineActivation: boolean;
}
export interface LicensedDevice {
  id: string; name: string; createdAt: number; current: boolean; allowed: boolean;
  lastSeenAt: number | null; version: number;
}
export interface LicensePreview {
  previewKey: string; alreadyInstalled: boolean; currentPlan: Plan | null;
  plan: Plan; revision: number; maxDevices: number; features: LicenseStatus["features"]; modules: ModuleMap;
  expiresAt: number; graceUntil: number; trial: boolean;
  blockedDevices: Array<{ id: string; name: string }>;
}
export interface LicenseEvent {
  id: number; occurredAt: number; actorName: string;
  kind: "license_activated" | "device_registered" | "device_renamed" | "device_removed";
  summary: string; revision: number | null; deviceId: string | null;
}
export interface LicenseHistory { events: LicenseEvent[]; nextBefore: number | null }
export interface ActivationRequest {
  format: "masalapos-activation-request"; version: 1; installationId: string;
  licenseId: string | null; organizationId: string | null; outletId: string | null;
  currentRevision: number; generatedAt: number; verificationKeyFingerprint: string;
  /** Reported so MasalaPOS support can see which version and restaurant a counter is; neither affects the licence. */
  appVersion?: string; outletName?: string;
}
