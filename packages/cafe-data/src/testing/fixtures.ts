import { createBill, voidBill, type PaymentInput } from "../bills.js";
import { saveCafe } from "../cafe.js";
import type { SqlDriver } from "../driver.js";
import { saveCategory, saveItem, type Item } from "../menu.js";
import { memoryCafeDb } from "./sqlite-driver.js";

/** The cafe the tests save first: prices include GST at 5%, bills round to the rupee, prefix "cp". */
export const base = { name: " Chai Point ", address: "", phone: "", gstin: "", fssai: "", gstMode: "included", defaultGstRate: 5, roundOff: "rupee",
  invoicePrefix: "cp", receiptHeader: "", receiptFooter: "", receiptStyle: "classic", upiId: "" };

/** 13 Nov 2026, 11:30 IST. */
export const T0 = Date.UTC(2026, 10, 13, 6, 0);

/** The base cafe with Masala Chai (₹20; Small ₹15, Large ₹25, cafe default GST) and Samosa (₹18, GST 5%). */
export function menuCafe(): { db: SqlDriver; chai: Item; samosa: Item } {
  const db = memoryCafeDb();
  saveCafe(db, base, 1);
  const category = saveCategory(db, { name: "Menu" }, 1);
  const chai = saveItem(db, { categoryId: category.id, name: "Masala Chai", pricePaise: 2000, gstRate: null,
    variants: [{ name: "Small", pricePaise: 1500 }, { name: "Large", pricePaise: 2500 }] }, 1);
  const samosa = saveItem(db, { categoryId: category.id, name: "Samosa", pricePaise: 1800, gstRate: 5, variants: [] }, 1);
  return { db, chai, samosa };
}

/**
 * Three bills on 13 Nov: b1 Samosa x2 cash 3600; b2 Large chai + custom "Cookie" ₹40 with ₹5 off, cash 4000 + UPI 2000;
 * b3 Samosa x1 card 1800, then voided with reason "x".
 */
export function threeBillDay() {
  const { db, chai, samosa } = menuCafe();
  const pay = (mode: PaymentInput["mode"], amountPaise: number): PaymentInput => ({ mode, amountPaise, refNote: null });
  const common = { discountPaise: 0, discountNote: null, tzOffsetMinutes: 330 };
  createBill(db, { ...common, id: "b1", lines: [{ itemId: samosa.id, variantId: null, qty: 2 }], payments: [pay("cash", 3600)], now: T0 });
  createBill(db, { ...common, id: "b2", now: T0 + 60_000, discountPaise: 500, discountNote: "Regular",
    lines: [{ itemId: chai.id, variantId: chai.variants.find((v) => v.name === "Large")!.id, qty: 1 },
      { itemId: null, variantId: null, qty: 1, custom: { name: "Cookie", pricePaise: 4000, gstRate: null } }],
    payments: [pay("cash", 4000), pay("upi", 2000)] });
  createBill(db, { ...common, id: "b3", lines: [{ itemId: samosa.id, variantId: null, qty: 1 }], payments: [pay("card", 1800)], now: T0 + 120_000 });
  voidBill(db, { billId: "b3", reason: "x", now: T0 + 180_000, tzOffsetMinutes: 330 });
  return { db, chai, samosa };
}
