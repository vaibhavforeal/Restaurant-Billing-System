import { z } from "zod";
import { localDateKey } from "./dates.js";
import { allocatePaise } from "./report-lines.js";

/**
 * Offers: "buy X get Y" deals, item discounts and bill discounts the owner sets up once and the till applies by
 * itself. `applyOffers` is pure, with no database access: the server feeds it the billed lines and the offers
 * and stores what it returns on the bill. Money is integer paise; "half up" rounding is `(amount * bp + 5000) / 10000`.
 */

export type OfferKind = "buy_get" | "item_off" | "bill_off";

const OFFER_NAME_MAX = 40;
const BUY_GET_QTY_MAX = 20;
const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];
const LAST_MINUTE = 24 * 60 - 1;

/** The fields an admin sends to create or change an offer; defaults are filled in. */
export type OfferInputValue = {
  name: string;
  active: boolean;
  kind: OfferKind;
  /** `buy_get` only: pay for `buyQty` units, get `getQty` more at `percentBp` off. */
  buyQty: number | null;
  getQty: number | null;
  /** `buy_get` only: the units must share product and variant. */
  sameItemOnly: boolean;
  /** Basis points (10000 = 100%). `buy_get`: the reward units' discount. `item_off` / `bill_off`: percent off, when `amountPaise` is not set. */
  percentBp: number | null;
  /** `item_off`: paise off each unit. `bill_off`: paise off the bill. */
  amountPaise: number | null;
  /** `bill_off` only: the items total after item offers must be at least this. */
  minBillPaise: number;
  /** `bill_off` with a percent only: cap on the discount. */
  maxDiscountPaise: number | null;
  /** `buy_get` and `item_off`: the item set, by category or product (a product covers all its variants). */
  categoryIds: string[];
  productIds: string[];
  /** Local dates, YYYY-MM-DD, both inclusive. */
  validFrom: string | null;
  validUntil: string | null;
  /** Days it runs, 0 = Monday ... 6 = Sunday. */
  days: number[];
  /** Local minutes from midnight; `timeFrom > timeUntil` crosses midnight. Both set or both null. */
  timeFrom: number | null;
  timeUntil: number | null;
  /** Empty means every order type. */
  orderTypeIds: string[];
};

export interface Offer extends OfferInputValue {
  id: string;
  createdAt: number;
}

const isCalendarDate = (value: string) => {
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
};
const LocalDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date like 2026-11-13").refine(isCalendarDate, "That is not a calendar date");
const Minute = z.number().int().min(0).max(LAST_MINUTE);

const offerFields = z.object({
  name: z.string().trim().min(1).max(OFFER_NAME_MAX),
  active: z.boolean().default(true),
  kind: z.enum(["buy_get", "item_off", "bill_off"]),
  buyQty: z.number().int().min(1).max(BUY_GET_QTY_MAX).nullable().default(null),
  getQty: z.number().int().min(1).max(BUY_GET_QTY_MAX).nullable().default(null),
  sameItemOnly: z.boolean().default(false),
  percentBp: z.number().int().min(1).max(10000).nullable().default(null),
  amountPaise: z.number().int().min(1).nullable().default(null),
  minBillPaise: z.number().int().min(0).default(0),
  maxDiscountPaise: z.number().int().min(1).nullable().default(null),
  categoryIds: z.array(z.string().min(1)).default([]),
  productIds: z.array(z.string().min(1)).default([]),
  validFrom: LocalDate.nullable().default(null),
  validUntil: LocalDate.nullable().default(null),
  days: z.array(z.number().int().min(0).max(6)).min(1, "Pick at least one day").default(() => [...ALL_DAYS]),
  timeFrom: Minute.nullable().default(null),
  timeUntil: Minute.nullable().default(null),
  orderTypeIds: z.array(z.string().min(1)).default([]),
});

/** The checks that need more than one field. */
function checkOffer(offer: OfferInputValue, ctx: z.RefinementCtx): void {
  const problem = (path: string, message: string) => ctx.addIssue({ code: "custom", path: [path], message });
  const hasTargets = offer.categoryIds.length > 0 || offer.productIds.length > 0;

  if (offer.kind === "buy_get") {
    if (offer.buyQty === null) problem("buyQty", "Say how many to buy");
    if (offer.getQty === null) problem("getQty", "Say how many to get");
    if (offer.percentBp === null) problem("percentBp", "Say how much off the free items get");
    if (offer.amountPaise !== null) problem("amountPaise", "Buy and get takes a percentage, not an amount");
  } else if ((offer.percentBp === null) === (offer.amountPaise === null)) {
    problem("percentBp", "Set either a percentage or an amount");
  }

  if (offer.kind === "bill_off") {
    if (hasTargets) problem("categoryIds", "A bill offer covers the whole bill, so it has no items");
  } else if (!hasTargets) {
    problem("categoryIds", "Pick at least one category or item");
  }

  if (offer.kind !== "bill_off" && offer.minBillPaise > 0) problem("minBillPaise", "Only a bill offer has a minimum bill");
  if (offer.maxDiscountPaise !== null) {
    if (offer.kind !== "bill_off") problem("maxDiscountPaise", "Only a bill offer has a maximum discount");
    else if (offer.amountPaise !== null) problem("maxDiscountPaise", "A maximum discount only applies to a percentage");
  }
  if (offer.kind !== "buy_get" && offer.sameItemOnly) problem("sameItemOnly", "Only buy and get can require the same item");

  if (offer.validFrom !== null && offer.validUntil !== null && offer.validFrom > offer.validUntil) problem("validUntil", "The end date is before the start date");

  if ((offer.timeFrom === null) !== (offer.timeUntil === null)) problem("timeFrom", "Set both the start and the end time, or neither");
  else if (offer.timeFrom !== null && offer.timeFrom === offer.timeUntil) problem("timeUntil", "The start and end time are the same");

  if (new Set(offer.days).size !== offer.days.length) problem("days", "A day is listed twice");
}

/** Body of an offer's create and update requests. */
export const OfferInput: z.ZodType<OfferInputValue, unknown> = offerFields.superRefine(checkOffer);

export interface OfferLine {
  id: string;
  productId: string;
  variantId: string | null;
  categoryId: string;
  pricePaise: number;
  qty: number;
}

export interface OfferContext {
  /** Local date of the bill, YYYY-MM-DD. */
  localDate: string;
  /** 0 = Monday ... 6 = Sunday. */
  weekday: number;
  /** Local minutes from midnight. */
  minutes: number;
  orderTypeId: string;
  orderTypeKind: "dine_in" | "takeaway" | "delivery" | "aggregator" | null;
  /** Offers the cashier switched off for this bill. */
  removedOfferIds: string[];
}

export interface AppliedOffer {
  offerId: string;
  name: string;
  discountPaise: number;
  perLine: Array<{ lineId: string; discountPaise: number }>;
}

export interface OfferResult {
  /** Offer discount per line id, for lines that got one. */
  lineDiscounts: Map<string, number>;
  /** In the order the offers were applied: item offers by size of saving, then the bill offer. */
  applied: AppliedOffer[];
  /** Offers that would have run on this bill but the cashier removed. */
  removed: Array<{ offerId: string; name: string }>;
}

/** The local date, weekday (Monday = 0) and minutes from midnight of a moment. */
export function offerClock(ms: number): Pick<OfferContext, "localDate" | "weekday" | "minutes"> {
  const date = new Date(ms);
  return { localDate: localDateKey(ms), weekday: (date.getDay() + 6) % 7, minutes: date.getHours() * 60 + date.getMinutes() };
}

const previousDate = (localDate: string): string => {
  const [year = 0, month = 1, day = 1] = localDate.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day - 1)).toISOString().slice(0, 10);
};

/**
 * Whether the offer is on right now for this order: switched on, inside its dates, days and time window, and
 * allowed for the order type. Aggregator orders get no offers. The cashier's removal is not considered here.
 */
export function offerRuns(offer: Offer, ctx: Omit<OfferContext, "removedOfferIds">): boolean {
  if (!offer.active || ctx.orderTypeKind === "aggregator") return false;
  if (offer.orderTypeIds.length > 0 && !offer.orderTypeIds.includes(ctx.orderTypeId)) return false;

  // The day and date are those of the day the time window started, so 01:00 belongs to the evening before.
  let date = ctx.localDate;
  let weekday = ctx.weekday;
  if (offer.timeFrom !== null && offer.timeUntil !== null) {
    if (offer.timeFrom < offer.timeUntil) {
      if (ctx.minutes < offer.timeFrom || ctx.minutes >= offer.timeUntil) return false;
    } else if (ctx.minutes < offer.timeUntil) {
      date = previousDate(ctx.localDate);
      weekday = (ctx.weekday + 6) % 7;
    } else if (ctx.minutes < offer.timeFrom) {
      return false;
    }
  }

  if (!offer.days.includes(weekday)) return false;
  if (offer.validFrom !== null && date < offer.validFrom) return false;
  if (offer.validUntil !== null && date > offer.validUntil) return false;
  return true;
}

const halfUp = (amount: number, bp: number): number => Number((BigInt(amount) * BigInt(bp) + 5000n) / 10000n);

/** One unit of a line: the item offers pick units, dearest first. */
interface Unit {
  lineIndex: number;
  price: number;
  used: boolean;
  discount: number;
}

/** What an offer would do on the units still free. */
interface Plan {
  offer: Offer;
  saving: number;
  /** Units the offer would use up, buy and reward units alike. */
  used: Unit[];
  rewards: Array<{ unit: Unit; paise: number }>;
}

const inItemSet = (offer: Offer, line: OfferLine) => offer.categoryIds.includes(line.categoryId) || offer.productIds.includes(line.productId);

/** Largest saving first; equal savings go to the earlier-created offer, then the lower id. */
const byPriority = (a: { saving: number; offer: Offer }, b: { saving: number; offer: Offer }): number =>
  b.saving - a.saving || a.offer.createdAt - b.offer.createdAt || (a.offer.id < b.offer.id ? -1 : a.offer.id > b.offer.id ? 1 : 0);

function planItemOffer(offer: Offer, units: Unit[], lines: OfferLine[]): Plan {
  const free = units.filter((unit) => !unit.used && inItemSet(offer, lines[unit.lineIndex]!));
  const used: Unit[] = [];
  const rewards: Plan["rewards"] = [];

  if (offer.kind === "buy_get") {
    const buy = offer.buyQty ?? 0, get = offer.getQty ?? 0, bp = offer.percentBp ?? 0;
    if (buy > 0 && get > 0 && bp > 0) {
      const groups = new Map<string, Unit[]>();
      for (const unit of free) {
        const line = lines[unit.lineIndex]!;
        const key = offer.sameItemOnly ? `${line.productId}/${line.variantId ?? ""}` : "";
        const group = groups.get(key);
        if (group) group.push(unit);
        else groups.set(key, [unit]);
      }
      for (const group of groups.values()) {
        const sets = Math.floor(group.length / (buy + get));
        // The cheapest units are the reward, the next cheapest the ones bought; the dearest stay free for other offers.
        const rewardFrom = group.length - sets * get;
        const buyFrom = rewardFrom - sets * buy;
        used.push(...group.slice(buyFrom));
        for (const unit of group.slice(rewardFrom)) rewards.push({ unit, paise: halfUp(unit.price, bp) });
      }
    }
  } else if (offer.kind === "item_off") {
    for (const unit of free) {
      const paise = offer.percentBp !== null ? halfUp(unit.price, offer.percentBp) : Math.min(offer.amountPaise ?? 0, unit.price);
      used.push(unit);
      rewards.push({ unit, paise });
    }
  }
  return { offer, saving: rewards.reduce((sum, reward) => sum + reward.paise, 0), used, rewards };
}

function billOfferSaving(offer: Offer, remaining: number): number {
  if (remaining < offer.minBillPaise) return 0;
  if (offer.percentBp !== null) {
    const percent = halfUp(remaining, offer.percentBp);
    return offer.maxDiscountPaise !== null ? Math.min(percent, offer.maxDiscountPaise) : percent;
  }
  return Math.min(offer.amountPaise ?? 0, remaining);
}

/**
 * Works out the offers on a bill. Item offers (`buy_get`, `item_off`) are applied greedily, the biggest saving
 * first, each on the units no earlier offer used. Then the best bill offer takes its share of what is left.
 */
export function applyOffers(lines: OfferLine[], offers: Offer[], context: OfferContext): OfferResult {
  const cashierRemoved = new Set(context.removedOfferIds);
  const running = offers.filter((offer) => offerRuns(offer, context));
  const removed = running.filter((offer) => cashierRemoved.has(offer.id)).map((offer) => ({ offerId: offer.id, name: offer.name }));
  const eligible = running.filter((offer) => !cashierRemoved.has(offer.id));

  // Dearest units first, then line order; a stable sort keeps the units of one line together.
  const units: Unit[] = lines.flatMap((line, lineIndex) => Array.from({ length: line.qty }, (): Unit => ({ lineIndex, price: line.pricePaise, used: false, discount: 0 })));
  units.sort((a, b) => b.price - a.price || a.lineIndex - b.lineIndex);

  const perLineOf = (parts: Array<{ lineIndex: number; paise: number }>): AppliedOffer["perLine"] => {
    const byLine = new Map<number, number>();
    for (const { lineIndex, paise } of parts) byLine.set(lineIndex, (byLine.get(lineIndex) ?? 0) + paise);
    return [...byLine].filter(([, paise]) => paise > 0).sort(([a], [b]) => a - b).map(([lineIndex, paise]) => ({ lineId: lines[lineIndex]!.id, discountPaise: paise }));
  };

  const applied: AppliedOffer[] = [];
  const itemDiscount = lines.map(() => 0);
  let pending = eligible.filter((offer) => offer.kind !== "bill_off");
  for (;;) {
    const best = pending.map((offer) => planItemOffer(offer, units, lines)).filter((plan) => plan.saving > 0).sort(byPriority)[0];
    if (!best) break;
    for (const unit of best.used) unit.used = true;
    for (const { unit, paise } of best.rewards) {
      unit.discount += paise;
      itemDiscount[unit.lineIndex]! += paise;
    }
    applied.push({ offerId: best.offer.id, name: best.offer.name, discountPaise: best.saving, perLine: perLineOf(best.rewards.map(({ unit, paise }) => ({ lineIndex: unit.lineIndex, paise }))) });
    pending = pending.filter((offer) => offer !== best.offer);
  }

  const afterItems = lines.map((line, i) => line.pricePaise * line.qty - itemDiscount[i]!);
  const remaining = afterItems.reduce((sum, amount) => sum + amount, 0);
  const billOffer = eligible.filter((offer) => offer.kind === "bill_off")
    .map((offer) => ({ offer, saving: billOfferSaving(offer, remaining) }))
    .filter((candidate) => candidate.saving > 0)
    .sort(byPriority)[0];
  const billShare = lines.map(() => 0);
  if (billOffer) {
    allocatePaise(billOffer.saving, afterItems).forEach((paise, i) => { billShare[i] = paise; });
    applied.push({ offerId: billOffer.offer.id, name: billOffer.offer.name, discountPaise: billOffer.saving, perLine: perLineOf(billShare.map((paise, lineIndex) => ({ lineIndex, paise }))) });
  }

  const lineDiscounts = new Map<string, number>();
  lines.forEach((line, i) => {
    const total = itemDiscount[i]! + billShare[i]!;
    if (total > 0) lineDiscounts.set(line.id, (lineDiscounts.get(line.id) ?? 0) + total);
  });
  return { lineDiscounts, applied, removed };
}
