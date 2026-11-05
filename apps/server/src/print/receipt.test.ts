import { describe, expect, it } from "vitest";
import { calculateBill, RECEIPT_STYLES, type Bill } from "@masalapos/domain";
import { money, receiptHtml, receiptSlip } from "./receipt.js";
import { billUpiPayment } from "./upi.js";
import { renderBytes } from "./render-bytes.js";

const bill: Bill = {
  ...calculateBill([{ pricePaise: 10500, qty: 2, gstRate: 5 }]),
  id: "bill-1", billNo: 42, invoiceNo: "42", orderId: "order-1", status: "paid", discountNote: null,
  createdAt: new Date(2026, 8, 28, 13, 30).getTime(),
  receipt: { restaurantName: "MasalaPOS Cafe", address: "12 Market Road", gstin: "29ABCDE1234F1Z5", fssai: "12345678901234", receiptFooter: "Thank you!", gstMode: "included",
    orderType: "dine_in", tableName: "T1", splitLabel: "B", items: [{ name: "Meal", pricePaise: 10500, qty: 2, gstRate: 5 }] },
  payments: [{ mode: "cash", amountPaise: 10000, refNote: null, createdAt: 1 }, { mode: "upi", amountPaise: 11000, refNote: null, createdAt: 1 }],
  refundState: "none", creditNotes: [], refundedQty: {},
};
describe("receipts", () => {
  it.each(RECEIPT_STYLES)("uses the saved %s style without changing bill content", (receiptStyle) => {
    const sample = { ...bill, receipt: { ...bill.receipt, receiptStyle } };
    expect(receiptHtml(sample)).toContain(`class="bill bill--${receiptStyle}"`);
    const body = (value: Bill) => receiptHtml(value).split("</style>")[1]!.replace(/bill--\w+/g, "bill--style");
    expect(body(sample)).toBe(body(bill));
    for (const width of [58, 80] as const) {
      const text = renderBytes(receiptSlip(sample, width)).replace(/<[0-9A-F]{2}>/g, "");
      expect(text.split("\n").every((line) => line.length <= (width === 58 ? 32 : 48))).toBe(true);
      expect(text).toContain("CGST 2.5%"); expect(text).toContain("210.00");
      expect(text).toContain("PAID IN FULL"); expect(text).toContain("FSSAI: 12345678901234");
    }
  });
  it("prints the restaurant's phone under the address, and nothing for bills issued without one", () => {
    const sample = { ...bill, receipt: { ...bill.receipt, phone: "9845012345" } };
    for (const width of [58, 80] as const) {
      const text = renderBytes(receiptSlip(sample, width));
      expect(text.indexOf("Ph: 9845012345")).toBeGreaterThan(text.indexOf("12 Market Road"));
      expect(renderBytes(receiptSlip(bill, width))).not.toContain("Ph:");
    }
    expect(receiptHtml(sample)).toContain('<p class="phone">Ph: 9845012345</p>');
    expect(receiptHtml(bill)).not.toContain('class="phone"');
  });
  it("falls back to Classic for missing or unrecognized historic style values", () => {
    for (const receiptStyle of [undefined, 'unknown', '\" onload=alert(1)']) {
      const sample = { ...bill, receipt: { ...bill.receipt, receiptStyle } } as Bill;
      expect(receiptHtml(sample)).toContain('class="bill bill--classic"');
      expect(receiptSlip(sample, 58)).toEqual(receiptSlip(bill, 58));
    }
  });
  it.each([58, 80] as const)("renders a %imm GST receipt with split and payment details", (width) => {
    const rendered = renderBytes(receiptSlip(bill, width));
    expect(rendered).toMatchSnapshot();
    expect(rendered).toContain("T1 / B"); expect(rendered).toContain("CGST 2.5%");
    expect(rendered).toContain("210.00");
  });
  it("escapes markup and strips ESC/POS control bytes from user content", () => {
    const changed = { ...bill, receipt: { ...bill.receipt, restaurantName: '<script>alert("x")</script>\x1b@' } };
    const html = receiptHtml(changed);
    expect(html).not.toContain('<script>'); expect(html).toContain("&lt;script&gt;");
    const bytes = receiptSlip(changed, 58);
    expect(bytes.indexOf(Buffer.from([27, 64]), 2)).toBe(-1);
  });
  it("wraps long text at the paper width", () => {
    const changed = { ...bill, receipt: { ...bill.receipt, restaurantName: "A".repeat(100) } };
    const rendered = renderBytes(receiptSlip(changed, 58));
    expect(rendered).not.toContain("A".repeat(33));
  });
  it.each([58, 80] as const)("keeps long names, references and large amounts within %imm", (width) => {
    const changed = { ...bill, discountNote: "Long discount reason ".repeat(15), receipt: { ...bill.receipt,
      restaurantName: "A very long restaurant name ".repeat(4), address: "Floor 2\nMarket Road ".repeat(8),
      items: [{ name: "Paneer tikka with extra vegetables and special sauce ".repeat(4), qty: 100, pricePaise: 9999999, gstRate: 5 }],
    } };
    const rendered = renderBytes(receiptSlip(changed, width)).replace(/<[0-9A-F]{2}>/g, "");
    expect(rendered.split("\n").every((line) => line.length <= (width === 58 ? 32 : 48))).toBe(true);
    expect(rendered).toContain("9999999.00");
    expect(rendered).toContain("Floor 2\n");
  });
  it.each(RECEIPT_STYLES)("shows unpaid and void %s bills without claiming payment was received", (receiptStyle) => {
    for (const status of ["unpaid", "void"] as const) {
      const changed = { ...bill, status, payments: [], receipt: { ...bill.receipt, receiptStyle } };
      const html = receiptHtml(changed), slip = renderBytes(receiptSlip(changed, 58));
      expect(html).not.toContain("PAID IN FULL"); expect(slip).not.toContain("PAID IN FULL");
      if (status === "unpaid") {
        expect(html).toContain("AMOUNT DUE ₹210.00"); expect(slip).toContain("AMOUNT DUE Rs.");
      } else {
        expect(html).toContain("VOID - NOT PAYABLE"); expect(slip).toContain("VOID - NOT PAYABLE");
        expect(html).not.toContain("AMOUNT DUE"); expect(slip).not.toContain("AMOUNT DUE");
      }
    }
  });
  const thermal = (value: Bill, width: 58 | 80) => renderBytes(receiptSlip(value, width)).replace(/<[0-9A-F]{2}>/g, "");
  const fits = (text: string, width: 58 | 80) => text.split("\n").every((line) => line.length <= (width === 58 ? 32 : 48));
  const oldWording = /All prices include tax|GST added to menu prices|\(included\)/;
  const paid = (value: Bill): Bill => ({ ...value, payments: [{ mode: "cash", amountPaise: value.totalPaise, refNote: null, createdAt: 1 }] });
  it.each(RECEIPT_STYLES)("prints a %s tax invoice with Includes GST after the total, one block per rate", (receiptStyle) => {
    const items = [{ name: '<img src=x onerror=alert(1)>', pricePaise: 10500, qty: 2, gstRate: 5 },
      { name: "Packaged drink", pricePaise: 5900, qty: 1, gstRate: 18 }];
    const totals = calculateBill(items, 1000);
    const changed = paid({ ...bill, ...totals, discountNote: '<b>Member discount</b>',
      receipt: { ...bill.receipt, receiptStyle, gstMode: "included", receiptFooter: "", items } });
    const before = structuredClone(changed);
    const html = receiptHtml(changed);
    expect(html).toContain("<h2>Tax invoice</h2>");
    expect(html.indexOf("Includes GST")).toBeGreaterThan(html.indexOf("TOTAL</td>"));
    for (const rendered of [html, ...([58, 80] as const).map((width) => thermal(changed, width))]) {
      expect(rendered).toContain("Taxable @ 5%"); expect(rendered).toContain("Taxable @ 18%");
      expect(rendered).toContain("CGST 2.5%"); expect(rendered).toContain("SGST 2.5%");
      expect(rendered).toContain("CGST 9%"); expect(rendered).toContain("SGST 9%");
      expect(rendered).toContain("259.00");
      expect(rendered).toContain("PAID IN FULL");
      expect(rendered).toContain("Thank you for visiting.");
      expect(rendered).not.toMatch(oldWording);
    }
    // Both rates print their saved amounts, and taxable + CGST + SGST across the blocks adds back to the total before round-off.
    expect(totals.taxes).toHaveLength(2);
    for (const t of totals.taxes) for (const rendered of [html, thermal(changed, 80)]) {
      expect(rendered).toContain(money(t.taxablePaise)); expect(rendered).toContain(money(t.cgstPaise)); expect(rendered).toContain(money(t.sgstPaise));
    }
    expect(totals.taxes.reduce((sum, t) => sum + t.taxablePaise + t.cgstPaise + t.sgstPaise, 0) + totals.roundingPaise).toBe(totals.totalPaise);
    for (const width of [58, 80] as const) {
      const slip = thermal(changed, width);
      expect(slip).toContain("TAX INVOICE");
      expect(slip.indexOf("Includes GST:")).toBeGreaterThan(slip.indexOf("TOTAL Rs."));
      expect(slip.indexOf("Includes GST:")).toBeLessThan(slip.indexOf("PAID IN FULL"));
      expect(fits(slip, width)).toBe(true);
    }
    expect(changed).toEqual(before);
    expect(html).toContain("-₹10.00"); expect(html).toContain("₹259.00");
    expect(html).toContain("&lt;b&gt;Member discount&lt;/b&gt;"); expect(html).not.toContain("<img");
    expect(html).toContain("size:A4 portrait"); expect(html).toContain("display:table-header-group");
  });
  it.each(RECEIPT_STYLES)("prints a %s tax invoice with GST added on top, before round-off and the total", (receiptStyle) => {
    const items = [{ name: "Thali", pricePaise: 10000, qty: 1, gstRate: 5 }, { name: "Mocktail", pricePaise: 20000, qty: 1, gstRate: 18 }];
    const totals = calculateBill(items, 3000, "exclusive");
    expect(totals).toMatchObject({ cgstPaise: 1845, sgstPaise: 1845, roundingPaise: 10, totalPaise: 30700 });
    const added = paid({ ...bill, ...totals, receipt: { ...bill.receipt, receiptStyle, gstMode: "exclusive", items, billShow: { fssai: true, customer: true, table: true, servedBy: false, itemGst: true } } });
    const html = receiptHtml(added);
    expect(html).toContain("<h2>Tax invoice</h2>");
    expect(html).not.toContain("Includes GST");
    expect(html).toContain("<th scope=\"col\">GST</th>"); expect(html).toContain("<td>18%</td>");
    for (const label of ["CGST 2.5% on 90.00", "SGST 2.5% on 90.00", "CGST 9% on 180.00", "SGST 9% on 180.00"]) {
      expect(html.indexOf(label), label).toBeGreaterThan(html.indexOf("Discount</td>"));
      expect(html.indexOf(label), label).toBeLessThan(html.indexOf("Round off</td>"));
    }
    expect(html).toContain("₹2.25"); expect(html).toContain("₹16.20"); expect(html).toContain("₹307.00");
    expect(html.indexOf("Round off</td>")).toBeLessThan(html.indexOf("TOTAL</td>"));
    for (const width of [58, 80] as const) {
      const slip = thermal(added, width);
      expect(slip).toContain("TAX INVOICE");
      expect(slip).not.toContain("Includes GST");
      expect(slip).toContain("GST 18%");
      for (const label of ["CGST 2.5% on 90.00", "SGST 2.5% on 90.00", "CGST 9% on 180.00", "SGST 9% on 180.00"]) {
        expect(slip.indexOf(label), label).toBeGreaterThan(slip.indexOf("Discount"));
        expect(slip.indexOf(label), label).toBeLessThan(slip.indexOf("Round off"));
      }
      expect(slip).toContain("16.20");
      expect(slip.indexOf("Round off")).toBeLessThan(slip.indexOf("TOTAL Rs."));
      expect(fits(slip, width)).toBe(true);
    }
  });
  it("reprints an included bill with its Includes GST block after the setting changes to GST added on top", () => {
    // The receipt renders from the bill's snapshot, so only gstMode on the snapshot matters.
    const included = paid(bill);
    expect(receiptHtml(included)).toContain("Includes GST");
    expect(thermal(included, 80)).toContain("Includes GST:");
    expect(thermal(included, 80)).not.toMatch(/CGST \S+ on /);
  });
  it.each(RECEIPT_STYLES)("prints a %s bill of supply with the declaration and no GST lines for a no-GST restaurant with a GSTIN", (receiptStyle) => {
    const totals = calculateBill([{ pricePaise: 10050, qty: 2, gstRate: 5 }], 0, "none");
    const supply = paid({ ...bill, ...totals, receipt: { ...bill.receipt, receiptStyle, gstMode: "none" } });
    const html = receiptHtml(supply);
    expect(html).toContain("<h2>Bill of supply<");
    expect(html).toContain("Composition taxable person, not eligible to collect tax on supplies");
    expect(html).not.toMatch(/Restaurant bill<|Tax invoice|CGST|SGST|Taxable|Includes GST/);
    expect(html).not.toMatch(oldWording);
    for (const width of [58, 80] as const) {
      const slip = renderBytes(receiptSlip(supply, width));
      expect(slip).toContain("BILL OF SUPPLY"); expect(slip).toContain("GSTIN: 29ABCDE1234F1Z5");
      expect(slip.replace(/\s+/g, " ")).toContain("Composition taxable person, not eligible to collect tax on supplies");
      expect(slip).toContain("201.00");
      expect(slip).not.toMatch(/RESTAURANT BILL|TAX INVOICE|CGST|SGST|Taxable|Includes GST/);
      expect(slip).not.toMatch(oldWording);
      expect(fits(thermal(supply, width), width)).toBe(true);
    }
  });
  it.each(RECEIPT_STYLES)("prints a plain %s restaurant bill without declaration or GST lines for a no-GST restaurant without a GSTIN", (receiptStyle) => {
    const totals = calculateBill([{ pricePaise: 10050, qty: 2, gstRate: 5 }], 0, "none");
    for (const gstin of ["", "  "]) {
      const plain = paid({ ...bill, ...totals, receipt: { ...bill.receipt, receiptStyle, gstMode: "none", gstin } });
      const html = receiptHtml(plain);
      expect(html).toContain("<h2>Restaurant bill</h2>");
      expect(html).not.toMatch(/Bill of supply|Tax invoice|Composition|CGST|SGST|Taxable|Includes GST/);
      expect(html).not.toMatch(oldWording);
      for (const width of [58, 80] as const) {
        const slip = renderBytes(receiptSlip(plain, width));
        expect(slip).toContain("RESTAURANT BILL"); expect(slip).toContain("201.00");
        expect(slip).not.toMatch(/BILL OF SUPPLY|TAX INVOICE|Composition|CGST|SGST|Taxable|Includes GST/);
        expect(slip).not.toMatch(oldWording);
        expect(fits(thermal(plain, width), width)).toBe(true);
      }
    }
  });
  it.each(RECEIPT_STYLES)("labels a %s Zomato bill with the section 9(5) note and no GST lines", (receiptStyle) => {
    const totals = calculateBill([{ pricePaise: 25000, qty: 1, gstRate: 5 }], 0, "none");
    const zomato: Bill = { ...bill, ...totals,
      receipt: { ...bill.receipt, receiptStyle, gstMode: "none", orderType: "zomato", tableName: null, splitLabel: null, zomatoOrderId: "5821", gstPaidBy: "zomato",
        items: [{ name: "Thali", pricePaise: 25000, qty: 1, gstRate: 5 }] },
      payments: [{ mode: "zomato", amountPaise: 25000, refNote: null, createdAt: 1 }] };
    const html = receiptHtml(zomato);
    expect(html).toContain("<dt>Service</dt><dd>Zomato</dd>");
    expect(html).toContain("<dt>Order</dt><dd>Zomato #5821</dd>");
    expect(html).toContain("GST paid by Zomato (section 9(5))");
    expect(html).toContain("<h2>Restaurant bill</h2>");
    expect(html).not.toMatch(/Dine-in|Parcel|Tax invoice|Bill of supply|Includes GST|Taxable|All prices include tax|GST added to menu prices|CGST|SGST|GST 5%/);
    expect(html).toContain("₹250.00");
    for (const width of [58, 80] as const) {
      const slip = renderBytes(receiptSlip(zomato, width));
      expect(slip).toContain("ZOMATO #5821");
      expect(slip).toContain("GST paid by Zomato");
      expect(slip).toContain("RESTAURANT BILL");
      expect(slip).not.toMatch(/DINE-IN|TAKEAWAY|TAX INVOICE|BILL OF SUPPLY|Includes GST|Taxable|CGST|SGST|All prices include tax|GST added to menu prices/);
    }
  });
  describe("invoice number", () => {
    const invoiced: Bill = { ...bill, invoiceNo: "MP/25-26/0007" };
    it("heads the html, the page footer and the bill-meta cell, without a #", () => {
      const html = receiptHtml(invoiced);
      expect(html).toContain("<title>Bill MP/25-26/0007</title>");
      expect(html).toContain("<dt>Bill no.</dt><dd><strong>MP/25-26/0007</strong>");
      expect(html).toContain('content:"Bill MP/25-26/0007"');
      expect(html).not.toContain("#42");
    });
    it("prints on the thermal slip", () => {
      expect(thermal(invoiced, 80)).toContain("Bill MP/25-26/0007");
    });
    it("goes in the UPI note and the printed UPI caption", () => {
      const unpaid: Bill = { ...invoiced, status: "unpaid", payments: [], receipt: { ...invoiced.receipt, upiId: "cafe@upi" } };
      expect(billUpiPayment(unpaid)!.uri).toContain("tn=Bill%20MP%2F25-26%2F0007");
      expect(receiptHtml(unpaid)).toContain("Bill MP/25-26/0007 · Amount filled in automatically");
      expect(thermal(unpaid, 80)).toContain("Bill MP/25-26/0007");
    });
  });

  describe("bill settings", () => {
    const withReceipt = (extra: Partial<Bill["receipt"]>): Bill => ({ ...bill, receipt: { ...bill.receipt, ...extra } });
    const show = (patch: Partial<NonNullable<Bill["receipt"]["billShow"]>>) =>
      ({ fssai: true, customer: true, table: true, servedBy: false, itemGst: false, ...patch });
    const customer = { name: "Asha", phone: "9800000000" } as NonNullable<Bill["receipt"]["customer"]>;
    it("prints a snapshot without the new fields exactly as before", () => {
      for (const width of [58, 80] as const) {
        const plain = receiptSlip(bill, width);
        expect(receiptSlip(withReceipt({ receiptHeader: "" }), width)).toEqual(plain);
        expect(thermal(bill, width)).not.toContain("Served by");
      }
    });
    it("prints header lines after the name and before the address", () => {
      const sample = withReceipt({ receiptHeader: "Pure veg\n\n  Since 1998  " });
      for (const width of [58, 80] as const) {
        const text = thermal(sample, width);
        expect(text.indexOf("Pure veg")).toBeGreaterThan(text.indexOf("MasalaPOS Cafe"));
        expect(text.indexOf("Pure veg")).toBeLessThan(text.indexOf("12 Market Road"));
        expect(text.indexOf("Since 1998")).toBeGreaterThan(text.indexOf("Pure veg"));
      }
      const html = receiptHtml(sample);
      expect(html).toContain('class="header-line">Pure veg'); expect(html).toContain('class="header-line">Since 1998');
    });
    it("prints each footer line and drops the default thank-you", () => {
      const sample = withReceipt({ receiptHeader: "", receiptFooter: "Line one\nLine two" });
      for (const rendered of [receiptHtml(sample), thermal(sample, 58), thermal(sample, 80)]) {
        expect(rendered).toContain("Line one"); expect(rendered).toContain("Line two");
        expect(rendered).not.toContain("Thank you for visiting");
      }
      expect(thermal(withReceipt({ receiptHeader: "", receiptFooter: " \n " }), 58)).toContain("Thank you for visiting");
    });
    it("reprints a legacy snapshot's footer raw, exactly as before", () => {
      const legacy = withReceipt({ receiptFooter: "Line one\n\n    Indented" });
      expect(legacy.receipt.receiptHeader).toBeUndefined();
      expect(receiptHtml(legacy)).toContain("<footer>Line one\n\n    Indented</footer>");
      const trimmed = receiptHtml(withReceipt({ receiptHeader: "", receiptFooter: "Line one\n\n    Indented" }));
      expect(trimmed).toContain("<footer>Line one\nIndented</footer>");
      const text = thermal(legacy, 80);
      expect(text).toContain("Line one"); expect(text).toContain("Indented");
    });
    it("hides FSSAI, customer and table when switched off, and shows them otherwise", () => {
      const base = withReceipt({ customer });
      for (const rendered of [receiptHtml(base), thermal(base, 58), thermal(base, 80)]) {
        expect(rendered).toContain("FSSAI:"); expect(rendered).toContain("Customer:"); expect(rendered).toContain("T1 / B");
      }
      const off = withReceipt({ customer, billShow: show({ fssai: false, customer: false, table: false }) });
      for (const rendered of [receiptHtml(off), thermal(off, 58), thermal(off, 80)]) {
        expect(rendered).not.toContain("FSSAI:"); expect(rendered).not.toContain("Customer:"); expect(rendered).not.toContain("T1 / B");
        expect(rendered).toContain("GSTIN:");
      }
      expect(thermal(off, 58)).toContain("DINE-IN");
      expect(receiptHtml(off)).not.toContain("Table / Group");
    });
    it("adds Served by only when the flag is on and a name was frozen", () => {
      const on = withReceipt({ servedBy: "Ravi", billShow: show({ servedBy: true }) });
      for (const rendered of [receiptHtml(on), thermal(on, 58), thermal(on, 80)]) expect(rendered).toContain("Served by");
      expect(thermal(on, 58)).toContain("Served by: Ravi");
      expect(receiptHtml(on)).toContain("<dt>Served by</dt><dd>Ravi</dd>");
      const off = withReceipt({ servedBy: "Ravi", billShow: show({ servedBy: false }) });
      for (const rendered of [receiptHtml(off), thermal(off, 58)]) expect(rendered).not.toContain("Served by");
      const noName = withReceipt({ billShow: show({ servedBy: true }) });
      for (const rendered of [receiptHtml(noName), thermal(noName, 58), thermal(noName, 80)]) expect(rendered).not.toContain("Served by");
    });
    it("shows the item GST rate only when switched on", () => {
      const on = withReceipt({ billShow: show({ itemGst: true }) });
      for (const rendered of [receiptHtml(on), thermal(on, 58), thermal(on, 80)]) expect(rendered).toContain("5%");
      expect(thermal(on, 58)).toContain("  GST 5%"); expect(receiptHtml(on)).toContain('<th scope="col">GST</th>');
      for (const rendered of [receiptHtml(bill), thermal(bill, 58), thermal(bill, 80)]) expect(rendered).not.toContain("GST 5%");
      expect(receiptHtml(bill)).not.toContain('<th scope="col">GST</th>');
    });
    it("shows item GST only on bills that charge GST, with a matching table class", () => {
      const on = show({ itemGst: true });
      const charged = withReceipt({ billShow: on });
      expect(receiptHtml(charged)).toContain('class="items items--gst"');
      expect(receiptHtml(bill)).toContain('class="items" aria');
      for (const other of [withReceipt({ billShow: on, gstPaidBy: "zomato" }), withReceipt({ billShow: on, gstMode: "none" })]) {
        for (const rendered of [receiptHtml(other), thermal(other, 58), thermal(other, 80)]) {
          expect(rendered).not.toContain("GST 5%"); expect(rendered).not.toContain('<th scope="col">GST</th>');
          expect(rendered).not.toContain('class="items items--gst"');
        }
      }
    });
    it("escapes header markup and strips control bytes", () => {
      const sample = withReceipt({ receiptHeader: "<b>x</b>\x1b@", receiptFooter: "<i>y</i>\x1b@" });
      const html = receiptHtml(sample);
      expect(html).toContain("&lt;b&gt;x&lt;/b&gt;"); expect(html).not.toContain("<b>x</b>"); expect(html).not.toContain("<i>y</i>");
      for (const width of [58, 80] as const) expect(receiptSlip(sample, width).indexOf(Buffer.from([27, 64]), 2)).toBe(-1);
    });
    it.each([58, 80] as const)("keeps every %imm line within the paper width with header, footer and item GST", (width) => {
      const long = "H".repeat(48);
      const sample = withReceipt({ receiptHeader: `${long}\n${long}\n${long}`, receiptFooter: `${long}\n${long}\n${long}`,
        servedBy: "Ravi Kumar", customer, billShow: show({ servedBy: true, itemGst: true }) });
      expect(fits(thermal(sample, width), width)).toBe(true);
    });
  });
});
