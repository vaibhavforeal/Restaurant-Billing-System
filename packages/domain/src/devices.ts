import { z } from "zod";

/** The kinds of staff device. Each one uses a licence slot; guest phones on the QR menu are not devices. */
export const DEVICE_KINDS = ["counter", "kitchen", "captain"] as const;
export type DeviceKind = (typeof DEVICE_KINDS)[number];

/** Something that happened to a device. Never carries a device credential or its hash. */
export interface DeviceEvent {
  id: number; occurredAt: number; actorName: string; deviceId: string;
  kind: "joined" | "renamed" | "replaced" | "removed" | "settings_changed";
  summary: string;
}
export interface DeviceHistory { events: DeviceEvent[]; nextBefore: number | null }

/** Join codes leave out the characters people mix up: 0 and O, 1, I and L. */
export const JOIN_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const JOIN_CODE_LENGTH = 6;
export const JOIN_CODE_TTL_MS = 10 * 60_000;
/** Upper-cases and drops spaces and hyphens; null unless what is left is a whole join code. */
export function normalizeJoinCode(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const code = input.replace(/[\s-]/g, "").toUpperCase();
  return code.length === JOIN_CODE_LENGTH && [...code].every((c) => JOIN_CODE_ALPHABET.includes(c)) ? code : null;
}
/** What an administrator asks for: a code for a new device, or one that moves an existing device to another browser. */
export const JoinCodeCreate = z.union([
  z.object({ kind: z.enum(DEVICE_KINDS), name: z.string().trim().min(1).max(80) }).strict(),
  z.object({ replacesDeviceId: z.string().uuid() }).strict(),
]);
export type JoinCodeCreate = z.infer<typeof JoinCodeCreate>;
/** A fresh join code. `links` open the join screen with the code filled in, one for each address the device can use. */
export interface JoinCodeIssued {
  code: string; expiresAt: number; kind: DeviceKind; name: string; replacesDeviceId: string | null;
  links: { url: string; qr: string }[];
}
/** What a browser learns about itself before sign-in. `mainPc` is true for a browser on the main POS PC itself. */
export interface DeviceMe { joined: boolean; kind: DeviceKind | null; mainPc: boolean }
export interface DeviceJoined { kind: DeviceKind; name: string }

/** Where a new bill's payment starts: on the method this device used last, or always on one method. */
export const PAYMENT_STARTS = ["last", "cash", "card", "upi"] as const;
export type PaymentStart = (typeof PAYMENT_STARTS)[number];
/** What the main PC keeps for each device. `billPrinterId` is null for the browser (A4) receipt. */
export const DeviceSettings = z.object({
  billPrinterId: z.string().min(1).nullable().default(null).catch(null),
  paymentStart: z.enum(PAYMENT_STARTS).default("last").catch("last"),
});
export type DeviceSettings = z.infer<typeof DeviceSettings>;
/** What is stored for a device, with defaults for whatever is missing or unreadable. Unknown keys are dropped. */
export function deviceSettings(stored: unknown): DeviceSettings {
  return DeviceSettings.parse(typeof stored === "object" && stored !== null && !Array.isArray(stored) ? stored : {});
}
/** A change to some settings, with the device version it was made against. */
export const DeviceSettingsPatch = z.object({
  version: z.number().int().positive(),
  billPrinterId: z.string().min(1).nullable().optional(),
  paymentStart: z.enum(PAYMENT_STARTS).optional(),
}).strict();
export type DeviceSettingsPatch = z.infer<typeof DeviceSettingsPatch>;
/** A new name for a device, with the device version it was made against. */
export const DeviceRename = z.object({ name: z.string().trim().min(1).max(80), version: z.number().int().positive() }).strict();
/** Removing a device; the version is checked when it is given. */
export const DeviceRemove = z.object({ version: z.number().int().positive().optional() }).strict();
/** A row of the device list. `settings` is what is saved; `printerInactive` says its printer is switched off. */
export interface DeviceInfo {
  id: string; kind: DeviceKind; name: string; isMain: boolean; createdAt: number; lastSeenAt: number | null; version: number;
  /** The browser asking. */
  current: boolean;
  /** Within the licence's device count; always true in builds without one. */
  allowed: boolean;
  online: boolean; settings: DeviceSettings; printerInactive: boolean;
}
export interface DeviceList { devices: DeviceInfo[]; maxDevices: number | null }
/**
 * The calling device's own settings, as they apply now. `deviceId` is null for a browser that is not a device.
 * `printerInactive` says a printer is saved for the device but switched off, so `settings.billPrinterId` reads null.
 */
export interface MyDeviceSettings { deviceId: string | null; version: number | null; printerInactive: boolean; settings: DeviceSettings }
