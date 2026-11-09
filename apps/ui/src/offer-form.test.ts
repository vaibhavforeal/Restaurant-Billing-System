import { describe, expect, it } from "vitest";
import { OfferInput } from "@masalapos/domain/offers";
import { offerForm, offerHundredths, offerSummary, parseOfferForm, type OfferFormState } from "./offer-form";

const base = () => ({ ...offerForm(), name: "Pizza deal", categoryIds: ["pizza"] });
describe("offer form conversion and validation", () => {
  it("defaults to an active 1+1 free deal with unrestricted conditions", () => {
    expect(offerForm()).toMatchObject({ active: true, kind: "buy_get", buyQty: "1", getQty: "1", percentBp: "100", days: [0, 1, 2, 3, 4, 5, 6], categoryIds: [], orderTypeIds: [], timeFrom: "", validFrom: "" });
    expect(parseOfferForm(base()).value).toEqual(OfferInput.parse({ name: "Pizza deal", kind: "buy_get", buyQty: 1, getQty: 1, percentBp: 10000, categoryIds: ["pizza"] }));
  });
  it.each([["12.5", 1250], ["0.29", 29], ["100", 10000], ["001.01", 101], ["", null], [" 2. ", 200]])("converts % or rupees %s exactly", (text, expected) => expect(offerHundredths(text as string)).toBe(expected));
  it.each(["12.345", "-1", "1e2", "NaN", "Infinity", "9007199254740992"]) ("rejects unsafe or imprecise numeric input %s", (text) => expect(offerHundredths(text)).toBeNaN());
  it("round trips a switched-off offer with dates, overnight times and inactive references", () => {
    const offer = OfferInput.parse({ name: "Old deal", active: false, kind: "item_off", amountPaise: 2995, productIds: ["inactive"], orderTypeIds: ["inactive-type"], days: [4], validFrom: "2026-11-01", validUntil: "2026-12-01", timeFrom: 1320, timeUntil: 120 });
    expect(parseOfferForm(offerForm(offer)).value).toEqual(offer);
  });
  it("normalizes fields left behind after kind and discount-mode changes", () => {
    const stale: OfferFormState = { ...base(), sameItemOnly: true, minBillPaise: "500", maxDiscountPaise: "150", amountPaise: "30" };
    expect(parseOfferForm({ ...stale, kind: "bill_off", discountMode: "amount" }).value).toMatchObject({ active: true, buyQty: null, getQty: null, sameItemOnly: false, percentBp: null, amountPaise: 3000, categoryIds: [], productIds: [], minBillPaise: 50000, maxDiscountPaise: null });
    expect(parseOfferForm({ ...stale, kind: "item_off" }).value).toMatchObject({ buyQty: null, getQty: null, sameItemOnly: false, minBillPaise: 0, maxDiscountPaise: null, amountPaise: null });
    expect(parseOfferForm(stale).value).toMatchObject({ percentBp: 10000, amountPaise: null, minBillPaise: 0, maxDiscountPaise: null });
  });
  it.each([
    [{ categoryIds: [] }, "categoryIds", "Pick at least one category or item"],
    [{ buyQty: "" }, "buyQty", "Say how many to buy"],
    [{ getQty: "" }, "getQty", "Say how many to get"],
    [{ percentBp: "" }, "percentBp", "Say how much off the free items get"],
    [{ days: [] }, "days", "Pick at least one day"],
    [{ days: [1, 1] }, "days", "A day is listed twice"],
    [{ validFrom: "2026-12-01", validUntil: "2026-11-01" }, "validUntil", "The end date is before the start date"],
    [{ validFrom: "2026-02-30" }, "validFrom", "That is not a calendar date"],
    [{ timeFrom: "22:00" }, "timeFrom", "Set both the start and the end time, or neither"],
    [{ timeFrom: "12:00", timeUntil: "12:00" }, "timeUntil", "The start and end time are the same"],
    [{ categoryIds: ["pizza", "pizza"] }, "categoryIds", "An item is listed twice"],
    [{ kind: "item_off", percentBp: "" }, "percentBp", "Set either a percentage or an amount"],
  ] as const)("keeps the domain message on %s", (patch, field, message) => {
    expect(parseOfferForm({ ...base(), ...patch } as OfferFormState).errors?.[field]).toBe(message);
  });
  it.each([
    ["name", ""], ["name", "x".repeat(41)], ["buyQty", "21"], ["getQty", "1.5"], ["percentBp", "100.01"], ["percentBp", "12.345"],
  ])("reports invalid %s on that field", (field, text) => expect(parseOfferForm({ ...base(), [field]: text }).errors?.[field]).toBeTruthy());
  it("allows blank optional limits and rejects nonpositive amounts/caps", () => {
    const form: OfferFormState = { ...base(), kind: "bill_off", discountMode: "amount", amountPaise: "0" };
    expect(parseOfferForm(form).errors?.amountPaise).toBeTruthy();
    expect(parseOfferForm({ ...form, amountPaise: "20" }).value).toMatchObject({ minBillPaise: 0, maxDiscountPaise: null });
    expect(parseOfferForm({ ...form, discountMode: "percent", maxDiscountPaise: "0" }).errors?.maxDiscountPaise).toBeTruthy();
  });
  it.each(["12:99", "24:00", "-1:00"])("rejects malformed clock time %s", (timeFrom) => {
    expect(parseOfferForm({ ...base(), timeFrom, timeUntil: "02:00" }).errors?.timeFrom).toBeTruthy();
  });
});

describe("offer summaries", () => {
  const choices = { categories: [{ id: "pizza", name: "Pizzas", isActive: true }], products: [{ id: "drink", name: "Coke", isActive: true }], orderTypes: [{ id: "dine", name: "Dine-in", isActive: true }] };
  const summary = (form: OfferFormState) => offerSummary(parseOfferForm(form).value!, choices);
  it("formats buy/get and omits all-day restrictions", () => expect(summary(base())).toBe("Buy 1 get 1 free · Pizzas"));
  it("includes reward percentage, same-item and overnight restrictions", () => {
    expect(summary({ ...base(), buyQty: "2", percentBp: "50", sameItemOnly: true, days: [0, 1, 2, 3], timeFrom: "22:00", timeUntil: "02:00", orderTypeIds: ["dine"] })).toBe("Buy 2 get 1 at 50% off · Pizzas · Same item only · Mon–Thu 22:00–02:00 (ends next morning) · Dine-in");
  });
  it("formats percentage and amount item offers", () => {
    expect(summary({ ...base(), kind: "item_off", percentBp: "12.5" })).toBe("12.5% off · Pizzas");
    expect(summary({ ...base(), kind: "item_off", discountMode: "amount", amountPaise: "30", categoryIds: [], productIds: ["drink"] })).toBe("₹30 off each item · Coke");
  });
  it("formats bill thresholds inclusively, caps and dates", () => {
    expect(summary({ ...base(), kind: "bill_off", percentBp: "10", minBillPaise: "500", maxDiscountPaise: "150", validUntil: "2026-11-29" })).toBe("10% off bills of ₹500 or more, up to ₹150 · Until 2026-11-29");
  });
});
