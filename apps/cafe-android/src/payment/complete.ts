import { createBill, getBill, kitchenLines, printTarget, type CafeBill, type CreateBillInput, type Printer, type SqlDriver } from "@masalapos/cafe-data";
import { receiptSlip } from "@masalapos/print";
import { kitchenSlipBytes, kitchenTarget, NO_KITCHEN_PRINTER } from "../print/kitchen-slip";
import type { PrintJob } from "../print/print-queue";

export interface PaymentResult {
  bill: CafeBill; jobId: string | null; printError: string | null;
  /** The kitchen slip's job, queued after the receipt when the cafe prints one. */
  kitchenJobId: string | null; kitchenProblem: string | null;
}

/**
 * Saves the bill, then queues its receipt and, when the cafe prints one, the kitchen slip after it. A problem with
 * either never undoes or hides the saved bill, and a repeated call for the same bill id returns it without printing
 * again. A failure to save throws.
 */
export function completePayment(db: SqlDriver, input: CreateBillInput, deps: {
  printer: Printer | null; enqueue: (job: PrintJob) => void; newId: () => string;
}): PaymentResult {
  const already = getBill(db, input.id) !== null;
  const bill = createBill(db, input);
  if (already) return { bill, jobId: null, printError: null, kitchenJobId: null, kitchenProblem: null };
  let jobId: string | null = null;
  let printError: string | null = null;
  if (deps.printer) {
    try {
      const id = deps.newId();
      const p = deps.printer;
      deps.enqueue({ id, label: `Bill ${bill.invoiceNo}`, target: printTarget(p), bytes: receiptSlip(bill, p.paperWidth, p.profile), copies: p.profile.copies });
      jobId = id;
    } catch {
      printError = "The receipt could not be sent to the printer. Reprint it from Bills.";
    }
  }
  return { bill, jobId, printError, ...queueKitchenSlip(db, bill, deps) };
}

/** Queues one kitchen slip for a saved bill (after Paid, or Reprint kitchen slip). Never throws. */
export function queueKitchenSlip(db: SqlDriver, bill: CafeBill, deps: { enqueue: (job: PrintJob) => void; newId: () => string }):
  { kitchenJobId: string | null; kitchenProblem: string | null } {
  try {
    const target = kitchenTarget(db);
    if (!("printer" in target)) {
      return { kitchenJobId: null, kitchenProblem: target.reason === "no_kitchen_printer" ? NO_KITCHEN_PRINTER : null };
    }
    const p = target.printer;
    const id = deps.newId();
    deps.enqueue({ id, label: `Kitchen slip, token ${bill.token}`, target: printTarget(p),
      bytes: kitchenSlipBytes(bill, kitchenLines(db, bill.id), p.paperWidth, p.profile), copies: 1 });
    return { kitchenJobId: id, kitchenProblem: null };
  } catch {
    return { kitchenJobId: null, kitchenProblem: "The kitchen slip could not be sent to the printer. Reprint it from Bills." };
  }
}
