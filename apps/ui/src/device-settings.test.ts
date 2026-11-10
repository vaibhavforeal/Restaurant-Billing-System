import { beforeEach, describe, expect, it } from "vitest";
import { DEVICE_SETTINGS_KEY, NO_DEVICE, printerField, readSavedDeviceSettings, saveDeviceSettings, shownPrinter } from "./device-settings";

describe("the last settings the main PC gave this device", () => {
  const store = new Map<string, string>();
  beforeEach(() => {
    store.clear();
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => { store.set(key, value); },
      removeItem: (key: string) => { store.delete(key); },
    } });
  });
  const loaded = { deviceId: "d1", version: 4, printerInactive: false, settings: { billPrinterId: "front", paymentStart: "upi" as const } };

  it("are kept in this browser, for a page that loads while the main PC cannot be reached", () => {
    expect(readSavedDeviceSettings()).toEqual(NO_DEVICE);
    saveDeviceSettings(loaded);
    expect(readSavedDeviceSettings()).toEqual(loaded);
    expect(DEVICE_SETTINGS_KEY).toBe("masalapos.device-settings.v1");
  });
  it("fall back to no device when what is stored cannot be read", () => {
    for (const bad of ["not json", "null", "[]", JSON.stringify({ deviceId: 7 }), JSON.stringify({ deviceId: "d1", version: 1, settings: { billPrinterId: 5, paymentStart: "wallet" } })]) {
      store.set(DEVICE_SETTINGS_KEY, bad);
      expect(readSavedDeviceSettings()).toEqual(NO_DEVICE);
    }
  });
  it("read as no device where the browser has no storage", () => {
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } } });
    expect(() => saveDeviceSettings(loaded)).not.toThrow();
    expect(readSavedDeviceSettings()).toEqual(NO_DEVICE);
  });
});

const active = [{ id: "front" }, { id: "back" }];

describe("the receipt printer picker", () => {
  it("shows the device's printer until the cashier picks another", () => {
    expect(shownPrinter(undefined, "front", active)).toBe("front");
    expect(shownPrinter(undefined, null, active)).toBe("");
    expect(shownPrinter("back", "front", active)).toBe("back");
    expect(shownPrinter("", "front", active)).toBe("");
  });
  it("shows Browser / A4 for a printer that is not active", () => {
    expect(shownPrinter(undefined, "gone", active)).toBe("");
    expect(shownPrinter("gone", "front", active)).toBe("");
  });
  it("keeps the printer while the list of active printers has not loaded", () => {
    expect(shownPrinter(undefined, "front", null)).toBe("front");
    expect(shownPrinter("back", "front", null)).toBe("back");
    expect(shownPrinter(undefined, null, null)).toBe("");
  });
});

describe("the printer sent with a request", () => {
  it("is left out when it is the device's own", () => {
    expect(printerField("front", "front")).toEqual({});
    expect(printerField("", null)).toEqual({});
  });
  it("is named when the cashier picked another, and null for Browser / A4", () => {
    expect(printerField("back", "front")).toEqual({ printerId: "back" });
    expect(printerField("", "front")).toEqual({ printerId: null });
    expect(printerField("front", null)).toEqual({ printerId: "front" });
  });
});
