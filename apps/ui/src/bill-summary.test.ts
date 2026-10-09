import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BillSummary } from "./screens/BillingPanel";

const totals = { subtotalPaise: 10000, discountPaise: 0, roundingPaise: 0, totalPaise: 10000, taxablePaise: 10000, cgstPaise: 0, sgstPaise: 0, taxes: [{ gstRate: 0, taxablePaise: 10000, cgstPaise: 0, sgstPaise: 0 }] };

describe("BillSummary Includes GST line", () => {
  it("shows the GST included in the total", () => {
    const html = renderToStaticMarkup(createElement(BillSummary, { value: { ...totals, cgstPaise: 250, sgstPaise: 250 }, gst: { gstMode: "included" } }));
    expect(html).toContain("Includes GST");
    expect(html).toContain("5.00");
  });

  it("hides the Includes GST line when every item is 0% and the GST amount is zero", () => {
    const html = renderToStaticMarkup(createElement(BillSummary, { value: totals, gst: { gstMode: "included" } }));
    expect(html).not.toContain("bill-includes-gst");
  });
});
