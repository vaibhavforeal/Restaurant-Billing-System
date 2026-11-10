import { useCallback, useEffect, useState } from "react";
import type { MyDeviceSettings } from "@masalapos/domain/devices";
import { apiFetch } from "./api";
import { connectWs } from "./ws";

/** What a browser that is not one of the restaurant's devices works with: the browser receipt, and the method used last. */
export const NO_DEVICE: MyDeviceSettings = { deviceId: null, version: null, printerInactive: false, settings: { billPrinterId: null, paymentStart: "last" } };

export const DEVICE_SETTINGS_KEY = "masalapos.device-settings.v1";
const PAYMENT_STARTS = ["last", "cash", "card", "upi"];

/**
 * The last settings the main PC gave this device, kept in this browser so a page that loads while the main PC cannot
 * be reached still knows its printer and starting payment method. The main PC's answer always replaces it.
 */
export function readSavedDeviceSettings(): MyDeviceSettings {
  try {
    const saved = JSON.parse(localStorage.getItem(DEVICE_SETTINGS_KEY) ?? "null") as Partial<MyDeviceSettings> | null;
    const settings = saved?.settings;
    if (!saved || typeof saved.deviceId !== "string" || typeof saved.version !== "number" || !settings) return NO_DEVICE;
    if ((settings.billPrinterId !== null && typeof settings.billPrinterId !== "string") || !PAYMENT_STARTS.includes(settings.paymentStart)) return NO_DEVICE;
    return { deviceId: saved.deviceId, version: saved.version, printerInactive: saved.printerInactive === true,
      settings: { billPrinterId: settings.billPrinterId, paymentStart: settings.paymentStart } };
  } catch { return NO_DEVICE; }
}

export function saveDeviceSettings(value: MyDeviceSettings): void {
  try { localStorage.setItem(DEVICE_SETTINGS_KEY, JSON.stringify(value)); } catch { /* A browser without storage starts from the defaults next time. */ }
}

// The last answer any screen got, so a screen opened later starts from it and not from the defaults.
let lastLoaded: MyDeviceSettings | null = null;

/**
 * This device's settings, kept on the main PC and set by an administrator: its bill printer and the payment method a new
 * bill starts on. Reloaded when the main PC says devices changed and when the connection comes back; a load that fails
 * keeps the last values.
 */
export function useDeviceSettings(): MyDeviceSettings & { reload: () => Promise<void> } {
  const [value, setValue] = useState(() => (lastLoaded ??= readSavedDeviceSettings()));
  const reload = useCallback(async () => {
    try {
      const loaded = await apiFetch<MyDeviceSettings>("/api/devices/me/settings", { cache: "no-store" });
      lastLoaded = loaded;
      saveDeviceSettings(loaded);
      setValue(loaded);
    } catch { /* Keep the last known settings. */ }
  }, []);
  useEffect(() => {
    void reload();
    return connectWs({
      onEvent: (event) => { if (event === "devices.changed") void reload(); },
      onStatus: (connected) => { if (connected) void reload(); },
    });
  }, [reload]);
  return { ...value, reload };
}

/**
 * Loads this device's settings as soon as someone signs in, so the first bill already has them; renders nothing.
 */
export function DeviceSettingsSync() {
  useDeviceSettings();
  return null;
}

/**
 * What the Receipt printer picker shows: the cashier's choice for this bill, else the device's printer. "" is the
 * browser (A4) receipt, which is also what a printer that is no longer active shows as. `active` is null until the list
 * of active printers has loaded (it never does on a counter that is offline); until then the printer is taken as it is,
 * so a bill saved offline is not sent with "do not print".
 */
export function shownPrinter(choice: string | undefined, devicePrinterId: string | null, active: ReadonlyArray<{ id: string }> | null): string {
  const id = choice ?? devicePrinterId ?? "";
  return active === null || active.some((printer) => printer.id === id) ? id : "";
}

/**
 * The printer field of a bill or print request. The main PC uses the device's own printer when the field is left out,
 * so it is sent only when the cashier chose otherwise: a printer id, or null for no thermal print.
 */
export function printerField(shown: string, devicePrinterId: string | null): { printerId?: string | null } {
  if (shown === (devicePrinterId ?? "")) return {};
  return { printerId: shown || null };
}
