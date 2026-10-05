import { describe, expect, it } from "vitest";
import { blendUnitCost, moveCostPaise, preGstPaise, dishCost, buildProfitReport, type ProfitLine } from "./costing.js";

describe("weighted-average costing", () => {
  it("blends deliveries into a weighted average", () => {
    expect(blendUnitCost(10_000, 30_000_000, 10_000, 340_000)).toBe(32_000_000); // 10 kg @₹300 + 10 kg for ₹3,400 → ₹320/kg
  });
  it("starts fresh when stock was at or below zero, or cost unknown", () => {
    expect(blendUnitCost(-2_000, 30_000_000, 5_000, 200_000)).toBe(40_000_000);
    expect(blendUnitCost(0, 30_000_000, 5_000, 200_000)).toBe(40_000_000);
    expect(blendUnitCost(5_000, null, 5_000, 200_000)).toBe(40_000_000);
  });
  it("keeps cheap units precise", () => {
    expect(blendUnitCost(0, null, 100_000, 234)).toBe(2_340); // 100 ml for ₹2.34 → 2.34 paise/ml
    expect(moveCostPaise(-250_000, 2_340)).toBe(-585); // 250 ml used
  });
  it("handles large values without overflow", () => {
    expect(blendUnitCost(1_000_000_000, 100_000_000_000, 1_000_000_000, 1_000_000_000)).toBe(50_000_500_000); // (1e20 + 1e15) / 2e9
  });
  it("rejects a non-positive delivery quantity", () => {
    expect(() => blendUnitCost(0, null, 0, 100)).toThrow();
    expect(() => blendUnitCost(5_000, 100, -1, 100)).toThrow();
  });
  it("rounds half away from zero", () => {
    expect(blendUnitCost(0, null, 2_000_000, 3)).toBe(2); // 1.5 → 2
    expect(moveCostPaise(1, 1_500_000)).toBe(2); // 1.5 → 2
    expect(moveCostPaise(-1, 1_500_000)).toBe(-2); // -1.5 → -2
  });
  it("values movements and treats unknown cost as null", () => {
    expect(moveCostPaise(-1_500, 32_000_000)).toBe(-48_000);
    expect(moveCostPaise(-1, 1_500)).toBe(0); // rounds to zero; normalise -0 to 0
    expect(moveCostPaise(-1_500, null)).toBeNull();
  });
  it("converts tax-inclusive prices to pre-GST", () => {
    expect(preGstPaise(10_500, 5, true)).toBe(10_000);
    expect(preGstPaise(10_500, 5, false)).toBe(10_500);
    expect(preGstPaise(9_900, 0, true)).toBe(9_900);
  });
  it("costs a dish and flags missing ingredients", () => {
    expect(dishCost([])).toEqual({ costPaise: null, status: "no_recipe", missing: [] });
    expect(dishCost([{ stockName: "Paneer", qtyPerSale: 0.15, unitCostMilliPaise: 32_000_000 }, { stockName: "Oil", qtyPerSale: 20, unitCostMilliPaise: 150 }]))
      .toEqual({ costPaise: 4_803, status: "complete", missing: [] });
    expect(dishCost([{ stockName: "Paneer", qtyPerSale: 0.15, unitCostMilliPaise: 32_000_000 }, { stockName: "Cream", qtyPerSale: 0.05, unitCostMilliPaise: null }]))
      .toEqual({ costPaise: null, status: "incomplete", missing: ["Cream"] });
  });
});

describe("profit report", () => {
  const base = { from: "2026-10-01", to: "2026-10-05", today: "2026-10-05", timezone: "Asia/Kolkata", generatedAt: 1 };
  const none = { costPaise: 0, unknownCount: 0 };
  const lines: ProfitLine[] = [
    { categoryName: "Mains", name: "Paneer Tikka", qty: 2, revenuePaise: 10_000, costPaise: 4_800, saleMoves: 2 },
    { categoryName: "Mains", name: "Dal", qty: 1, revenuePaise: 5_000, costPaise: null, saleMoves: 1 },
    { categoryName: "Drinks", name: "Water", qty: 1, revenuePaise: 2_000, costPaise: null, saleMoves: 0 },
  ];
  const summary = (report: ReturnType<typeof buildProfitReport>) =>
    Object.fromEntries(report.tables[0]!.rows.map((row) => [row.metric, row]));

  it("builds profit totals, statuses and notes", () => {
    const report = buildProfitReport({ ...base, lines, wastage: { costPaise: 1_000, unknownCount: 0 }, adjustments: none });
    expect(report).toMatchObject({ kind: "profit", from: "2026-10-01", to: "2026-10-05", today: "2026-10-05", timezone: "Asia/Kolkata", generatedAt: 1 });
    expect(report.tables.map((t) => t.title)).toEqual(["Summary", "By category", "By dish"]);
    const s = summary(report);
    expect(Object.keys(s)).toEqual(["Revenue (pre-GST)", "Costed revenue", "Ingredient cost", "Gross profit", "Food cost %", "Wastage cost", "Count adjustments (net)", "Excluded: cost unknown", "Excluded: no recipe"]);
    expect(s["Revenue (pre-GST)"]!.amount).toBe(17_000);
    expect(s["Costed revenue"]!.amount).toBe(10_000);
    expect(s["Ingredient cost"]!.amount).toBe(4_800);
    expect(s["Gross profit"]!.amount).toBe(5_200);
    expect(s["Food cost %"]).toMatchObject({ amount: null, percent: 48 });
    expect(s["Wastage cost"]!.amount).toBe(1_000);
    expect(s["Excluded: cost unknown"]!.amount).toBe(5_000);
    expect(s["Excluded: no recipe"]!.amount).toBe(2_000);
    expect(report.tables[0]!.columns.map((c) => [c.key, c.format])).toEqual([["metric", undefined], ["amount", "money"], ["percent", "percent"]]);
    expect(report.notes).toContain("Revenue is bill taxable value after discount, excluding GST, by bill issue date.");
    expect(report.notes.some((n) => /cost is unknown/.test(n) && /no recipe/.test(n))).toBe(true);
    expect(report.notes).toContain("Sales before costing was set up have no recorded cost.");
    expect(report.tables[1]!.columns.map((c) => c.key)).toEqual(["name", "qty", "revenue", "costedRevenue", "cost", "profit", "costPercent", "status"]);
    expect(report.tables[2]!.columns.map((c) => c.key)).toEqual(["category", "name", "qty", "revenue", "costedRevenue", "cost", "profit", "costPercent", "status"]);
    expect(report.tables[2]!.columns.find((c) => c.key === "costPercent")!.format).toBe("percent");
    for (const table of report.tables.slice(1)) expect(table.columns.find((c) => c.key === "costedRevenue")).toEqual({ key: "costedRevenue", label: "Costed revenue", format: "money" });
    expect(report.tables[2]!.columns[0]).toEqual({ key: "category", label: "Category" });
  });

  it("breaks revenue down by category and dish with a status per row", () => {
    const report = buildProfitReport({ ...base, lines, wastage: none, adjustments: none });
    const dishes = Object.fromEntries(report.tables[2]!.rows.map((r) => [r.name, r]));
    expect(dishes["Paneer Tikka"]).toMatchObject({ category: "Mains", qty: 2, revenue: 10_000, costedRevenue: 10_000, cost: 4_800, profit: 5_200, costPercent: 48, status: "Costed" });
    expect(dishes["Dal"]).toMatchObject({ category: "Mains", revenue: 5_000, costedRevenue: null, cost: null, profit: null, costPercent: null, status: "Cost unknown" });
    expect(dishes["Water"]).toMatchObject({ category: "Drinks", revenue: 2_000, costedRevenue: null, cost: null, status: "No recipe" });
    const categories = Object.fromEntries(report.tables[1]!.rows.map((r) => [r.name, r]));
    // Revenue stays the full total; profit reconciles against costed revenue (10,000 − 4,800 = 5,200).
    expect(categories["Mains"]).toMatchObject({ qty: 3, revenue: 15_000, costedRevenue: 10_000, cost: 4_800, profit: 5_200, costPercent: 48, status: "1 costed, 1 cost unknown" });
    for (const row of [...report.tables[1]!.rows, ...report.tables[2]!.rows]) {
      if (row.cost !== null) expect((row.costedRevenue as number) - (row.cost as number)).toBe(row.profit);
    }
    expect(categories["Drinks"]).toMatchObject({ status: "No recipe" });
  });

  it("keeps same-named dishes in different categories apart", () => {
    const report = buildProfitReport({ ...base, wastage: none, adjustments: none, lines: [
      { categoryName: "Lunch", name: "Thali", qty: 1, revenuePaise: 20_000, costPaise: 8_000, saleMoves: 1 },
      { categoryName: "Dinner", name: "Thali", qty: 1, revenuePaise: 30_000, costPaise: 9_000, saleMoves: 1 },
    ] });
    expect(report.tables[2]!.rows.map((r) => [r.category, r.name, r.revenue])).toEqual([["Lunch", "Thali", 20_000], ["Dinner", "Thali", 30_000]]);
  });

  it("stays quiet when everything is costed and reports unknown wastage and adjustments", () => {
    const quiet = buildProfitReport({ ...base, lines: [lines[0]!], wastage: none, adjustments: none });
    expect(quiet.notes).toEqual(["Revenue is bill taxable value after discount, excluding GST, by bill issue date."]);
    const noisy = buildProfitReport({ ...base, lines: [], wastage: { costPaise: 0, unknownCount: 2 }, adjustments: { costPaise: -300, unknownCount: 1 } });
    expect(noisy.notes.some((n) => /2 wastage movements/.test(n))).toBe(true);
    expect(noisy.notes.some((n) => /1 count adjustment/.test(n))).toBe(true);
    expect(summary(noisy)["Food cost %"]).toMatchObject({ percent: null });
    expect(summary(noisy)["Count adjustments (net)"]!.amount).toBe(-300);
  });
});
