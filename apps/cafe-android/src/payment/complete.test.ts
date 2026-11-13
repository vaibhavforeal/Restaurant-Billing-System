import { describe, expect, it } from "vitest";
import {
  getBill, getCounterSettings, kitchenLines, previewBill, saveCounterSettings, saveCustomer, savePrinter, type CreateBillInput,
} from "@masalapos/cafe-data";
import { menuCafe, T0, walkIn } from "../../../../packages/cafe-data/src/testing/fixtures";
import type { PrintJob } from "../print/print-queue";
import { completePayment } from "./complete";

function setup(withPrinter = true) {
  const { db, samosa, owner } = menuCafe();
  const printer = withPrinter ? savePrinter(db, { name: "BT", transport: "bluetooth", address: "AA:BB:CC:DD:EE:FF", paperWidth: 58, role: "receipt" }) : null;
  const input: CreateBillInput = { id: "b1", lines: [{ itemId: samosa.id, variantId: null, qty: 2 }], discountPaise: 0, discountNote: null,
    payments: [{ mode: "cash", amountPaise: 3600, refNote: null }], now: T0, tzOffsetMinutes: 330, ...walkIn(owner.id) };
  return { db, printer, input };
}

describe("completePayment", () => {
  it("keeps the saved bill when its receipt cannot be queued", () => {
    const { db, printer, input } = setup();
    const result = completePayment(db, input, { printer, enqueue: () => { throw new Error("queue broken"); }, newId: () => "job-1" });
    expect(result.bill.id).toBe("b1");
    expect(getBill(db, "b1")).not.toBeNull();
    expect(result.jobId).toBeNull();
    expect(result.printError).toBe("The receipt could not be sent to the printer. Reprint it from Bills.");
  });

  it("queues one receipt even when Paid runs twice for the same bill", () => {
    const { db, printer, input } = setup();
    const jobs: PrintJob[] = [];
    const deps = { printer, enqueue: (j: PrintJob) => { jobs.push(j); }, newId: () => `job-${jobs.length + 1}` };
    const first = completePayment(db, input, deps);
    const second = completePayment(db, input, deps);
    expect(second.bill).toEqual(first.bill);
    expect(jobs).toHaveLength(1);
    expect(first.jobId).toBe("job-1");
    expect(second.jobId).toBeNull();
  });

  it("queues nothing without a printer", () => {
    const { db, input } = setup(false);
    const result = completePayment(db, input, { printer: null, enqueue: () => { throw new Error("must not be called"); }, newId: () => "x" });
    expect(result).toMatchObject({ jobId: null, printError: null });
  });
});

describe("completePayment with Phase 2 fields", () => {
  it("passes staff, approval, customer, kind and notes to createBill", () => {
    const { db, samosa, cashier, owner } = menuCafe();
    const c = saveCustomer(db, { name: "Asha", phone: "9876543210" }, 1);
    saveCounterSettings(db, { ...getCounterSettings(db), cashierDiscountBp: 0 }, 1);
    const lines = [{ itemId: samosa.id, variantId: null, qty: 2, note: "less oil" }];
    const total = previewBill(db, { lines, discountPaise: 360 }).totalPaise;
    const { bill } = completePayment(db, { id: "b9", lines, discountPaise: 360, discountNote: "Regular",
      payments: [{ mode: "cash", amountPaise: total, refNote: null }], now: T0, tzOffsetMinutes: 330,
      staffId: cashier.id, approvedBy: owner.id, customerId: c.id, orderKind: "delivery", deliveryNote: "Flat 4" },
      { printer: null, enqueue: () => undefined, newId: () => "x" });
    expect(bill).toMatchObject({ staffId: cashier.id, approvedBy: owner.id, customerId: c.id, orderKind: "delivery", deliveryNote: "Flat 4" });
    expect(kitchenLines(db, "b9")[0]!.note).toBe("less oil");
  });
});

describe("completePayment and the kitchen slip", () => {
  function kitchenSetup(kitchenSlip: "off" | "kitchen" | "receipt") {
    const { db, samosa, cashier } = menuCafe();
    const printer = savePrinter(db, { name: "Counter", transport: "bluetooth", address: "AA:BB:CC:DD:EE:FF", paperWidth: 58, role: "receipt" });
    saveCounterSettings(db, { ...getCounterSettings(db), kitchenSlip }, 1);
    const input: CreateBillInput = { id: "k1", lines: [{ itemId: samosa.id, variantId: null, qty: 2, note: "less sugar" }], discountPaise: 0,
      discountNote: null, payments: [{ mode: "cash", amountPaise: 3600, refNote: null }], now: T0, tzOffsetMinutes: 330, ...walkIn(cashier.id) };
    return { db, printer, input };
  }

  it("queues the kitchen slip after the receipt and never fails the saved bill", () => {
    const { db, printer, input } = kitchenSetup("receipt");
    const jobs: PrintJob[] = [];
    const ok = completePayment(db, input, { printer, enqueue: (j) => { jobs.push(j); }, newId: () => `job-${jobs.length + 1}` });
    expect(jobs.map((j) => j.label)).toEqual([`Bill ${ok.bill.invoiceNo}`, `Kitchen slip, token ${ok.bill.token}`]);
    expect(jobs[1]!.copies).toBe(1);
    expect(ok).toMatchObject({ jobId: "job-1", kitchenJobId: "job-2", kitchenProblem: null });

    const second = kitchenSetup("receipt");
    const printed: PrintJob[] = [];
    const result = completePayment(second.db, second.input, { printer: second.printer, newId: () => `job-${printed.length + 1}`,
      enqueue: (j) => { if (j.label.startsWith("Kitchen")) throw new Error("queue broken"); printed.push(j); } });
    expect(getBill(second.db, "k1")).not.toBeNull();
    expect(printed).toHaveLength(1);
    expect(result).toMatchObject({ jobId: "job-1", printError: null, kitchenJobId: null });
    expect(result.kitchenProblem).toBe("The kitchen slip could not be sent to the printer. Reprint it from Bills.");
  });

  it("says when the kitchen slip has no printer, and prints none when it is off", () => {
    const off = kitchenSetup("off");
    const jobs: PrintJob[] = [];
    expect(completePayment(off.db, off.input, { printer: off.printer, enqueue: (j) => { jobs.push(j); }, newId: () => "j" }))
      .toMatchObject({ kitchenJobId: null, kitchenProblem: null });
    expect(jobs).toHaveLength(1);
    const kitchen = kitchenSetup("kitchen");
    expect(completePayment(kitchen.db, kitchen.input, { printer: kitchen.printer, enqueue: () => undefined, newId: () => "j" }))
      .toMatchObject({ kitchenJobId: null, kitchenProblem: "No kitchen printer. Add one in More, Printers." });
  });
});
