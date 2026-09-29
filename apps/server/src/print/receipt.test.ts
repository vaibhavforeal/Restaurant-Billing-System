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
});
