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

describe("BillSummary with GST added on the bill", () => {
  const added = { subtotalPaise: 10000, discountPaise: 1000, roundingPaise: 10, totalPaise: 9460, taxablePaise: 9000, cgstPaise: 225, sgstPaise: 225, taxes: [{ gstRate: 5, taxablePaise: 9000, cgstPaise: 225, sgstPaise: 225 }] };
  it("lists CGST and SGST between Discount and Round off, with no Includes GST line", () => {
    const html = renderToStaticMarkup(createElement(BillSummary, { value: added, gst: { gstMode: "exclusive" } }));
    const totals = html.slice(html.indexOf('<dl class="pos-totals">'), html.indexOf("</dl>"));
    expect(totals).toMatch(/<dt>Discount<\/dt><dd>[^<]*10\.00<\/dd><dt>CGST<\/dt><dd>[^<]*2\.25<\/dd><dt>SGST<\/dt><dd>[^<]*2\.25<\/dd><dt>Round off<\/dt>/);
    expect(html).not.toContain("Includes GST");
    expect(html).toContain("GST added on the bill");
  });
  it("still shows Includes GST on an included bill", () => {
    const html = renderToStaticMarkup(createElement(BillSummary, { value: { ...added, discountPaise: 0, cgstPaise: 250, sgstPaise: 250 }, gst: { gstMode: "included" } }));
    expect(html).toContain("Includes GST <strong>");
    expect(html).not.toContain("<dt>CGST</dt>");
  });
});
