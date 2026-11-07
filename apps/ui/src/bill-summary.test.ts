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

describe("BillSummary with service and packaging charges", () => {
  const charge = { kind: "service" as const, label: "Service charge", percentBp: 1000, gstRate: 5, amountPaise: 900, taxablePaise: 900, cgstPaise: 22, sgstPaise: 22 };
  const withCharges = { subtotalPaise: 10000, discountPaise: 1000, roundingPaise: 0, totalPaise: 9990, taxablePaise: 9900, cgstPaise: 45, sgstPaise: 45, taxes: [{ gstRate: 5, taxablePaise: 9900, cgstPaise: 45, sgstPaise: 45 }], charges: [charge, { kind: "packaging" as const, label: "Packaging", gstRate: 5, amountPaise: 2000, taxablePaise: 2000, cgstPaise: 50, sgstPaise: 50 }] };
  it("lists each charge between Discount and CGST when GST is added", () => {
    const html = renderToStaticMarkup(createElement(BillSummary, { value: withCharges, gst: { gstMode: "exclusive" } }));
    expect(html).toMatch(/<dt>Discount<\/dt><dd>[^<]*10\.00<\/dd><dt>Service charge 10%<\/dt><dd>[^<]*9\.00<\/dd><dt>Packaging<\/dt><dd>[^<]*20\.00<\/dd><dt>CGST<\/dt>/);
  });
  it("lists charges between Discount and Round off when GST is included", () => {
    const html = renderToStaticMarkup(createElement(BillSummary, { value: withCharges, gst: { gstMode: "included" } }));
    expect(html).toMatch(/<dt>Discount<\/dt><dd>[^<]*10\.00<\/dd><dt>Service charge 10%<\/dt><dd>[^<]*9\.00<\/dd><dt>Packaging<\/dt><dd>[^<]*20\.00<\/dd><dt>Round off<\/dt>/);
  });
  it("renders as before without charges", () => {
    const html = renderToStaticMarkup(createElement(BillSummary, { value: { ...withCharges, charges: [] }, gst: { gstMode: "included" } }));
    expect(html).toContain("<dt>Discount</dt><dd>₹10.00</dd><dt>Round off</dt>");
  });
});
