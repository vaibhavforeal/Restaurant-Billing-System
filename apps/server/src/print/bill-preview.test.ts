import { describe, expect, it } from "vitest";
import { calculateBill } from "@masalapos/domain";
import { sampleBill } from "./bill-preview.js";

const settings = { restaurantName: "Cafe", address: "", gstin: "", fssai: "", receiptHeader: "", receiptFooter: "", stateCode: "29", city: "Bengaluru", pincode: "560001", phone: "9876543210" };

describe("sampleBill", () => {
  it("numbers the sample in the 2026-27 year with the saved prefix", () => {
    expect(sampleBill({ ...settings, invoicePrefix: "MP" }).invoiceNo).toBe("MP/26-27/0001");
    expect(sampleBill(settings).invoiceNo).toBe("26-27/0001");
  });
  it("honours the round-off setting", () => {
    const items = [{ pricePaise: 28000, qty: 1, gstRate: 5 }, { pricePaise: 9013, qty: 2, gstRate: 18 }];
    const rounding = { rupee: -26, half: 24, off: 0 };
    for (const roundOff of ["rupee", "half", "off"] as const) {
      expect(sampleBill({ ...settings, roundOff }).roundingPaise).toBe(rounding[roundOff]);
      expect(sampleBill({ ...settings, roundOff })).toMatchObject(calculateBill(items, 0, "included", roundOff));
    }
  });
});
