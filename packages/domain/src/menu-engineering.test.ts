import { describe, expect, it } from "vitest";
import type { ProfitLine } from "./costing.js";
import { buildMenuEngineeringReport, ENGINEERING_GROUPS } from "./menu-engineering.js";

/** `qty` plates of a dish at `price` and `cost` per plate (paise); `cost: null` is a dish whose cost is unknown, `"none"` one with no recipe. */
function line(categoryName: string, name: string, qty: number, price: number, cost: number | null | "none"): ProfitLine {
  return { categoryName, name, qty, revenuePaise: qty * price, costPaise: cost === "none" || cost === null ? (cost === null ? null : 0) : qty * cost, saleMoves: cost === "none" ? 0 : 1 };
}
const build = (lines: ProfitLine[]) => buildMenuEngineeringReport({ from: "2026-11-01", to: "2026-11-04", today: "2026-11-04", timezone: "Asia/Kolkata", generatedAt: 0, lines });
const table = (report: ReturnType<typeof build>, title: string) => report.tables.find((t) => t.title === title)!;
const byDish = (report: ReturnType<typeof build>, title: string) => Object.fromEntries(table(report, title).rows.map((row) => [row.dish, row]));

describe("buildMenuEngineeringReport", () => {
  // Mains: 80 plates over 4 costed dishes. Even share 25%, so high sellers need 17.5%.
  // Weighted average margin = (40×140 + 30×60 + 5×200 + 5×30) / 80 = 106.875 per plate.
  const mains = [
    line("Mains", "Biryani", 40, 200, 60),
    line("Mains", "Dal", 30, 150, 90),
    line("Mains", "Lobster", 5, 300, 100),
    line("Mains", "Khichdi", 5, 100, 70),
  ];

  it("sorts each dish into Star, Plowhorse, Puzzle or Dog within its category", () => {
    const report = build(mains);
    expect(report.kind).toBe("menu-engineering");
    const rows = byDish(report, "Mains");
    expect(rows.Biryani).toMatchObject({ plates: 40, share: 50, seller: "High", price: 200, cost: 60, margin: 140, group: "Star", action: "Keep as is and make it easy to find" });
    expect(rows.Dal).toMatchObject({ seller: "High", margin: 60, group: "Plowhorse", action: "Raise the price a little or lower its cost" });
    expect(rows.Lobster).toMatchObject({ seller: "Low", margin: 200, group: "Puzzle", action: "Promote it: menu position, staff push, photo" });
    expect(rows.Khichdi).toMatchObject({ seller: "Low", margin: 30, group: "Dog", action: "Rework or remove" });
    expect(table(report, "Mains").rows.map((row) => row.dish)).toEqual(["Biryani", "Dal", "Khichdi", "Lobster"]);
    expect(table(report, "Mains").totals).toMatchObject({ dish: "Category", plates: 80, share: 100, margin: 107 });
  });

  it("uses the 70% rule for sellers: a dish just under 70% of an even share is a low seller", () => {
    // 10 dishes, 100 plates: even share 10%, so 7 plates is high and 6 is low.
    const lines = [line("Snacks", "A", 6, 100, 50), line("Snacks", "B", 7, 100, 50),
      ...Array.from({ length: 8 }, (_, i) => line("Snacks", `F${i}`, i === 0 ? 17 : 10, 100, 50))];
    const rows = byDish(build(lines), "Snacks");
    expect(rows.A!.seller).toBe("Low");
    expect(rows.B!.seller).toBe("High");
  });

  it("does not group dishes without full recipe costs, but counts their plates for popularity", () => {
    const report = build([...mains, line("Mains", "Thali", 20, 250, "none"), line("Mains", "Kadhai", 4, 180, null),
      { ...line("Mains", "Pulao", 2, 120, 40) }, line("Mains", "Pulao", 1, 120, "none")]);
    const rows = byDish(report, "Mains");
    // 107 plates over 7 dishes: high sellers need 70% of 1/7 of them, about 10.7 plates.
    expect(rows.Thali).toMatchObject({ plates: 20, seller: "High", cost: null, margin: null, group: "Needs a recipe cost", action: "Add its recipe costs" });
    expect(rows.Kadhai).toMatchObject({ seller: "Low", group: "Needs a recipe cost" });
    expect(rows.Pulao).toMatchObject({ plates: 3, group: "Needs a recipe cost" });
    expect(rows.Dal).toMatchObject({ seller: "High", group: "Plowhorse" });
    // The average margin is still over costed dishes only.
    expect(table(report, "Mains").totals).toMatchObject({ plates: 107, margin: 107 });
    expect(report.notes).toContain("3 dishes need recipe costs (a recipe with every ingredient costed) before they can be grouped.");
  });

  it("ranks combos like any dish and nets credit notes off plates and revenue", () => {
    const report = build([line("Combos", "Thali combo", 10, 300, 120), line("Combos", "Mini meal", 10, 200, 150),
      line("Combos", "Mini meal", -2, 200, 0), line("Combos", "Gone", 1, 100, 50), line("Combos", "Gone", -1, 100, 0)]);
    const rows = byDish(report, "Combos");
    expect(rows["Mini meal"]).toMatchObject({ plates: 8, price: 200 });
    expect(rows.Gone).toBeUndefined();
    expect(rows["Thali combo"]!.group).toBe("Star");
    expect(report.notes.some((note) => /net of credit notes/.test(note))).toBe(true);
  });

  it("summarises each group and keeps categories in name order", () => {
    const report = build([...mains, line("Breads", "Naan", 10, 60, 15), line("Breads", "Roti", 10, 40, 10)]);
    expect(report.tables.map((t) => t.title)).toEqual(["Summary", "Breads", "Mains"]);
    const summary = Object.fromEntries(table(report, "Summary").rows.map((row) => [row.group, row]));
    expect(Object.keys(summary)).toEqual([...ENGINEERING_GROUPS]);
    expect(summary.Star).toMatchObject({ dishes: 2, plates: 50, revenue: 40 * 200 + 10 * 60 });
    expect(summary.Plowhorse).toMatchObject({ dishes: 2, plates: 40 });
    expect(summary["Needs a recipe cost"]).toMatchObject({ dishes: 0, plates: 0, revenue: 0 });
    expect(table(report, "Summary").totals).toMatchObject({ group: "All dishes", dishes: 6, plates: 100 });
  });

  it("says so when nothing was sold", () => {
    const report = build([]);
    expect(report.tables.map((t) => t.title)).toEqual(["Summary"]);
    expect(report.notes).toContain("No dishes were sold in these dates.");
  });
});
