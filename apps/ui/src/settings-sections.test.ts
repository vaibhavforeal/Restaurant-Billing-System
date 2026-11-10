import { describe, expect, it } from "vitest";
import { initialSettingsSection, SETTINGS_SECTIONS, visibleSettingsSections } from "./settings-sections";

describe("settings sections", () => {
  it("lists each section once with a title, icon and description", () => {
    const ids = SETTINGS_SECTIONS.map((section) => section.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(["profile", "bill", "discounts", "loyalty", "tables", "ai-suggestions", "order-types", "devices", "device", "backups", "plan", "updates", "shortcuts", "support"]);
    for (const section of SETTINGS_SECTIONS) {
      expect(section.title.trim()).not.toBe("");
      expect(section.blurb.trim()).not.toBe("");
      expect(section.icon).toBeTruthy();
    }
  });

  it("names the cards as the Devices area left them", () => {
    const titles = SETTINGS_SECTIONS.map((section) => section.title);
    expect(titles).toContain("Devices");
    expect(titles).toContain("Backups");
    expect(titles).not.toContain("Backups & connections");
  });

  it("opens on the card grid unless a section is requested", () => {
    expect(initialSettingsSection(undefined)).toBeNull();
    expect(initialSettingsSection("plan")).toBe("plan");
    expect(initialSettingsSection("loyalty")).toBe("loyalty");
  });

  it("hides Tables without table rights and Loyalty while the CRM add-on is off", () => {
    const ids = (canManageTables: boolean, crmActive: boolean) =>
      visibleSettingsSections({ canManageSettings: true, canReadPrinters: true, canManageTables, crmActive }).map((s) => s.id);
    expect(ids(true, true)).toEqual(SETTINGS_SECTIONS.map((s) => s.id));
    expect(ids(false, true)).not.toContain("tables");
    expect(ids(true, false)).not.toContain("loyalty");
    expect(ids(true, false)).toContain("discounts");
  });

  it("shows only Devices to someone who can see printers but not manage settings", () => {
    const ids = (canManageSettings: boolean, canReadPrinters: boolean) =>
      visibleSettingsSections({ canManageSettings, canReadPrinters, canManageTables: true, crmActive: true }).map((s) => s.id);
    expect(ids(false, true)).toEqual(["devices"]);
    expect(ids(false, false)).toEqual([]);
    expect(ids(true, false)).toContain("devices");
    expect(ids(true, false)).toContain("profile");
  });
});
