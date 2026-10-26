import { describe, expect, it } from "vitest";
import { configToDraft, draftToConfig, newDraft, newFilter, savedToDraft, withColumn, withGrouping } from "./custom-report";

describe("custom report draft", () => {
  it("starts every source with a runnable report", () => {
    for (const source of ["bills", "bill_items", "payments", "customers"]) expect(draftToConfig(newDraft(source)), source).toHaveProperty("config");
  });
  it("saves money filters in paise and reads them back in rupees", () => {
    const draft = { ...newDraft("bills"), filters: [{ field: "total", op: "gte" as const, text: "250.5" }, { field: "status", op: "ne" as const, text: "void" }] };
    const result = draftToConfig(draft);
    expect(result).toMatchObject({ config: { filters: [{ field: "total", op: "gte", value: 25050 }, { field: "status", op: "ne", value: "void" }] } });
    expect(configToDraft((result as { config: Parameters<typeof configToDraft>[0] }).config).filters).toEqual(draft.filters);
  });
  it("explains what is wrong instead of sending a bad definition", () => {
    expect(draftToConfig({ ...newDraft("bills"), columns: [] })).toEqual({ problem: "Pick at least one column" });
    expect(draftToConfig({ ...newDraft("bills"), filters: [{ field: "total", op: "gt", text: "abc" }] })).toEqual({ problem: "Total needs a number" });
    expect(draftToConfig({ ...newDraft("bills"), filters: [{ field: "status", op: "eq", text: " " }] })).toEqual({ problem: "Enter a value for the Status filter" });
    expect(draftToConfig({ ...newDraft("bills"), columns: [...newDraft("bills").columns, { field: "status", label: "" }] })).toEqual({ problem: "Status must be grouped by, or removed, because the report is grouped" });
  });
  it("groups and ungroups without duplicating a field, and starts a filter on a filterable column", () => {
    const grouped = withGrouping(newDraft("bills"), "date", true);
    expect(grouped.groupBy).toEqual(["date"]);
    expect(withGrouping(grouped, "date", false).groupBy).toEqual([]);
    expect(newFilter(newDraft("bills"))).toEqual({ field: "date", op: "eq", text: "" });
  });
  it("keeps the report runnable when grouping changes", () => {
    // Default Bills is grouped by date; grouping by order type as well keeps date, and both stay valid.
    const both = withGrouping(newDraft("bills"), "orderType", true);
    expect(both.columns.map((c) => c.field)).toEqual(["orderType", "date", "bills", "subtotal", "discount", "gst", "total"]);
    expect(draftToConfig(both)).toHaveProperty("config");
    // Grouping a detail report drops the descriptive columns that are not grouped by, and a sort on them.
    const detail = { ...newDraft("bills"), groupBy: [], columns: [{ field: "billNo", label: "" }, { field: "status", label: "" }, { field: "total", label: "" }], sort: { field: "billNo", dir: "asc" as const } };
    const byStatus = withGrouping(detail, "status", true);
    expect(byStatus.columns.map((c) => c.field)).toEqual(["status", "total"]);
    expect(byStatus.sort).toBeNull();
    expect(draftToConfig(byStatus)).toHaveProperty("config");
  });
  it("groups by a descriptive column ticked on a grouped report, and ungroups it when unticked", () => {
    const ticked = withColumn(newDraft("bills"), "orderType", true);
    expect(ticked.groupBy).toEqual(["date", "orderType"]);
    expect(draftToConfig(ticked)).toHaveProperty("config");
    const unticked = withColumn(ticked, "orderType", false);
    expect(unticked.groupBy).toEqual(["date"]);
    expect(unticked.columns.some((c) => c.field === "orderType")).toBe(false);
    expect(withColumn(newDraft("bills"), "cgst", true).columns.at(-1)).toEqual({ field: "cgst", label: "" });
    expect(withColumn(newDraft("bills"), "time", true)).toEqual(newDraft("bills"));
  });
  it("refuses to open a saved report that uses a column that no longer exists", () => {
    expect(savedToDraft({ source: "bills", columns: [{ field: "removedField" }], filters: [], groupBy: [] })).toMatchObject({ problem: expect.stringMatching(/no longer matches/) });
    expect(savedToDraft({ source: "gone" as never, columns: [{ field: "total" }], filters: [], groupBy: [] })).toHaveProperty("problem");
    expect(savedToDraft({ source: "bills", columns: [{ field: "total" }], filters: [], groupBy: [] })).toHaveProperty("draft");
  });
});
