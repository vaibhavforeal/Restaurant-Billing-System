import { expect, it } from "vitest";
import type { OperationalReport } from "@forkflow/domain";
import { operationalCsv, operationalCell } from "./operational-report";

it("exports the loaded report with rupee precision, safe text, negative numeric quantities and metadata", () => {
  const report: OperationalReport = { kind: "stock", from: "2026-09-27", to: "2026-09-29", today: "2026-09-29", timezone: "Asia/Kolkata", generatedAt: 0, notes: ["No mixed-unit totals"], tables: [{ title: "Details", columns: [{ key: "name", label: "Item" }, { key: "value", label: "Value", format: "money" }, { key: "qty", label: "Change", format: "quantity" }], rows: [{ name: '=HYPERLINK("bad")', value: 12345, qty: -0.125 }] }] };
  const csv = operationalCsv(report);
  expect(csv).toContain('"\'=HYPERLINK(""bad"")"'); expect(csv).toContain('"123.45","-0.125"');
  expect(csv).toContain('"Value INR"'); expect(csv).toContain('"Server timezone","Asia/Kolkata"');
});
it("formats timestamps in the server timezone and preserves absent durations", () => {
  expect(operationalCell(Date.UTC(2026, 8, 27, 0), { key: "time", label: "Time", format: "time" }, "Asia/Kolkata")).toContain("05:30:00");
  expect(operationalCell(null, { key: "time", label: "Time", format: "minutes" }, "UTC")).toBe("—");
});
it("formats percent columns with one decimal on screen and in CSV, keeping null empty", () => {
  const column = { key: "p", label: "Food cost", format: "percent" } as const;
  expect(operationalCell(48, column, "UTC")).toBe("48.0%");
  expect(operationalCell(48, column, "UTC", true)).toBe("48.0");
  expect(operationalCell(null, column, "UTC", true)).toBe("");
  expect(operationalCell(null, column, "UTC")).toBe("—");
});
it("labels percent CSV headers with a percent sign and writes a plain number", () => {
  const report = { kind: "profit", from: "2026-09-27", to: "2026-09-29", today: "2026-09-29", timezone: "UTC", generatedAt: 0, notes: [], tables: [{ title: "Summary", columns: [{ key: "n", label: "Metric" }, { key: "p", label: "Food cost", format: "percent" as const }], rows: [{ n: "All", p: 48 }, { n: "Unknown", p: null }] }] };
  const csv = operationalCsv(report);
  expect(csv).toContain('"Food cost %"'); expect(csv).toContain('"All","48.0"'); expect(csv).toContain('"Unknown",""');
});
it("does not repeat the percent sign on headers that already say percent", () => {
  const report = { kind: "profit", from: "2026-09-27", to: "2026-09-29", today: "2026-09-29", timezone: "UTC", generatedAt: 0, notes: [], tables: [{ title: "Summary", columns: [{ key: "n", label: "Metric" }, { key: "a", label: "Food cost %", format: "percent" as const }, { key: "b", label: "Percent", format: "percent" as const }], rows: [{ n: "All", a: 48, b: 12.5 }] }] };
  const header = operationalCsv(report).split("\r\n").find((line) => line.startsWith('"Metric"'));
  expect(header).toBe('"Metric","Food cost %","Percent"');
});
