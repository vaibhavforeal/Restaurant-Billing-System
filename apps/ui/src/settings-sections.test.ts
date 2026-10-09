import { describe, expect, it } from "vitest";
import { initialSettingsSection, SETTINGS_SECTIONS } from "./settings-sections";

describe("settings sections", () => {
  it("lists each section once with a title, icon and description", () => {
    const ids = SETTINGS_SECTIONS.map((section) => section.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(["profile", "printers", "stations", "jobs", "backups", "plan", "shortcuts"]);
    for (const section of SETTINGS_SECTIONS) {
      expect(section.title.trim()).not.toBe("");
      expect(section.blurb.trim()).not.toBe("");
      expect(section.icon).toBeTruthy();
    }
  });

  it("keeps the section names the Marketplace and e2e checks rely on", () => {
    const titles = SETTINGS_SECTIONS.map((section) => section.title);
    expect(titles).toContain("Backups & connections");
    expect(titles).toContain("Plan & devices");
  });

  it("opens on the card grid unless a section is requested", () => {
    expect(initialSettingsSection(undefined)).toBeNull();
    expect(initialSettingsSection("plan")).toBe("plan");
  });
});
