import { beforeEach, describe, expect, it } from "vitest";
import { BillError, createBill, getBill, kitchenLines, previewBill, type CreateBillInput, type PaymentInput } from "./bills.js";
import { getCounterSettings, saveCounterSettings } from "./counter-settings.js";
import { deleteCustomer, saveCustomer } from "./customers.js";
import type { SqlDriver } from "./driver.js";
import type { Item } from "./menu.js";
import { addStaff, updateStaff, type Staff } from "./staff.js";
import { menuCafe, T0, walkIn } from "./testing/fixtures.js";

let db: SqlDriver, samosa: Item, cashier: Staff, manager: Staff;
const pay = (amountPaise: number): PaymentInput[] => [{ mode: "cash", amountPaise, refNote: null }];
/** Two samosas, subtotal 3600, made by the cashier. */
const bill = (id: string, extra: Partial<CreateBillInput> = {}): CreateBillInput => ({
  id, lines: [{ itemId: samosa.id, variantId: null, qty: 2 }], discountPaise: 0, discountNote: null, payments: pay(3600), now: T0,
  tzOffsetMinutes: 330, ...walkIn(cashier.id), ...extra,
});
const totalWith = (discountPaise: number) => previewBill(db, { lines: [{ itemId: samosa.id, variantId: null, qty: 2 }], discountPaise }).totalPaise;
const count = (table: string) => db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`)!.n;
function code(fn: () => unknown): string {
  try { fn(); } catch (e) { if (e instanceof BillError) return e.code; throw e; }
  return "no error";
}

describe("createBill: staff, approvals, customers, order kind and notes", () => {
  beforeEach(() => {
    ({ db, samosa, cashier } = menuCafe());
    manager = addStaff(db, { name: "Meena", role: "manager", pinHash: "x" }, 1);
  });

  it("records who made the bill and puts their name in the snapshot", () => {
    const b = createBill(db, bill("b1"));
    expect(b).toMatchObject({ staffId: cashier.id, staffName: "Ravi", approvedBy: null });
    expect(b.receipt.servedBy).toBe("Ravi");
    expect(b.receipt.billShow!.servedBy).toBe(false);
    saveCounterSettings(db, { ...getCounterSettings(db), showServedBy: true }, 2);
    expect(createBill(db, bill("b2")).receipt.billShow!.servedBy).toBe(true);
  });

  it("refuses a bill from unknown or inactive staff", () => {
    expect(code(() => createBill(db, bill("b1", { staffId: "nobody" })))).toBe("unknown_staff");
    updateStaff(db, cashier.id, { active: false }, 2);
    expect(code(() => createBill(db, bill("b1")))).toBe("unknown_staff");
    expect(count("bills")).toBe(0);
    expect(count("sequences")).toBe(0);
  });

  it("refuses a cashier discount above the limit without approval, and takes it with a manager's", () => {
    saveCounterSettings(db, { ...getCounterSettings(db), cashierDiscountBp: 500 }, 2);
    const tenPercent = { discountPaise: 360, payments: pay(totalWith(360)) };
    expect(code(() => createBill(db, bill("b1", tenPercent)))).toBe("approval_needed");
    const other = addStaff(db, { name: "Kiran", role: "cashier", pinHash: "x" }, 3);
    expect(code(() => createBill(db, bill("b1", { ...tenPercent, approvedBy: other.id })))).toBe("approval_needed");
    expect(count("sequences")).toBe(0);
    const b = createBill(db, bill("b1", { ...tenPercent, approvedBy: manager.id }));
    expect(b.approvedBy).toBe(manager.id);
    expect(db.get<{ approved_by: string }>("SELECT approved_by FROM bills WHERE id = 'b1'")!.approved_by).toBe(manager.id);
  });

  it("refuses an approval from a manager who has since been deactivated", () => {
    saveCounterSettings(db, { ...getCounterSettings(db), cashierDiscountBp: 500 }, 2);
    updateStaff(db, manager.id, { active: false }, 3);
    expect(code(() => createBill(db, bill("b1", { discountPaise: 360, payments: pay(totalWith(360)), approvedBy: manager.id })))).toBe("approval_needed");
  });

  it("takes a cashier discount within the limit with no approval", () => {
    saveCounterSettings(db, { ...getCounterSettings(db), cashierDiscountBp: 500 }, 2);
    expect(createBill(db, bill("b1", { discountPaise: 180, payments: pay(totalWith(180)) })).discountPaise).toBe(180);
  });

  it("stores a delivery bill's kind and note and prints them in the snapshot", () => {
    const b = createBill(db, bill("b1", { orderKind: "delivery", deliveryNote: " Flat 4 " }));
    expect(b).toMatchObject({ orderKind: "delivery", deliveryNote: "Flat 4" });
    expect(b.receipt).toMatchObject({ orderType: "parcel", orderTypeKind: "delivery", orderTypeName: "Delivery", deliveryNote: "Flat 4" });
    expect(createBill(db, bill("b2", { deliveryNote: "x".repeat(250), orderKind: "delivery" })).deliveryNote).toHaveLength(200);
  });

  it("drops a delivery note on a takeaway bill", () => {
    const b = createBill(db, bill("b1", { deliveryNote: "Flat 4" }));
    expect(b).toMatchObject({ orderKind: "takeaway", deliveryNote: null });
    expect(b.receipt).toMatchObject({ orderTypeKind: "takeaway", orderTypeName: "Takeaway" });
    expect(b.receipt.deliveryNote).toBeUndefined();
  });

  it("attaches a customer with a masked phone", () => {
    const c = saveCustomer(db, { name: "Priya", phone: "9876543210" }, 1);
    const b = createBill(db, bill("b1", { customerId: c.id }));
    expect(b.customerId).toBe(c.id);
    expect(b.receipt.customer).toEqual({ name: "Priya", phone: "******3210" });
    expect(createBill(db, bill("b2")).receipt.customer).toBeUndefined();
  });

  it("refuses a deleted customer", () => {
    const c = saveCustomer(db, { name: "Priya", phone: "9876543210" }, 1);
    deleteCustomer(db, c.id, 2);
    expect(code(() => createBill(db, bill("b1", { customerId: c.id })))).toBe("unknown_customer");
    expect(count("sequences")).toBe(0);
  });

  it("stores line notes and gives them back for the kitchen", () => {
    createBill(db, bill("b1", { payments: pay(5600), lines: [
      { itemId: samosa.id, variantId: null, qty: 2, note: " less sugar " },
      { itemId: null, variantId: null, qty: 1, custom: { name: "Cake", pricePaise: 2000, gstRate: null }, note: "   " },
    ] }));
    expect(kitchenLines(db, "b1")).toEqual([
      { name: "Samosa", qty: 2, note: "less sugar", addonOf: null },
      { name: "Cake", qty: 1, note: null, addonOf: null },
    ]);
    expect(JSON.stringify(getBill(db, "b1")!.receipt)).not.toContain("less sugar");
  });
});
