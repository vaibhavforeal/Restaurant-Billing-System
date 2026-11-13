import { uuidv7 } from "@masalapos/domain/id";
import { calculateBill, type Bill, type BillTotals, type ReceiptSnapshot } from "@masalapos/domain/billing";
import { effectiveGstRate } from "@masalapos/domain/gst";
import { formatCreditNoteNo, formatInvoiceNo, INVOICE_COUNTER_MAX } from "@masalapos/domain/invoice-numbers";
import { DEFAULT_BILL_SHOW } from "@masalapos/domain/bill-print";
import { getCafe, getDevice, type CafeSettings } from "./cafe.js";
import type { SqlDriver } from "./driver.js";
import { dataChanged } from "./events.js";
import { nextSequence } from "./sequences.js";
import { businessDate, cafeFinancialYear } from "./time.js";

export type BillErrorCode = "no_cafe" | "empty" | "invalid_line" | "item_unavailable" | "discount_too_large"
  | "payments_mismatch" | "counter_exhausted" | "not_found" | "already_void" | "invalid_reason";

export class BillError extends Error {
  constructor(readonly code: BillErrorCode, message: string, readonly lineIndex?: number) {
    super(message);
    this.name = "BillError";
  }
}

/** A cart line: a menu item (with its variant, if it has variants) or a custom line typed in at the counter. */
export interface CartLine { itemId: string | null; variantId: string | null; qty: number; custom?: { name: string; pricePaise: number; gstRate: number | null } }
export interface PaymentInput { mode: "cash" | "upi" | "card"; amountPaise: number; refNote: string | null }
export interface CreateBillInput {
  /** Made by the caller when payment opens, so a repeated Paid returns the same bill. */
  id: string;
  lines: CartLine[]; discountPaise: number; discountNote: string | null;
  payments: PaymentInput[]; now: number;
  /** Minutes east of UTC on the device; decides the bill's day and financial year. */
  tzOffsetMinutes: number;
}
export interface CafeBill extends Bill {
  token: number; businessDate: string;
  voided: { creditNoteNo: string; reason: string; at: number } | null;
}

interface ResolvedLine { itemId: string | null; variantId: string | null; name: string; pricePaise: number; qty: number; gstRate: number }

const GST_RATES = [0, 5, 12, 18, 28];
const MAX_PRICE_PAISE = 10_000_000;

/** Turns cart lines into priced lines from the menu as it is now. Throws a BillError naming the first bad line. */
function resolveLines(db: SqlDriver, cafe: CafeSettings, lines: readonly CartLine[]): ResolvedLine[] {
  if (!lines.length) throw new BillError("empty", "Add an item to the bill");
  return lines.map((line, index) => {
    if (!Number.isInteger(line.qty) || line.qty < 1 || line.qty > 999) throw new BillError("invalid_line", "Quantity must be 1 to 999", index);
    if (line.itemId === null) {
      const c = line.custom;
      if (!c || !Number.isInteger(c.pricePaise) || c.pricePaise < 0 || c.pricePaise > MAX_PRICE_PAISE ||
          (c.gstRate !== null && !GST_RATES.includes(c.gstRate))) {
        throw new BillError("invalid_line", "Check this item's price", index);
      }
      return { itemId: null, variantId: null, name: c.name.trim().slice(0, 60) || "Item", pricePaise: c.pricePaise, qty: line.qty,
        gstRate: effectiveGstRate(c.gstRate, cafe.defaultGstRate) };
    }
    const item = db.get<{ name: string; price_paise: number; gst_rate: number | null }>(
      "SELECT name, price_paise, gst_rate FROM items WHERE id = ? AND deleted_at IS NULL AND available = 1", [line.itemId]);
    if (!item) throw new BillError("item_unavailable", "This item is no longer available", index);
    const gstRate = effectiveGstRate(item.gst_rate, cafe.defaultGstRate);
    if (line.variantId === null) {
      if (db.get("SELECT id FROM item_variants WHERE item_id = ? AND deleted_at IS NULL", [line.itemId])) {
        throw new BillError("invalid_line", "Choose a size or variant", index);
      }
      return { itemId: line.itemId, variantId: null, name: item.name, pricePaise: item.price_paise, qty: line.qty, gstRate };
    }
    const variant = db.get<{ name: string; price_paise: number }>(
      "SELECT name, price_paise FROM item_variants WHERE id = ? AND item_id = ? AND deleted_at IS NULL", [line.variantId, line.itemId]);
    if (!variant) throw new BillError("item_unavailable", "This item is no longer available", index);
    return { itemId: line.itemId, variantId: line.variantId, name: `${item.name} (${variant.name})`, pricePaise: variant.price_paise, qty: line.qty, gstRate };
  });
}

function totalsFor(cafe: CafeSettings, lines: readonly ResolvedLine[], discountPaise: number): BillTotals {
  const subtotal = lines.reduce((sum, l) => sum + l.pricePaise * l.qty, 0);
  if (!Number.isInteger(discountPaise) || discountPaise < 0 || discountPaise > subtotal) {
    throw new BillError("discount_too_large", "The discount is more than the bill");
  }
  return calculateBill(lines.map((l) => ({ pricePaise: l.pricePaise, qty: l.qty, gstRate: l.gstRate })), discountPaise, cafe.gstMode, cafe.roundOff);
}

function requireCafe(db: SqlDriver): CafeSettings {
  const cafe = getCafe(db);
  if (!cafe) throw new BillError("no_cafe", "Set up the cafe first");
  return cafe;
}

/** The totals a cart would bill at, without saving anything. */
export function previewBill(db: SqlDriver, input: Pick<CreateBillInput, "lines" | "discountPaise">): BillTotals {
  const cafe = requireCafe(db);
  return totalsFor(cafe, resolveLines(db, cafe, input.lines), input.discountPaise);
}

/**
 * Saves a paid bill in one transaction: lines priced from the menu, totals from calculateBill, the next invoice number
 * and token, a frozen receipt, and its payments. A bill id that already exists returns that bill and writes nothing.
 */
export function createBill(db: SqlDriver, input: CreateBillInput): CafeBill {
  const bill = db.transaction(() => {
    const existing = getBill(db, input.id);
    if (existing) return { bill: existing, created: false };
    const cafe = requireCafe(db);
    const device = getDevice(db);
    if (!device) throw new BillError("no_cafe", "Set up the cafe first");
    // Every check comes before any number is taken, so a refused bill never uses one.
    const lines = resolveLines(db, cafe, input.lines);
    const totals = totalsFor(cafe, lines, input.discountPaise);
    const paid = input.payments.reduce((sum, p) => sum + p.amountPaise, 0);
    if (input.payments.some((p) => !Number.isInteger(p.amountPaise) || p.amountPaise <= 0) || paid !== totals.totalPaise) {
      throw new BillError("payments_mismatch", "The payments do not add up to the total");
    }
    const day = businessDate(input.now, input.tzOffsetMinutes);
    const fy = cafeFinancialYear(input.now, input.tzOffsetMinutes);
    const series = cafe.invoicePrefix + device.seriesLetter;
    const counter = `invoice:${series}:${fy.key}`;
    const used = db.get<{ value: number }>("SELECT value FROM sequences WHERE name = ?", [counter])?.value ?? 0;
    if (used >= INVOICE_COUNTER_MAX) throw new BillError("counter_exhausted", "This year's bill numbers are used up");
    const billNo = nextSequence(db, counter);
    const invoiceNo = formatInvoiceNo(series, fy.short, billNo);
    const token = nextSequence(db, `token:${day}`);
    const receipt: ReceiptSnapshot = {
      restaurantName: cafe.name, address: cafe.address, phone: cafe.phone, gstin: cafe.gstin, fssai: cafe.fssai,
      receiptHeader: cafe.receiptHeader, receiptFooter: cafe.receiptFooter, receiptStyle: cafe.receiptStyle,
      ...(cafe.upiId ? { upiId: cafe.upiId } : {}),
      gstMode: cafe.gstMode, orderType: "parcel", orderTypeKind: "takeaway", tableName: null, splitLabel: null,
      token, billShow: DEFAULT_BILL_SHOW,
      items: lines.map((l) => ({ name: l.name, pricePaise: l.pricePaise, qty: l.qty, gstRate: l.gstRate })),
    };
    const now = input.now;
    db.run(`INSERT INTO bills (id, device_id, bill_no, invoice_no, token, business_date, created_at, discount_paise, discount_note,
      total_paise, totals_json, receipt_json, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [input.id, device.id, billNo, invoiceNo, token, day, now, input.discountPaise, input.discountNote?.trim() || null,
        totals.totalPaise, JSON.stringify(totals), JSON.stringify(receipt), now]);
    lines.forEach((l, i) => db.run(`INSERT INTO bill_lines (id, bill_id, item_id, variant_id, name, price_paise, qty, gst_rate, sort, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [uuidv7(), input.id, l.itemId, l.variantId, l.name, l.pricePaise, l.qty, l.gstRate, i + 1, now]));
    for (const p of input.payments) {
      db.run("INSERT INTO payments (id, bill_id, mode, amount_paise, ref_note, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [uuidv7(), input.id, p.mode, p.amountPaise, p.refNote, now, now]);
    }
    return { bill: getBill(db, input.id)!, created: true };
  });
  if (bill.created) dataChanged();
  return bill.bill;
}

interface BillRow {
  id: string; bill_no: number; invoice_no: string; token: number; business_date: string; created_at: number;
  discount_note: string | null; totals_json: string; receipt_json: string;
}

function toBill(db: SqlDriver, row: BillRow): CafeBill {
  const payments = db.all<{ mode: PaymentInput["mode"]; amount_paise: number; ref_note: string | null; created_at: number }>(
    "SELECT mode, amount_paise, ref_note, created_at FROM payments WHERE bill_id = ? AND deleted_at IS NULL ORDER BY rowid", [row.id]);
  const voided = db.get<{ credit_note_no: string; reason: string; created_at: number }>(
    "SELECT credit_note_no, reason, created_at FROM bill_voids WHERE bill_id = ? AND deleted_at IS NULL", [row.id]);
  return {
    ...(JSON.parse(row.totals_json) as BillTotals),
    id: row.id, billNo: row.bill_no, invoiceNo: row.invoice_no, orderId: row.id, status: voided ? "void" : "paid",
    discountNote: row.discount_note, createdAt: row.created_at, receipt: JSON.parse(row.receipt_json) as ReceiptSnapshot,
    payments: payments.map((p) => ({ mode: p.mode, amountPaise: p.amount_paise, refNote: p.ref_note, createdAt: p.created_at })),
    refundState: "none", creditNotes: [], refundedQty: {},
    token: row.token, businessDate: row.business_date,
    voided: voided ? { creditNoteNo: voided.credit_note_no, reason: voided.reason, at: voided.created_at } : null,
  };
}

export function getBill(db: SqlDriver, id: string): CafeBill | null {
  const row = db.get<BillRow>("SELECT * FROM bills WHERE id = ? AND deleted_at IS NULL", [id]);
  return row ? toBill(db, row) : null;
}

/**
 * A day's bills, newest first. A search of digits only finds a token or an invoice serial ("2" finds token 2 and
 * CPA/26-27/0002); any other search matches part of the invoice number, ignoring case.
 */
export function listBills(db: SqlDriver, day: string, search?: string): CafeBill[] {
  const q = search?.trim() ?? "";
  const rows = !q
    ? db.all<BillRow>("SELECT * FROM bills WHERE business_date = ? AND deleted_at IS NULL ORDER BY created_at DESC, id DESC", [day])
    : /^\d+$/.test(q)
      ? db.all<BillRow>("SELECT * FROM bills WHERE business_date = ? AND deleted_at IS NULL AND (token = ? OR bill_no = ?) ORDER BY created_at DESC, id DESC",
        [day, Number(q), Number(q)])
      : db.all<BillRow>("SELECT * FROM bills WHERE business_date = ? AND deleted_at IS NULL AND instr(lower(invoice_no), lower(?)) > 0 ORDER BY created_at DESC, id DESC",
        [day, q]);
  return rows.map((r) => toBill(db, r));
}

/**
 * Cancels a paid bill with a credit-note number and a reason. The bill row is not changed: the void is its own row,
 * and the bill stays in its own day's report under voids.
 */
export function voidBill(db: SqlDriver, input: { billId: string; reason: string; now: number; tzOffsetMinutes: number }): CafeBill {
  const reason = input.reason.trim();
  const bill = db.transaction(() => {
    const bill = getBill(db, input.billId);
    if (!bill) throw new BillError("not_found", "This bill could not be found");
    if (bill.voided) throw new BillError("already_void", "This bill is already void");
    if (reason.length < 1 || reason.length > 120) throw new BillError("invalid_reason", "Give a reason of up to 120 characters");
    const fy = cafeFinancialYear(input.now, input.tzOffsetMinutes);
    const creditNoteNo = formatCreditNoteNo(fy.short, nextSequence(db, `cn:${fy.key}`));
    db.run("INSERT INTO bill_voids (id, bill_id, credit_note_no, reason, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      [uuidv7(), input.billId, creditNoteNo, reason, input.now, input.now]);
    return getBill(db, input.billId)!;
  });
  dataChanged();
  return bill;
}

/** When the newest bill was made, to warn when the phone's clock is behind it. */
export function lastBillAt(db: SqlDriver): number | null {
  return db.get<{ at: number | null }>("SELECT MAX(created_at) AS at FROM bills")?.at ?? null;
}
