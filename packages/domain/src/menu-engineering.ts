import type { ProfitLine } from "./costing.js";
import type { OperationalReport, ReportCell, ReportColumn, ReportTable } from "./operational-reports.js";

export const ENGINEERING_GROUPS = ["Star", "Plowhorse", "Puzzle", "Dog", "Needs a recipe cost"] as const;
export type EngineeringGroup = typeof ENGINEERING_GROUPS[number];
export type MenuEngineeringReport = Omit<OperationalReport, "kind"> & { kind: "menu-engineering" };

const ACTIONS: Record<EngineeringGroup, string> = {
  Star: "Keep as is and make it easy to find",
  Plowhorse: "Raise the price a little or lower its cost",
  Puzzle: "Promote it: menu position, staff push, photo",
  Dog: "Rework or remove",
  "Needs a recipe cost": "Add its recipe costs",
};

interface Dish { category: string; name: string; plates: number; revenue: number; cost: number; costed: boolean }

const column = (key: string, label: string, format?: ReportColumn["format"]): ReportColumn => format ? { key, label, format } : { key, label };
const perPlate = (paise: number, plates: number) => Math.round(paise / plates);

/** Adds up a dish's lines (sales and credit notes). It is costed only if every line had a full recipe cost. */
function dishes(lines: ProfitLine[]): Dish[] {
  const byKey = new Map<string, Dish>();
  for (const line of lines) {
    const key = `${line.categoryName}\u0000${line.name}`;
    const dish = byKey.get(key) ?? { category: line.categoryName, name: line.name, plates: 0, revenue: 0, cost: 0, costed: true };
    dish.plates += line.qty; dish.revenue += line.revenuePaise;
    if (line.saleMoves === 0 || line.costPaise === null) dish.costed = false;
    else dish.cost += line.costPaise;
    byKey.set(key, dish);
  }
  return [...byKey.values()].filter((dish) => dish.plates > 0);
}

/**
 * Menu engineering: each dish compared with its own category on popularity and margin per plate.
 * - High seller: its share of the category's plates is at least 70% of an even share (the usual menu-engineering rule).
 * - High margin: margin per plate (pre-GST price minus the food cost recorded at sale) at or above the category's
 *   average, weighted by plates, over fully costed dishes.
 * Star = high/high, Plowhorse = high seller/low margin, Puzzle = low seller/high margin, Dog = low/low. A dish without
 * a full recipe cost is not guessed into a group. Lines come from the profit report's query, so combos rank as dishes.
 */
export function buildMenuEngineeringReport(input: {
  from: string; to: string; today: string; timezone: string; generatedAt: number; lines: ProfitLine[];
}): MenuEngineeringReport {
  const all = dishes(input.lines);
  const summary = new Map<EngineeringGroup, { dishes: number; plates: number; revenue: number }>(ENGINEERING_GROUPS.map((g) => [g, { dishes: 0, plates: 0, revenue: 0 }]));
  const categoryTables: ReportTable[] = [];
  const categories = [...new Set(all.map((dish) => dish.category))].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
  for (const category of categories) {
    const inCategory = all.filter((dish) => dish.category === category).sort((a, b) => b.plates - a.plates || a.name.localeCompare(b.name));
    const plates = inCategory.reduce((sum, dish) => sum + dish.plates, 0);
    const costed = inCategory.filter((dish) => dish.costed);
    const costedPlates = costed.reduce((sum, dish) => sum + dish.plates, 0);
    const averageMargin = costedPlates ? costed.reduce((sum, dish) => sum + dish.revenue - dish.cost, 0) / costedPlates : null;
    const rows = inCategory.map((dish): Record<string, ReportCell> => {
      // plates / total >= 0.7 × (1 / dishes), kept in whole numbers so the boundary is exact.
      const highSeller = dish.plates * inCategory.length * 10 >= 7 * plates;
      const margin = dish.costed ? (dish.revenue - dish.cost) / dish.plates : null;
      const group: EngineeringGroup = margin === null || averageMargin === null ? "Needs a recipe cost"
        : highSeller ? (margin >= averageMargin ? "Star" : "Plowhorse") : (margin >= averageMargin ? "Puzzle" : "Dog");
      const totals = summary.get(group)!;
      totals.dishes++; totals.plates += dish.plates; totals.revenue += dish.revenue;
      return {
        dish: dish.name, plates: dish.plates, share: Math.round(dish.plates * 1000 / plates) / 10, seller: highSeller ? "High" : "Low",
        price: perPlate(dish.revenue, dish.plates), cost: dish.costed ? perPlate(dish.cost, dish.plates) : null,
        margin: margin === null ? null : Math.round(margin), group, action: ACTIONS[group],
      };
    });
    categoryTables.push({
      title: category,
      columns: [column("dish", "Dish"), column("plates", "Plates sold", "quantity"), column("share", "Share of category", "percent"), column("seller", "Sells"),
        column("price", "Price per plate", "money"), column("cost", "Food cost per plate", "money"), column("margin", "Margin per plate", "money"),
        column("group", "Group"), column("action", "Suggested action")],
      rows,
      totals: { dish: "Category", plates, share: 100, seller: null, price: null, cost: null, margin: averageMargin === null ? null : Math.round(averageMargin), group: null, action: null },
    });
  }
  const summaryRows = ENGINEERING_GROUPS.map((group) => ({ group, ...summary.get(group)! }));
  const summaryTable: ReportTable = {
    title: "Summary",
    columns: [column("group", "Group"), column("dishes", "Dishes", "quantity"), column("plates", "Plates sold", "quantity"), column("revenue", "Revenue (pre-GST)", "money")],
    rows: summaryRows,
    totals: { group: "All dishes", dishes: all.length, plates: summaryRows.reduce((s, r) => s + r.plates, 0), revenue: summaryRows.reduce((s, r) => s + r.revenue, 0) },
  };
  const needsCost = summary.get("Needs a recipe cost")!.dishes;
  const notes = all.length ? [
    "Each dish is compared with its own category. High seller: at least 70% of an even share of the category's plates (with 10 dishes, 7%). High margin: margin per plate at or above the category's average, weighted by plates sold, over fully costed dishes.",
    "Prices, food costs and margins are per plate and before GST; food cost is what the recipe's stock cost when the dish was sold.",
  ] : ["No dishes were sold in these dates."];
  if (needsCost) notes.push(`${needsCost} dish${needsCost === 1 ? " needs" : "es need"} recipe costs (a recipe with every ingredient costed) before ${needsCost === 1 ? "it" : "they"} can be grouped.`);
  if (input.lines.some((line) => line.qty < 0)) notes.push("Plates and revenue are net of credit notes (voids and refunds) made in these dates.");
  return { kind: "menu-engineering", from: input.from, to: input.to, today: input.today, timezone: input.timezone, generatedAt: input.generatedAt, notes, tables: [summaryTable, ...categoryTables] };
}
