import { describe, expect, it } from "vitest";
import { calculateBill, type Bill } from "@forkflow/domain";
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
  it("shows unpaid and void bills without claiming payment was received", () => {
    for (const status of ["unpaid", "void"] as const) {
      const changed = { ...bill, status, payments: [] };
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
  it("uses saved inclusive taxes, discount, split payments and a default footer", () => {
    const totals = calculateBill([{ pricePaise: 10500, qty: 2, gstRate: 5 }], 1000, true);
    const changed = { ...bill, ...totals, discountNote: '<b>Member discount</b>',
      receipt: { ...bill.receipt, taxInclusive: true, receiptFooter: "", items: [{ name: '<img src=x onerror=alert(1)>', pricePaise: 10500, qty: 2, gstRate: 5 }] },
      payments: [{ mode: "cash" as const, amountPaise: totals.totalPaise, createdAt: 1, refNote: null }],
    };
    const html = receiptHtml(changed), slip = renderBytes(receiptSlip(changed, 80));
    expect(html).toContain("CGST (included)"); expect(html).toContain("SGST (included)");
    expect(html).toContain("Prices include GST"); expect(slip).toContain("Prices include GST");
    expect(html).toContain("-₹10.00"); expect(html).toContain("₹200.00");
    expect(html).toContain("&lt;b&gt;Member discount&lt;/b&gt;"); expect(html).not.toContain("<img");
    expect(html).toContain("Thank you for visiting."); expect(slip).toContain("Thank you for visiting.");
    expect(html).toContain("size:A4 portrait"); expect(html).toContain("display:table-header-group");
  });
  it("labels a Zomato bill as a Zomato order with the section 9(5) note and no GST lines", () => {
    const totals = calculateBill([{ pricePaise: 25000, qty: 1, gstRate: 5 }], 0, false, "operator");
    const zomato: Bill = { ...bill, ...totals,
      receipt: { ...bill.receipt, orderType: "zomato", tableName: null, splitLabel: null, zomatoOrderId: "5821", gstPaidBy: "zomato",
        items: [{ name: "Thali", pricePaise: 25000, qty: 1, gstRate: 5 }] },
      payments: [{ mode: "zomato", amountPaise: 25000, refNote: null, createdAt: 1 }] };
    const html = receiptHtml(zomato);
    expect(html).toContain("<dt>Service</dt><dd>Zomato</dd>");
    expect(html).toContain("<dt>Order</dt><dd>Zomato #5821</dd>");
    expect(html).toContain("GST paid by Zomato (section 9(5))");
    expect(html).not.toMatch(/Dine-in|Parcel|Prices include GST|GST added to menu prices|CGST|SGST|GST 5%/);
    expect(html).toContain("₹250.00");
  });
});
