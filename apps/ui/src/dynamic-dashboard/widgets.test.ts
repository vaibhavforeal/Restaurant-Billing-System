import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DASHBOARD_WIDGETS, type WidgetDef, type WidgetResult } from "@masalapos/domain/dashboard";
import { BarChart } from "./charts";
import { WidgetBody } from "./widgets";

const def = (id: string): WidgetDef => (DASHBOARD_WIDGETS as readonly WidgetDef[]).find((w) => w.id === id)!;
const kpi = (current: number, compare: number | null): WidgetResult => ({
  ok: true, range: null, current: { kind: "number", value: current, format: "money" },
  compareRange: null, compare: compare === null ? null : { kind: "number", value: compare, format: "money" },
});
const render = (widget: WidgetDef, result: WidgetResult | undefined) => renderToStaticMarkup(createElement(WidgetBody, { def: widget, result, onRetry: () => {} }));
const kpiDef = (): WidgetDef => (DASHBOARD_WIDGETS as readonly WidgetDef[]).find((w) => w.kind === "kpi")!;

describe("widget renderers", () => {
  it("shows a KPI with its change against the comparison", () => {
    const html = render(kpiDef(), kpi(15000, 10000));
    expect(html).toContain("150.00");
    expect(html).toContain("50%");
  });

  it("shows a dash when the comparison is zero", () => {
    const html = render(kpiDef(), kpi(15000, 0));
    expect(html).toContain("—");
    expect(html).not.toContain("%");
  });

  it("shows an error with a retry button", () => {
    const html = render(kpiDef(), { ok: false, error: "Could not load" });
    expect(html).toContain("Could not load");
    expect(html).toContain("Retry");
    expect(html).toContain('type="button"');
  });

  it("draws one bar per point and scales to the largest value", () => {
    const html = renderToStaticMarkup(createElement(BarChart, { format: "count", points: [{ label: "a", value: 5 }, { label: "b", value: 10 }, { label: "c", value: 0 }] }));
    expect(html.match(/dd-bar-track/g)).toHaveLength(3);
    expect(html).toContain("height:100%");
    expect(html).toContain("height:50%");
    expect(html).not.toContain("NaN");
  });

  it("formats negative money from credit notes", () => {
    const html = render(kpiDef(), kpi(-1500, null));
    expect(html).toContain("-₹15.00");
  });
});

describe("BoardUI widget styling", () => {
  it("shows the change as a coloured chip with screen-reader direction", () => {
    const up = render(kpiDef(), kpi(15000, 10000));
    expect(up).toContain("bg-status-lime-background");
    expect(up).toContain('aria-hidden="true">▲');
    expect(up).toContain("up </span>vs");
    const down = render(kpiDef(), kpi(10000, 15000));
    expect(down).toContain("bg-status-rose-background");
    expect(down).toContain('aria-hidden="true">▼');
    expect(down).toContain("down </span>vs");
  });

  it("shows no-comparison and unchanged as neutral chips", () => {
    expect(render(kpiDef(), kpi(15000, 15000))).toContain("bg-background-tertiary-default");
    expect(render(kpiDef(), kpi(15000, 0))).toContain("bg-background-tertiary-default");
  });

  it("shows a BoardUI skeleton while loading, still announced as busy", () => {
    const html = render(kpiDef(), undefined);
    expect(html).toContain("bui-skeleton");
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain(`aria-label="Loading ${kpiDef().title}"`);
  });

  it("renders the retry action as a BoardUI secondary button", () => {
    const html = render(kpiDef(), { ok: false, error: "Could not load" });
    expect(html).toContain('role="alert"');
    expect(html).toContain("border-border-button-default");
    expect(html).toContain(">Retry<");
  });
});
