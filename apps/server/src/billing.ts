import { createHash } from "node:crypto";
import { z } from "zod";
import { BillCreate, BillPreview, BillSettle, BillPrint, calculateBill, nextSequence, uuidv7, roleFor,
  type Bill, type ReceiptSnapshot, type TaxLine } from "@forkflow/domain";
import type { FastifyInstance } from "fastify";
import { httpError } from "./http-error.js";
import { loadOrderJson } from "./mappers.js";
import { receiptSlip, receiptHtml } from "./print/receipt.js";
import { billUpiPayment, upiQrSvg } from "./print/upi.js";
import { consumeStock, saveReportLines } from "@forkflow/domain";
import { publishStock } from "./stock.js";
import { readProfile } from "./print/profile.js";
import { bestEffortPrint } from "./print/best-effort.js";

interface BillRow {
  id: string; bill_no: number; order_id: string; status: Bill["status"];
  subtotal_paise: number; discount_paise: number; discount_note: string | null;
  cgst_paise: number; sgst_paise: number; rounding_paise: number; total_paise: number;
  created_at: number; client_ref: string | null; request_json: string | null; receipt_json: string | null;
}
interface PrinterRow { id: string; name: string; kind: "network" | "windows" | "bluetooth"; connection: string; paper_width: 58 | 80; receipt_profile: string }

export function registerBilling(app: FastifyInstance): void {
  const db = app.db;
  const read = app.requirePermission("bills.read");
  const create = app.requirePermission("bills.create");
  const getRow = (id: string) => db.prepare("SELECT * FROM bills WHERE id = ?").get(id) as BillRow | undefined;
  const getBill = (id: string): Bill => {
    const r = getRow(id);
    if (!r) throw httpError(404, "bill not found");
    if (!r.receipt_json) throw httpError(409, "This legacy bill has no saved receipt");
    const taxes = db.prepare("SELECT gst_rate AS gstRate, taxable_paise AS taxablePaise, cgst_paise AS cgstPaise, sgst_paise AS sgstPaise FROM bill_taxes WHERE bill_id = ? ORDER BY gst_rate").all(id) as TaxLine[];
    const payments = db.prepare("SELECT mode, amount_paise AS amountPaise, ref_note AS refNote, created_at AS createdAt FROM payments WHERE bill_id = ? ORDER BY id").all(id) as Bill["payments"];
    const receipt = JSON.parse(r.receipt_json) as ReceiptSnapshot;
    return { id, billNo: r.bill_no, orderId: r.order_id, status: r.status, subtotalPaise: r.subtotal_paise,
      discountPaise: r.discount_paise, discountNote: r.discount_note, cgstPaise: r.cgst_paise, sgstPaise: r.sgst_paise,
      roundingPaise: r.rounding_paise, totalPaise: r.total_paise, createdAt: r.created_at,
      receipt, taxInclusive: receipt.taxInclusive, taxes, payments };
  };
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
  function broadcast(orderId: string) {
    const order = loadOrderJson(db, orderId)!;
    app.broadcast("order.updated", { order });
    if (order.tableId) app.broadcast("table.changed", { tableId: order.tableId });
    return order;
  }
  function preview(orderId: string, body: z.infer<typeof BillPreview>, role: Parameters<typeof roleFor>[0]) {
    const order = loadOrderJson(db, orderId);
    if (!order) throw httpError(404, "order not found");
    if (order.status !== "open") throw httpError(409, "order is not open");
    const items = order.items.filter((item) => item.status !== "cancelled");
    if (!items.length) throw httpError(409, "Add items before billing");
    const unsent = db.prepare("SELECT oi.id FROM order_items oi JOIN products p ON p.id = oi.product_id WHERE oi.order_id = ? AND oi.status = 'pending' AND p.kot_station_id IS NOT NULL LIMIT 1").get(orderId);
    if (unsent) throw httpError(409, "Send kitchen items before billing");
    const { require_kitchen_acceptance } = db.prepare("SELECT require_kitchen_acceptance FROM settings WHERE id = 1").get() as { require_kitchen_acceptance: number };
    if (order.type === "dine_in" && require_kitchen_acceptance === 1) {
      const acceptedKots = new Set(order.kots.filter((kot) => kot.acceptedAt != null || kot.doneAt != null).map((kot) => kot.id));
      if (items.some((item) => item.status === "sent" && item.kotId && !acceptedKots.has(item.kotId))) {
        throw httpError(409, "Wait for the kitchen to accept all tickets before billing this table order");
      }
    }
    let totals;
    const { tax_inclusive } = db.prepare("SELECT tax_inclusive FROM settings WHERE id = 1").get() as { tax_inclusive: number };
    try { totals = calculateBill(items, body.discountPaise, tax_inclusive === 1); }
    catch (err) { throw httpError(400, err instanceof Error ? err.message : "Invalid bill"); }
    const limit = roleFor(role).limits?.["max_discount_percent"];
    if (typeof limit === "number" && totals.discountPaise * 100 > totals.subtotalPaise * limit) throw httpError(403, `Your discount limit is ${limit}%`);
    const profile = db.prepare("SELECT restaurant_name AS restaurantName, address, gstin, fssai, receipt_footer AS receiptFooter, upi_id AS upiId FROM settings WHERE id = 1").get() as Pick<ReceiptSnapshot, "restaurantName" | "address" | "gstin" | "fssai" | "receiptFooter" | "upiId">;
    const receipt: ReceiptSnapshot = { ...profile, taxInclusive: tax_inclusive === 1, orderType: order.type, tableName: order.tableName, splitLabel: order.splitLabel,
      items: items.map(({ name, qty, pricePaise, gstRate }) => ({ name, qty, pricePaise, gstRate })) };
    const previewKey = createHash("sha256").update(JSON.stringify({ orderId, items, receipt, totals, discountNote: body.discountNote })).digest("hex");
    return { ...totals, receipt, previewKey };
  }

  app.post("/api/orders/:id/bill-preview", { preHandler: create }, async (req) => {
    const { id } = req.params as { id: string };
    return { preview: preview(id, BillPreview.parse(req.body ?? {}), req.user.role) };
  });
  app.get("/api/orders/:id/bill", { preHandler: read }, async (req) => {
    const { id } = req.params as { id: string };
    const row = db.prepare("SELECT id FROM bills WHERE order_id = ?").get(id) as { id: string } | undefined;
    return { bill: row ? getBill(row.id) : null };
  });
  app.post("/api/orders/:id/bill", { preHandler: create }, async (req, reply) => {
    const { id: orderId } = req.params as { id: string };
    const body = BillCreate.parse(req.body);
    const requestJson = JSON.stringify({ orderId, ...body });
    const changedStockIds: string[] = [];
    const result = db.transaction(() => {
      const existing = db.prepare("SELECT * FROM bills WHERE client_ref = ?").get(body.clientRef) as BillRow | undefined;
      if (existing) {
        if (existing.request_json !== requestJson) throw httpError(409, "Billing reference already used for a different request");
        return { billId: existing.id, created: false, job: null, printError: null };
      }
      if (db.prepare("SELECT id FROM bills WHERE order_id = ?").get(orderId)) throw httpError(409, "Order already billed; reload to view its bill");
      const value = preview(orderId, body, req.user.role);
      if (value.previewKey !== body.previewKey) throw httpError(409, "Order changed; review a fresh bill preview");
      const target = body.printerId ? printer(body.printerId) : null;
      const id = uuidv7();
      const billNo = nextSequence(db, "bill_no");
      db.prepare(`INSERT INTO bills (id, bill_no, order_id, subtotal_paise, discount_paise, discount_note,
        cgst_paise, sgst_paise, rounding_paise, total_paise, created_at, created_by, client_ref, request_json, receipt_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, billNo, orderId, value.subtotalPaise,
          value.discountPaise, body.discountNote || null, value.cgstPaise, value.sgstPaise, value.roundingPaise,
          value.totalPaise, Date.now(), req.user.id, body.clientRef, requestJson, JSON.stringify(value.receipt));
      for (const tax of value.taxes) db.prepare("INSERT INTO bill_taxes (id, bill_id, gst_rate, taxable_paise, cgst_paise, sgst_paise) VALUES (?, ?, ?, ?, ?, ?)").run(uuidv7(), id, tax.gstRate, tax.taxablePaise, tax.cgstPaise, tax.sgstPaise);
      saveReportLines(db, id);
      // All remaining pending items are stationless; deduct before changing status.
      const pending = db.prepare("SELECT id FROM order_items WHERE order_id = ? AND status = 'pending'").all(orderId) as { id: string }[];
      changedStockIds.push(...consumeStock(db, pending.map((item) => item.id), req.user.id));
      db.prepare("UPDATE order_items SET status = 'sent' WHERE order_id = ? AND status = 'pending'").run(orderId);
      db.prepare("UPDATE orders SET status = 'billed' WHERE id = ?").run(orderId);
      const print = target ? printNewBill(getBill(id), target) : { value: null, error: null };
      return { billId: id, created: true, job: print.value, printError: print.error };
    })();
    const bill = getBill(result.billId);
    if (result.created) publishStock(app, changedStockIds);
    const order = result.created ? broadcast(orderId) : loadOrderJson(db, orderId);
    const job = result.job;
    return reply.status(result.created ? 201 : 200).send({ bill, order, job, printError: result.printError });
  });
  app.post("/api/bills/:id/settle", { preHandler: app.requirePermission("bills.settle") }, async (req) => {
    const { id } = req.params as { id: string };
    const body = BillSettle.parse(req.body);
    const requestJson = JSON.stringify({ billId: id, payments: body.payments });
    const changed = db.transaction(() => {
      const replay = db.prepare("SELECT bill_id, request_json FROM bill_settlements WHERE client_ref = ?").get(body.clientRef) as { bill_id: string; request_json: string } | undefined;
      if (replay) {
        if (replay.bill_id !== id || replay.request_json !== requestJson) throw httpError(409, "Settlement reference already used for a different request");
        return false;
      }
      const bill = getRow(id);
      if (!bill) throw httpError(404, "bill not found");
      if (bill.status !== "unpaid") throw httpError(409, "Bill already settled or void");
      const order = loadOrderJson(db, bill.order_id);
      if (order?.status !== "billed") throw httpError(409, "Order is not billed");
      const amount = body.payments.reduce((sum, p) => sum + p.amountPaise, 0);
      if (amount !== bill.total_paise) throw httpError(400, "Payments must exactly match the bill total");
      const now = Date.now();
      db.prepare("INSERT INTO bill_settlements (bill_id, client_ref, request_json, created_by, created_at) VALUES (?, ?, ?, ?, ?)").run(id, body.clientRef, requestJson, req.user.id, now);
      for (const payment of body.payments) db.prepare("INSERT INTO payments (id, bill_id, mode, amount_paise, ref_note, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(uuidv7(), id, payment.mode, payment.amountPaise, payment.refNote || null, now);
      db.prepare("UPDATE bills SET status = 'paid' WHERE id = ?").run(id);
      db.prepare("UPDATE orders SET status = 'settled', closed_at = ? WHERE id = ?").run(now, bill.order_id);
      return true;
    })();
    const bill = getBill(id);
    return { bill, order: changed ? broadcast(bill.orderId) : loadOrderJson(db, bill.orderId) };
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
