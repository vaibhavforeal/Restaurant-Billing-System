import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { calculateBill, RECEIPT_STYLES, type Bill } from "@forkflow/domain";
import { billUpiPayment } from "./upi.js";
import { receiptHtml, receiptSlip } from "./receipt.js";

// jsQR's CommonJS function export and declaration default differ under NodeNext.
const decodeQr = createRequire(import.meta.url)("jsqr") as typeof import("jsqr").default;

const items = [{ name: "Lunch", pricePaise: 12345, qty: 2, gstRate: 5 }];
const bill: Bill = {
  ...calculateBill(items, 1234), id: "01900000-1234-7123-8123-123456789abc", billNo: 42,
  orderId: "order", status: "unpaid", discountNote: "Offer", createdAt: 1, payments: [], refundState: "none", creditNotes: [], refundedQty: {},
  receipt: { restaurantName: "Cafe & Co / भोजन", address: "", gstin: "", fssai: "", receiptFooter: "", gstMode: "included",
    upiId: "cafe.123@bank", orderType: "parcel", tableName: null, splitLabel: null, items },
};

describe("bill UPI QR", () => {
  it("requests the final discounted, taxed and rounded amount with INR and the saved recipient", () => {
    const payment = billUpiPayment(bill)!;
    const url = new URL(payment.uri);
    expect(url.protocol).toBe("upi:"); expect(url.host).toBe("pay");
    expect(Object.fromEntries(url.searchParams)).toEqual({ pa: "cafe.123@bank", pn: "Cafe & Co / भोजन",
      am: "235.00", cu: "INR", tr: "01900000123471238123123456789abc", tn: "Bill #42" });
    expect(payment.amountPaise).toBe(bill.totalPaise);
    expect(billUpiPayment({ ...bill, ...calculateBill(items, 1234, "none") })!.amountPaise).toBe(23500);
  });

  it.each(RECEIPT_STYLES.flatMap((style) => ([58, 80] as const).map((width) => [style, width] as const)))("independently decodes the %s %imm ESC/POS bitmap to the payment request", (receiptStyle, paperWidth) => {
    // Parse the printer output, not the QR encoder's internal matrix.
    const bytes = receiptSlip({ ...bill, receipt: { ...bill.receipt, receiptStyle } }, paperWidth);
    const offset = bytes.indexOf(Buffer.from([0x1d, 0x76, 0x30, 0x00]));
    expect(offset).toBeGreaterThan(0);
    const widthBytes = bytes.readUInt16LE(offset + 4), height = bytes.readUInt16LE(offset + 6);
    const width = widthBytes * 8;
    expect(width).toBe(paperWidth === 58 ? 384 : 576);
    const data = bytes.subarray(offset + 8, offset + 8 + widthBytes * height);
    const rgba = new Uint8ClampedArray(width * height * 4).fill(255);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      if (data[y * widthBytes + (x >> 3)]! & (0x80 >> (x & 7))) rgba.fill(0, (y * width + x) * 4, (y * width + x) * 4 + 3);
    }
    expect(decodeQr(rgba, width, height)?.data).toBe(billUpiPayment(bill)!.uri);
    expect(data.subarray(0, widthBytes * 8).every((byte) => byte === 0)).toBe(true);
    expect(bytes.subarray(offset + 8 + data.length).toString()).toContain("UPI: cafe.123@bank");
  });

  it("omits payment QRs for paid, void, free and unconfigured/legacy bills", () => {
    const variants: Bill[] = [
      { ...bill, status: "paid" }, { ...bill, status: "void" }, { ...bill, totalPaise: 0 },
      { ...bill, receipt: { ...bill.receipt, upiId: "" } },
      { ...bill, receipt: { ...bill.receipt, upiId: "bad@bank&am=1" } },
      { ...bill, receipt: { ...bill.receipt } },
    ];
    delete variants[5]!.receipt.upiId;
    for (const value of variants) {
      expect(billUpiPayment(value)).toBeNull();
      expect(receiptHtml(value)).not.toContain('<section class="upi-payment"');
      expect(receiptSlip(value, 58).includes(Buffer.from([0x1d, 0x76, 0x30, 0]))).toBe(false);
    }
  });

  it("uses the balance due if payment rows already exist, and no QR when fully covered", () => {
    const partial = { ...bill, payments: [{ mode: "cash" as const, amountPaise: 2345, refNote: null, createdAt: 1 }] };
    expect(new URL(billUpiPayment(partial)!.uri).searchParams.get("am")).toBe("211.55");
    expect(billUpiPayment({ ...partial, totalPaise: 2345 })).toBeNull();
  });

  it("renders a self-contained SVG and safely escapes restaurant details", () => {
    const html = receiptHtml({ ...bill, receipt: { ...bill.receipt, restaurantName: '<script>"&</script>' } });
    expect(html).toContain('aria-label="UPI payment"');
    expect(html).toContain('viewBox="0 0 ');
    expect(html).toContain("₹235.00"); expect(html).toContain("cafe.123@bank");
    expect(html).not.toContain("<script>"); expect(html).not.toContain("<img");
  });
});
