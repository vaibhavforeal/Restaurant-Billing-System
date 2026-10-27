import { describe, expect, it } from "vitest";
import { formatOccasion, joinOccasion, occasionNote, parseTags, splitOccasion, stars } from "./crm";

describe("CRM helpers", () => {
  it("formats and edits birthdays with or without a year", () => {
    expect(formatOccasion("1990-03-14")).toBe("14 Mar 1990");
    expect(formatOccasion("--11-02")).toBe("2 Nov");
    expect(splitOccasion("1990-03-14")).toEqual({ day: "03-14", year: "1990" });
    expect(splitOccasion("--03-14")).toEqual({ day: "03-14", year: "" });
    expect(joinOccasion("03-14", "1990")).toBe("1990-03-14");
    expect(joinOccasion("03-14", "")).toBe("--03-14");
    expect(joinOccasion("", "1990")).toBe("");
  });

  it("notes birthdays and anniversaries close to today", () => {
    expect(occasionNote({ birthDate: "--10-27", anniversaryDate: null }, "2026-10-27")).toBe("Birthday today");
    expect(occasionNote({ birthDate: "--10-29", anniversaryDate: "2019-10-26" }, "2026-10-27")).toBe("Birthday in 2 days · Anniversary 1 day ago");
    expect(occasionNote({ birthDate: "--12-01", anniversaryDate: null }, "2026-10-27")).toBeNull();
  });

  it("draws star ratings and splits tags", () => {
    expect(stars(4)).toBe("★★★★☆");
    expect(parseTags(" Vegan, ,VIP ")).toEqual(["Vegan", "VIP"]);
  });
});
