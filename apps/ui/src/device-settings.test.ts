import { describe, expect, it } from "vitest";
import { printerField, shownPrinter } from "./device-settings";

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
