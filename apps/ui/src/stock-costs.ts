import type { StockCostChange, StockMove, StockUnit } from "@forkflow/domain";
import { rupeesToPaise } from "./money";

const MILLI_PAISE_PER_RUPEE = 100_000;
const MAX_PURCHASE_PAISE = 1_000_000_000;

const twoDecimals = new Intl.NumberFormat("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fourDecimals = new Intl.NumberFormat("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 4 });

/** "₹320.00/kg"; up to four decimals below one rupee ("₹0.0234/ml"); "Cost not set" when unknown. */
export function formatUnitCost(milliPaise: number | null, unit: StockUnit): string {
  if (milliPaise === null) return "Cost not set";
  const rupees = milliPaise / MILLI_PAISE_PER_RUPEE;
  return `₹${(rupees < 1 ? fourDecimals : twoDecimals).format(rupees)}/${unit}`;
}

/** Rupees per unit (up to 4 decimals) to integer milli-paise; null if invalid or not above zero. */
export function rupeesPerUnitToMilliPaise(text: string): number | null {
  const match = /^(?:(\d+)(?:\.(\d{1,4}))?|\.(\d{1,4}))$/.exec(text.trim());
  if (!match) return null;
  const whole = match[1] ?? "0";
  const fraction = (match[2] ?? match[3] ?? "").padEnd(4, "0");
  const milli = (Number(whole) * 10_000 + Number(fraction)) * 10;
  return Number.isSafeInteger(milli) && milli > 0 ? milli : null;
}

/** Live "= ₹34.00/kg" hint for the amount paid; null until both inputs are valid and quantity is above zero. */
export function perUnitHint(amountRupees: string, quantity: string, unit: StockUnit): string | null {
  if (!amountRupees.trim() || !quantity.trim()) return null;
  const paise = rupeesToPaise(amountRupees);
  const qty = Number(quantity);
  if (paise === null || !Number.isFinite(qty) || qty <= 0) return null;
  return `= ${formatUnitCost(Math.round((paise * 1000) / qty), unit)}`;
}

/** Amount paid in rupees to integer paise; undefined when blank (keeps the current average); throws when invalid. */
export function amountPaidToPaise(text: string): number | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  if (!/^\d+(\.\d{1,2})?$|^\.\d{1,2}$/.test(trimmed)) throw new Error("Enter the amount paid in rupees, with up to 2 decimal places");
  const paise = rupeesToPaise(trimmed);
  if (paise === null || paise > MAX_PURCHASE_PAISE) throw new Error("Amount paid cannot be more than ₹1,00,00,000");
  return paise;
}

/** Cost of one movement (signed paise); unknown is never shown as zero. */
export function formatMovementCost(paise: number | null | undefined): string {
  if (paise === null || paise === undefined) return "Cost unknown";
  return `${paise < 0 ? "-" : ""}₹${twoDecimals.format(Math.abs(paise) / 100)}`;
}

/** Add another page of cost changes; a change at a page boundary can be returned twice, so de-duplicate by id. */
export function mergeCostChanges(prior: StockCostChange[], next: StockCostChange[]): StockCostChange[] {
  const seen = new Set(prior.map((change) => change.id));
  return [...prior, ...next.filter((change) => !seen.has(change.id))];
}

export type HistoryRow = { kind: "move"; at: number; id: string; move: StockMove } | { kind: "cost"; at: number; id: string; change: StockCostChange };

/** Movements and "Unit cost set" entries on one timeline, newest first (ties by id, which is time-ordered). */
export function mergeHistory(moves: StockMove[], changes: StockCostChange[]): HistoryRow[] {
  const rows: HistoryRow[] = [
    ...moves.map((move): HistoryRow => ({ kind: "move", at: move.createdAt, id: move.id, move })),
    ...changes.map((change): HistoryRow => ({ kind: "cost", at: change.createdAt, id: change.id, change })),
  ];
  return rows.sort((a, b) => b.at - a.at || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
}
