import { createBill, getBill, printTarget, type CafeBill, type CreateBillInput, type Printer, type SqlDriver } from "@masalapos/cafe-data";
import { receiptSlip } from "@masalapos/print";
import type { PrintJob } from "../print/print-queue";

/**
 * Saves the bill, then queues its receipt. A problem with the receipt never undoes or hides the saved bill, and a
 * repeated call for the same bill id returns it without printing a second receipt. A failure to save throws.
 */
export function completePayment(db: SqlDriver, input: CreateBillInput, deps: {
  printer: Printer | null; enqueue: (job: PrintJob) => void; newId: () => string;
}): { bill: CafeBill; jobId: string | null; printError: string | null } {
  const already = getBill(db, input.id) !== null;
  const bill = createBill(db, input);
  if (already || !deps.printer) return { bill, jobId: null, printError: null };
  try {
    const jobId = deps.newId();
    const p = deps.printer;
    deps.enqueue({ id: jobId, label: `Bill ${bill.invoiceNo}`, target: printTarget(p), bytes: receiptSlip(bill, p.paperWidth, p.profile), copies: p.profile.copies });
    return { bill, jobId, printError: null };
  } catch {
    return { bill, jobId: null, printError: "The receipt could not be sent to the printer. Reprint it from Bills." };
  }
}
