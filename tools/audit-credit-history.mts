import Database from "better-sqlite3";
import { copyFileSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CreditHistoryError, validateCreditHistory, type BillLine, type Credited, type Money } from "../packages/domain/src/credit-notes.js";

interface Finding { billId: string; orderItemId?: string; creditNoteId?: string; invariant: string; field?: string; mode?: string }
type StoredLine = Money & { orderItemId: string; qty: number };
const fields = ["taxablePaise", "cgstPaise", "sgstPaise", "roundingPaise", "totalPaise"] as const;
const columns = "taxable_paise AS taxablePaise, cgst_paise AS cgstPaise, sgst_paise AS sgstPaise, rounding_paise AS roundingPaise, total_paise AS totalPaise";
const zero = (): Money => ({ taxablePaise: 0, cgstPaise: 0, sgstPaise: 0, roundingPaise: 0, totalPaise: 0 });

function assertNoJournal(path: string) {
  for (const suffix of ["-wal", "-journal"]) {
    try {
      if (statSync(path + suffix).size > 0) throw new Error("A standalone, consistent backup is required");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

/** SQLite may create sidecars even in readonly mode. Open only our private copy. */
function auditCreditHistory(path: string): { billsChecked: number; findings: Finding[] } {
  const source = resolve(path);
  const before = statSync(source);
  if (!before.isFile()) throw new Error("An existing database file is required");
  assertNoJournal(source);
  const directory = mkdtempSync(join(resolve(tmpdir()), "forkflow-credit-snapshot-"));
  try {
    const snapshot = join(directory, "backup.db");
    copyFileSync(source, snapshot);
    assertNoJournal(source);
    const after = statSync(source);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
      throw new Error("The supplied backup changed during inspection");
    }
    return auditSnapshot(snapshot);
  } finally {
    // This absolute directory was created uniquely by mkdtemp under the OS temp root.
    rmSync(directory, { recursive: true, force: true });
  }
}

function auditSnapshot(path: string): { billsChecked: number; findings: Finding[] } {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    return db.transaction(() => {
      const findings: Finding[] = [];
      // Prepare every required query even for an empty database, validating the schema up front.
      const queries = {
        lines: db.prepare(`SELECT order_item_id AS orderItemId, qty, ${columns} FROM bill_report_lines WHERE bill_id = ? ORDER BY order_item_id`),
        notes: db.prepare(`SELECT id, kind, ${columns} FROM credit_notes WHERE bill_id = ? ORDER BY cn_no`),
        payments: db.prepare("SELECT mode, amount_paise AS amountPaise FROM payments WHERE bill_id = ?"),
        savedLines: db.prepare(`SELECT order_item_id AS orderItemId, gst_rate AS gstRate, qty, ${columns}
          FROM credit_note_lines WHERE credit_note_id = ? ORDER BY order_item_id`),
        taxes: db.prepare(`SELECT gst_rate AS gstRate, taxable_paise AS taxablePaise, cgst_paise AS cgstPaise, sgst_paise AS sgstPaise
          FROM credit_note_taxes WHERE credit_note_id = ? ORDER BY gst_rate`),
        refunds: db.prepare("SELECT mode, amount_paise AS amountPaise FROM refund_payments WHERE credit_note_id = ?"),
      };
      const bills = db.prepare("SELECT id FROM bills ORDER BY id").all() as Array<{ id: string }>;
      for (const { id: billId } of bills) {
        const add = (invariant: string, location: Omit<Finding, "billId" | "invariant"> = {}) => findings.push({ billId, ...location, invariant });
        const checkMoney = (money: Money, location: Omit<Finding, "billId" | "invariant">) => {
          for (const field of fields) {
            if (!Number.isSafeInteger(money[field])) add("nonintegral_saved_amount", { ...location, field });
            if (field !== "roundingPaise" && money[field] < 0) add("negative_saved_amount", { ...location, field });
          }
          if (money.totalPaise !== money.taxablePaise + money.cgstPaise + money.sgstPaise + money.roundingPaise) add("saved_components_do_not_sum", location);
        };
        const lines = queries.lines.all(billId) as StoredLine[];
        const credited: Record<string, Credited> = Object.create(null);
        const notes = queries.notes.all(billId) as Array<Money & { id: string; kind: string }>;
        const payments = queries.payments.all(billId) as Array<{ mode: string; amountPaise: number }>;
        const paidByMode = new Map<string, number>(), refundedByMode = new Map<string, number>();
        for (const payment of payments) paidByMode.set(payment.mode, (paidByMode.get(payment.mode) ?? 0) + payment.amountPaise);
        const paidTotal = payments.reduce((sum, p) => sum + p.amountPaise, 0);
        let refundedTotal = 0;
        for (const note of notes) {
          const creditNoteId = note.id;
          checkMoney(note, { creditNoteId });
          const saved = queries.savedLines.all(creditNoteId) as Array<StoredLine & { gstRate: number }>;
          const sums = zero();
          const taxes = new Map<number, Money>();
          for (const row of saved) {
            const location = { creditNoteId, orderItemId: row.orderItemId };
            checkMoney(row, location);
            if (!Number.isSafeInteger(row.qty)) add("nonintegral_saved_quantity", location);
            if (row.qty <= 0) add("nonpositive_saved_quantity", location);
            const prior = credited[row.orderItemId] ?? { qty: 0, ...zero() };
            prior.qty += row.qty;
            const tax = taxes.get(row.gstRate) ?? zero();
            for (const field of fields) {
              prior[field] += row[field];
              sums[field] += row[field];
              tax[field] += row[field];
            }
            credited[row.orderItemId] = prior;
            taxes.set(row.gstRate, tax);
          }
          // Older bills without stored lines legitimately have a line-less void note.
          if (lines.length || saved.length || note.kind !== "void") {
            for (const field of fields) if (note[field] !== sums[field]) add("note_lines_do_not_sum", { creditNoteId, field });
          }
          const savedTaxes = queries.taxes.all(creditNoteId) as Array<Pick<BillLine, "gstRate" | "taxablePaise" | "cgstPaise" | "sgstPaise">>;
          for (const field of ["taxablePaise", "cgstPaise", "sgstPaise"] as const) {
            if (savedTaxes.reduce((sum, tax) => sum + tax[field], 0) !== note[field]) add("note_taxes_do_not_sum", { creditNoteId, field });
          }
          if (saved.length) {
            for (const rate of new Set([...taxes.keys(), ...savedTaxes.map((tax) => tax.gstRate)])) {
              const actual = savedTaxes.find((tax) => tax.gstRate === rate);
              const expected = taxes.get(rate);
              for (const field of ["taxablePaise", "cgstPaise", "sgstPaise"] as const) {
                if ((actual?.[field] ?? 0) !== (expected?.[field] ?? 0)) add("line_taxes_do_not_sum", { creditNoteId, field });
              }
            }
          }
          const refunds = queries.refunds.all(creditNoteId) as Array<{ mode: string; amountPaise: number }>;
          let noteRefunds = 0;
          for (const refund of refunds) {
            noteRefunds += refund.amountPaise;
            refundedByMode.set(refund.mode, (refundedByMode.get(refund.mode) ?? 0) + refund.amountPaise);
            if (!Number.isSafeInteger(refund.amountPaise) || refund.amountPaise <= 0) add("invalid_saved_refund_amount", { creditNoteId, mode: refund.mode });
          }
          if ((note.kind === "refund" || paidTotal > 0) && noteRefunds !== note.totalPaise) add("note_refunds_do_not_sum", { creditNoteId });
          refundedTotal += noteRefunds;
        }
        try { validateCreditHistory(lines, credited); }
        catch (error) {
          if (!(error instanceof CreditHistoryError)) throw error;
          for (const violation of error.violations) findings.push({ billId, ...violation });
        }
        if (refundedTotal > paidTotal) add("refunds_exceed_payments");
        for (const [mode, amount] of refundedByMode) {
          if (amount > (paidByMode.get(mode) ?? 0)) add("refunds_exceed_payments_by_mode", { mode });
        }
      }
      return { billsChecked: bills.length, findings };
    })();
  } finally { db.close(); }
}

const args = process.argv.slice(2);
if (args.length !== 1 || !args[0]?.trim() || args[0] === ":memory:") {
  console.log(JSON.stringify({ error: "Usage: node --import tsx tools/audit-credit-history.mts <existing-backup-database-path>" }));
  process.exitCode = 2;
} else {
  try {
    const report = auditCreditHistory(args[0]);
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.findings.length ? 1 : 0;
  } catch {
    // Do not echo database content, payment references or credentials in execution errors.
    console.log(JSON.stringify({ error: "Unable to inspect the database. Use an existing, readable, standalone backup with the ForkFlow credit-note schema and no outstanding WAL or journal data." }));
    process.exitCode = 2;
  }
}
