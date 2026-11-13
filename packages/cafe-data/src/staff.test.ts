import { describe, expect, it } from "vitest";
import {
  addStaff, hasActiveOwner, listStaff, setStaffPinHash, staffPinHash, StaffError, updateStaff,
} from "./index.js";
import { memoryCafeDb } from "./testing/sqlite-driver.js";

function code(fn: () => unknown): string | undefined {
  try { fn(); } catch (e) { return e instanceof StaffError ? e.code : `other: ${String(e)}`; }
  return undefined;
}

describe("staff", () => {
  it("adds staff in order and lists only active ones by default", () => {
    const db = memoryCafeDb();
    const owner = addStaff(db, { name: " Asha ", role: "owner", pinHash: "h" }, 1);
    const cashier = addStaff(db, { name: "Ravi", role: "cashier", pinHash: "h" }, 2);
    const manager = addStaff(db, { name: "Meena", role: "manager", pinHash: "h" }, 3);
    expect([owner.sort, cashier.sort, manager.sort]).toEqual([1, 2, 3]);
    expect(owner.name).toBe("Asha");
    updateStaff(db, cashier.id, { active: false }, 4);
    expect(listStaff(db).map((s) => s.name)).toEqual(["Asha", "Meena"]);
    expect(listStaff(db, { includeInactive: true }).map((s) => s.name)).toEqual(["Asha", "Ravi", "Meena"]);
  });
  it("refuses a blank or over-long name", () => {
    const db = memoryCafeDb();
    expect(code(() => addStaff(db, { name: "  ", role: "cashier", pinHash: "h" }, 1))).toBe("invalid");
    expect(code(() => addStaff(db, { name: "x".repeat(31), role: "cashier", pinHash: "h" }, 1))).toBe("invalid");
    expect(addStaff(db, { name: "x".repeat(30), role: "cashier", pinHash: "h" }, 1).name).toHaveLength(30);
  });
  it("refuses to demote or deactivate the last owner", () => {
    const db = memoryCafeDb();
    const a = addStaff(db, { name: "Asha", role: "owner", pinHash: "h" }, 1);
    expect(code(() => updateStaff(db, a.id, { role: "cashier" }, 2))).toBe("last_owner");
    expect(code(() => updateStaff(db, a.id, { active: false }, 2))).toBe("last_owner");
    const b = addStaff(db, { name: "Bala", role: "owner", pinHash: "h" }, 3);
    expect(updateStaff(db, a.id, { role: "manager" }, 4).role).toBe("manager");
    expect(code(() => updateStaff(db, b.id, { active: false }, 5))).toBe("last_owner");
  });
  it("refuses an update of someone who does not exist", () => {
    expect(code(() => updateStaff(memoryCafeDb(), "nope", { name: "X" }, 1))).toBe("not_found");
  });
  it("stores and reads a PIN hash", () => {
    const db = memoryCafeDb();
    const a = addStaff(db, { name: "Asha", role: "owner", pinHash: "h1" }, 1);
    expect(staffPinHash(db, a.id)).toBe("h1");
    setStaffPinHash(db, a.id, "h2", 2);
    expect(staffPinHash(db, a.id)).toBe("h2");
    expect(staffPinHash(db, "nope")).toBeNull();
  });
  it("reports whether an active owner exists", () => {
    const db = memoryCafeDb();
    expect(hasActiveOwner(db)).toBe(false);
    addStaff(db, { name: "Ravi", role: "cashier", pinHash: "h" }, 1);
    expect(hasActiveOwner(db)).toBe(false);
    addStaff(db, { name: "Asha", role: "owner", pinHash: "h" }, 2);
    expect(hasActiveOwner(db)).toBe(true);
  });
});
