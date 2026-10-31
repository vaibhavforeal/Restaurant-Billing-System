import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { BillCreate, BillPreview, BillSettle, BillPrint, calculateBill, nextSequence, uuidv7, roleFor,
  localDateKey, pointsEarned, type Bill, type Database, type GstMode, type PaymentMode, type ReceiptCustomer, type ReceiptSnapshot, type TaxLine } from "@forkflow/domain";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { httpError } from "./http-error.js";
import { loadBillCreditNotes } from "./credit-notes.js";
import { readGstSettings } from "./gst-settings.js";
import { loadOrderJson } from "./mappers.js";
import { linkedTableIds, orderTableLabel } from "./table-label.js";
import { receiptSlip, receiptHtml } from "./print/receipt.js";
import { billUpiPayment, upiQrSvg } from "./print/upi.js";
import { consumeStock, saveReportLines } from "@forkflow/domain";
import { publishStock } from "./stock.js";
import { readProfile } from "./print/profile.js";
import { bestEffortPrint } from "./print/best-effort.js";
import { effectiveDiscountCap } from "./discount-caps.js";
import { resolveApprover } from "./credit-notes.js";
import { customerSlab } from "./customers.js";
import { earnExpiry, loyaltySettings, sweepExpiry } from "./loyalty.js";
import { billFeedbackUrl } from "./feedback.js";
import { crmEnabled } from "./integrations.js";
import { pointsBalance } from "./mappers.js";

interface BillRow {
  id: string; bill_no: number; order_id: string; status: Bill["status"];
  subtotal_paise: number; discount_paise: number; discount_note: string | null;
  cgst_paise: number; sgst_paise: number; rounding_paise: number; total_paise: number;
  created_at: number; client_ref: string | null; request_json: string | null; receipt_json: string | null;
}
interface PrinterRow { id: string; name: string; kind: "network" | "windows" | "bluetooth"; connection: string; paper_width: 58 | 80; receipt_profile: string }

const feedbackOf = (db: Database, id: string) => { const url = billFeedbackUrl(db, id); return url ? { feedbackUrl: url } : {}; };

/** A bill's JSON, including its credit notes. */
export function loadBill(db: Database, id: string): Bill {
  const r = db.prepare("SELECT * FROM bills WHERE id = ?").get(id) as BillRow | undefined;
  if (!r) throw httpError(404, "bill not found");
  if (!r.receipt_json) throw httpError(409, "This legacy bill has no saved receipt");
  const taxes = db.prepare("SELECT gst_rate AS gstRate, taxable_paise AS taxablePaise, cgst_paise AS cgstPaise, sgst_paise AS sgstPaise FROM bill_taxes WHERE bill_id = ? ORDER BY gst_rate").all(id) as TaxLine[];
  const payments = db.prepare("SELECT mode, amount_paise AS amountPaise, ref_note AS refNote, created_at AS createdAt FROM payments WHERE bill_id = ? ORDER BY id").all(id) as Bill["payments"];
  const receipt = JSON.parse(r.receipt_json) as ReceiptSnapshot;
  return { id, billNo: r.bill_no, orderId: r.order_id, status: r.status, subtotalPaise: r.subtotal_paise,
    discountPaise: r.discount_paise, discountNote: r.discount_note, cgstPaise: r.cgst_paise, sgstPaise: r.sgst_paise,
    roundingPaise: r.rounding_paise, totalPaise: r.total_paise, createdAt: r.created_at,
    receipt, taxes, payments, ...loadBillCreditNotes(db, id, r.total_paise), ...feedbackOf(db, id) };
}

type IssueRole = Parameters<typeof roleFor>[0];
/** Who is billing, and the admin (if any) who approved a discount above their limit. */
interface BillActor { id: string; role: IssueRole; approvedBy?: string | null }
/** The staff-entered discount, and the loyalty points the customer spends. */
interface BillDiscount { manualPaise: number; redeemPoints?: number }
const isDiscountCapError = (err: unknown) => typeof err === "object" && err !== null && "code" in err && err.code === "discount_cap";

/** Validates an order for billing and prices it. Shared by the preview and by `issueBill` so both see the same bill. */
function priceOrder(db: Database, orderId: string, discount: BillDiscount, actor: BillActor, gstMode: GstMode | undefined, receiptExtra?: Partial<ReceiptSnapshot>) {
  const order = loadOrderJson(db, orderId);
  if (!order) throw httpError(404, "order not found");
  if (order.status !== "open") throw httpError(409, "order is not open");
  const active = order.items.filter((item) => item.status !== "cancelled");
  // A combo's items are ₹0 lines under it: the bill shows the combo, with what it held.
  const items = active.filter((item) => !item.parentItemId);
  if (!items.length) throw httpError(409, "Add items before billing");
  const contents = (combo: (typeof items)[number]) => active.filter((item) => item.parentItemId === combo.id)
    .map((item) => item.qty > combo.qty ? `${item.qty / combo.qty} x ${item.name}` : item.name);
  const unsent = db.prepare("SELECT oi.id FROM order_items oi JOIN products p ON p.id = oi.product_id WHERE oi.order_id = ? AND oi.status = 'pending' AND p.kot_station_id IS NOT NULL LIMIT 1").get(orderId);
  if (unsent) throw httpError(409, "Send kitchen items before billing");
  let totals;
  // The restaurant's setting, unless the caller overrides it (Zomato bills charge no GST).
  const mode = gstMode ?? readGstSettings(db).gstMode;
  // With CRM & Loyalty off in the Marketplace a customer left on the order gives no discount, points or receipt line.
  const customer = crmEnabled(db) ? order.customer : null;
  const loyalty = customerDiscounts(db, customer, items.reduce((sum, item) => sum + item.pricePaise * item.qty, 0), discount);
  try { totals = calculateBill(items, discount.manualPaise + loyalty.customerDiscountPaise + loyalty.pointsValuePaise, mode); }
  catch (err) { throw httpError(400, err instanceof Error ? err.message.replace("Discount exceeds subtotal", "The discounts are more than the bill") : "Invalid bill"); }
  // The limit is on what staff choose to give; slab discounts are set by an admin and points were earned.
  const limit = effectiveDiscountCap(db, actor);
  if (limit !== null && !actor.approvedBy && discount.manualPaise * 100 > totals.subtotalPaise * limit) throw httpError(403, `Your discount limit is ${limit}%; an admin PIN is needed for more`, "discount_cap");
  const earned = customer && loyalty.enabled ? pointsEarned(totals.totalPaise, loyalty.pointsPer100, customer.tier?.earnMultiplier ?? 1) : 0;
  const profile = db.prepare("SELECT restaurant_name AS restaurantName, address, gstin, fssai, receipt_footer AS receiptFooter, upi_id AS upiId, receipt_style AS receiptStyle FROM settings WHERE id = 1").get() as Pick<ReceiptSnapshot, "restaurantName" | "address" | "gstin" | "fssai" | "receiptFooter" | "upiId" | "receiptStyle">;
  const receipt: ReceiptSnapshot = { ...profile, gstMode: mode, orderType: order.type, tableName: orderTableLabel(db, orderId), splitLabel: order.splitLabel,
    ...(order.orderTypeName ? { orderTypeName: order.orderTypeName } : {}),
    ...(customer ? { customer: receiptCustomer(customer, loyalty, earned) } : {}),
    items: items.map((item) => {
      const held = contents(item);
      return { name: item.name, qty: item.qty, pricePaise: item.pricePaise, gstRate: item.gstRate, ...(held.length ? { contents: held } : {}) };
    }), ...receiptExtra };
  return { items, totals, receipt, loyalty: { ...loyalty, customerId: customer?.id ?? null, pointsEarned: earned } };
}

type OrderCustomer = NonNullable<NonNullable<ReturnType<typeof loadOrderJson>>["customer"]>;

/**
 * The customer's slab discount and the points they spend. Points need loyalty turned on and enough unexpired balance,
 * and may pay at most `maxRedeemPercent` of what is left of the subtotal after the other discounts.
 */
function customerDiscounts(db: Database, customer: OrderCustomer | null, subtotalPaise: number, discount: BillDiscount) {
  const settings = loyaltySettings(db);
  const slab = customer ? customerSlab(db, customer.id, subtotalPaise, localDateKey(Date.now())) : null;
  const points = discount.redeemPoints ?? 0;
  const balance = customer && settings.enabled ? pointsBalance(db, customer.id) : 0;
  const payable = Math.max(0, subtotalPaise - discount.manualPaise - (slab?.discountPaise ?? 0));
  const capPoints = Math.floor(payable * settings.maxRedeemPercent / 100 / settings.pointValuePaise);
  if (points > 0) {
    if (!customer) throw httpError(400, "Add the customer to the order to redeem points");
    if (!settings.enabled) throw httpError(400, "Loyalty points are turned off");
    if (points < settings.minRedeemPoints) throw httpError(400, `At least ${settings.minRedeemPoints} points can be redeemed at a time`);
    if (points > balance) throw httpError(400, `${customer.name} has ${balance} points`);
    if (points > capPoints) throw httpError(400, `Points can pay up to ${settings.maxRedeemPercent}% of this bill: at most ${capPoints} points`);
  }
  return { enabled: settings.enabled, pointsPer100: settings.pointsPer100, slab, maxRedeemPoints: Math.max(0, Math.min(balance, capPoints)),
    customerDiscountPaise: slab?.discountPaise ?? 0, pointsRedeemed: points, pointsValuePaise: points * settings.pointValuePaise };
}

function receiptCustomer(customer: OrderCustomer, loyalty: ReturnType<typeof customerDiscounts>, earned: number): ReceiptCustomer {
  return {
    name: customer.name, phone: `******${customer.phone.slice(-4)}`,
    ...(customer.tier && loyalty.enabled ? { tierName: customer.tier.name } : {}),
    ...(loyalty.slab ? { typeName: loyalty.slab.typeName, slabPercent: loyalty.slab.percent, customerDiscountPaise: loyalty.slab.discountPaise } : {}),
    ...(loyalty.pointsRedeemed ? { pointsRedeemed: loyalty.pointsRedeemed, pointsValuePaise: loyalty.pointsValuePaise } : {}),
    ...(loyalty.enabled ? { pointsEarned: earned, pointsBalance: customer.pointsBalance - loyalty.pointsRedeemed + earned } : {}),
  };
}

/** The bill's discount reason: what staff typed, then the slab and points parts. */
function discountNote(manual: string | null, loyalty: ReturnType<typeof priceOrder>["loyalty"]): string | null {
  const parts = [manual || null,
    loyalty.slab ? `${loyalty.slab.typeName} ${loyalty.slab.percent}%` : null,
    loyalty.pointsRedeemed ? `${loyalty.pointsRedeemed} loyalty points` : null].filter(Boolean);
  return parts.length ? parts.join(" · ") : null;
}

/**
 * Creates the bill for an open order: bill row, tax lines, report lines, stock deduction, and the order moves to `billed`.
 * Call inside an open `db.transaction`. Printing and broadcasting are the caller's job; the returned stock IDs are for `publishStock`.
 */
export function issueBill(db: Database, orderId: string, opts: {
  discountPaise: number; discountNote: string | null; redeemPoints?: number; clientRef: string; requestJson: string; actorId: string; role: IssueRole; approvedBy?: string | null;
  gstMode?: GstMode; receiptExtra?: Partial<ReceiptSnapshot>;
}): { billId: string; changedStockIds: string[] } {
  const { totals, receipt, loyalty } = priceOrder(db, orderId, { manualPaise: opts.discountPaise, redeemPoints: opts.redeemPoints ?? 0 }, { id: opts.actorId, role: opts.role, approvedBy: opts.approvedBy ?? null }, opts.gstMode, opts.receiptExtra);
  const id = uuidv7();
  const billNo = nextSequence(db, "bill_no");
  const now = Date.now();
  const settings = loyaltySettings(db);
  // A random, unguessable link for the receipt's feedback QR; Zomato's customers are not ours to ask.
  const isZomato = (db.prepare("SELECT type FROM orders WHERE id = ?").get(orderId) as { type: string }).type === "zomato";
  const feedbackToken = settings.feedbackEnabled && !isZomato && crmEnabled(db) ? randomBytes(24).toString("base64url") : null;
  db.prepare(`INSERT INTO bills (id, bill_no, order_id, subtotal_paise, discount_paise, discount_note,
    cgst_paise, sgst_paise, rounding_paise, total_paise, created_at, created_by, client_ref, request_json, receipt_json, discount_approved_by,
    customer_id, customer_discount_paise, points_redeemed, points_value_paise, feedback_token)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, billNo, orderId, totals.subtotalPaise,
      totals.discountPaise, discountNote(opts.discountNote, loyalty), totals.cgstPaise, totals.sgstPaise, totals.roundingPaise,
      totals.totalPaise, now, opts.actorId, opts.clientRef, opts.requestJson, JSON.stringify(receipt), opts.discountPaise > 0 ? opts.approvedBy ?? null : null,
      loyalty.customerId, loyalty.customerDiscountPaise, loyalty.pointsRedeemed, loyalty.pointsValuePaise, feedbackToken);
  // Record any expired points first so this bill's redemption comes out of points that are still good.
  if (loyalty.customerId && (loyalty.pointsRedeemed || loyalty.pointsEarned)) sweepExpiry(db, loyalty.customerId, now);
  const ledger = db.prepare(`INSERT INTO loyalty_ledger (id, customer_id, kind, points, bill_id, created_at, created_by, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  if (loyalty.customerId && loyalty.pointsRedeemed) ledger.run(uuidv7(), loyalty.customerId, "redeem", -loyalty.pointsRedeemed, id, now, opts.actorId, null);
  if (loyalty.customerId && loyalty.pointsEarned) ledger.run(uuidv7(), loyalty.customerId, "earn", loyalty.pointsEarned, id, now, opts.actorId, earnExpiry(settings, now));
  for (const tax of totals.taxes) db.prepare("INSERT INTO bill_taxes (id, bill_id, gst_rate, taxable_paise, cgst_paise, sgst_paise) VALUES (?, ?, ?, ?, ?, ?)").run(uuidv7(), id, tax.gstRate, tax.taxablePaise, tax.cgstPaise, tax.sgstPaise);
  saveReportLines(db, id);
  // All remaining pending items are stationless; deduct before changing status.
  const pending = db.prepare("SELECT id FROM order_items WHERE order_id = ? AND status = 'pending'").all(orderId) as { id: string }[];
  const changedStockIds = consumeStock(db, pending.map((item) => item.id), opts.actorId);
  db.prepare("UPDATE order_items SET status = 'sent' WHERE order_id = ? AND status = 'pending'").run(orderId);
  db.prepare("UPDATE orders SET status = 'billed' WHERE id = ?").run(orderId);
  return { billId: id, changedStockIds };
}

/**
 * Records the payments for an unpaid bill, marks the bill paid and settles its order. Returns the linked table IDs,
 * read before settling deactivates the table links. Call inside an open `db.transaction`; replay detection by
 * `clientRef` is the caller's job.
 */
export function settleBill(db: Database, billId: string, opts: {
  payments: Array<{ mode: PaymentMode; amountPaise: number; refNote?: string | null }>; clientRef: string; requestJson: string; actorId: string;
}): string[] {
  const bill = db.prepare("SELECT * FROM bills WHERE id = ?").get(billId) as BillRow | undefined;
  if (!bill) throw httpError(404, "bill not found");
  if (bill.status !== "unpaid") throw httpError(409, "Bill already settled or void");
  const order = loadOrderJson(db, bill.order_id);
  if (order?.status !== "billed") throw httpError(409, "Order is not billed");
  const amount = opts.payments.reduce((sum, p) => sum + p.amountPaise, 0);
  if (amount !== bill.total_paise) throw httpError(400, "Payments must exactly match the bill total");
  const now = Date.now();
  const linkedTables = linkedTableIds(db, bill.order_id);
  db.prepare("INSERT INTO bill_settlements (bill_id, client_ref, request_json, created_by, created_at) VALUES (?, ?, ?, ?, ?)").run(billId, opts.clientRef, opts.requestJson, opts.actorId, now);
  for (const payment of opts.payments) db.prepare("INSERT INTO payments (id, bill_id, mode, amount_paise, ref_note, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(uuidv7(), billId, payment.mode, payment.amountPaise, payment.refNote || null, now);
  db.prepare("UPDATE bills SET status = 'paid' WHERE id = ?").run(billId);
  db.prepare("UPDATE orders SET status = 'settled', closed_at = ? WHERE id = ?").run(now, bill.order_id);
  return linkedTables;
}

export function registerBilling(app: FastifyInstance): void {
  const db = app.db;
  const read = app.requirePermission("bills.read");
  const create = app.requirePermission("bills.create");
  const getBill = (id: string): Bill => loadBill(db, id);
  function printer(id: string): PrinterRow {
    const p = db.prepare("SELECT * FROM printers WHERE id = ? AND is_active = 1").get(id) as PrinterRow | undefined;
    if (!p) throw httpError(400, "Choose an active receipt printer");
    return p;
  }
  function printBill(bill: Bill, p: PrinterRow) {
    const profile = readProfile(p.receipt_profile);
    return app.printQueue.enqueue(p, "receipt", `Bill #${bill.billNo}`, receiptSlip(bill, p.paper_width, profile), profile.copies);
  }
  // Rendering is best effort so a bad printer profile cannot block the sale; the queue insert stays atomic with the bill.
  function printNewBill(bill: Bill, p: PrinterRow) {
    const rendered = bestEffortPrint(app.log, `Bill #${bill.billNo}`, () => {
      const profile = readProfile(p.receipt_profile);
      return { bytes: receiptSlip(bill, p.paper_width, profile), copies: profile.copies };
    });
    const job = rendered.value ? app.printQueue.enqueue(p, "receipt", `Bill #${bill.billNo}`, rendered.value.bytes, rendered.value.copies) : null;
    return { value: job, error: rendered.error };
  }
  /** `linkedTables` are the tables linked to a combined order; they change state together with its own table. */
  function broadcast(orderId: string, linkedTables: string[]) {
    const order = loadOrderJson(db, orderId)!;
    app.broadcast("order.updated", { order });
    if (order.tableId) app.broadcast("table.changed", { tableId: order.tableId });
    for (const tableId of linkedTables) if (tableId !== order.tableId) app.broadcast("table.changed", { tableId });
    return order;
  }
  /** Zomato orders close only through Picked up (zomato-desk.ts), which calls issueBill and settleBill itself. */
  function refuseZomato(type: string | undefined) {
    if (type === "zomato") throw httpError(409, "Zomato orders are billed and closed with Picked up on the Zomato desk", "zomato_order");
  }
  const orderType = (orderId: string) => (db.prepare("SELECT type FROM orders WHERE id = ?").get(orderId) as { type: string } | undefined)?.type;
  function preview(orderId: string, body: z.infer<typeof BillPreview>, actor: BillActor) {
    refuseZomato(orderType(orderId));
    const { items, totals, receipt, loyalty } = priceOrder(db, orderId, { manualPaise: body.discountPaise, redeemPoints: body.redeemPoints }, actor, undefined);
    const previewKey = createHash("sha256").update(JSON.stringify({ orderId, items, receipt, totals, discountNote: body.discountNote })).digest("hex");
    return { ...totals, receipt, previewKey, maxRedeemPoints: loyalty.maxRedeemPoints };
  }

  /**
   * A discount above the signed-in user's limit needs an admin PIN. Returns the approving admin's id, or null when the
   * discount is within the limit. Runs before the write transaction because checking a PIN is asynchronous.
   */
  async function discountApproval(req: FastifyRequest, orderId: string, body: z.infer<typeof BillPreview>): Promise<string | null> {
    try { priceOrder(db, orderId, { manualPaise: body.discountPaise, redeemPoints: body.redeemPoints }, { id: req.user.id, role: req.user.role }, undefined); return null; }
    catch (err) {
      if (!isDiscountCapError(err) || !body.approverPin) throw err;
      return (await resolveApprover(app, req, body.approverPin)).id;
    }
  }
  app.post("/api/orders/:id/bill-preview", { preHandler: create }, async (req) => {
    const { id } = req.params as { id: string };
    const body = BillPreview.parse(req.body ?? {});
    refuseZomato(orderType(id));
    const approvedBy = await discountApproval(req, id, body);
    return { preview: preview(id, body, { id: req.user.id, role: req.user.role, approvedBy }) };
  });
  app.get("/api/orders/:id/bill", { preHandler: read }, async (req) => {
    const { id } = req.params as { id: string };
    const row = db.prepare("SELECT id FROM bills WHERE order_id = ?").get(id) as { id: string } | undefined;
    return { bill: row ? getBill(row.id) : null };
  });
  app.post("/api/orders/:id/bill", { preHandler: create }, async (req, reply) => {
    const { id: orderId } = req.params as { id: string };
    const { approverPin, ...body } = BillCreate.parse(req.body);
    // The PIN is a credential: it approves this request but is never stored in the replay record.
    const requestJson = JSON.stringify({ orderId, ...body });
    // A replay of an already-issued bill needs no approval; the transaction below answers it.
    const replayed = db.prepare("SELECT 1 FROM bills WHERE client_ref = ?").get(body.clientRef) !== undefined;
    if (!replayed) refuseZomato(orderType(orderId));
    const approvedBy = replayed ? null : await discountApproval(req, orderId, { ...body, approverPin });
    const changedStockIds: string[] = [];
    const result = db.transaction(() => {
      const existing = db.prepare("SELECT * FROM bills WHERE client_ref = ?").get(body.clientRef) as BillRow | undefined;
      if (existing) {
        if (existing.request_json !== requestJson) throw httpError(409, "Billing reference already used for a different request");
        return { billId: existing.id, created: false, job: null, printError: null, linkedTables: [] as string[] };
      }
      refuseZomato(orderType(orderId));
      if (db.prepare("SELECT id FROM bills WHERE order_id = ?").get(orderId)) throw httpError(409, "Order already billed; reload to view its bill");
      const value = preview(orderId, body, { id: req.user.id, role: req.user.role, approvedBy });
      if (value.previewKey !== body.previewKey) throw httpError(409, "Order changed; review a fresh bill preview");
      const target = body.printerId ? printer(body.printerId) : null;
      const issued = issueBill(db, orderId, { discountPaise: body.discountPaise, discountNote: body.discountNote ?? null, redeemPoints: body.redeemPoints, clientRef: body.clientRef, requestJson, actorId: req.user.id, role: req.user.role, approvedBy });
      changedStockIds.push(...issued.changedStockIds);
      const print = target ? printNewBill(getBill(issued.billId), target) : { value: null, error: null };
      return { billId: issued.billId, created: true, job: print.value, printError: print.error, linkedTables: linkedTableIds(db, orderId) };
    })();
    const bill = getBill(result.billId);
    if (result.created) publishStock(app, changedStockIds);
    const order = result.created ? broadcast(orderId, result.linkedTables) : loadOrderJson(db, orderId);
    const job = result.job;
    return reply.status(result.created ? 201 : 200).send({ bill, order, job, printError: result.printError });
  });
  app.post("/api/bills/:id/settle", { preHandler: app.requirePermission("bills.settle") }, async (req) => {
    const { id } = req.params as { id: string };
    const body = BillSettle.parse(req.body);
    const requestJson = JSON.stringify({ billId: id, payments: body.payments });
    // Settling deactivates the order's table links, so the linked tables are read inside the transaction.
    const changed = db.transaction((): string[] | null => {
      const replay = db.prepare("SELECT bill_id, request_json FROM bill_settlements WHERE client_ref = ?").get(body.clientRef) as { bill_id: string; request_json: string } | undefined;
      if (replay) {
        if (replay.bill_id !== id || replay.request_json !== requestJson) throw httpError(409, "Settlement reference already used for a different request");
        return null;
      }
      refuseZomato((db.prepare("SELECT o.type FROM bills b JOIN orders o ON o.id = b.order_id WHERE b.id = ?").get(id) as { type: string } | undefined)?.type);
      return settleBill(db, id, { payments: body.payments, clientRef: body.clientRef, requestJson, actorId: req.user.id });
    })();
    const bill = getBill(id);
    return { bill, order: changed ? broadcast(bill.orderId, changed) : loadOrderJson(db, bill.orderId) };
  });
  app.get("/api/bills", { preHandler: read }, async (req) => {
    const query = z.object({ status: z.enum(["unpaid", "paid", "all"]).default("all"), before: z.coerce.number().int().positive().optional() }).parse(req.query);
    const rows = db.prepare("SELECT id FROM bills WHERE (? = 'all' OR status = ?) AND bill_no < ? ORDER BY bill_no DESC LIMIT 100").all(query.status, query.status, query.before ?? Number.MAX_SAFE_INTEGER) as { id: string }[];
    return { bills: rows.map((r) => getBill(r.id)) };
  });
  app.get("/api/bills/:id", { preHandler: read }, async (req) => ({ bill: getBill((req.params as { id: string }).id) }));
  app.get("/api/bills/:id/upi-qr", { preHandler: read }, async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    const bill = getBill((req.params as { id: string }).id);
    const payment = billUpiPayment(bill);
    return { payment: payment ? {
      billId: bill.id, billNo: bill.billNo, restaurantName: bill.receipt.restaurantName,
      upiId: payment.upiId, amountPaise: payment.amountPaise,
      qrDataUrl: `data:image/svg+xml;base64,${Buffer.from(upiQrSvg(payment.uri)).toString("base64")}`,
    } : null };
  });
  app.get("/api/billing-printers", { preHandler: read }, async () => ({
    printers: db.prepare("SELECT id, name, paper_width AS paperWidth FROM printers WHERE is_active = 1 ORDER BY name").all(),
  }));
  app.post("/api/bills/:id/print", { preHandler: app.requirePermission("bills.print") }, async (req, reply) => {
    const bill = getBill((req.params as { id: string }).id);
    // Zomato bills are never printed: Zomato issues the customer's invoice.
    if (bill.receipt.orderType === "zomato") throw httpError(409, "Zomato bills are not printed", "zomato_order");
    const body = BillPrint.parse(req.body);
    return reply.status(202).send({ job: printBill(bill, printer(body.printerId)) });
  });
  app.get("/api/bills/:id/print-jobs", { preHandler: read }, async (req) => {
    const bill = getBill((req.params as { id: string }).id);
    return { jobs: app.printQueue.jobs().filter((job) => job.kind === "receipt" && job.label === `Bill #${bill.billNo}`) };
  });
  app.get("/api/bills/:id/receipt", { preHandler: read }, async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    reply.header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'");
    return reply.type("text/html; charset=utf-8").send(receiptHtml(getBill((req.params as { id: string }).id)));
  });
}
