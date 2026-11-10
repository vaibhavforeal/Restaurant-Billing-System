import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (file: string) => readFileSync(new URL(`./${file}`, import.meta.url), "utf8");

/** Everything Settings → Devices is drawn with. It must follow the theme, so nothing here sets a colour or an inline style. */
const FILES = ["screens/DevicesSettings.tsx", "screens/PrintersTab.tsx", "screens/StationsTab.tsx", "screens/PrintJobsTab.tsx", "screens/PrinterControls.tsx", "screens/DevicesTab.tsx", "screens/DeviceDialog.tsx", "screens/AddDeviceDialog.tsx", "screens/ConnectionHelp.tsx", "devices.css", "printer-settings.css"];

describe("Settings → Devices", () => {
  it.each(FILES)("%s has no inline styles and no hard-coded colours", (file) => {
    const source = read(file);
    expect(source).not.toMatch(/style=\{/);
    expect(source).not.toMatch(/#[0-9a-fA-F]{3,8}\b|\b(crimson|green|red)\b|rgba?\(/);
  });
  it("Settings no longer holds the printer markup", () => {
    expect(read("screens/Settings.tsx")).not.toMatch(/api\/printers|kot-stations|print-jobs/);
  });
  it("the Printers tab says where printers must be", () => {
    expect(read("screens/PrintersTab.tsx")).toContain("Printers must be reachable from the main PC: on the network, installed in Windows on the main PC, or paired to it by Bluetooth.");
  });
  it("Backups no longer explains how to connect devices", () => {
    expect(read("screens/SystemSettings.tsx")).not.toMatch(/system\/connections|Connect your team/);
  });
});
