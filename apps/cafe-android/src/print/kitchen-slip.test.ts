import { describe, expect, it } from "vitest";
import { createBill, getCounterSettings, saveCounterSettings, savePrinter, type KitchenLine } from "@masalapos/cafe-data";
import { renderBytes } from "@masalapos/print";
import { menuCafe, T0, walkIn } from "../../../../packages/cafe-data/src/testing/fixtures";
import { kitchenSlipBytes, kitchenTarget } from "./kitchen-slip";

describe("kitchen slip", () => {
  it("builds a token kitchen slip with notes, add-ons and the delivery note", () => {
    const { db, samosa, cashier } = menuCafe();
    const bill = createBill(db, { id: "b1", lines: [{ itemId: samosa.id, variantId: null, qty: 2, note: "less sugar" }], discountPaise: 0,
      discountNote: null, payments: [{ mode: "cash", amountPaise: 3600, refNote: null }], now: T0, tzOffsetMinutes: 330,
      ...walkIn(cashier.id), orderKind: "delivery", deliveryNote: "Flat 4" });
    const lines: KitchenLine[] = [
      { name: "Samosa", qty: 2, note: "less sugar", addonOf: null },
      { name: "Green chutney", qty: 2, note: null, addonOf: 0 },
    ];
    const text = renderBytes(kitchenSlipBytes(bill, lines, 58));
    expect(text).toContain(`TOKEN ${bill.token}`);
    expect(text).not.toContain("KOT #");
    expect(text).toContain("Delivery");
    expect(text).toContain("2 x Samosa");
    expect(text).toContain("(less sugar)");
    expect(text).toContain("  + Green chutney");
    expect(text).toContain("Note: Flat 4");
  });

  it("says Takeaway and prints no note on a takeaway bill", () => {
    const { db, samosa, cashier } = menuCafe();
    const bill = createBill(db, { id: "b1", lines: [{ itemId: samosa.id, variantId: null, qty: 1 }], discountPaise: 0, discountNote: null,
      payments: [{ mode: "cash", amountPaise: 1800, refNote: null }], now: T0, tzOffsetMinutes: 330, ...walkIn(cashier.id) });
    const text = renderBytes(kitchenSlipBytes(bill, [{ name: "Samosa", qty: 1, note: null, addonOf: null }], 80));
    expect(text).toContain("Takeaway");
    expect(text).not.toContain("Note:");
  });

  it.each([
    ["off", null, "off"],
    ["kitchen", null, "no_kitchen_printer"],
    ["kitchen", "receipt", "no_kitchen_printer"],
    ["kitchen", "kitchen", "kitchen printer"],
    ["receipt", null, "no_printer"],
    ["receipt", "receipt", "receipt printer"],
  ] as const)("picks the kitchen target for %s with a %s printer: %s", (setting, role, expected) => {
    const { db } = menuCafe();
    saveCounterSettings(db, { ...getCounterSettings(db), kitchenSlip: setting }, 2);
    if (role) savePrinter(db, { name: `${role} printer`, transport: "bluetooth", address: "AA:BB:CC:DD:EE:FF", paperWidth: 58, role });
    const target = kitchenTarget(db);
    expect("printer" in target ? target.printer.name : target.reason).toBe(expected);
  });
});
