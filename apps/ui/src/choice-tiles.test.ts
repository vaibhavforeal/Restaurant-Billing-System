import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ChoiceTiles } from "./ChoiceTiles";

describe("choice tiles", () => {
  it("exposes each choice and the current value as native radios", () => {
    const html = renderToStaticMarkup(h(ChoiceTiles, { "aria-label": "Unit", value: "kg", onChange: () => {} },
      h("option", null, "pcs"), h("option", null, "kg")));
    expect(html).not.toContain("<select");
    expect(html).toContain('role="radiogroup"');
    expect(html).toMatch(/type="radio"[^>]*checked=""[^>]*value="kg"/);
    expect(html).toContain('value="pcs"');
  });

  it("does not allow an empty placeholder to satisfy a required choice", () => {
    const html = renderToStaticMarkup(h(ChoiceTiles, { "aria-label": "Category", value: "", required: true, onChange: () => {} },
      h("option", { value: "" }, "Choose a category"), h("option", { value: "food" }, "Food")));
    expect(html).toContain('type="radio"');
    expect(html).toContain('required=""');
    expect(html).not.toContain('checked=""');
  });

  it("keeps grouped, disabled and numeric choices available with their labels", () => {
    const html = renderToStaticMarkup(h(ChoiceTiles, { "aria-label": "Paper", value: 80, disabled: true, onChange: () => {} },
      h("optgroup", { label: "Paper widths" }, h("option", { value: 80 }, "80mm"), h("option", { value: 58 }, "58mm"))));
    expect(html).toContain("Paper widths");
    expect(html.match(/type="radio"/g)).toHaveLength(2);
    expect(html.match(/disabled=""/g)).toHaveLength(2);
    expect(html).toMatch(/checked=""[^>]*value="80"/);
  });
});
