import type { FastifyInstance } from "fastify";
import { localDateKey, type OperationalReport, type ReportColumn, type ReportTable, type ReportCell } from "@forkflow/domain";
import { z } from "zod";
import { reportRange } from "./sales-reports.js";

type Row = Record<string, ReportCell>;
const column = (key: string, label: string, format?: ReportColumn["format"]): ReportColumn => format ? { key, label, format } : { key, label };
const sum = (rows: Row[], keys: string[]) => Object.fromEntries(keys.map((key) => [key, rows.reduce((n, row) => n + Number(row[key] ?? 0), 0)]));
const salesColumns = [column("qty", "Quantity", "quantity"), column("bills", "Bills"), column("subtotal", "Subtotal", "money"), column("discount", "Discount", "money"), column("taxable", "Taxable", "money"), column("gst", "GST", "money"), column("rounding", "Round off", "money"), column("total", "Sales", "money")];

export function registerOperationalReports(app: FastifyInstance) {
  app.get("/api/reports/operations/:kind", { preHandler: app.requirePermission("reports.read") }, async (req, reply) => {
    const { kind } = z.object({ kind: z.enum(["items", "cashiers", "hourly", "kots", "cancellations", "stock", "credit-notes"]) }).parse(req.params);
    const { from, to, bounds } = reportRange(req.query);
    const [start, end] = bounds;
    const db = app.db;
    const query = (sql: string, ...params: (string | number)[]) => db.prepare(sql).all(...params) as Row[];
    const tables: ReportTable[] = [], notes: string[] = [];
    const generatedAt = Date.now();
    // One synchronous read transaction gives all sections the same database snapshot.
    db.transaction(() => {
      if (kind === "items") {
        notes.push("Issued sales by bill date, including unpaid and void bills. Discounts, GST and round-off are allocated in paise so totals match the bills.",
          "Credit notes (voids and refunds) subtract on their own date: credited quantity and value come off net quantity and net sales. Voids of bills issued before report tracking have no item lines and are not itemised here.",
          "Categories are saved at billing. Bills created before report tracking use ‘Historical category unavailable’. Bill counts across items/categories overlap; the total counts distinct bills.");
        // Issued lines by bill date, and credited lines (keyed by the bill line they credit) by credit-note date.
        const entries = `WITH entries AS (
            SELECT l.product_id, l.variant_id, l.name, l.category_id, l.category_name, l.bill_id, l.qty, l.subtotal_paise AS subtotal, l.discount_paise AS discount,
              l.taxable_paise AS taxable, l.cgst_paise + l.sgst_paise AS gst, l.rounding_paise AS rounding, l.total_paise AS total, 0 AS creditQty, 0 AS credit
            FROM bill_report_lines l JOIN bills b ON b.id = l.bill_id WHERE b.created_at >= ? AND b.created_at < ?
            UNION ALL
            SELECT l.product_id, l.variant_id, l.name, l.category_id, l.category_name, NULL, 0, 0, 0, 0, 0, 0, 0, cl.qty, cl.total_paise
            FROM credit_note_lines cl JOIN credit_notes c ON c.id = cl.credit_note_id
            JOIN bill_report_lines l ON l.bill_id = c.bill_id AND l.order_item_id = cl.order_item_id
            WHERE c.created_at >= ? AND c.created_at < ?)`;
        const aggregates = `SUM(qty) AS qty, COUNT(DISTINCT bill_id) AS bills, SUM(subtotal) AS subtotal, SUM(discount) AS discount,
          SUM(taxable) AS taxable, SUM(gst) AS gst, SUM(rounding) AS rounding, SUM(total) AS total,
          SUM(creditQty) AS creditQty, SUM(credit) AS credit, SUM(qty) - SUM(creditQty) AS netQty, SUM(total) - SUM(credit) AS netTotal`;
        const items = query(`${entries} SELECT name, category_name AS category, ${aggregates} FROM entries
          GROUP BY product_id, variant_id, name, category_id, category_name ORDER BY netTotal DESC, name`, ...bounds, ...bounds);
        const categories = query(`${entries} SELECT category_name AS category, ${aggregates} FROM entries
          GROUP BY category_id, category_name ORDER BY netTotal DESC, category_name`, ...bounds, ...bounds);
        const totals = { ...sum(items, ["qty", "subtotal", "discount", "taxable", "gst", "rounding", "total", "creditQty", "credit", "netQty", "netTotal"]),
          bills: query(`${entries} SELECT COUNT(DISTINCT bill_id) AS count FROM entries`, ...bounds, ...bounds)[0]!.count! };
        const columns = [...salesColumns, column("creditQty", "Credited quantity", "quantity"), column("credit", "Credit notes", "money"),
          column("netQty", "Net quantity", "quantity"), column("netTotal", "Net sales", "money")];
        tables.push({ title: "Item sales", columns: [column("name", "Item / variant"), column("category", "Category"), ...columns], rows: items, totals: { name: "Total", ...totals } },
          { title: "Category sales", columns: [column("category", "Category"), ...columns], rows: categories, totals: { category: "Total", ...totals } });
      }
      if (kind === "cashiers") {
        notes.push("Collections by payment date, including payments for older bills. Cashier means the person who settled the bill, not the person who issued it. Split payments count as one bill. Legacy receipts without a settlement actor are shown as Unknown.",
          "Refunds paid out are subtracted by refund date and method from the cashier who requested them.");
        const rows = query(`WITH entries AS (
            SELECT s.created_by AS userId, p.bill_id, p.mode, p.amount_paise AS amount, 0 AS refund
            FROM payments p LEFT JOIN bill_settlements s ON s.bill_id = p.bill_id WHERE p.created_at >= ? AND p.created_at < ?
            UNION ALL
            SELECT c.requested_by, NULL, r.mode, -r.amount_paise, r.amount_paise
            FROM refund_payments r JOIN credit_notes c ON c.id = r.credit_note_id WHERE r.created_at >= ? AND r.created_at < ?)
          SELECT COALESCE(u.name, 'Unknown') AS cashier, COUNT(DISTINCT e.bill_id) AS bills,
            SUM(CASE WHEN e.mode = 'cash' THEN e.amount ELSE 0 END) AS cash,
            SUM(CASE WHEN e.mode = 'upi' THEN e.amount ELSE 0 END) AS upi,
            SUM(CASE WHEN e.mode = 'card' THEN e.amount ELSE 0 END) AS card, SUM(e.refund) AS refunds, SUM(e.amount) AS total
          FROM entries e LEFT JOIN users u ON u.id = e.userId GROUP BY e.userId ORDER BY total DESC, cashier`, ...bounds, ...bounds);
        tables.push({ title: "Cashier collections", columns: [column("cashier", "Collecting cashier"), column("bills", "Bills"),
          ...["cash", "upi", "card"].map((key) => column(key, key.toUpperCase(), "money")), column("refunds", "Refunded", "money"), column("total", "Net received", "money")],
          rows, totals: { cashier: "Total", ...sum(rows, ["bills", "cash", "upi", "card", "refunds", "total"]) } });
      }
      if (kind === "hourly") {
        notes.push("Issued bills (including void ones) grouped by local hour across the selected dates, less credit notes in the hour they were made. Sales include GST and rounding; unpaid bills count as sales. All 24 hours are shown.");
        const hourOf = (col: string) => `CAST(strftime('%H', ${col} / 1000, 'unixepoch', 'localtime') AS INTEGER)`;
        const data = query(`SELECT hour, SUM(bills) AS bills, SUM(total) AS total, SUM(discount) AS discount, SUM(gst) AS gst, SUM(credit) AS credit FROM (
            SELECT ${hourOf("created_at")} AS hour, 1 AS bills, total_paise AS total, discount_paise AS discount, cgst_paise + sgst_paise AS gst, 0 AS credit
            FROM bills WHERE created_at >= ? AND created_at < ?
            UNION ALL
            SELECT ${hourOf("created_at")}, 0, -total_paise, 0, -(cgst_paise + sgst_paise), total_paise
            FROM credit_notes WHERE created_at >= ? AND created_at < ?) GROUP BY hour`, ...bounds, ...bounds);
        const rows = Array.from({ length: 24 }, (_, hour) => {
          const row = data.find((r) => r.hour === hour) ?? { bills: 0, total: 0, discount: 0, gst: 0, credit: 0 };
          return { ...row, hour: `${String(hour).padStart(2, "0")}:00–${String(hour).padStart(2, "0")}:59`, average: Number(row.bills) ? Math.round(Number(row.total) / Number(row.bills)) : 0 };
        });
        const totals = sum(rows, ["bills", "total", "discount", "gst", "credit"]);
        tables.push({ title: "Hourly sales", columns: [column("hour", "Hour"), column("bills", "Bills"), column("discount", "Discount", "money"), column("gst", "Net GST", "money"), column("credit", "Credit notes", "money"), column("total", "Net sales", "money"), column("average", "Average bill", "money")], rows,
          totals: { hour: "Total", ...totals, average: totals.bills ? Math.round(totals.total! / totals.bills) : 0 } });
      }
      if (kind === "credit-notes") {
        notes.push("Every void and refund credit note made during the selected dates, by the date it was made (not the original bill's date). GST is CGST + SGST credited; total includes round-off.");
        const rows = query(`SELECT 'CN-' || c.cn_no AS cnNo, c.created_at AS date, b.bill_no AS billNo,
            CASE c.kind WHEN 'void' THEN 'Void' ELSE 'Refund' END AS kind, c.reason, rb.name AS requestedBy, ab.name AS approvedBy,
            COALESCE((SELECT group_concat(label, ', ') FROM (SELECT CASE r.mode WHEN 'cash' THEN 'Cash' WHEN 'upi' THEN 'UPI' ELSE 'Card' END AS label
              FROM refund_payments r WHERE r.credit_note_id = c.id GROUP BY r.mode ORDER BY MIN(r.rowid))), 'None') AS refundModes,
            c.taxable_paise AS taxable, c.cgst_paise + c.sgst_paise AS gst, c.total_paise AS total
          FROM credit_notes c JOIN bills b ON b.id = c.bill_id JOIN users rb ON rb.id = c.requested_by JOIN users ab ON ab.id = c.approved_by
          WHERE c.created_at >= ? AND c.created_at < ? ORDER BY c.cn_no`, ...bounds);
        tables.push({ title: "Credit notes", columns: [column("cnNo", "CN"), column("date", "Date", "time"), column("billNo", "Bill"), column("kind", "Kind"), column("reason", "Reason"),
          column("requestedBy", "Requested by"), column("approvedBy", "Approved by"), column("refundModes", "Refund methods"),
          column("taxable", "Taxable", "money"), column("gst", "GST", "money"), column("total", "Total", "money")],
          rows, totals: { cnNo: "Total", ...sum(rows, ["taxable", "gst", "total"]) } });
      }
      if (kind === "kots") {
        notes.push("Tickets sent during the selected dates, with their current completion status. Duration measures send-to-completion, not active cooking time. Fully cancelled tickets are excluded from completion averages. Pending age is measured at report refresh.");
        const rows = query(`SELECT k.id, k.station_id AS stationId, k.kot_no AS ticket, ks.name AS kitchen, COALESCE(u.name, 'Unknown') AS staff,
          COALESCE(dt.name, 'Takeaway') AS location, k.created_at AS sent, k.done_at AS completed,
          SUM(CASE WHEN oi.status != 'cancelled' THEN oi.qty ELSE 0 END) AS qty,
          SUM(CASE WHEN oi.status = 'cancelled' THEN oi.qty ELSE 0 END) AS cancelled
          FROM kots k JOIN kot_stations ks ON ks.id = k.station_id JOIN orders o ON o.id = k.order_id
          LEFT JOIN dining_tables dt ON dt.id = o.table_id LEFT JOIN users u ON u.id = k.created_by LEFT JOIN order_items oi ON oi.kot_id = k.id
          WHERE k.created_at >= ? AND k.created_at < ? GROUP BY k.id ORDER BY k.created_at DESC, k.id`, ...bounds).map((row): Row => ({ ...row,
            status: !Number(row.qty) ? "Cancelled" : row.completed === null ? "Pending" : "Completed",
            minutes: Number(row.qty) && row.completed !== null && Number(row.completed) >= Number(row.sent) ? (Number(row.completed) - Number(row.sent)) / 60000 : null,
            age: Number(row.qty) && row.completed === null ? Math.max(0, generatedAt - Number(row.sent)) / 60000 : null }));
        const groups = new Map<ReportCell, Row[]>();
        for (const row of rows) groups.set(row.stationId!, [...(groups.get(row.stationId!) ?? []), row]);
        const summary = [...groups.values()].map((group) => {
          const completed = group.filter((r) => r.minutes !== null);
          return { kitchen: group[0]!.kitchen!, tickets: group.length, completed: group.filter((r) => r.status === "Completed").length,
            pending: group.filter((r) => r.status === "Pending").length, cancelled: group.filter((r) => r.status === "Cancelled").length,
            average: completed.length ? completed.reduce((n, r) => n + Number(r.minutes), 0) / completed.length : null,
            longest: completed.length ? Math.max(...completed.map((r) => Number(r.minutes))) : null };
        });
        tables.push({ title: "Kitchen performance", columns: [column("kitchen", "Kitchen"), column("tickets", "Tickets"), column("completed", "Completed"), column("pending", "Pending"), column("cancelled", "Cancelled"), column("average", "Average minutes", "minutes"), column("longest", "Longest minutes", "minutes")], rows: summary },
          { title: "KOT details", columns: [column("ticket", "KOT"), column("kitchen", "Kitchen"), column("staff", "Sent by"), column("location", "Table / takeaway"), column("sent", "Sent at", "time"), column("completed", "Completed at", "time"), column("status", "Status"), column("qty", "Active qty"), column("cancelled", "Cancelled qty"), column("minutes", "Completion minutes", "minutes"), column("age", "Pending minutes", "minutes")], rows });
      }
      if (kind === "cancellations") {
        notes.push("Item cancellations by recorded cancellation time. Value is the cancelled quantity at its saved menu price, before bill discounts; this is not a refund. Cancelled orders are listed separately and must not be added to item values.");
        const unknown = query("SELECT COUNT(*) AS count FROM order_items WHERE status = 'cancelled' AND cancelled_at IS NULL")[0]!.count;
        if (Number(unknown)) notes.push(`${unknown} historical cancelled item entries have no cancellation timestamp and cannot be assigned to this date range.`);
        const rows = query(`SELECT oi.cancelled_at AS time, oi.order_id AS orderId, k.kot_no AS ticket, oi.name_snapshot AS item, oi.qty,
          oi.qty * oi.price_paise_snapshot AS value, COALESCE(u.name, 'Unknown') AS staff, COALESCE(oi.cancel_reason, 'Not recorded') AS reason,
          COALESCE(dt.name, 'Takeaway') AS location
          FROM order_items oi JOIN orders o ON o.id = oi.order_id LEFT JOIN kots k ON k.id = oi.kot_id
          LEFT JOIN users u ON u.id = oi.cancelled_by LEFT JOIN dining_tables dt ON dt.id = o.table_id
          WHERE oi.status = 'cancelled' AND oi.cancelled_at >= ? AND oi.cancelled_at < ? ORDER BY oi.cancelled_at DESC, oi.id`, ...bounds);
        tables.push({ title: "Cancelled items", columns: [column("time", "Cancelled at", "time"), column("orderId", "Order reference"), column("ticket", "KOT"), column("location", "Table / takeaway"), column("item", "Item"), column("qty", "Quantity"), column("value", "Menu value", "money"), column("staff", "Cancelled by"), column("reason", "Reason")], rows, totals: { item: "Total", ...sum(rows, ["qty", "value"]) } });
        const orders = query(`SELECT o.id AS orderId, o.closed_at AS time, COALESCE(dt.name, 'Takeaway') AS location,
          COALESCE(u.name, 'Unknown') AS staff, COALESCE(o.cancel_reason, 'Not recorded') AS reason
          FROM orders o LEFT JOIN users u ON u.id = o.cancelled_by LEFT JOIN dining_tables dt ON dt.id = o.table_id
          WHERE o.status = 'cancelled' AND o.merged_into IS NULL AND o.closed_at >= ? AND o.closed_at < ? ORDER BY o.closed_at DESC, o.id`, ...bounds);
        tables.push({ title: "Cancelled orders", columns: [column("time", "Cancelled at", "time"), column("orderId", "Order reference"), column("location", "Table / takeaway"), column("staff", "Cancelled by"), column("reason", "Reason")], rows: orders });
      }
      if (kind === "stock") {
        notes.push("Quantities use each stock item's own unit; different units are never added together. Consumption is recorded when sent to the kitchen (or billed for non-kitchen items), not when paid. Reversals restore cancelled consumption. No ingredient costs or wastage values are inferred.");
        const rows = query(`SELECT s.name AS item, s.unit,
          ROUND((s.qty - COALESCE(SUM(CASE WHEN m.created_at >= ? THEN m.delta ELSE 0 END),0)) * 1000) / 1000.0 AS opening,
          ROUND(COALESCE(SUM(CASE WHEN m.created_at >= ? AND m.created_at < ? AND m.reason = 'purchase' THEN m.delta ELSE 0 END),0)*1000)/1000.0 AS received,
          ROUND(-COALESCE(SUM(CASE WHEN m.created_at >= ? AND m.created_at < ? AND m.reason = 'sale' THEN m.delta ELSE 0 END),0)*1000)/1000.0 AS consumed,
          ROUND(COALESCE(SUM(CASE WHEN m.created_at >= ? AND m.created_at < ? AND m.reason = 'cancel_reversal' THEN m.delta ELSE 0 END),0)*1000)/1000.0 AS restored,
          ROUND(-COALESCE(SUM(CASE WHEN m.created_at >= ? AND m.created_at < ? AND m.reason = 'wastage' THEN m.delta ELSE 0 END),0)*1000)/1000.0 AS wastage,
          ROUND(COALESCE(SUM(CASE WHEN m.created_at >= ? AND m.created_at < ? AND m.reason = 'adjustment' THEN m.delta ELSE 0 END),0)*1000)/1000.0 AS adjustment,
          ROUND((s.qty - COALESCE(SUM(CASE WHEN m.created_at >= ? THEN m.delta ELSE 0 END),0))*1000)/1000.0 AS closing
          FROM stock_items s LEFT JOIN stock_moves m ON m.stock_item_id = s.id GROUP BY s.id ORDER BY s.name, s.id`, start, start, end, start, end, start, end, start, end, start, end, end);
        tables.push({ title: "Stock movement summary", columns: [column("item", "Stock item"), column("unit", "Unit"), ...["opening", "received", "consumed", "restored", "wastage", "adjustment", "closing"].map((key) => column(key, key[0]!.toUpperCase() + key.slice(1), "quantity"))], rows });
        const details = query(`SELECT m.created_at AS time, s.name AS item, s.unit, m.reason, m.delta AS quantity,
          COALESCE(u.name, 'Unknown') AS staff, m.note, oi.order_id AS orderId
          FROM stock_moves m JOIN stock_items s ON s.id = m.stock_item_id LEFT JOIN users u ON u.id = m.created_by
          LEFT JOIN order_items oi ON oi.id = m.order_item_id
          WHERE m.created_at >= ? AND m.created_at < ? ORDER BY m.created_at DESC, m.id`, ...bounds);
        tables.push({ title: "Stock movement details", columns: [column("time", "Recorded at", "time"), column("item", "Stock item"), column("unit", "Unit"), column("reason", "Movement"), column("quantity", "Change", "quantity"), column("staff", "Recorded by"), column("note", "Reason / reference"), column("orderId", "Order reference")], rows: details });
      }
    })();
    const report: OperationalReport = { kind, from, to, today: localDateKey(generatedAt), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, generatedAt, notes, tables };
    reply.header("Cache-Control", "no-store");
    return { report };
  });
}
