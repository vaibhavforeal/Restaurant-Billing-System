import { useCallback, useEffect, useState } from "react";
import type { MyDeviceSettings } from "@masalapos/domain/devices";
import { apiFetch } from "./api";
import { connectWs } from "./ws";

/** What a browser that is not one of the restaurant's devices works with: the browser receipt, and the method used last. */
export const NO_DEVICE: MyDeviceSettings = { deviceId: null, version: null, settings: { billPrinterId: null, paymentStart: "last" } };

// The last answer any screen got, so a screen opened later starts from it and not from the defaults.
let lastLoaded = NO_DEVICE;

/**
 * This device's settings, kept on the main PC and set by an administrator: its bill printer and the payment method a new
 * bill starts on. Reloaded when the main PC says devices changed and when the connection comes back; a load that fails
 * keeps the last values.
 */
export function useDeviceSettings(): MyDeviceSettings & { reload: () => Promise<void> } {
  const [value, setValue] = useState(lastLoaded);
  const reload = useCallback(async () => {
    try {
      lastLoaded = await apiFetch<MyDeviceSettings>("/api/devices/me/settings", { cache: "no-store" });
      setValue(lastLoaded);
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
