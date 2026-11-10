import { describe, expect, it } from "vitest";
import { DeviceRename, DeviceSettingsPatch, JoinCodeCreate, deviceSettings, normalizeJoinCode } from "./devices.js";

describe("device join codes", () => {
  it("normalises a typed join code", () => {
    expect(normalizeJoinCode("k7m 2qp")).toBe("K7M2QP");
    expect(normalizeJoinCode(" K7M-2QP ")).toBe("K7M2QP");
    for (const bad of ["K7M2Q", "K7M2QPX", "K7M2Q0", "K7M2QO", "K7M2QI", "K7M2QL", "K7M2Q1", "", null, 123456]) expect(normalizeJoinCode(bad)).toBeNull();
  });
  it("accepts a new device or a replacement, not both", () => {
    expect(JoinCodeCreate.parse({ kind: "kitchen", name: "  Pass  " })).toEqual({ kind: "kitchen", name: "Pass" });
    expect(JoinCodeCreate.safeParse({ replacesDeviceId: crypto.randomUUID() }).success).toBe(true);
    for (const bad of [{ kind: "display", name: "X" }, { kind: "counter", name: " " }, { kind: "counter", name: "x".repeat(81) },
      { kind: "counter", name: "X", replacesDeviceId: crypto.randomUUID() }, {}]) expect(JoinCodeCreate.safeParse(bad).success).toBe(false);
  });
});

describe("device settings", () => {
  it("fills defaults for missing, unknown and unreadable values", () => {
    expect(deviceSettings({})).toEqual({ billPrinterId: null, paymentStart: "last" });
    expect(deviceSettings(null)).toEqual({ billPrinterId: null, paymentStart: "last" });
    expect(deviceSettings({ billPrinterId: "p1", paymentStart: "upi", x: 1 })).toEqual({ billPrinterId: "p1", paymentStart: "upi" });
    expect(deviceSettings({ billPrinterId: 7, paymentStart: "wallet" })).toEqual({ billPrinterId: null, paymentStart: "last" });
  });
  it("a patch needs a version and takes only known keys", () => {
    expect(DeviceSettingsPatch.parse({ version: 2, paymentStart: "cash" })).toEqual({ version: 2, paymentStart: "cash" });
    expect(DeviceSettingsPatch.parse({ version: 2, billPrinterId: null })).toEqual({ version: 2, billPrinterId: null });
    expect(DeviceSettingsPatch.safeParse({ paymentStart: "cash" }).success).toBe(false);
    expect(DeviceSettingsPatch.safeParse({ version: 1, theme: "dark" }).success).toBe(false);
    expect(DeviceSettingsPatch.safeParse({ version: 1, paymentStart: "wallet" }).success).toBe(false);
  });
});

describe("renaming a device", () => {
  it("trims the name and needs a version", () => {
    expect(DeviceRename.parse({ name: "  Bar ", version: 2 })).toEqual({ name: "Bar", version: 2 });
    expect(DeviceRename.safeParse({ name: " ", version: 2 }).success).toBe(false);
    expect(DeviceRename.safeParse({ name: "Bar" }).success).toBe(false);
    expect(DeviceRename.safeParse({ name: "Bar", version: 2, kind: "kitchen" }).success).toBe(false);
  });
});
