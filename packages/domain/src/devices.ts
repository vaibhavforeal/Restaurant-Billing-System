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
