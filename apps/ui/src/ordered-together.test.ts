import { describe, expect, it } from "vitest";
import { suggestTogether } from "./ordered-together";

const catalog = [
  { id: "biryani", categoryId: "mains", isSoldOut: false },
  { id: "dal", categoryId: "mains", isSoldOut: false },
  { id: "raita", categoryId: "sides", isSoldOut: false },
  { id: "papad", categoryId: "sides", isSoldOut: false },
  { id: "lassi", categoryId: "drinks", isSoldOut: false },
  { id: "soda", categoryId: "drinks", isSoldOut: false },
  { id: "kulfi", categoryId: "desserts", isSoldOut: false },
  { id: "halwa", categoryId: "desserts", isSoldOut: true },
];
const pair = (productId: string, variantId: string | null = null) => ({ productId, variantId });
const cart = (...ids: string[]) => ids.map((productId) => ({ productId }));

describe("suggestTogether", () => {
  it("suggests the cart's partners in rank order, at most one per category and three in all", () => {
    const pairs = { biryani: [pair("raita"), pair("papad"), pair("lassi", "large"), pair("kulfi"), pair("soda")] };
    expect(suggestTogether(cart("biryani"), pairs, catalog)).toEqual([pair("raita"), pair("lassi", "large"), pair("kulfi")]);
  });

  it("skips dishes in the cart, categories already in the cart, sold-out and unknown dishes", () => {
    const pairs = { biryani: [pair("halwa"), pair("gone"), pair("soda"), pair("raita")], lassi: [pair("biryani"), pair("dal"), pair("kulfi")] };
    expect(suggestTogether(cart("biryani", "lassi"), pairs, catalog)).toEqual([pair("kulfi"), pair("raita")]);
  });

  it("puts dishes suggested by more of the cart first", () => {
    const pairs = { biryani: [pair("raita"), pair("kulfi")], lassi: [pair("kulfi")] };
    expect(suggestTogether(cart("biryani", "lassi"), pairs, catalog)).toEqual([pair("kulfi"), pair("raita")]);
  });

  it("prefers the latest dish's partners when counts tie", () => {
    const pairs = { biryani: [pair("raita")], lassi: [pair("kulfi")] };
    expect(suggestTogether(cart("biryani", "lassi"), pairs, catalog)).toEqual([pair("kulfi"), pair("raita")]);
  });

  it("suggests nothing for an empty cart or without pairs", () => {
    expect(suggestTogether([], { biryani: [pair("raita")] }, catalog)).toEqual([]);
    expect(suggestTogether(cart("biryani"), {}, catalog)).toEqual([]);
  });
});
