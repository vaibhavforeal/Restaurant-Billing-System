import { z } from "zod";
import { localDateKey } from "./dates.js";
import { allocatePaise } from "./report-lines.js";

const qty = z.number().int().min(1).max(999);
const targets = z.array(z.object({ productId: z.string().min(1), variantId: z.string().min(1).nullable() })).min(1).max(1000);
const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).nullable();
export const OfferRule = z.object({
  name: z.string().trim().min(1).max(80).regex(/^[^\x00-\x1f\x7f]+$/),
  state: z.enum(["active", "paused", "archived"]),
  benefit: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("percent"), percent: z.number().int().min(1).max(100) }),
    z.object({ kind: z.literal("fixed"), paise: z.number().int().min(1).max(1_000_000_000) }),
    z.object({ kind: z.literal("bogo"), buy: qty, get: qty, qualifying: targets, rewards: targets }),
  ]),
  minimumPaise: z.number().int().min(0).max(1_000_000_000),
  kinds: z.array(z.enum(["dine_in", "takeaway", "delivery"])).min(1).max(3),
  weekdays: z.array(z.number().int().min(0).max(6)).min(1).max(7),
  firstDate: z.iso.date().nullable(), lastDate: z.iso.date().nullable(),
  startTime: clock, endTime: clock,
}).refine(r => !r.firstDate || !r.lastDate || r.firstDate <= r.lastDate, "End date precedes start date")
  .refine(r => (r.startTime === null && r.endTime === null) || (r.startTime && r.endTime && r.startTime !== r.endTime), "Choose distinct start and end times, or leave both blank");
export type OfferRule = z.infer<typeof OfferRule>;
export type Offer = OfferRule & { id: string; createdAt: number; revision: number };
export interface AppliedOffer { id: string; name: string; savingPaise: number; allocations: Record<string, number> }
interface Item { id: string; productId: string; variantId: string | null; pricePaise: number; qty: number; addonOfItemId?: string | null }

export function inOfferWindow(rule: OfferRule, time: number) {
  const day = new Date(time);
  const hhmm = [day.getHours(), day.getMinutes()].map(n => String(n).padStart(2, "0")).join(":");
  if (rule.startTime && rule.endTime) {
    if (rule.startTime < rule.endTime) {
      if (hhmm < rule.startTime || hhmm >= rule.endTime) return false;
    } else if (hhmm < rule.endTime) day.setDate(day.getDate() - 1);
    else if (hhmm < rule.startTime) return false;
  }
  const date = localDateKey(day.getTime());
  return rule.weekdays.includes(day.getDay()) && (!rule.firstDate || date >= rule.firstDate) && (!rule.lastDate || date <= rule.lastDate);
}

function bogoAllocations(rule: Extract<OfferRule["benefit"], { kind: "bogo" }>, items: Item[]) {
  const matches = (item: Item, list: typeof rule.rewards) => list.some(t => t.productId === item.productId && (!t.variantId || t.variantId === item.variantId));
  const lines = items.filter(i => !i.addonOfItemId).map(item => ({ item, buy: matches(item, rule.qualifying), reward: matches(item, rule.rewards) }));
  let buy = 0, reward = 0, either = 0;
  for (const line of lines) {
    if (line.buy) buy += line.item.qty;
    if (line.reward) reward += line.item.qty;
    if (line.buy || line.reward) either += line.item.qty;
  }
  const groups = Math.min(Math.floor(buy / rule.buy), Math.floor(reward / rule.get), Math.floor(either / (rule.buy + rule.get)));
  let needed = groups * rule.get;
  let sharedAvailable = buy - groups * rule.buy;
  const allocations: Record<string, number> = {};
  for (const line of lines.filter(l => l.reward).sort((a,b) => a.item.pricePaise - b.item.pricePaise || a.item.id.localeCompare(b.item.id))) {
    const take = Math.min(needed, line.item.qty, line.buy ? sharedAvailable : needed);
    if (take) allocations[line.item.id] = take * line.item.pricePaise;
    needed -= take;
    if (line.buy) sharedAvailable -= take;
    if (!needed) break;
  }
  return allocations;
}

/** Offers arrive oldest first, so equal savings preserve the earlier rule. */
export function bestOffer(offers: Offer[], items: Item[], kind: OfferRule["kinds"][number], time: number): AppliedOffer | null {
  const weights = items.map(i => i.pricePaise * i.qty);
  const subtotal = weights.reduce((a,b) => a+b, 0);
  let best: AppliedOffer | null = null;
  for (const offer of offers) {
    if (offer.state !== "active" || !offer.kinds.includes(kind) || subtotal < offer.minimumPaise || !inOfferWindow(offer, time)) continue;
    const benefit = offer.benefit;
    let allocations: Record<string, number>;
    if (benefit.kind === "bogo") allocations = bogoAllocations(benefit, items);
    else {
      const saving = benefit.kind === "fixed" ? Math.min(benefit.paise, subtotal) : Math.round(subtotal * benefit.percent / 100);
      const parts = allocatePaise(saving, weights);
      allocations = Object.fromEntries(items.map((item,i) => [item.id, parts[i]!]));
    }
    const savingPaise = Object.values(allocations).reduce((a,b) => a+b, 0);
    if (savingPaise > (best?.savingPaise ?? 0)) best = { id: offer.id, name: offer.name, savingPaise, allocations };
  }
  return best;
}
