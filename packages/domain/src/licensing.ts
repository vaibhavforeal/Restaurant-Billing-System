import { z } from "zod";

export const PLANS = {
  basic: { name: "Basic", maxDevices: 2, features: { recipes: false, qrOrdering: false, kds: false } },
  pro: { name: "Pro", maxDevices: 5, features: { recipes: true, qrOrdering: true, kds: true } },
} as const;
export type Plan = keyof typeof PLANS;
export type Feature = keyof typeof PLANS.basic.features;

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
  issuedAt: z.number().int().nonnegative().max(8_640_000_000_000_000),
  expiresAt: z.number().int().positive().max(8_640_000_000_000_000),
  graceUntil: z.number().int().positive().max(8_640_000_000_000_000),
  trial: z.boolean().optional(),
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
}
export interface LicensedDevice {
  id: string; name: string; createdAt: number; current: boolean; allowed: boolean;
  lastSeenAt: number | null; version: number;
}
export interface LicensePreview {
  previewKey: string; alreadyInstalled: boolean; currentPlan: Plan | null;
  plan: Plan; revision: number; maxDevices: number; features: LicenseStatus["features"];
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
  format: "forkflow-activation-request"; version: 1; installationId: string;
  licenseId: string | null; organizationId: string | null; outletId: string | null;
  currentRevision: number; generatedAt: number; verificationKeyFingerprint: string;
}
