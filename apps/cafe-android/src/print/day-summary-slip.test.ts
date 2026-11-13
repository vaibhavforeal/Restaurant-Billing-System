import { describe, expect, it } from "vitest";
import { daySummary } from "@masalapos/cafe-data";
import { DEFAULT_PROFILE, renderBytes } from "@masalapos/print";
import { threeBillDay } from "../../../../packages/cafe-data/src/testing/fixtures";
import { daySummarySlip } from "./day-summary-slip";

describe("daySummarySlip", () => {
  it("prints the day's totals, payment modes, tax, items and voids", () => {
    const summary = daySummary(threeBillDay().db, "2026-11-13");
    const text = renderBytes(daySummarySlip(summary, "Chai Point", 58, DEFAULT_PROFILE));
    for (const part of ["Chai Point", "DAY SUMMARY", "13 Nov 2026", "Bills", "2", "Net sales", "96.00", "Cash", "76.00", "UPI", "20.00", "Card", "0.00",
      "Discounts", "5.00", "Samosa", "Cookie", "Voids", "CPA/26-27/0003"]) expect(text).toContain(part);
    for (const line of text.split("\n")) expect(line.replace(/<[0-9A-F]{2}>/g, "").length).toBeLessThanOrEqual(32);
  });
});
