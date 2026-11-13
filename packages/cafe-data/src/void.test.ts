import { beforeEach, describe, expect, it } from "vitest";
import { receiptSlip, renderBytes } from "@masalapos/print";
import { BillError, createBill, getBill, voidBill } from "./bills.js";
import type { SqlDriver } from "./driver.js";
import { menuCafe, T0, walkIn } from "./testing/fixtures.js";
import { addStaff, type Staff } from "./staff.js";

let db: SqlDriver, owner: Staff, cashier: Staff;
const code = (fn: () => unknown) => {
  try { fn(); } catch (e) { if (e instanceof BillError) return e.code; throw e; }
  return "no error";
};

describe("voidBill", () => {
  beforeEach(() => {
    const cafe = menuCafe();
    ({ db, owner, cashier } = cafe);
    createBill(db, { id: "b1", lines: [{ itemId: cafe.samosa.id, variantId: null, qty: 2 }], discountPaise: 0, discountNote: null,
      payments: [{ mode: "cash", amountPaise: 3600, refNote: null }], now: T0, tzOffsetMinutes: 330, ...walkIn(cashier.id) });
  });

  it("voids a bill with a credit note number and a reason", () => {
    const voided = voidBill(db, { billId: "b1", staffId: owner.id, reason: " wrong order ", now: T0 + 60_000, tzOffsetMinutes: 330 });
    expect(voided).toMatchObject({ status: "void", voided: { creditNoteNo: "CN/26-27/001", reason: "wrong order", at: T0 + 60_000 } });
    expect(getBill(db, "b1")!.status).toBe("void");
    expect(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM bills")!.n).toBe(1); // the bill row itself is untouched
  });

  it("refuses a second void, an unknown bill and an empty reason", () => {
    expect(code(() => voidBill(db, { billId: "b1", staffId: owner.id, reason: "  ", now: T0, tzOffsetMinutes: 330 }))).toBe("invalid_reason");
    expect(code(() => voidBill(db, { billId: "b1", staffId: owner.id, reason: "y".repeat(121), now: T0, tzOffsetMinutes: 330 }))).toBe("invalid_reason");
    expect(code(() => voidBill(db, { billId: "nope", staffId: owner.id, reason: "x", now: T0, tzOffsetMinutes: 330 }))).toBe("not_found");
    voidBill(db, { billId: "b1", staffId: owner.id, reason: "x", now: T0, tzOffsetMinutes: 330 });
    expect(code(() => voidBill(db, { billId: "b1", staffId: owner.id, reason: "x", now: T0, tzOffsetMinutes: 330 }))).toBe("already_void");
    expect(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM bill_voids")!.n).toBe(1);
  });

  it("prints VOID on the receipt of a voided bill", () => {
    expect(renderBytes(receiptSlip(voidBill(db, { billId: "b1", staffId: owner.id, reason: "x", now: T0, tzOffsetMinutes: 330 }), 58))).toContain("VOID");
  });

  it("lets a manager void and records them", () => {
    const manager = addStaff(db, { name: "Meena", role: "manager", pinHash: "x" }, 1);
    voidBill(db, { billId: "b1", staffId: manager.id, reason: "x", now: T0, tzOffsetMinutes: 330 });
    expect(db.get<{ staff_id: string }>("SELECT staff_id FROM bill_voids WHERE bill_id = 'b1'")!.staff_id).toBe(manager.id);
  });

  it("refuses a void by a cashier", () => {
    expect(code(() => voidBill(db, { billId: "b1", staffId: cashier.id, reason: "x", now: T0, tzOffsetMinutes: 330 }))).toBe("not_allowed");
    expect(code(() => voidBill(db, { billId: "b1", staffId: "nobody", reason: "x", now: T0, tzOffsetMinutes: 330 }))).toBe("not_allowed");
    expect(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM bill_voids")!.n).toBe(0);
    expect(db.get("SELECT value FROM sequences WHERE name LIKE 'cn:%'")).toBeUndefined();
  });
});
