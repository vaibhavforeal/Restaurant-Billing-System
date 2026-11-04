import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DASHBOARD_WIDGETS, type DashboardItemValue, type WidgetDef } from "@masalapos/domain/dashboard";
import { EditToolbar } from "./EditToolbar";
import { addWidget } from "./editing";
import { CatalogueList } from "./WidgetCatalogue";
import { WidgetSettingsForm } from "./WidgetSettings";

const defs = DASHBOARD_WIDGETS as readonly WidgetDef[];
const itemFor = (def: WidgetDef): DashboardItemValue => addWidget([], def.id, "k1")[0]!;
const withOption = (option: keyof WidgetDef["options"]) => defs.find((d) => d.options[option])!;
const noop = () => undefined;

const toolbar = (props: Partial<Parameters<typeof EditToolbar>[0]> = {}) => renderToStaticMarkup(createElement(EditToolbar, {
  editing: true, busy: false, full: false, onCustomise: noop, onAdd: noop, onReset: noop, onCancel: noop, onSave: noop, ...props,
}));
const settings = (def: WidgetDef, zomatoActive = true) => renderToStaticMarkup(createElement(WidgetSettingsForm, { item: itemFor(def), zomatoActive, onChange: noop, onDone: noop }));

describe("edit toolbar", () => {
  it("offers only Customise when not editing", () => {
    const html = toolbar({ editing: false });
    expect(html).toContain("Customise");
    expect(html).not.toContain("Add widget");
    expect(html).not.toContain("Save");
  });

  it("offers Add widget, Reset to default, Cancel and Save while editing", () => {
    const html = toolbar();
    for (const text of ["Add widget", "Reset to default", "Cancel", "Save"]) expect(html).toContain(text);
    expect(html).not.toContain("Customise");
  });

  it("disables Add widget with an explanation when the dashboard is full", () => {
    const add = toolbar({ full: true }).match(/<button[^>]*>(?:(?!<\/button>).)*Add widget/s)?.[0] ?? "";
    expect(add).toContain('title="Your dashboard is full"');
    expect(add).toMatch(/\sdisabled=""/);
  });

  it("disables everything and says Saving… while busy", () => {
    const html = toolbar({ busy: true });
    expect(html).toContain("Saving…");
    expect(html.match(/<button/g)!.length).toBe(html.match(/\sdisabled=""/g)!.length);
  });
});

describe("widget settings form", () => {
  it("shows period and compare for a KPI, not the top-N choice", () => {
    const html = settings(defs.find((d) => d.options.period && d.options.compare && !d.options.topN && !d.options.orderType)!);
    expect(html).toContain("Period");
    expect(html).toContain("Compare with");
    expect(html).not.toContain("How many items");
  });

  it("shows the top-N choice only for widgets that support it", () => {
    expect(settings(withOption("topN"))).toContain("How many items");
  });

  it("hides the Zomato order type unless the Zomato module is on", () => {
    const def = withOption("orderType");
    expect(settings(def, true)).toContain("Zomato");
    expect(settings(def, false)).not.toContain("Zomato");
    expect(settings(def, false)).toContain("Takeaway");
  });
});

describe("widget catalogue list", () => {
  it("groups widgets under Numbers, Charts and Live service with their descriptions", () => {
    const html = renderToStaticMarkup(createElement(CatalogueList, { defs, onPick: noop }));
    for (const heading of ["Numbers", "Charts", "Live service"]) expect(html).toContain(heading);
    for (const def of defs) { expect(html).toContain(def.title); expect(html).toContain(def.description); }
  });

  it("says so when nothing is available", () => {
    expect(renderToStaticMarkup(createElement(CatalogueList, { defs: [], onPick: noop }))).toContain("No widgets are available for your account.");
  });
});
