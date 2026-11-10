import { describe, expect, it } from "vitest";
import type { DeviceEvent, DeviceInfo, JoinCodeIssued } from "@masalapos/domain/devices";
import {
  DEVICES_TABS, KIND_LABELS, billPrinterText, canAddNew, deviceBadges, devicesTabs, joinEvent, newestEventId, presenceText,
  slotsText, usedByText, withPresence,
} from "./devices-model";

const device = (over: Partial<DeviceInfo>): DeviceInfo => ({
  id: "d1", kind: "counter", name: "Counter", isMain: false, createdAt: 0, lastSeenAt: null, version: 1,
  current: false, allowed: true, online: false, settings: { billPrinterId: null, paymentStart: "last" }, printerInactive: false,
  ...over,
});

describe("the Devices card", () => {
  it("names its tabs and the kinds of device", () => {
    expect(DEVICES_TABS.map((tab) => tab.label)).toEqual(["Devices", "Printers", "Kitchen stations", "Print jobs"]);
    expect(KIND_LABELS).toEqual({ counter: "Billing counter", kitchen: "Kitchen display", captain: "Captain" });
  });
  it("shows each person the tabs they may use", () => {
    const can = (...slugs: string[]) => (slug: string) => slugs.includes(slug);
    expect(devicesTabs(can("settings.manage", "printers.read"))).toEqual(["devices", "printers", "stations", "jobs"]);
    expect(devicesTabs(can("printers.read"))).toEqual(["printers", "stations", "jobs"]);
    expect(devicesTabs(can("settings.manage"))).toEqual(["devices"]);
    expect(devicesTabs(can())).toEqual([]);
  });
  it("badges a device", () => {
    expect(deviceBadges(device({ isMain: true, current: true }), true)).toEqual(["Main", "This device"]);
    expect(deviceBadges(device({ allowed: false, printerInactive: true }), true)).toEqual(["Over limit", "Printer inactive"]);
    expect(deviceBadges(device({ allowed: false }), false)).toEqual([]);
  });
  it("says when a device was seen", () => {
    expect(presenceText(device({ online: true, lastSeenAt: 5 }))).toBe("Online");
    expect(presenceText(device({}))).toBe("Not seen yet");
    expect(presenceText(device({ lastSeenAt: Date.UTC(2026, 10, 10, 6, 30) }), "Asia/Kolkata")).toMatch(/^Last seen .*2026/);
  });
  it("counts slots only where there is a limit", () => {
    expect(slotsText({ devices: [device({}), device({})], maxDevices: 5 })).toBe("2 of 5 devices used");
    expect(slotsText({ devices: [device({})], maxDevices: null })).toBeNull();
  });
  it("names a device's bill printer", () => {
    const printers = [{ id: "p1", name: "Front" }];
    expect(billPrinterText(device({}), printers)).toBe("Browser / A4");
    expect(billPrinterText(device({ settings: { billPrinterId: "p1", paymentStart: "last" } }), printers)).toBe("Front");
    expect(billPrinterText(device({ settings: { billPrinterId: "gone", paymentStart: "last" }, printerInactive: true }), printers)).toBe("Printer inactive");
    expect(billPrinterText(device({ kind: "kitchen" }), printers)).toBe("—");
    // The printer list could not be read (the licence recovery screen): a working printer is not called inactive.
    expect(billPrinterText(device({ settings: { billPrinterId: "p1", paymentStart: "last" } }), [])).toBe("Thermal printer");
  });
  it("applies a presence change to one device", () => {
    const list = [device({ id: "a" }), device({ id: "b" })];
    expect(withPresence(list, { deviceId: "b", online: true }).map((d) => d.online)).toEqual([false, true]);
    expect(withPresence(list, { deviceId: "zz", online: true })).toEqual(list);
  });
  it("lists who prints to a printer", () => {
    expect(usedByText({ devices: ["Two"], stations: ["Grill", "Bar"] })).toBe("Two, Grill, Bar");
    expect(usedByText({ devices: [], stations: [] })).toBe("—");
  });
  it("allows a new device only while a slot is free", () => {
    expect(canAddNew({ devices: [device({})], maxDevices: 2 })).toEqual({ allowed: true, reason: "" });
    expect(canAddNew({ devices: [device({}), device({})], maxDevices: 2 })).toEqual({ allowed: false, reason: "Device limit reached. Remove an unused device or upgrade the plan. Replacing a device uses no extra slot." });
    expect(canAddNew({ devices: [device({}), device({})], maxDevices: null }).allowed).toBe(true);
  });
  it("knows the device a code was for has joined", () => {
    const event = (id: number, kind: DeviceEvent["kind"], deviceId: string): DeviceEvent => ({ id, kind, deviceId, occurredAt: 0, actorName: "Asha", summary: "" });
    const code = (replacesDeviceId: string | null): JoinCodeIssued => ({ code: "K7M2QP", expiresAt: 0, kind: "counter", name: "Two", replacesDeviceId, links: [], pairings: [] });
    const known = new Set(["a", "b"]);
    expect(newestEventId([event(9, "joined", "a"), event(4, "renamed", "a")])).toBe(9);
    expect(newestEventId([])).toBe(0);
    expect(joinEvent(code(null), [event(10, "joined", "c")], 9, known)?.deviceId).toBe("c");
    expect(joinEvent(code(null), [event(9, "joined", "c")], 9, known)).toBeNull();   // older than the code
    expect(joinEvent(code(null), [event(10, "joined", "b")], 9, known)).toBeNull();  // a device already there
    expect(joinEvent(code("b"), [event(10, "replaced", "b")], 9, known)?.id).toBe(10);
    // The device being replaced is renamed, or its settings change, while the dialog waits: that is not a join.
    expect(joinEvent(code("b"), [event(11, "renamed", "b"), event(10, "settings_changed", "b")], 9, known)).toBeNull();
    expect(joinEvent(code("b"), [event(10, "replaced", "a")], 9, known)).toBeNull();
  });
});
