import { describe, expect, it } from "vitest";
import { calculateBill, RECEIPT_STYLES, type Bill } from "@forkflow/domain";
import { receiptHtml, receiptSlip } from "./receipt.js";
import { renderBytes } from "./render-bytes.js";

const bill: Bill = {
  ...calculateBill([{ pricePaise: 10000, qty: 2, gstRate: 5 }]),
  id: "bill-1", billNo: 42, orderId: "order-1", status: "paid", discountNote: null,
  createdAt: new Date(2026, 8, 28, 13, 30).getTime(),
  receipt: { restaurantName: "ForkFlow Cafe", address: "12 Market Road", gstin: "29ABCDE1234F1Z5", fssai: "12345678901234", receiptFooter: "Thank you!", taxInclusive: false,
    orderType: "dine_in", tableName: "T1", splitLabel: "B", items: [{ name: "Meal", pricePaise: 10000, qty: 2, gstRate: 5 }] },
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
      expect(text).toContain("CGST @ 2.5%"); expect(text).toContain("210.00");
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
    expect(rendered).toContain("T1 / B"); expect(rendered).toContain("CGST @ 2.5%");
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
  it.each(RECEIPT_STYLES)("prints %s inclusive prices with the included GST itemised and saved financial data unchanged", (receiptStyle) => {
    const items = [{ name: '<img src=x onerror=alert(1)>', pricePaise: 10500, qty: 2, gstRate: 5 },
      { name: "Packaged drink", pricePaise: 5900, qty: 1, gstRate: 18 }];
    const totals = calculateBill(items, 1000, true);
    const changed = { ...bill, ...totals, discountNote: '<b>Member discount</b>',
      receipt: { ...bill.receipt, receiptStyle, taxInclusive: true, receiptFooter: "", items },
      payments: [{ mode: "cash" as const, amountPaise: totals.totalPaise, createdAt: 1, refNote: null }],
    };
    const before = structuredClone(changed);
    const html = receiptHtml(changed);
    for (const rendered of [html, ...([58, 80] as const).map((width) => renderBytes(receiptSlip(changed, width)))]) {
      expect(rendered).toContain("Taxable @ 5%"); expect(rendered).toContain("Taxable @ 18%");
      expect(rendered).toContain("CGST"); expect(rendered).toContain("SGST");
      expect(rendered).toContain("All prices include tax");
      expect(rendered).toContain("259.00");
      expect(rendered).toContain("PAID IN FULL");
      expect(rendered).toContain("Thank you for visiting.");
    }
    expect(changed).toEqual(before);
    expect(changed.cgstPaise).toBeGreaterThan(0); expect(changed.sgstPaise).toBeGreaterThan(0);
    expect(html).toContain("CGST (included)"); expect(html).toContain("SGST (included)");
    expect(html).toContain("-₹10.00"); expect(html).toContain("₹259.00");
    expect(html).toContain("&lt;b&gt;Member discount&lt;/b&gt;"); expect(html).not.toContain("<img");
    expect(html).toContain("size:A4 portrait"); expect(html).toContain("display:table-header-group");
  });
  it.each(RECEIPT_STYLES)("prints a %s composition bill of supply with the declaration and no GST lines", (receiptStyle) => {
    const totals = calculateBill([{ pricePaise: 10050, qty: 2, gstRate: 5 }], 0, false, "composition");
    const supply: Bill = { ...bill, ...totals,
      receipt: { ...bill.receipt, receiptStyle, gstScheme: "composition" },
      payments: [{ mode: "cash", amountPaise: totals.totalPaise, refNote: null, createdAt: 1 }] };
    const html = receiptHtml(supply);
    expect(html).toContain("<h2>Bill of supply<");
    expect(html).toContain("Composition taxable person, not eligible to collect tax on supplies");
    expect(html).not.toMatch(/Restaurant bill<|CGST|SGST|Taxable @|include tax|GST added/);
    for (const width of [58, 80] as const) {
      const slip = renderBytes(receiptSlip(supply, width));
      expect(slip).toContain("BILL OF SUPPLY"); expect(slip).toContain("GSTIN: 29ABCDE1234F1Z5");
      expect(slip.replace(/\s+/g, " ")).toContain("Composition taxable person, not eligible to collect tax on supplies");
      expect(slip).toContain("201.00");
      expect(slip).not.toMatch(/RESTAURANT BILL|CGST|SGST|Taxable @|include tax|GST added/);
      const text = slip.replace(/<[0-9A-F]{2}>/g, "");
      expect(text.split("\n").every((line) => line.length <= (width === 58 ? 32 : 48))).toBe(true);
    }
  });
  it.each(RECEIPT_STYLES)("labels a %s Zomato bill with the section 9(5) note and no GST lines", (receiptStyle) => {
    const totals = calculateBill([{ pricePaise: 25000, qty: 1, gstRate: 5 }], 0, false, "operator");
    const zomato: Bill = { ...bill, ...totals,
      receipt: { ...bill.receipt, receiptStyle, orderType: "zomato", tableName: null, splitLabel: null, zomatoOrderId: "5821", gstPaidBy: "zomato",
        items: [{ name: "Thali", pricePaise: 25000, qty: 1, gstRate: 5 }] },
      payments: [{ mode: "zomato", amountPaise: 25000, refNote: null, createdAt: 1 }] };
    const html = receiptHtml(zomato);
    expect(html).toContain("<dt>Service</dt><dd>Zomato</dd>");
    expect(html).toContain("<dt>Order</dt><dd>Zomato #5821</dd>");
    expect(html).toContain("GST paid by Zomato (section 9(5))");
    expect(html).not.toMatch(/Dine-in|Parcel|All prices include tax|GST added to menu prices|CGST|SGST|GST 5%/);
    expect(html).toContain("₹250.00");
    for (const width of [58, 80] as const) {
      const slip = renderBytes(receiptSlip(zomato, width));
      expect(slip).toContain("ZOMATO #5821");
      expect(slip).toContain("GST paid by Zomato");
      expect(slip).not.toMatch(/DINE-IN|TAKEAWAY|CGST|SGST|All prices include tax|GST added to menu prices/);
    }
  });
});
