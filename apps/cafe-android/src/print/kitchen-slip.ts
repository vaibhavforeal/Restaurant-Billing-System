import { getCounterSettings, printerFor, type CafeBill, type KitchenLine, type Printer, type SqlDriver } from "@masalapos/cafe-data";
import type { PrintProfileInput } from "@masalapos/domain/printer-schemas";
import { kotSlip } from "@masalapos/print";

/**
 * The kitchen's copy of a bill: `TOKEN n` in large type, Takeaway or Delivery, each line with its note, add-ons under
 * their dish, and the delivery note at the end. Prices never print on it.
 */
export function kitchenSlipBytes(bill: CafeBill, lines: readonly KitchenLine[], paperWidth: 58 | 80, profile?: PrintProfileInput): Uint8Array {
  return kotSlip({
    kotNo: bill.token, token: bill.token, stationName: "Kitchen", orderType: "parcel",
    orderTypeName: bill.orderKind === "delivery" ? "Delivery" : "Takeaway", tableName: null, splitLabel: null,
    note: bill.deliveryNote, atMs: bill.createdAt,
    items: lines.map((l) => ({ qty: l.qty, name: l.name, note: l.note, cancelled: false, ...(l.addonOf !== null ? { addon: true } : {}) })),
  }, paperWidth, profile);
}

/** Where the kitchen slip goes under the cafe's setting, or why it does not print. */
export function kitchenTarget(db: SqlDriver): { printer: Printer } | { reason: "off" | "no_kitchen_printer" | "no_printer" } {
  const setting = getCounterSettings(db).kitchenSlip;
  if (setting === "off") return { reason: "off" };
  if (setting === "kitchen") {
    const printer = printerFor(db, "kitchen");
    return printer ? { printer } : { reason: "no_kitchen_printer" };
  }
  const printer = printerFor(db, "receipt");
  return printer ? { printer } : { reason: "no_printer" };
}

export const NO_KITCHEN_PRINTER = "No kitchen printer. Add one in More, Printers.";
