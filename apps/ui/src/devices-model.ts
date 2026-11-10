import type { DeviceEvent, DeviceInfo, DeviceKind, DeviceList, JoinCodeIssued } from "@masalapos/domain/devices";
import type { PrinterInfo } from "./types";

/** What Settings → Devices decides without drawing anything: who sees which tab, what a row says, when a device has joined. */

export type DevicesTabId = "devices" | "printers" | "stations" | "jobs";
export const DEVICES_TABS: ReadonlyArray<{ id: DevicesTabId; label: string }> = [
  { id: "devices", label: "Devices" },
  { id: "printers", label: "Printers" },
  { id: "stations", label: "Kitchen stations" },
  { id: "jobs", label: "Print jobs" },
];

/** The tabs this person sees: Devices needs settings.manage, the other three printers.read. */
export function devicesTabs(can: (slug: string) => boolean): DevicesTabId[] {
  return DEVICES_TABS.map((tab) => tab.id).filter((id) => can(id === "devices" ? "settings.manage" : "printers.read"));
}

export const KIND_LABELS: Record<DeviceKind, string> = { counter: "Billing counter", kitchen: "Kitchen display", captain: "Captain" };

/** In this order: Main, This device, Over limit, Printer inactive. Over limit only when the build has a device limit. */
export function deviceBadges(device: DeviceInfo, hasLimit: boolean): string[] {
  return [
    ...(device.isMain ? ["Main"] : []),
    ...(device.current ? ["This device"] : []),
    ...(hasLimit && !device.allowed ? ["Over limit"] : []),
    ...(device.printerInactive ? ["Printer inactive"] : []),
  ];
}

/** "Online", "Last seen <date and time>", or "Not seen yet". */
export function presenceText(device: DeviceInfo, timezone?: string): string {
  if (device.online) return "Online";
  if (device.lastSeenAt === null) return "Not seen yet";
  return `Last seen ${new Date(device.lastSeenAt).toLocaleString("en-IN", { timeZone: timezone })}`;
}

/** "2 of 5 devices used"; null in builds without a limit. */
export function slotsText(list: DeviceList): string | null {
  return list.maxDevices === null ? null : `${list.devices.length} of ${list.maxDevices} devices used`;
}

/**
 * A kitchen display prints no bills. Otherwise the browser receipt, the printer's name, or that its printer is switched
 * off or gone. When the printer's name is not known here (the list of printers could not be read) it is a thermal
 * printer all the same: only the main PC's word makes it inactive.
 */
export function billPrinterText(device: DeviceInfo, activePrinters: ReadonlyArray<{ id: string; name: string }>): string {
  if (device.kind === "kitchen") return "—";
  const id = device.settings.billPrinterId;
  if (id === null) return "Browser / A4";
  if (device.printerInactive) return "Printer inactive";
  return activePrinters.find((printer) => printer.id === id)?.name ?? "Thermal printer";
}

/** The list with one device's `online` changed (a devices.presence event). */
export function withPresence(devices: DeviceInfo[], change: { deviceId: string; online: boolean }): DeviceInfo[] {
  return devices.map((device) => device.id === change.deviceId ? { ...device, online: change.online } : device);
}

/** Device names then station names; "—" when nothing prints to the printer. */
export function usedByText(usedBy: PrinterInfo["usedBy"]): string {
  return [...usedBy.devices, ...usedBy.stations].join(", ") || "—";
}

/** Whether Add device can make a code for a new device; `reason` is shown when it cannot. Replacing a device is always possible. */
export function canAddNew(list: DeviceList): { allowed: boolean; reason: string } {
  const allowed = list.maxDevices === null || list.devices.length < list.maxDevices;
  return { allowed, reason: allowed ? "" : "Device limit reached. Remove an unused device or upgrade the plan. Replacing a device uses no extra slot." };
}

/** The newest event id, or 0: what the Add device dialog remembers when it makes a code. */
export function newestEventId(events: DeviceEvent[]): number {
  return events.reduce((newest, event) => Math.max(newest, event.id), 0);
}

/**
 * The event that says the device this code is for has joined, or null. A new device: a `joined` event newer than
 * `sinceId` for a device that was not in the list when the code was made. A replacement: a `replaced` event newer than
 * `sinceId` for the device being replaced. A rename or a settings change in the meantime is neither.
 */
export function joinEvent(issued: JoinCodeIssued, events: DeviceEvent[], sinceId: number, knownIds: ReadonlySet<string>): DeviceEvent | null {
  return events.find((event) => event.id > sinceId && (issued.replacesDeviceId
    ? event.kind === "replaced" && event.deviceId === issued.replacesDeviceId
    : event.kind === "joined" && !knownIds.has(event.deviceId))) ?? null;
}
