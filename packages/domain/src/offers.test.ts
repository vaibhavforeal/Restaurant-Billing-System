import { describe, expect, it } from "vitest";
import { OfferInput, applyOffers, offerClock, offerRuns, type Offer, type OfferContext, type OfferLine } from "./offers.js";

const offer = (partial: Partial<Offer> & { id: string }): Offer => ({
  name: partial.id, active: true, kind: "item_off",
  buyQty: null, getQty: null, sameItemOnly: false,
  percentBp: null, amountPaise: null, minBillPaise: 0, maxDiscountPaise: null,
  categoryIds: [], productIds: [], validFrom: null, validUntil: null,
  days: [0, 1, 2, 3, 4, 5, 6], timeFrom: null, timeUntil: null, orderTypeIds: [],
  createdAt: 1,
  ...partial,
});

const line = (id: string, productId: string, categoryId: string, pricePaise: number, qty: number, variantId: string | null = null): OfferLine =>
  ({ id, productId, variantId, categoryId, pricePaise, qty });

/** Friday 13 Nov 2026, 12:00, dine-in. */
const ctx = (partial: Partial<OfferContext> = {}): OfferContext => ({
  localDate: "2026-11-13", weekday: 4, minutes: 720, orderTypeId: "dine", orderTypeKind: "dine_in", removedOfferIds: [], ...partial,
});

const bogo = (partial: Partial<Offer> = {}) => offer({ id: "bogo", name: "BOGO Pizza", kind: "buy_get", buyQty: 1, getQty: 1, percentBp: 10000, categoryIds: ["pizza"], ...partial });

describe("OfferInput", () => {
  const valid = { name: "BOGO Pizza", kind: "buy_get", buyQty: 1, getQty: 1, percentBp: 10000, categoryIds: ["pizza"] };

  it("applies defaults and trims the name", () => {
    expect(OfferInput.parse({ ...valid, name: "  BOGO Pizza  " })).toEqual({
      name: "BOGO Pizza", active: true, kind: "buy_get", buyQty: 1, getQty: 1, sameItemOnly: false,
      percentBp: 10000, amountPaise: null, minBillPaise: 0, maxDiscountPaise: null,
      categoryIds: ["pizza"], productIds: [], validFrom: null, validUntil: null,
      days: [0, 1, 2, 3, 4, 5, 6], timeFrom: null, timeUntil: null, orderTypeIds: [],
    });
  });

  it("accepts each kind with its own fields", () => {
    expect(OfferInput.safeParse({ ...valid, sameItemOnly: true, productIds: ["p1"], categoryIds: [] }).success).toBe(true);
    expect(OfferInput.safeParse({ name: "Cool", kind: "item_off", amountPaise: 500, categoryIds: ["bev"] }).success).toBe(true);
    expect(OfferInput.safeParse({ name: "Big", kind: "bill_off", percentBp: 1000, minBillPaise: 50000, maxDiscountPaise: 15000 }).success).toBe(true);
    expect(OfferInput.safeParse({ name: "Big", kind: "bill_off", amountPaise: 5000 }).success).toBe(true);
  });

  it("accepts the largest target and order type lists", () => {
    const many = (prefix: string, count: number) => Array.from({ length: count }, (_, i) => `${prefix}${i}`);
    expect(OfferInput.safeParse({ ...valid, categoryIds: many("c", 200), productIds: many("p", 200), orderTypeIds: many("o", 20) }).success).toBe(true);
  });

  it("accepts a window that crosses midnight and dates on one day", () => {
    expect(OfferInput.safeParse({ ...valid, timeFrom: 1320, timeUntil: 120, validFrom: "2026-11-13", validUntil: "2026-11-13", days: [4, 5] }).success).toBe(true);
  });

  const billOff = { name: "Big", kind: "bill_off", percentBp: 1000 };
  const itemOff = { name: "Cool", kind: "item_off", percentBp: 2000, categoryIds: ["bev"] };
  const rejected: Array<[string, Record<string, unknown>]> = [
    ["an empty name", { ...valid, name: "" }],
    ["a blank name", { ...valid, name: "   " }],
    ["a 41-character name", { ...valid, name: "x".repeat(41) }],
    ["buy_get without buyQty", { ...valid, buyQty: null }],
    ["buy_get without getQty", { ...valid, getQty: null }],
    ["buy_get without percentBp", { ...valid, percentBp: null }],
    ["buy_get with amountPaise", { ...valid, amountPaise: 500 }],
    ["item_off with both percent and amount", { ...itemOff, amountPaise: 500 }],
    ["item_off with neither percent nor amount", { ...itemOff, percentBp: null }],
    ["bill_off with both percent and amount", { ...billOff, amountPaise: 500 }],
    ["bill_off with neither percent nor amount", { ...billOff, percentBp: null }],
    ["percentBp 0", { ...itemOff, percentBp: 0 }],
    ["percentBp 10001", { ...itemOff, percentBp: 10001 }],
    ["buyQty 21", { ...valid, buyQty: 21 }],
    ["getQty 0", { ...valid, getQty: 0 }],
    ["buy_get with no targets", { ...valid, categoryIds: [] }],
    ["item_off with no targets", { ...itemOff, categoryIds: [] }],
    ["bill_off with a category target", { ...billOff, categoryIds: ["bev"] }],
    ["bill_off with a product target", { ...billOff, productIds: ["p1"] }],
    ["maxDiscountPaise with amountPaise", { ...billOff, percentBp: null, amountPaise: 5000, maxDiscountPaise: 1000 }],
    ["minBillPaise on item_off", { ...itemOff, minBillPaise: 100 }],
    ["minBillPaise on buy_get", { ...valid, minBillPaise: 100 }],
    ["maxDiscountPaise on item_off", { ...itemOff, maxDiscountPaise: 100 }],
    ["maxDiscountPaise on buy_get", { ...valid, maxDiscountPaise: 100 }],
    ["sameItemOnly on item_off", { ...itemOff, sameItemOnly: true }],
    ["sameItemOnly on bill_off", { ...billOff, sameItemOnly: true }],
    ["buyQty on item_off", { ...itemOff, buyQty: 1 }],
    ["getQty on item_off", { ...itemOff, getQty: 1 }],
    ["buyQty on bill_off", { ...billOff, buyQty: 2 }],
    ["getQty on bill_off", { ...billOff, getQty: 2 }],
    ["a repeated category", { ...valid, categoryIds: ["pizza", "pizza"] }],
    ["a repeated product", { ...valid, productIds: ["p1", "p1"] }],
    ["a repeated order type", { ...valid, orderTypeIds: ["dine", "dine"] }],
    ["201 categories", { ...valid, categoryIds: Array.from({ length: 201 }, (_, i) => `c${i}`) }],
    ["201 products", { ...valid, productIds: Array.from({ length: 201 }, (_, i) => `p${i}`) }],
    ["21 order types", { ...valid, orderTypeIds: Array.from({ length: 21 }, (_, i) => `o${i}`) }],
    ["validFrom after validUntil",{ ...valid, validFrom: "2026-11-14", validUntil: "2026-11-13" }],
    ["a date that is not a calendar date", { ...valid, validFrom: "2026-02-30" }],
    ["a date in the wrong format", { ...valid, validUntil: "13/11/2026" }],
    ["timeFrom without timeUntil", { ...valid, timeFrom: 540 }],
    ["timeUntil without timeFrom", { ...valid, timeUntil: 540 }],
    ["timeFrom equal to timeUntil", { ...valid, timeFrom: 540, timeUntil: 540 }],
    ["timeFrom 1440", { ...valid, timeFrom: 1440, timeUntil: 60 }],
    ["no days", { ...valid, days: [] }],
    ["a day 7", { ...valid, days: [7] }],
    ["duplicate days", { ...valid, days: [1, 1] }],
  ];
  it.each(rejected)("rejects %s", (_label, input) => {
    expect(OfferInput.safeParse(input).success).toBe(false);
  });
});

describe("offerClock", () => {
  it("reads the local date, weekday (Monday is 0) and minutes", () => {
    expect(offerClock(new Date(2026, 10, 14, 1, 5).getTime())).toEqual({ localDate: "2026-11-14", weekday: 5, minutes: 65 });
    expect(offerClock(new Date(2026, 10, 16, 23, 59).getTime())).toEqual({ localDate: "2026-11-16", weekday: 0, minutes: 1439 });
    expect(offerClock(new Date(2026, 10, 15, 0, 0).getTime())).toEqual({ localDate: "2026-11-15", weekday: 6, minutes: 0 });
  });
});

describe("offerRuns", () => {
  it("is off when the offer is inactive", () => {
    expect(offerRuns(offer({ id: "a", active: false }), ctx())).toBe(false);
    expect(offerRuns(offer({ id: "a" }), ctx())).toBe(true);
  });

  it("honours the date range, both ends inclusive", () => {
    const o = offer({ id: "a", validFrom: "2026-11-10", validUntil: "2026-11-13" });
    expect(offerRuns(o, ctx({ localDate: "2026-11-09" }))).toBe(false);
    expect(offerRuns(o, ctx({ localDate: "2026-11-10" }))).toBe(true);
    expect(offerRuns(o, ctx({ localDate: "2026-11-13" }))).toBe(true);
    expect(offerRuns(o, ctx({ localDate: "2026-11-14", weekday: 5 }))).toBe(false);
  });

  it("honours the days of the week", () => {
    const o = offer({ id: "a", days: [0, 1] });
    expect(offerRuns(o, ctx({ weekday: 1 }))).toBe(true);
    expect(offerRuns(o, ctx({ weekday: 4 }))).toBe(false);
  });

  it("runs a time window from its start minute up to, not including, its end minute", () => {
    const o = offer({ id: "a", timeFrom: 900, timeUntil: 1080 });
    expect(offerRuns(o, ctx({ minutes: 899 }))).toBe(false);
    expect(offerRuns(o, ctx({ minutes: 900 }))).toBe(true);
    expect(offerRuns(o, ctx({ minutes: 1079 }))).toBe(true);
    expect(offerRuns(o, ctx({ minutes: 1080 }))).toBe(false);
  });

  it("checks the day and date of the day a midnight-crossing window started", () => {
    const o = offer({ id: "a", timeFrom: 1320, timeUntil: 120, days: [4], validUntil: "2026-11-13" });
    // 01:00 Saturday 14 Nov belongs to the Friday 13 Nov window, which is still in range.
    expect(offerRuns(o, ctx({ localDate: "2026-11-14", weekday: 5, minutes: 60 }))).toBe(true);
    // 01:00 Friday 13 Nov belongs to the Thursday window, and Thursday is not a run day.
    expect(offerRuns(o, ctx({ localDate: "2026-11-13", weekday: 4, minutes: 60 }))).toBe(false);
    // 23:00 Friday is the start of the Friday window.
    expect(offerRuns(o, ctx({ localDate: "2026-11-13", weekday: 4, minutes: 1380 }))).toBe(true);
    // 23:00 Saturday is outside the run day and the date range.
    expect(offerRuns(o, ctx({ localDate: "2026-11-14", weekday: 5, minutes: 1380 }))).toBe(false);
    // Midday is outside the window.
    expect(offerRuns(o, ctx({ minutes: 720 }))).toBe(false);
    // The window end is exclusive across midnight too.
    expect(offerRuns(o, ctx({ localDate: "2026-11-14", weekday: 5, minutes: 120 }))).toBe(false);
  });

  it("steps back over a month and year boundary", () => {
    const o = offer({ id: "a", timeFrom: 1320, timeUntil: 120, validUntil: "2026-12-31" });
    expect(offerRuns(o, ctx({ localDate: "2027-01-01", weekday: 4, minutes: 30 }))).toBe(true);
    expect(offerRuns(offer({ id: "b", timeFrom: 1320, timeUntil: 120, validFrom: "2027-01-01" }), ctx({ localDate: "2027-01-01", weekday: 4, minutes: 30 }))).toBe(false);
  });

  it("honours the order types", () => {
    const o = offer({ id: "a", orderTypeIds: ["takeaway"] });
    expect(offerRuns(o, ctx({ orderTypeId: "dine" }))).toBe(false);
    expect(offerRuns(o, ctx({ orderTypeId: "takeaway", orderTypeKind: "takeaway" }))).toBe(true);
    expect(offerRuns(offer({ id: "b" }), ctx({ orderTypeId: "anything" }))).toBe(true);
  });

  it("never runs on an aggregator order", () => {
    expect(offerRuns(offer({ id: "a" }), ctx({ orderTypeKind: "aggregator" }))).toBe(false);
  });
});

describe("applyOffers", () => {
  const lines = [line("marg", "p-marg", "pizza", 29900, 2), line("farm", "p-farm", "pizza", 34900, 1), line("coke", "p-coke", "bev", 6000, 2)];
  const offers = [
    bogo({ createdAt: 1 }),
    offer({ id: "cool", name: "Cool Drinks", kind: "item_off", percentBp: 2000, categoryIds: ["bev"], createdAt: 2 }),
    offer({ id: "big", name: "Big Bill", kind: "bill_off", percentBp: 1000, minBillPaise: 50000, maxDiscountPaise: 15000, createdAt: 3 }),
  ];

  it("works the spec example: BOGO, then Cool Drinks, then Big Bill on what is left", () => {
    const result = applyOffers(lines, offers, ctx());
    expect(result.lineDiscounts).toEqual(new Map([["marg", 32890], ["farm", 3490], ["coke", 3360]]));
    expect(result.applied).toEqual([
      { offerId: "bogo", name: "BOGO Pizza", discountPaise: 29900, perLine: [{ lineId: "marg", discountPaise: 29900 }] },
      { offerId: "cool", name: "Cool Drinks", discountPaise: 2400, perLine: [{ lineId: "coke", discountPaise: 2400 }] },
      { offerId: "big", name: "Big Bill", discountPaise: 7440, perLine: [
        { lineId: "marg", discountPaise: 2990 }, { lineId: "farm", discountPaise: 3490 }, { lineId: "coke", discountPaise: 960 },
      ] },
    ]);
    expect(result.removed).toEqual([]);
  });

  it("does nothing with no offers or no lines", () => {
    expect(applyOffers(lines, [], ctx())).toEqual({ lineDiscounts: new Map(), applied: [], removed: [] });
    expect(applyOffers([], offers, ctx())).toEqual({ lineDiscounts: new Map(), applied: [], removed: [] });
  });

  describe("buy_get", () => {
    it("with sameItemOnly needs the units to share product and variant", () => {
      const same = bogo({ sameItemOnly: true });
      const mixed = applyOffers([line("marg", "p-marg", "pizza", 29900, 1), line("farm", "p-farm", "pizza", 34900, 1)], [same], ctx());
      expect(mixed.applied).toEqual([]);
      expect(mixed.lineDiscounts.size).toBe(0);

      const twice = applyOffers([line("marg", "p-marg", "pizza", 29900, 2), line("farm", "p-farm", "pizza", 34900, 1)], [same], ctx());
      expect(twice.applied.map((a) => [a.offerId, a.discountPaise])).toEqual([["bogo", 29900]]);
      expect(twice.lineDiscounts).toEqual(new Map([["marg", 29900]]));
    });

    it("with sameItemOnly treats variants of one product as different items", () => {
      const result = applyOffers([line("small", "p-marg", "pizza", 20000, 1, "small"), line("large", "p-marg", "pizza", 30000, 1, "large")], [bogo({ sameItemOnly: true })], ctx());
      expect(result.applied).toEqual([]);
    });

    it("without sameItemOnly mixes products: the cheaper unit is the reward", () => {
      const result = applyOffers([line("marg", "p-marg", "pizza", 29900, 1), line("farm", "p-farm", "pizza", 34900, 1)], [bogo()], ctx());
      expect(result.lineDiscounts).toEqual(new Map([["marg", 29900]]));
    });

    it("does not apply on a single unit (no complete set)", () => {
      const result = applyOffers([line("marg", "p-marg", "pizza", 29900, 1)], [bogo()], ctx());
      expect(result.applied).toEqual([]);
      expect(result.lineDiscounts.size).toBe(0);
    });

    it("buy 2 get 1 on five units rewards the cheapest, uses the next two cheapest and leaves the dearest free", () => {
      const five = [100, 90, 80, 70, 60].map((price, i) => line(`l${i + 1}`, `p${i + 1}`, "x", price, 1));
      const threeFor2 = offer({ id: "b2g1", kind: "buy_get", buyQty: 2, getQty: 1, percentBp: 10000, categoryIds: ["x"], createdAt: 1 });
      const alone = applyOffers(five, [threeFor2], ctx());
      expect(alone.lineDiscounts).toEqual(new Map([["l5", 60]]));

      // A second offer on the same set proves 100 and 90 were left free (and 80, 70, 60 were used).
      const tenPercent = offer({ id: "ten", kind: "item_off", percentBp: 1000, categoryIds: ["x"], createdAt: 2 });
      const both = applyOffers(five, [tenPercent, threeFor2], ctx());
      expect(both.applied.map((a) => [a.offerId, a.discountPaise])).toEqual([["b2g1", 60], ["ten", 19]]);
      expect(both.lineDiscounts).toEqual(new Map([["l1", 10], ["l2", 9], ["l5", 60]]));
    });

    it("applies as many sets as the units allow", () => {
      const result = applyOffers([line("marg", "p-marg", "pizza", 29900, 5)], [bogo()], ctx());
      expect(result.lineDiscounts).toEqual(new Map([["marg", 29900 * 2]]));
    });

    it("gives a part-price reward, rounding half up per unit", () => {
      const half = bogo({ percentBp: 5000 });
      const result = applyOffers([line("a", "p-a", "pizza", 29901, 2)], [half], ctx());
      expect(result.lineDiscounts).toEqual(new Map([["a", 14951]]));
    });

    it("matches products as well as categories, and a product covers all its variants", () => {
      const byProduct = bogo({ categoryIds: [], productIds: ["p-marg"] });
      const result = applyOffers([line("s", "p-marg", "pizza", 20000, 1, "small"), line("l", "p-marg", "pizza", 30000, 1, "large"), line("f", "p-farm", "pizza", 10000, 1)], [byProduct], ctx());
      expect(result.lineDiscounts).toEqual(new Map([["s", 20000]]));
    });
  });

  describe("item_off", () => {
    it("takes a percentage off every unit in the set", () => {
      const result = applyOffers([line("a", "p-a", "bev", 6000, 3)], [offer({ id: "o", percentBp: 1000, categoryIds: ["bev"] })], ctx());
      expect(result.lineDiscounts).toEqual(new Map([["a", 1800]]));
    });

    it("takes a fixed amount off each unit, never more than the unit price", () => {
      const o = offer({ id: "o", amountPaise: 5000, categoryIds: ["bev"] });
      const result = applyOffers([line("cheap", "p-a", "bev", 3000, 2), line("dear", "p-b", "bev", 9000, 1)], [o], ctx());
      expect(result.lineDiscounts).toEqual(new Map([["cheap", 6000], ["dear", 5000]]));
    });

    it("rounds each unit half up", () => {
      const o = offer({ id: "o", percentBp: 1250, categoryIds: ["bev"] });
      // 1250 bp of 10 paise is 1.25 -> 1; of 14 paise is 1.75 -> 2; of 12 paise is exactly 1.5 -> 2.
      const result = applyOffers([line("a", "p-a", "bev", 10, 1), line("b", "p-b", "bev", 14, 1), line("c", "p-c", "bev", 12, 1)], [o], ctx());
      expect(result.lineDiscounts).toEqual(new Map([["a", 1], ["b", 2], ["c", 2]]));
    });

    it("leaves lines outside its categories and products alone", () => {
      const result = applyOffers([line("a", "p-a", "food", 10000, 1)], [offer({ id: "o", percentBp: 1000, categoryIds: ["bev"] })], ctx());
      expect(result.applied).toEqual([]);
    });
  });

  describe("overlapping offers", () => {
    it("lets a unit used by BOGO escape other offers, and a free unit take another (Margherita x3)", () => {
      const pizzaTenPercent = offer({ id: "pizza10", name: "Pizza 10%", kind: "item_off", percentBp: 1000, categoryIds: ["pizza"], createdAt: 2 });
      const result = applyOffers([line("marg", "p-marg", "pizza", 29900, 3)], [bogo({ createdAt: 1 }), pizzaTenPercent], ctx());
      expect(result.lineDiscounts).toEqual(new Map([["marg", 29900 + 2990]]));
      expect(result.applied.map((a) => [a.offerId, a.discountPaise])).toEqual([["bogo", 29900], ["pizza10", 2990]]);
    });

    it("applies the bigger saving first, whatever the creation order", () => {
      const small = offer({ id: "small", percentBp: 1000, categoryIds: ["bev"], createdAt: 1 });
      const big = offer({ id: "big", percentBp: 2000, categoryIds: ["bev"], createdAt: 2 });
      const result = applyOffers([line("a", "p-a", "bev", 10000, 1)], [small, big], ctx());
      expect(result.applied.map((a) => [a.offerId, a.discountPaise])).toEqual([["big", 2000]]);
      expect(result.lineDiscounts).toEqual(new Map([["a", 2000]]));
    });

    it("breaks equal savings in favour of the earlier-created offer", () => {
      const first = offer({ id: "first", percentBp: 1000, categoryIds: ["bev"], createdAt: 1 });
      const second = offer({ id: "second", amountPaise: 1000, categoryIds: ["bev"], createdAt: 2 });
      const result = applyOffers([line("a", "p-a", "bev", 10000, 1)], [second, first], ctx());
      expect(result.applied.map((a) => a.offerId)).toEqual(["first"]);
    });

    it("keeps applied in the order the offers were applied, with item offers before the bill offer", () => {
      const result = applyOffers(lines, [offers[2]!, offers[1]!, offers[0]!], ctx());
      expect(result.applied.map((a) => a.offerId)).toEqual(["bogo", "cool", "big"]);
    });
  });

  describe("bill_off", () => {
    const big = (partial: Partial<Offer> = {}) => offer({ id: "big", name: "Big Bill", kind: "bill_off", percentBp: 1000, minBillPaise: 50000, ...partial });
    const food = [line("a", "p-a", "food", 30000, 1), line("b", "p-b", "food", 30000, 1)];

    it("needs the items total (after item offers) to reach the minimum", () => {
      expect(applyOffers(food, [big({ minBillPaise: 60000 })], ctx()).applied.map((a) => a.discountPaise)).toEqual([6000]);
      expect(applyOffers(food, [big({ minBillPaise: 60001 })], ctx()).applied).toEqual([]);

      // Item offers can bring the bill under the minimum: 60000 - 20% = 48000 < 50000.
      const cut = offer({ id: "cut", kind: "item_off", percentBp: 2000, categoryIds: ["food"], createdAt: 5 });
      const result = applyOffers(food, [cut, big()], ctx());
      expect(result.applied.map((a) => a.offerId)).toEqual(["cut"]);
    });

    it("applies only the larger of two bill offers", () => {
      const ten = big({ id: "ten", percentBp: 1000, minBillPaise: 0, createdAt: 1 });
      const flat = big({ id: "flat", percentBp: null, amountPaise: 7000, minBillPaise: 0, createdAt: 2 });
      const result = applyOffers(food, [ten, flat], ctx());
      expect(result.applied.map((a) => [a.offerId, a.discountPaise])).toEqual([["flat", 7000]]);
      expect(result.lineDiscounts).toEqual(new Map([["a", 3500], ["b", 3500]]));
    });

    it("breaks equal bill offers in favour of the earlier-created one", () => {
      const a = big({ id: "a", createdAt: 2, minBillPaise: 0 });
      const b = big({ id: "b", createdAt: 1, minBillPaise: 0 });
      expect(applyOffers(food, [a, b], ctx()).applied.map((x) => x.offerId)).toEqual(["b"]);
    });

    it("caps a percentage at maxDiscountPaise", () => {
      const result = applyOffers(food, [big({ minBillPaise: 0, maxDiscountPaise: 2500 })], ctx());
      expect(result.applied.map((a) => a.discountPaise)).toEqual([2500]);
      expect(result.lineDiscounts).toEqual(new Map([["a", 1250], ["b", 1250]]));
    });

    it("never takes off more than what is left", () => {
      const result = applyOffers([line("a", "p-a", "food", 3000, 1)], [big({ percentBp: null, amountPaise: 5000, minBillPaise: 0 })], ctx());
      expect(result.applied.map((a) => a.discountPaise)).toEqual([3000]);
      expect(result.lineDiscounts).toEqual(new Map([["a", 3000]]));
    });

    it("spreads the discount by what each line is worth after item offers, keeping every paisa", () => {
      const result = applyOffers([line("a", "p-a", "food", 10000, 1), line("b", "p-b", "food", 10000, 1), line("c", "p-c", "food", 10000, 1)], [big({ percentBp: null, amountPaise: 1000, minBillPaise: 0 })], ctx());
      expect([...result.lineDiscounts.values()].reduce((sum, n) => sum + n, 0)).toBe(1000);
      expect(result.applied[0]!.perLine.reduce((sum, p) => sum + p.discountPaise, 0)).toBe(1000);
      expect(result.lineDiscounts).toEqual(new Map([["a", 334], ["b", 333], ["c", 333]]));
    });
  });

  describe("eligibility", () => {
    it("skips offers that are not running", () => {
      const result = applyOffers(lines, [bogo({ active: false }), bogo({ id: "weekend", days: [5, 6] }), bogo({ id: "lunch", timeFrom: 540, timeUntil: 600 })], ctx());
      expect(result.applied).toEqual([]);
      expect(result.removed).toEqual([]);
    });

    it("gives an aggregator order no offers", () => {
      const result = applyOffers(lines, offers, ctx({ orderTypeKind: "aggregator" }));
      expect(result).toEqual({ lineDiscounts: new Map(), applied: [], removed: [] });
    });

    it("lists an offer the cashier removed as removed, not applied", () => {
      const result = applyOffers(lines, offers, ctx({ removedOfferIds: ["cool"] }));
      expect(result.applied.map((a) => a.offerId)).toEqual(["bogo", "big"]);
      expect(result.removed).toEqual([{ offerId: "cool", name: "Cool Drinks" }]);
      // Big Bill is worked out without Cool Drinks: 106700 - 29900 = 76800 -> 7680.
      expect(result.applied[1]!.discountPaise).toBe(7680);
    });

    it("lists a removed offer that would have saved nothing, as long as it is running", () => {
      const result = applyOffers([line("a", "p-a", "food", 10000, 1)], [bogo()], ctx({ removedOfferIds: ["bogo"] }));
      expect(result.removed).toEqual([{ offerId: "bogo", name: "BOGO Pizza" }]);
    });

    it("leaves a removed offer that would not run anyway out of both lists", () => {
      const result = applyOffers(lines, [bogo({ days: [5, 6] }), bogo({ id: "off", active: false })], ctx({ removedOfferIds: ["bogo", "off"] }));
      expect(result.applied).toEqual([]);
      expect(result.removed).toEqual([]);
    });
  });
});
