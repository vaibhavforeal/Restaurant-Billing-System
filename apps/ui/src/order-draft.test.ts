import { describe, expect, it } from "vitest";
import { addDraftRows, type DraftItem } from "./order-draft";

const dish = { productId: "dish", variantId: null, name: "Dish", pricePaise: 12000, qty: 1 };

function add(draft: DraftItem[], rows: Array<Omit<DraftItem, "clientRef" | "note">>, queued = new Set<string>()) {
  let ref = 0;
  return addDraftRows(draft, rows, queued, () => `new-${++ref}`);
}

describe("addDraftRows", () => {
  it("increments the existing row and retains its identity", () => {
    const original = { ...dish, clientRef: "existing", note: "" };
    expect(add([original], [dish, dish])).toEqual([{ ...original, qty: 3 }]);
    expect(original.qty).toBe(1);
  });

  it("matches selections regardless of order and separates different configurations", () => {
    const configured = { ...dish, comboPicks: ["rice", "dal"], addonPicks: ["sauce", "salad"] };
    const result = add([], [
      configured,
      { ...configured, comboPicks: ["dal", "rice"], addonPicks: ["salad", "sauce"] },
      { ...configured, addonPicks: ["sauce"] },
      { ...configured, comboPicks: ["rice", "bread"] },
      { ...configured, variantId: "large" },
      { ...configured, pricePaise: 13000 },
    ]);
    expect(result.map((row) => row.qty)).toEqual([2, 1, 1, 1, 1]);
  });

  it("keeps queued, held, and noted rows separate", () => {
    const special = [
      { ...dish, clientRef: "queued", note: "" },
      { ...dish, clientRef: "held", note: "", held: true },
      { ...dish, clientRef: "noted", note: "No onion" },
    ];
    expect(add(special, [dish], new Set(["queued"]))).toEqual([
      ...special,
      { ...dish, clientRef: "new-1", note: "" },
    ]);
  });

  it("fills existing duplicate rows up to 99 and puts overflow on a new row", () => {
    const draft = [
      { ...dish, clientRef: "first", note: "", qty: 98 },
      { ...dish, clientRef: "second", note: "", qty: 98 },
    ];
    expect(add(draft, [{ ...dish, qty: 3 }]).map(({ clientRef, qty }) => [clientRef, qty])).toEqual([
      ["first", 99],
      ["second", 99],
      ["new-1", 1],
    ]);
  });
});
