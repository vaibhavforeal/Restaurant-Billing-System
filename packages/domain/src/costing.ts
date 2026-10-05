import { stockMilli, type StockUnit } from "./stock-schemas.js";
import type { PriceTier } from "./pricing.js";
import type { OperationalReport, ReportCell, ReportColumn, ReportTable } from "./operational-reports.js";

/**
 * Weighted-average costing arithmetic. Costs are integer milli-paise (thousandths of a paise)
 * per one unit of an item's own unit; movement values are whole paise. All rounding is half
 * away from zero, with BigInt intermediates so large stock * cost products stay exact.
 */

const MILLI = 1_000_000n;

export interface StockCost {
  stockItemId: string; name: string; unit: StockUnit; qty: number; isActive: boolean;
  unitCostMilliPaise: number | null; valuePaise: number | null;
}
export interface DishPrice {
  tier: PriceTier; pricePaise: number; preGstPaise: number;
  costPercent: number | null; marginPaise: number | null;
}
export type DishCostStatus = "complete" | "incomplete" | "no_recipe";
export interface DishCost {
  productId: string; variantId: string | null; name: string; categoryName: string;
  costPaise: number | null; status: DishCostStatus; missing: string[]; prices: DishPrice[];
}
export interface StockCostChange {
  id: string; stockItemId: string; oldCostMilliPaise: number | null; newCostMilliPaise: number;
  note: string; createdAt: number; createdByName: string | null;
}

/** n / d rounded half away from zero (d must be positive). */
function roundDiv(n: bigint, d: bigint): bigint {
  const negative = n < 0n;
  const abs = negative ? -n : n;
  const q = (abs * 2n + d) / (d * 2n);
  return negative ? -q : q;
}

function toSafeNumber(n: bigint): number {
  const value = Number(n);
  if (!Number.isSafeInteger(value)) throw new Error("Cost calculation is outside the supported range");
  return value === 0 ? 0 : value; // normalise -0
}

/** Average cost (milli-paise per unit) after adding `addQtyMilli` stock bought for `paidPaise`. */
export function blendUnitCost(oldQtyMilli: number, oldCost: number | null, addQtyMilli: number, paidPaise: number): number {
  if (!(addQtyMilli > 0)) throw new Error("Delivery quantity must be greater than zero");
  const add = BigInt(addQtyMilli);
  const paid = BigInt(paidPaise) * MILLI;
  if (oldQtyMilli <= 0 || oldCost === null) return toSafeNumber(roundDiv(paid, add));
  const old = BigInt(oldQtyMilli);
  return toSafeNumber(roundDiv(old * BigInt(oldCost) + paid, old + add));
}

/** Whole-paise value of a stock movement; null when the unit cost is unknown. */
export function moveCostPaise(deltaMilli: number, unitCost: number | null): number | null {
  if (unitCost === null) return null;
  return toSafeNumber(roundDiv(BigInt(deltaMilli) * BigInt(unitCost), MILLI));
}

/** Price before GST: unchanged when tax-exclusive, otherwise the tax is stripped out. */
export function preGstPaise(pricePaise: number, gstRate: number, taxInclusive: boolean): number {
  if (!taxInclusive) return pricePaise;
  const result = Math.round(Math.abs(pricePaise) * 100 / (100 + gstRate)) * Math.sign(pricePaise);
  return result === 0 ? 0 : result;
}

export function dishCost(links: Array<{ stockName: string; qtyPerSale: number; unitCostMilliPaise: number | null }>): {
  costPaise: number | null; status: DishCostStatus; missing: string[];
} {
  if (links.length === 0) return { costPaise: null, status: "no_recipe", missing: [] };
  const missing: string[] = [];
  let total = 0;
  for (const link of links) {
    const cost = moveCostPaise(stockMilli(link.qtyPerSale), link.unitCostMilliPaise);
    if (cost === null) missing.push(link.stockName);
    else total += cost;
  }
  if (missing.length > 0) return { costPaise: null, status: "incomplete", missing };
  return { costPaise: total, status: "complete", missing };
}

/** One billed line: revenue is pre-GST taxable value; cost is null when unknown, saleMoves is 0 when the dish has no recipe. */
export interface ProfitLine {
  categoryName: string; name: string; qty: number; revenuePaise: number; costPaise: number | null; saleMoves: number;
}
type LineStatus = "costed" | "unknown" | "none";
const lineStatus = (line: ProfitLine): LineStatus => line.saleMoves === 0 ? "none" : line.costPaise === null ? "unknown" : "costed";
const percentOf = (part: number, whole: number): number | null => whole === 0 ? null : Math.round(part * 1000 / whole) / 10;
const column = (key: string, label: string, format?: ReportColumn["format"]): ReportColumn => format ? { key, label, format } : { key, label };
const STATUS_LABELS: Record<LineStatus, string> = { costed: "Costed", unknown: "Cost unknown", none: "No recipe" };

interface ProfitGroup { name: string; qty: number; revenue: number; costedRevenue: number; cost: number; counts: Record<LineStatus, number> }

function groupLines(lines: ProfitLine[], key: (line: ProfitLine) => string, label: (line: ProfitLine) => string): ProfitGroup[] {
  const groups = new Map<string, ProfitGroup>();
  for (const line of lines) {
    const k = key(line);
    const g = groups.get(k) ?? { name: label(line), qty: 0, revenue: 0, costedRevenue: 0, cost: 0, counts: { costed: 0, unknown: 0, none: 0 } };
    const status = lineStatus(line);
    g.qty += line.qty; g.revenue += line.revenuePaise; g.counts[status]++;
    if (status === "costed") { g.costedRevenue += line.revenuePaise; g.cost += line.costPaise!; }
    groups.set(k, g);
  }
  return [...groups.values()];
}

function groupStatus(counts: Record<LineStatus, number>): string {
  const present = (Object.keys(STATUS_LABELS) as LineStatus[]).filter((s) => counts[s] > 0);
  if (present.length === 1) return STATUS_LABELS[present[0]!];
  return present.map((s) => `${counts[s]} ${STATUS_LABELS[s].toLowerCase()}`).join(", ");
}

/** Food cost and gross profit. Only fully costed lines count towards cost %; the rest are reported as excluded revenue. */
export function buildProfitReport(input: {
  from: string; to: string; today: string; timezone: string; generatedAt: number; lines: ProfitLine[];
  wastage: { costPaise: number; unknownCount: number }; adjustments: { costPaise: number; unknownCount: number };
}): Omit<OperationalReport, "kind"> & { kind: "profit" } {
  let revenue = 0, costedRevenue = 0, cost = 0, unknownRevenue = 0, noRecipeRevenue = 0;
  for (const line of input.lines) {
    revenue += line.revenuePaise;
    const status = lineStatus(line);
    if (status === "costed") { costedRevenue += line.revenuePaise; cost += line.costPaise!; }
    else if (status === "unknown") unknownRevenue += line.revenuePaise;
    else noRecipeRevenue += line.revenuePaise;
  }
  const summaryRow = (metric: string, amount: number | null, percent: number | null = null): Record<string, ReportCell> => ({ metric, amount, percent });
  const summary: ReportTable = {
    title: "Summary",
    columns: [column("metric", "Metric"), column("amount", "Amount", "money"), column("percent", "Percent", "percent")],
    rows: [
      summaryRow("Revenue (pre-GST)", revenue), summaryRow("Costed revenue", costedRevenue), summaryRow("Ingredient cost", cost),
      summaryRow("Gross profit", costedRevenue - cost), summaryRow("Food cost %", null, percentOf(cost, costedRevenue)),
      summaryRow("Wastage cost", input.wastage.costPaise), summaryRow("Count adjustments (net)", input.adjustments.costPaise),
      summaryRow("Excluded: cost unknown", unknownRevenue), summaryRow("Excluded: no recipe", noRecipeRevenue),
    ],
  };
  const breakdown = (title: string, nameLabel: string, groups: ProfitGroup[]): ReportTable => ({
    title,
    columns: [column("name", nameLabel), column("qty", "Quantity", "quantity"), column("revenue", "Revenue", "money"), column("cost", "Cost", "money"),
      column("profit", "Gross profit", "money"), column("costPercent", "Food cost %", "percent"), column("status", "Status")],
    rows: groups.map((g): Record<string, ReportCell> => {
      const costed = g.counts.costed > 0;
      return { name: g.name, qty: g.qty, revenue: g.revenue, cost: costed ? g.cost : null, profit: costed ? g.costedRevenue - g.cost : null,
        costPercent: costed ? percentOf(g.cost, g.costedRevenue) : null, status: groupStatus(g.counts) };
    }),
  });
  const byCategory = groupLines(input.lines, (l) => l.categoryName, (l) => l.categoryName);
  const byDish = groupLines(input.lines, (l) => `${l.categoryName} ${l.name}`, (l) => l.name);

  const notes = ["Revenue is bill taxable value after discount, excluding GST, by bill issue date."];
  if (unknownRevenue > 0 || noRecipeRevenue > 0) {
    notes.push("Food cost % and gross profit use only fully costed sales. Sales whose cost is unknown and sales of dishes with no recipe are excluded and shown separately in the summary.");
  }
  if (input.lines.some((l) => lineStatus(l) === "unknown")) notes.push("Sales before costing was set up have no recorded cost.");
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  if (input.wastage.unknownCount > 0) notes.push(`${plural(input.wastage.unknownCount, "wastage movement has", "wastage movements have")} no recorded cost and ${input.wastage.unknownCount === 1 ? "is" : "are"} not in the wastage cost.`);
  if (input.adjustments.unknownCount > 0) notes.push(`${plural(input.adjustments.unknownCount, "count adjustment has", "count adjustments have")} no recorded cost and ${input.adjustments.unknownCount === 1 ? "is" : "are"} not in the net adjustment cost.`);

  return { kind: "profit", from: input.from, to: input.to, today: input.today, timezone: input.timezone, generatedAt: input.generatedAt, notes,
    tables: [summary, breakdown("By category", "Category", byCategory), breakdown("By dish", "Dish", byDish)] };
}
