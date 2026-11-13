import { beforeEach, describe, expect, it } from "vitest";
import { calculateBill } from "@masalapos/domain/billing";
import { BillError, createBill, getBill, lastBillAt, listBills, previewBill, type CartLine, type CreateBillInput, type PaymentInput } from "./bills.js";
import { saveCafe } from "./cafe.js";
import type { SqlDriver } from "./driver.js";
import { deleteItem, saveCategory, saveItem, setItemAvailable, type Item } from "./menu.js";
import { addStaff } from "./staff.js";
import { base } from "./testing/fixtures.js";
import { memoryCafeDb } from "./testing/sqlite-driver.js";

const T0 = Date.UTC(2026, 10, 13, 6, 0); // 13 Nov 2026, 11:30 IST
const DAY = 24 * 60 * 60 * 1000;
let db: SqlDriver, chai: Item, samosa: Item, ownerId: string;

function setup() {
  db = memoryCafeDb();
  saveCafe(db, base, 1);
  const category = saveCategory(db, { name: "Menu" }, 1);
  chai = saveItem(db, { categoryId: category.id, name: "Masala Chai", pricePaise: 2000, gstRate: null,
    variants: [{ name: "Small", pricePaise: 1500 }, { name: "Large", pricePaise: 2500 }] }, 1);
  samosa = saveItem(db, { categoryId: category.id, name: "Samosa", pricePaise: 1800, gstRate: 5, variants: [] }, 1);
  ownerId = addStaff(db, { name: "Asha", role: "owner", pinHash: "x" }, 1).id;
}
const variant = (name: string) => chai.variants.find((v) => v.name === name)!.id;
const cash = (amountPaise: number): PaymentInput[] => [{ mode: "cash", amountPaise, refNote: null }];
const input = (id: string, lines: CartLine[], payments: PaymentInput[], extra: Partial<CreateBillInput> = {}): CreateBillInput =>
  ({ id, lines, discountPaise: 0, discountNote: null, payments, now: T0, tzOffsetMinutes: 330, staffId: ownerId, approvedBy: null,
    customerId: null, orderKind: "takeaway", deliveryNote: null, ...extra });
const samosas = (qty: number): CartLine[] => [{ itemId: samosa.id, variantId: null, qty }];
const count = (table: string) => db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`)!.n;
function billError(fn: () => unknown): { code: string; lineIndex?: number | undefined } {
  try { fn(); } catch (e) { if (e instanceof BillError) return { code: e.code, lineIndex: e.lineIndex }; throw e; }
  throw new Error("expected a BillError");
}

describe("createBill", () => {
  beforeEach(setup);

  it("makes a paid bill with a number, a token and a frozen receipt", () => {
    const bill = createBill(db, { id: "b1", lines: [{ itemId: samosa.id, variantId: null, qty: 2 }], discountPaise: 0, discountNote: null,
      payments: [{ mode: "cash", amountPaise: 3600, refNote: null }], now: T0, tzOffsetMinutes: 330,
      staffId: ownerId, approvedBy: null, customerId: null, orderKind: "takeaway", deliveryNote: null });
    expect(bill).toMatchObject({ id: "b1", status: "paid", invoiceNo: "CPA/26-27/0001", billNo: 1, token: 1, businessDate: "2026-11-13", totalPaise: 3600, voided: null });
    expect(bill.receipt).toMatchObject({ restaurantName: "Chai Point", orderType: "parcel", orderTypeKind: "takeaway", token: 1,
      items: [{ name: "Samosa", pricePaise: 1800, qty: 2, gstRate: 5 }] });
    expect(bill.totalPaise).toBe(calculateBill([{ pricePaise: 1800, qty: 2, gstRate: 5 }], 0, "included", "rupee").totalPaise);
    expect(getBill(db, "b1")).toEqual(bill);
  });

  it("prices a variant and names the line after it", () => {
    const bill = createBill(db, input("b1", [{ itemId: chai.id, variantId: variant("Large"), qty: 1 }], cash(2500)));
    expect(bill.receipt.items).toEqual([{ name: "Masala Chai (Large)", pricePaise: 2500, qty: 1, gstRate: 5 }]);
  });

  it("refuses an item with variants when none is chosen", () => {
    expect(billError(() => createBill(db, input("b1", [{ itemId: chai.id, variantId: null, qty: 1 }], cash(2000)))))
      .toEqual({ code: "invalid_line", lineIndex: 0 });
  });

  it("bills a custom line with no menu item, defaulting its name and rate", () => {
    const bill = createBill(db, input("b1", [{ itemId: null, variantId: null, qty: 1, custom: { name: " ", pricePaise: 4000, gstRate: null } }], cash(4000)));
    expect(bill.receipt.items).toEqual([{ name: "Item", pricePaise: 4000, qty: 1, gstRate: 5 }]);
    expect(db.get<{ item_id: string | null }>("SELECT item_id FROM bill_lines WHERE bill_id = 'b1'")!.item_id).toBeNull();
  });

  it("mixes custom and menu lines in one bill", () => {
    const expected = calculateBill([{ pricePaise: 4000, qty: 1, gstRate: 5 }, { pricePaise: 1800, qty: 1, gstRate: 5 }], 0, "included", "rupee");
    const bill = createBill(db, input("b1", [{ itemId: null, variantId: null, qty: 1, custom: { name: "Cookie", pricePaise: 4000, gstRate: null } },
      ...samosas(1)], cash(expected.totalPaise)));
    expect(bill.receipt.items.map((i) => i.name)).toEqual(["Cookie", "Samosa"]);
    expect(bill).toMatchObject({ subtotalPaise: expected.subtotalPaise, totalPaise: expected.totalPaise, taxes: expected.taxes });
  });

  it("adds GST on top in exclusive mode and none in no-GST mode", () => {
    for (const gstMode of ["exclusive", "none"] as const) {
      saveCafe(db, { ...base, gstMode }, 2);
      const expected = calculateBill([{ pricePaise: 1800, qty: 2, gstRate: 5 }], 0, gstMode, "rupee");
      const bill = createBill(db, input(`b-${gstMode}`, samosas(2), cash(expected.totalPaise)));
      expect(bill).toMatchObject({ totalPaise: expected.totalPaise, cgstPaise: expected.cgstPaise, sgstPaise: expected.sgstPaise, taxes: expected.taxes });
      expect(bill.receipt.gstMode).toBe(gstMode);
    }
    expect(getBill(db, "b-exclusive")!.totalPaise).toBeGreaterThan(3600);
    expect(getBill(db, "b-none")!.cgstPaise).toBe(0);
  });

  it("takes a split payment that adds up", () => {
    const bill = createBill(db, input("b1", samosas(2), [{ mode: "cash", amountPaise: 2000, refNote: null }, { mode: "upi", amountPaise: 1600, refNote: "ref 9" }]));
    expect(bill.payments).toEqual([{ mode: "cash", amountPaise: 2000, refNote: null, createdAt: T0 }, { mode: "upi", amountPaise: 1600, refNote: "ref 9", createdAt: T0 }]);
    expect(count("payments")).toBe(2);
  });

  it.each([[3500], [3700]])("refuses payments of %i paise on a 3600 bill", (amountPaise) => {
    expect(billError(() => createBill(db, input("b1", samosas(2), cash(amountPaise)))).code).toBe("payments_mismatch");
    expect(count("bills")).toBe(0);
    expect(createBill(db, input("b2", samosas(2), cash(3600)))).toMatchObject({ invoiceNo: "CPA/26-27/0001", token: 1 });
  });

  it("saves a bill discounted to zero with no payments", () => {
    const bill = createBill(db, input("b1", samosas(2), [], { discountPaise: 3600, discountNote: "Staff" }));
    expect(bill).toMatchObject({ totalPaise: 0, status: "paid", payments: [], discountNote: "Staff" });
  });

  it("refuses a discount above the subtotal", () => {
    expect(billError(() => createBill(db, input("b1", samosas(2), [], { discountPaise: 3700 }))).code).toBe("discount_too_large");
  });

  it("refuses an empty cart and a quantity of zero or 1000", () => {
    expect(billError(() => createBill(db, input("b1", [], cash(100)))).code).toBe("empty");
    expect(billError(() => createBill(db, input("b1", samosas(0), cash(100))))).toEqual({ code: "invalid_line", lineIndex: 0 });
    expect(billError(() => createBill(db, input("b1", samosas(1000), cash(100))))).toEqual({ code: "invalid_line", lineIndex: 0 });
  });

  it("refuses a line whose item was deleted or made unavailable, and says which", () => {
    const lines: CartLine[] = [...samosas(1), { itemId: chai.id, variantId: variant("Small"), qty: 1 }];
    setItemAvailable(db, chai.id, false, 2);
    expect(billError(() => createBill(db, input("b1", lines, cash(3300))))).toEqual({ code: "item_unavailable", lineIndex: 1 });
    setItemAvailable(db, chai.id, true, 3);
    deleteItem(db, chai.id, 4);
    expect(billError(() => createBill(db, input("b1", lines, cash(3300))))).toEqual({ code: "item_unavailable", lineIndex: 1 });
    expect([count("bills"), count("bill_lines"), count("payments"), count("sequences")]).toEqual([0, 0, 0, 0]);
  });

  it("returns the same bill for a repeated id and makes no second one", () => {
    const first = createBill(db, input("b1", samosas(2), cash(3600)));
    const again = createBill(db, input("b1", samosas(2), cash(3600)));
    expect(again).toEqual(first);
    expect(count("bills")).toBe(1);
    expect(createBill(db, input("b2", samosas(2), cash(3600))).invoiceNo).toBe("CPA/26-27/0002");
  });

  it("writes nothing when a payment row cannot be stored", () => {
    expect(() => createBill(db, input("b1", samosas(2), [{ mode: "cheque" as never, amountPaise: 3600, refNote: null }]))).toThrow();
    expect([count("bills"), count("bill_lines"), count("payments"), count("sequences")]).toEqual([0, 0, 0, 0]);
  });

  it("restarts tokens each day and keeps invoice numbers running", () => {
    const a = createBill(db, input("b1", samosas(2), cash(3600)));
    const b = createBill(db, input("b2", samosas(2), cash(3600), { now: T0 + DAY }));
    expect([a.token, b.token]).toEqual([1, 1]);
    expect([a.invoiceNo, b.invoiceNo]).toEqual(["CPA/26-27/0001", "CPA/26-27/0002"]);
    expect(b.businessDate).toBe("2026-11-14");
  });

  it("starts a new invoice series in a new financial year", () => {
    const march = createBill(db, input("b1", samosas(2), cash(3600), { now: Date.UTC(2027, 2, 31, 18, 29) })); // 31 Mar 2027 23:59 IST
    const april = createBill(db, input("b2", samosas(2), cash(3600), { now: Date.UTC(2027, 2, 31, 18, 30) })); // 1 Apr 2027 00:00 IST
    expect(march.invoiceNo).toMatch(/^CPA\/26-27\/\d{4}$/);
    expect(april.invoiceNo).toBe("CPA/27-28/0001");
  });

  it("refuses to pass the yearly invoice limit", () => {
    db.run("INSERT INTO sequences (name, value) VALUES ('invoice:CPA:2026-27', 99999)");
    expect(billError(() => createBill(db, input("b1", samosas(2), cash(3600)))).code).toBe("counter_exhausted");
    expect(db.get<{ value: number }>("SELECT value FROM sequences WHERE name = 'invoice:CPA:2026-27'")!.value).toBe(99999);
    expect(count("bills")).toBe(0);
  });

  it("keeps an old bill's receipt when the cafe or the item changes later", () => {
    const bill = createBill(db, input("b1", samosas(2), cash(3600)));
    saveCafe(db, { ...base, name: "Renamed Cafe" }, 2);
    saveItem(db, { id: samosa.id, categoryId: samosa.categoryId, name: "Big Samosa", pricePaise: 2500, gstRate: 5, variants: [] }, 3);
    expect(getBill(db, "b1")!.receipt).toEqual(bill.receipt);
    expect(getBill(db, "b1")!.receipt.restaurantName).toBe("Chai Point");
  });

  it("lists a day's bills newest first and finds them by token or invoice number", () => {
    for (const [i, id] of ["b1", "b2", "b3"].entries()) createBill(db, input(id, samosas(2), cash(3600), { now: T0 + i * 60_000 }));
    expect(listBills(db, "2026-11-13").map((b) => b.id)).toEqual(["b3", "b2", "b1"]);
    expect(listBills(db, "2026-11-13", "2").map((b) => b.id)).toEqual(["b2"]);
    expect(listBills(db, "2026-11-13", "cpa/26-27/0003").map((b) => b.id)).toEqual(["b3"]);
    expect(listBills(db, "2026-11-14")).toEqual([]);
    expect(lastBillAt(db)).toBe(T0 + 120_000);
  });

  it("previews the same totals it will bill", () => {
    const lines: CartLine[] = [...samosas(1), { itemId: chai.id, variantId: variant("Large"), qty: 2 }];
    const preview = previewBill(db, { lines, discountPaise: 300 });
    const bill = createBill(db, input("b1", lines, cash(preview.totalPaise), { discountPaise: 300 }));
    expect(bill).toMatchObject(preview);
  });
});
