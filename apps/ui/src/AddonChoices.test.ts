import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AddonChoices, AddonLines } from "./AddonChoices";
import { BillItemLines } from "./screens/CreditNoteDialog";
import type { AddonPickerGroup, OrderItem } from "./types";
const groups: AddonPickerGroup[] = [{ id: "toppings", name: "Toppings", minPicks: 0, maxPicks: 1, options: [
  { id: "cheese", productId: "cheese", variantId: null, name: "Extra cheese", pricePaise: 3000 },
  { id: "corn", productId: "corn", variantId: null, name: "Corn", pricePaise: 1500, unavailable: true },
  { id: "olive", productId: "olive", variantId: null, name: "Olives", pricePaise: 2000 },
] }];
describe("add-on presentation", () => {
  it("shows group limits, prices, and disabled unavailable options", () => {
    const html = renderToStaticMarkup(createElement(AddonChoices, { groups, picks: [], onChange: () => {} }));
    expect(html).toContain("Up to 1");
    expect(html).toContain("30.00");
    expect(html).toContain("Sold out or unavailable");
    expect((html.match(/disabled=""/g) ?? []).length).toBe(1);
  });
  it("leaves a selected optional pick removable while blocking further picks at the maximum", () => {
    const html = renderToStaticMarkup(createElement(AddonChoices, { groups, picks: ["cheese"], onChange: () => {} }));
    expect((html.match(/disabled=""/g) ?? []).length).toBe(2);
    expect(html).toContain('type="checkbox" checked=""');
  });
  it("does not render archived groups or their hints", () => {
    const html = renderToStaticMarkup(createElement(AddonChoices, { groups: [{ ...groups[0]!, isActive: false }], picks: [], onChange: () => {} }));
    expect(html).not.toContain("Toppings");
  });
  it("prices every receipt add-on at the dish quantity", () => {
    const html = renderToStaticMarkup(createElement(AddonLines, { addons: [{ name: "Extra cheese", pricePaise: 3000 }, { name: "Olives", pricePaise: 2000 }], qty: 2 }));
    expect(html).toContain("+ Extra cheese");
    expect(html).toContain("60.00");
    expect(html).toContain("40.00");
    expect(html).not.toContain("button");
  });
  it("shows add-ons under their dish with independent billed and refunded quantities", () => {
    const base = { clientRef: null, productId: "p", variantId: null, name: "Pizza", pricePaise: 10000, gstRate: 5, qty: 2, status: "sent", note: null, cancelReason: null, kotId: null } as const;
    const items: OrderItem[] = [{ ...base, id: "addon", addonOfItemId: "dish", name: "Extra cheese", pricePaise: 3000 }, { ...base, id: "dish" }];
    const html = renderToStaticMarkup(createElement(BillItemLines, { items, refundedQty: { addon: 1 }, showRefunded: true }));
    expect(html.indexOf("Pizza")).toBeLessThan(html.indexOf("+ Extra cheese"));
    expect(html).toContain("addon-line");
    expect(html).toContain("60.00");
    expect(html).toContain("1 refunded");
    expect(html).toContain("0 refunded");
  });
});
