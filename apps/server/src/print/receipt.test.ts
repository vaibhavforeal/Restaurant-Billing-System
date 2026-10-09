import { describe, expect, it } from "vitest";
import { calculateBill, RECEIPT_STYLES, type Bill } from "@forkflow/domain";
import { money, receiptHtml, receiptSlip } from "./receipt.js";
import { renderBytes } from "./render-bytes.js";

const bill: Bill = {
  ...calculateBill([{ pricePaise: 10500, qty: 2, gstRate: 5 }]),
  id: "bill-1", billNo: 42, orderId: "order-1", status: "paid", discountNote: null,
  createdAt: new Date(2026, 8, 28, 13, 30).getTime(),
  receipt: { restaurantName: "ForkFlow Cafe", address: "12 Market Road", gstin: "29ABCDE1234F1Z5", fssai: "12345678901234", receiptFooter: "Thank you!", gstMode: "included",
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
  it("reads the heading of a bill saved before gstMode existed from its legacy flags", () => {
    const { gstMode: _gstMode, ...legacy } = bill.receipt;
    expect(renderBytes(receiptSlip({ ...bill, receipt: legacy as Bill["receipt"] }, 58))).toContain("TAX INVOICE");
    expect(renderBytes(receiptSlip({ ...bill, receipt: { ...legacy, gstScheme: "composition" } as Bill["receipt"] }, 58))).toContain("BILL OF SUPPLY");
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
});
