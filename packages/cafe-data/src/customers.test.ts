import { describe, expect, it } from "vitest";
import { CustomerError, deleteCustomer, findCustomers, getCustomer, maskPhone, normalisePhone, saveCustomer } from "./index.js";
import { memoryCafeDb } from "./testing/sqlite-driver.js";

function caught(fn: () => unknown): CustomerError {
  try { fn(); } catch (e) { if (e instanceof CustomerError) return e; throw e; }
  throw new Error("did not throw");
}

describe("customers", () => {
  it.each([["+91 98765 43210"], ["098765-43210"], ["9876543210"], ["919876543210"], ["(98765) 43210"]])("normalises %s to 9876543210", (raw) => {
    expect(normalisePhone(raw)).toBe("9876543210");
  });
  it.each([["12345"], ["5876543210"], ["+1 415 555 0100"], ["98765432101"]])("refuses %s", (raw) => {
    expect(normalisePhone(raw)).toBeNull();
    expect(caught(() => saveCustomer(memoryCafeDb(), { name: "A", phone: raw }, 1)).code).toBe("invalid");
  });
  it("saves a customer with a normalised phone and reads it back", () => {
    const db = memoryCafeDb();
    const c = saveCustomer(db, { name: " Asha ", phone: "+91 98765 43210", addressNote: " Flat 4 " }, 1);
    expect(c).toMatchObject({ name: "Asha", phone: "9876543210", addressNote: "Flat 4" });
    expect(getCustomer(db, c.id)).toEqual(c);
  });
  it("refuses a blank name, and over-long name or address", () => {
    const db = memoryCafeDb();
    expect(caught(() => saveCustomer(db, { name: " ", phone: "9876543210" }, 1)).code).toBe("invalid");
    expect(caught(() => saveCustomer(db, { name: "x".repeat(61), phone: "9876543210" }, 1)).code).toBe("invalid");
    expect(caught(() => saveCustomer(db, { name: "A", phone: "9876543210", addressNote: "x".repeat(201) }, 1)).code).toBe("invalid");
  });
  it("refuses a second customer with the same phone and names the first", () => {
    const db = memoryCafeDb();
    const first = saveCustomer(db, { name: "Asha", phone: "9876543210" }, 1);
    const e = caught(() => saveCustomer(db, { name: "Ravi", phone: "098765 43210" }, 2));
    expect(e.code).toBe("phone_taken");
    expect(e.existingId).toBe(first.id);
    expect(saveCustomer(db, { id: first.id, name: "Asha K", phone: "+91 98765 43210" }, 3).name).toBe("Asha K");
  });
  it("lets a deleted customer's phone be used again", () => {
    const db = memoryCafeDb();
    const first = saveCustomer(db, { name: "Asha", phone: "9876543210" }, 1);
    deleteCustomer(db, first.id, 2);
    expect(getCustomer(db, first.id)).toBeNull();
    expect(saveCustomer(db, { name: "Ravi", phone: "9876543210" }, 3).name).toBe("Ravi");
  });
  it("refuses to edit a deleted customer", () => {
    const db = memoryCafeDb();
    const c = saveCustomer(db, { name: "Asha", phone: "9876543210" }, 1);
    deleteCustomer(db, c.id, 2);
    expect(caught(() => saveCustomer(db, { id: c.id, name: "Asha", phone: "9876543210" }, 3)).code).toBe("not_found");
  });
  it("finds customers by part of the phone or the name", () => {
    const db = memoryCafeDb();
    saveCustomer(db, { name: "Asha", phone: "9876543210" }, 1);
    saveCustomer(db, { name: "Prakash", phone: "9123456789" }, 1);
    saveCustomer(db, { name: "Ravi", phone: "9000000000" }, 1);
    expect(findCustomers(db, "4321").map((c) => c.name)).toEqual(["Asha"]);
    expect(findCustomers(db, "ASH").map((c) => c.name)).toEqual(["Asha", "Prakash"]);
    expect(findCustomers(db, "98 7").map((c) => c.name)).toEqual(["Asha"]);
    expect(findCustomers(db, "", 2)).toHaveLength(2);
  });
  it("masks a phone to its last four digits", () => {
    expect(maskPhone("9876543210")).toBe("******3210");
  });
});
