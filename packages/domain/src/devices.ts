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
