import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BreakdownChart, TimeChart, plotRange } from "./DashboardCharts";

describe("dashboard chart scales", () => {
  it("includes refunds and comparisons on one scale", () => {
    const range = plotRange([{ label: "Today", value: -12000 }], [{ label: "Yesterday", value: 27000 }]);
    expect(range.min).toBeLessThanOrEqual(-12000);
    expect(range.max).toBeGreaterThanOrEqual(27000);
  });

  it("keeps a nonzero scale for empty and zero data", () => {
    for (const points of [[], [{ label: "00", value: 0 }]]) {
      const range = plotRange(points);
      expect(range.max).toBeGreaterThan(range.min);
    }
  });

  it("shows exact category amounts without selecting or hovering", () => {
    const html = renderToStaticMarkup(createElement(BreakdownChart, { points: [{ label: "Cash", value: 15000 }], compare: [{ label: "Cash", value: 10000 }], format: "money", title: "Payments", compareLabel: "Yesterday" }));
    expect(html).toContain("₹150.00");
    expect(html).toContain("Yesterday: ");
    expect(html).toContain("₹100.00");
  });

  it("renders a one-point negative time series with exact-value controls", () => {
    const html = renderToStaticMarkup(createElement(TimeChart, { points: [{ label: "2 Nov", value: -15000 }], format: "money", title: "Daily trend", compareLabel: "Yesterday" }));
    expect(html).toContain("-₹150.00");
    expect(html).toContain("Next Daily trend value");
    expect(html).not.toMatch(/NaN|Infinity/);
  });
});
