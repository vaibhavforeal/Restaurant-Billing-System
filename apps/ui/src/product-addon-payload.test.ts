import { describe, expect, it } from "vitest";
import { productAddonPayload } from "./product-addon-payload";

const groups = [{ id: "a", isActive: true }, { id: "b", isActive: true }, { id: "archived", isActive: false }];
const base = { isCombo: false, addonOnly: false, addonGroupIds: ["a", "archived"], groups };

describe("product add-on payload", () => {
  it("clears existing attachments in the same PATCH that enables add-on only", () => {
    expect(productAddonPayload({ ...base, product: { addonOnly: false, addonGroupIds: ["a", "archived"] }, addonOnly: true }))
      .toEqual({ addonOnly: true, addonGroupIds: [] });
  });
  it("creates an add-on-only product with no attachments", () => {
    expect(productAddonPayload({ ...base, product: null, addonOnly: true }))
      .toEqual({ addonOnly: true, addonGroupIds: [] });
  });
  it("omits add-on fields for combos", () => {
    expect(productAddonPayload({ ...base, product: null, isCombo: true, addonOnly: true })).toEqual({});
  });
  it("preserves unchanged archived attachments by omitting the replacement field", () => {
    expect(productAddonPayload({ ...base, product: { addonGroupIds: ["a", "archived"] } }))
      .toEqual({ addonOnly: false });
  });
  it("replaces changed attachments with active groups in the selected order", () => {
    expect(productAddonPayload({ ...base, product: { addonGroupIds: ["a"] }, addonGroupIds: ["b", "archived", "a"] }))
      .toEqual({ addonOnly: false, addonGroupIds: ["b", "a"] });
  });
  it("sends selected groups when changing an add-on-only product back to a dish", () => {
    expect(productAddonPayload({ ...base, product: { addonOnly: true, addonGroupIds: [] } }))
      .toEqual({ addonOnly: false, addonGroupIds: ["a"] });
  });
});
