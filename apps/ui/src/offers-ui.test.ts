import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { OfferForm } from "./screens/OfferForm";
import { OffersList } from "./screens/OffersManager";
import { offerForm, parseOfferForm, type OfferFormState } from "./offer-form";
import type { OrderTypeInfo } from "./types";

const categories = [{ id: "pizza", name: "Pizzas", isActive: true }, { id: "old", name: "Old category", isActive: false }];
const products = [{ id: "dish", name: "Margherita", isActive: true }, { id: "archived", name: "Old dish", isActive: false }];
const orderTypes: OrderTypeInfo[] = [
  { id: "dine", name: "Dine-in", kind: "dine_in", isActive: true, isSystem: true, sortOrder: 0 },
  { id: "zomato", name: "Zomato", kind: "aggregator", isActive: true, isSystem: true, sortOrder: 1 },
];
function form(patch: Partial<OfferFormState> = {}, errors = {}) {
  return renderToStaticMarkup(createElement(OfferForm, { value: { ...offerForm(), ...patch }, categories, products, orderTypes, errors, error: "", busy: false, onChange: () => {}, onSave: () => {}, onCancel: () => {} }));
}
describe("offer editor presentation", () => {
  it("shows only buy/get fields and labels the percentage as a reward", () => {
    const html = form();
    for (const label of ["Buy quantity", "Get quantity", "Same item only", "Discount on reward items (%)", "Categories", "Items"]) expect(html).toContain(label);
    expect(html).not.toContain("Minimum bill"); expect(html).not.toContain("Maximum discount"); expect(html).not.toContain("Discount type");
  });
  it("shows item discounts and no buy quantities or bill limits", () => {
    const html = form({ kind: "item_off", discountMode: "amount" });
    expect(html).toContain("Discount per item (₹)"); expect(html).toContain("Categories");
    for (const label of ["Buy quantity", "Same item only", "Minimum bill", "Maximum discount"]) expect(html).not.toContain(label);
  });
  it("shows minimums and percentage caps only on bill offers", () => {
    const html = form({ kind: "bill_off" });
    expect(html).toContain("Minimum bill"); expect(html).toContain("Maximum discount"); expect(html).not.toContain("<legend>Categories");
    expect(form({ kind: "bill_off", discountMode: "amount" })).not.toContain("Maximum discount");
  });
  it("excludes aggregator choices and keeps inactive selections visible and removable", () => {
    const html = form({ categoryIds: ["old"], productIds: ["archived"], orderTypeIds: [""] });
    expect(html).toContain("Old category (Inactive)"); expect(html).toContain("Old dish (Inactive)");
    expect(html).toContain('aria-label="Remove item 1"'); expect(html).toContain('value="dine"'); expect(html).not.toContain('value="zomato"');
    expect(form({ productIds: [""] })).not.toContain("Old dish");
  });
  it("shows overnight help and associates validation messages with controls", () => {
    const html = form({ timeFrom: "22:00", timeUntil: "02:00" }, { name: "Enter a name", timeFrom: "Set both times" });
    expect(html).toContain("Ends next morning"); expect(html).toContain('aria-invalid="true"'); expect(html).toContain('aria-describedby=');
    expect(html).toContain("Enter a name"); expect(html).toContain("Set both times"); expect(html).toContain('role="alert"');
  });
  it("associates the schema's missing-discount error with the visible amount input", () => {
    const html = form({ kind: "item_off", discountMode: "amount" }, { percentBp: "Set either a percentage or an amount" });
    expect(html).toMatch(/<input[^>]*aria-invalid="true"[^>]*aria-describedby="[^"]*-percentBp-error"/);
    expect(html).toContain("Set either a percentage or an amount");
  });
});
describe("offers list presentation", () => {
  const value = parseOfferForm({ ...offerForm(), name: "BOGO Pizza", categoryIds: ["pizza"] }).value!;
  const list = (used: boolean, active = true) => renderToStaticMarkup(createElement(OffersList, { offers: [{ ...value, id: "deal", createdAt: 1, bills30d: 12, used, active }], choices: { categories, products, orderTypes }, busy: false, onEdit: () => {}, onToggle: () => {}, onDelete: () => {} }));
  it("shows usage, summary, switch state and deletion for an unused offer", () => {
    const html = list(false, false);
    expect(html).toContain("12 bills in 30 days"); expect(html).toContain("Buy 1 get 1 free · Pizzas"); expect(html).toContain('aria-checked="false"'); expect(html).toContain('aria-label="Delete BOGO Pizza"');
  });
  it("hides deletion for offers on any bill", () => {
    expect(list(true)).not.toContain('aria-label="Delete'); expect(list(true)).toContain("Switch it off instead");
  });
  it("explains the empty state", () => {
    expect(renderToStaticMarkup(createElement(OffersList, { offers: [], choices: { categories, products, orderTypes }, busy: false, onEdit: () => {}, onToggle: () => {}, onDelete: () => {} }))).toContain("No offers yet");
  });
});
