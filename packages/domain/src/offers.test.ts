import { describe, expect, it } from "vitest";
import { bestOffer, inOfferWindow, type Offer } from "./offers.js";

const base: Offer = { id: "old", name: "Lunch", createdAt: 1, revision: 1, state: "active", minimumPaise: 0,
  kinds: ["takeaway"], weekdays: [0,1,2,3,4,5,6], firstDate: null, lastDate: null, startTime: null, endTime: null,
  benefit: { kind: "percent", percent: 15 } };
const item = (id: string, qty: number, pricePaise: number) => ({ id, productId: id, variantId: null, qty, pricePaise });
const target = (productId: string, variantId: string | null = null) => ({ productId, variantId });
const now = new Date(2026, 10, 20, 12).getTime();
describe("automatic offers", () => {
  it("uses inclusive local start dates and weekdays across midnight, with an exclusive end time", () => {
    const friday = { ...base, weekdays: [5], firstDate: "2026-11-20", lastDate: "2026-11-20", startTime: "22:00", endTime: "02:00" };
    for (const [day, hour, expected] of [[20,21,false], [20,22,true], [21,1,true], [21,2,false], [27,23,false]] as const)
      expect(inOfferWindow(friday, new Date(2026,10,day,hour).getTime())).toBe(expected);
  });
  it("uses gross merchandise thresholds, caps savings and keeps the first equal winner", () => {
    const rules: Offer[] = [{ ...base, minimumPaise: 200 }, { ...base, id: "new" }];
    expect(bestOffer(rules, [item("tea", 1, 199)], "takeaway", now)?.id).toBe("new");
    expect(bestOffer(rules, [item("tea", 1, 200)], "takeaway", now)).toMatchObject({ id: "old", savingPaise: 30 });
    expect(bestOffer(rules, [item("tea", 1, 200)], "delivery", now)).toBeNull();
    expect(bestOffer([{ ...base, benefit: { kind: "fixed", paise: 999 } }], [item("a",1,45), item("b",1,106)], "takeaway", now)?.allocations).toEqual({ a:45, b:106 });
  });
  it("maximizes complete groups and reserves enough overlapping units for the buy side", () => {
    const rule: Offer = { ...base, benefit: { kind: "bogo", buy: 2, get: 1, qualifying: [target("pizza")], rewards: [target("pizza"), target("drink","large")] } };
    const basket = [item("pizza",5,100), { ...item("drink",1,300), variantId:"large" }, { ...item("extra",1,1), productId:"pizza", addonOfItemId:"pizza" },
      { ...item("small",1,1), productId:"drink", variantId:"small" }];
    expect(bestOffer([rule], basket, "takeaway", now)?.allocations).toEqual({ pizza:100, drink:300 });
    expect(bestOffer([rule], [item("pizza",2,100)], "takeaway", now)).toBeNull();
    expect(bestOffer([{ ...rule, benefit: { kind:"bogo", buy:1, get:1, qualifying:[target("pizza")], rewards:[target("pizza")] } }],
      [item("pizza",4,100)], "takeaway", now)?.savingPaise).toBe(200);
  });
});
