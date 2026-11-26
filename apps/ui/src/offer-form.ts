import { OfferInput, type Offer, type OfferInputValue } from "@masalapos/domain/offers";

export interface OfferListItem extends Offer { bills30d: number; used: boolean }
export type OfferFormState = Omit<OfferInputValue, "buyQty" | "getQty" | "percentBp" | "amountPaise" | "minBillPaise" | "maxDiscountPaise" | "validFrom" | "validUntil" | "timeFrom" | "timeUntil"> & {
  buyQty: string; getQty: string; percentBp: string; amountPaise: string;
  minBillPaise: string; maxDiscountPaise: string; validFrom: string; validUntil: string;
  timeFrom: string; timeUntil: string; discountMode: "percent" | "amount";
};
export type OfferErrors = Record<string, string>;
export type OfferChoice = { id: string; name: string; isActive: boolean };
export const OFFER_DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const decimal = (value: number | null) => value === null ? "" : String(value / 100);
const timeText = (value: number | null) => value === null ? "" : `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;

export function offerForm(offer?: OfferInputValue): OfferFormState {
  return offer ? {
    ...offer, categoryIds: [...offer.categoryIds], productIds: [...offer.productIds], days: [...offer.days], orderTypeIds: [...offer.orderTypeIds],
    buyQty: offer.buyQty === null ? "" : String(offer.buyQty), getQty: offer.getQty === null ? "" : String(offer.getQty),
    percentBp: decimal(offer.percentBp), amountPaise: decimal(offer.amountPaise), minBillPaise: offer.minBillPaise ? decimal(offer.minBillPaise) : "",
    maxDiscountPaise: decimal(offer.maxDiscountPaise), validFrom: offer.validFrom ?? "", validUntil: offer.validUntil ?? "",
    timeFrom: timeText(offer.timeFrom), timeUntil: timeText(offer.timeUntil), discountMode: offer.amountPaise === null ? "percent" : "amount",
  } : {
    name: "", active: true, kind: "buy_get", buyQty: "1", getQty: "1", percentBp: "100", amountPaise: "", discountMode: "percent",
    sameItemOnly: false, minBillPaise: "", maxDiscountPaise: "", categoryIds: [], productIds: [],
    validFrom: "", validUntil: "", days: [0, 1, 2, 3, 4, 5, 6], timeFrom: "", timeUntil: "", orderTypeIds: [],
  };
}

/** Exact decimal conversion: reject extra precision rather than silently rounding a deal. */
export function offerHundredths(text: string): number | null {
  const value = text.trim();
  if (!value) return null;
  if (!/^\d+(?:\.\d{0,2})?$/.test(value)) return NaN;
  const [whole = "0", fraction = ""] = value.split(".");
  const result = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  return Number.isSafeInteger(result) ? result : NaN;
}

export function parseOfferForm(form: OfferFormState): { value: OfferInputValue; errors?: never } | { value?: never; errors: OfferErrors } {
  const buyGet = form.kind === "buy_get", bill = form.kind === "bill_off";
  const percent = buyGet || form.discountMode === "percent";
  const whole = (text: string) => text.trim() ? (/^\d+$/.test(text.trim()) ? Number(text) : NaN) : null;
  const minute = (text: string) => !text ? null : /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(text) ? Number(text.slice(0, 2)) * 60 + Number(text.slice(3)) : NaN;
  const input = {
    name: form.name, active: form.active, kind: form.kind,
    buyQty: buyGet ? whole(form.buyQty) : null, getQty: buyGet ? whole(form.getQty) : null,
    sameItemOnly: buyGet && form.sameItemOnly,
    percentBp: percent ? offerHundredths(form.percentBp) : null, amountPaise: percent ? null : offerHundredths(form.amountPaise),
    minBillPaise: bill ? (offerHundredths(form.minBillPaise) ?? 0) : 0,
    maxDiscountPaise: bill && percent ? offerHundredths(form.maxDiscountPaise) : null,
    categoryIds: bill ? [] : form.categoryIds, productIds: bill ? [] : form.productIds,
    validFrom: form.validFrom || null, validUntil: form.validUntil || null, days: form.days,
    timeFrom: minute(form.timeFrom), timeUntil: minute(form.timeUntil), orderTypeIds: form.orderTypeIds,
  };
  const result = OfferInput.safeParse(input);
  if (result.success) return { value: result.data };
  const errors: OfferErrors = {};
  for (const issue of result.error.issues) {
    const field = String(issue.path[0] ?? "form");
    errors[field] ??= issue.message;
  }
  for (const field of ["percentBp", "amountPaise", "minBillPaise", "maxDiscountPaise"] as const) {
    if (Number.isNaN(input[field])) errors[field] = "Enter a positive number with up to two decimal places.";
  }
  return { errors };
}

export function offerSummary(offer: OfferInputValue, choices: { categories: OfferChoice[]; products: OfferChoice[]; orderTypes: OfferChoice[] }): string {
  const money = (paise: number) => `₹${(paise / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
  const off = offer.percentBp !== null ? `${offer.percentBp / 100}% off` : `${money(offer.amountPaise ?? 0)} off`;
  const parts = [offer.kind === "buy_get"
    ? `Buy ${offer.buyQty} get ${offer.getQty} ${offer.percentBp === 10000 ? "free" : `at ${off}`}`
    : offer.kind === "bill_off" ? `${off} bills${offer.minBillPaise ? ` of ${money(offer.minBillPaise)} or more` : ""}${offer.maxDiscountPaise !== null ? `, up to ${money(offer.maxDiscountPaise)}` : ""}`
      : offer.amountPaise !== null ? `${off} each item` : off];
  const names = (ids: string[], list: OfferChoice[]) => ids.map((id) => list.find((item) => item.id === id)?.name ?? "Unavailable selection");
  const targets = [...names(offer.categoryIds, choices.categories), ...names(offer.productIds, choices.products)];
  if (targets.length) parts.push(targets.join(", "));
  if (offer.sameItemOnly) parts.push("Same item only");
  if (offer.validFrom || offer.validUntil) parts.push(offer.validFrom && offer.validUntil ? `${offer.validFrom} to ${offer.validUntil}` : offer.validFrom ? `From ${offer.validFrom}` : `Until ${offer.validUntil}`);
  const days = [...new Set(offer.days)].sort((a, b) => a - b);
  const dayGroups: string[] = [];
  if (days.length !== 7) {
    for (let i = 0; i < days.length; i++) {
      const first = days[i]!;
      let last = first;
      while (days[i + 1] === last + 1) last = days[++i]!;
      dayGroups.push(first === last ? OFFER_DAYS[first]! : `${OFFER_DAYS[first]}–${OFFER_DAYS[last]}`);
    }
  }
  const time = offer.timeFrom !== null && offer.timeUntil !== null ? `${timeText(offer.timeFrom)}–${timeText(offer.timeUntil)}${offer.timeFrom > offer.timeUntil ? " (ends next morning)" : ""}` : "";
  const schedule = [dayGroups.join(", "), time].filter(Boolean).join(" ");
  if (schedule) parts.push(schedule);
  if (offer.orderTypeIds.length) parts.push(names(offer.orderTypeIds, choices.orderTypes).join(", "));
  return parts.join(" · ");
}
