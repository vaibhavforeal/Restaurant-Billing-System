import { describe, expect, it } from "vitest";
import { calculateBill, type Bill } from "@masalapos/domain";
import { receiptHtml, receiptSlip } from "./receipt.js";
import { renderBytes } from "./render-bytes.js";
import { kotSlip, type KotSlipCtx } from "./templates.js";

const atMs = new Date("2026-08-15T14:30:00").getTime();
const cafeKot: KotSlipCtx = {
  kotNo: 7, stationName: "Kitchen", orderType: "parcel", orderTypeName: "Delivery", tableName: null, splitLabel: null,
  items: [{ qty: 2, name: "Masala Chai", note: "less sugar", cancelled: false }, { qty: 1, name: "Samosa", note: null, cancelled: false }],
  atMs,
};
const bill: Bill = {
  ...calculateBill([{ pricePaise: 1800, qty: 2, gstRate: 5 }]),
  id: "b1", billNo: 1, invoiceNo: "CPA/26-27/0001", orderId: "b1", status: "paid", discountNote: null, createdAt: atMs,
  receipt: { restaurantName: "Chai Point", address: "", gstin: "", fssai: "", receiptFooter: "", gstMode: "included", orderType: "parcel",
    orderTypeKind: "delivery", orderTypeName: "Delivery", tableName: null, splitLabel: null, token: 3,
    items: [{ name: "Samosa", pricePaise: 1800, qty: 2, gstRate: 5 }] },
  payments: [{ mode: "cash", amountPaise: 3600, refNote: null, createdAt: atMs }],
  refundState: "none", creditNotes: [], refundedQty: {},
};

describe("cafe kitchen slip", () => {
  it("heads a kitchen slip with the token when one is given", () => {
    const text = renderBytes(kotSlip({ ...cafeKot, token: 7 }, 58));
    expect(text).toContain("TOKEN 7");
    expect(text).not.toContain("KOT #");
    expect(text).toContain("Delivery");
  });
  it("prints a slip note after the items, wrapped to the paper width", () => {
    const text = renderBytes(kotSlip({ ...cafeKot, token: 7, note: "Flat 4, ring twice" }, 58));
    expect(text).toContain("Note: Flat 4, ring twice");
    expect(text.indexOf("Note: Flat 4")).toBeGreaterThan(text.indexOf("1 x Samosa"));
    const long = renderBytes(kotSlip({ ...cafeKot, note: "word ".repeat(30).trim() }, 58));
    const noteLines = long.split("\n").filter((l) => l.includes("word"));
    expect(noteLines.length).toBeGreaterThan(1);
    expect(noteLines.every((l) => l.length <= 32)).toBe(true);
  });
  it("prints a slip without a token or note exactly as before", () => {
    const before = renderBytes(kotSlip(cafeKot, 80));
    expect(renderBytes(kotSlip({ ...cafeKot, note: null }, 80))).toBe(before);
    expect(before).toContain("KOT #7");
    expect(before).not.toContain("Note:");
  });
});

describe("delivery note on the receipt", () => {
  it("prints the delivery note under the order line on the slip and in HTML", () => {
    const withNote = { ...bill, receipt: { ...bill.receipt, deliveryNote: "Flat 4" } };
    const text = renderBytes(receiptSlip(withNote, 58));
    const lines = text.split("\n");
    const order = lines.findIndex((l) => l.trim() === "DELIVERY");
    expect(order).toBeGreaterThan(-1);
    expect(lines[order + 1]).toContain("Deliver to: Flat 4");
    const html = receiptHtml(withNote);
    expect(html).toContain('<p class="delivery-note">Deliver to: Flat 4</p>');
  });
  it("escapes the delivery note in HTML", () => {
    expect(receiptHtml({ ...bill, receipt: { ...bill.receipt, deliveryNote: "<b>x</b>" } })).not.toContain("<b>x</b>");
  });
  it("prints a bill without a delivery note exactly as before", () => {
    expect(renderBytes(receiptSlip(bill, 58))).not.toContain("Deliver to");
    expect(receiptHtml(bill)).not.toContain("delivery-note");
  });
});
