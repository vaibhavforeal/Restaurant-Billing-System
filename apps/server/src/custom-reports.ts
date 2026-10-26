import type { FastifyInstance } from "fastify";
import {
  CUSTOM_REPORT_LIMITS, CustomReportConfig, CustomReportSave, customReportProblem, customReportSource, localDateKey, uuidv7,
  type CustomReport, type CustomReportConfigValue, type CustomReportField, type ReportCell, type ReportColumn, type SavedCustomReport,
} from "@forkflow/domain";
import { z } from "zod";
import { httpError } from "./http-error.js";
import { reportRange } from "./sales-reports.js";

type Row = Record<string, ReportCell>;
const AGG = { sum: "SUM", avg: "AVG", max: "MAX" } as const;
const local = (col: string, pattern: string) => `strftime('${pattern}', ${col} / 1000, 'unixepoch', 'localtime')`;

interface SourceSql {
  from: string;
  /** The timestamp column the report's date range filters. Null when the rows are not dated (customers). */
  dateColumn: string | null;
  /** Rows a source always leaves out, whatever the user's filters. */
  baseWhere?: string;
  /** SQL for each catalogue field id. */
  fields: Record<string, string>;
  /** Row order when the report is not grouped. */
  order: string;
}

/** `start`/`end` are validated epoch milliseconds from reportRange, so they are safe to inline into the correlated subqueries. */
function sourceSql(id: string, start: number, end: number): SourceSql {
  const billJoins = `JOIN orders o ON o.id = b.order_id LEFT JOIN users u ON u.id = b.created_by LEFT JOIN dining_tables dt ON dt.id = o.table_id
    LEFT JOIN order_types ot ON ot.id = COALESCE(o.order_type_id, o.type) LEFT JOIN customers c ON c.id = b.customer_id`;
  const billWhen = (col: string) => ({ date: local(col, "%Y-%m-%d"), month: local(col, "%Y-%m"), hour: local(col, "%H:00"), time: col });
  const billWho = {
    orderType: "COALESCE(ot.name, o.order_type_id, o.type)", table: "COALESCE(dt.name, 'Takeaway')", issuedBy: "COALESCE(u.name, 'Unknown')",
    customer: "COALESCE(c.name, 'Walk-in')", customerPhone: "COALESCE(c.phone, '')",
  };
  if (id === "bills") {
    return {
      from: `bills b ${billJoins}`, dateColumn: "b.created_at", order: "b.created_at DESC, b.bill_no DESC",
      fields: {
        ...billWhen("b.created_at"), billNo: "b.bill_no", ...billWho, status: "b.status",
        paymentModes: "COALESCE((SELECT group_concat(DISTINCT p.mode) FROM payments p WHERE p.bill_id = b.id), '')",
        bills: "1", subtotal: "b.subtotal_paise", discount: "b.discount_paise", customerDiscount: "b.customer_discount_paise", pointsValue: "b.points_value_paise",
        taxable: "COALESCE((SELECT SUM(t.taxable_paise) FROM bill_taxes t WHERE t.bill_id = b.id), 0)", cgst: "b.cgst_paise", sgst: "b.sgst_paise",
        gst: "b.cgst_paise + b.sgst_paise", rounding: "b.rounding_paise", total: "b.total_paise", averageBill: "b.total_paise",
      },
    };
  }
  if (id === "bill_items") {
    return {
      from: `bill_report_lines l JOIN bills b ON b.id = l.bill_id ${billJoins}`, dateColumn: "b.created_at", order: "b.created_at DESC, b.bill_no DESC, l.name, l.order_item_id",
      fields: {
        ...billWhen("b.created_at"), billNo: "b.bill_no", item: "l.name", category: "l.category_name", ...billWho, status: "b.status",
        lines: "1", qty: "l.qty", subtotal: "l.subtotal_paise", discount: "l.discount_paise", taxable: "l.taxable_paise", gst: "l.cgst_paise + l.sgst_paise",
        rounding: "l.rounding_paise", total: "l.total_paise",
      },
    };
  }
  if (id === "payments") {
    return {
      from: `payments p JOIN bills b ON b.id = p.bill_id LEFT JOIN bill_settlements s ON s.bill_id = p.bill_id LEFT JOIN users su ON su.id = s.created_by ${billJoins}`,
      // Zomato settlements are a receivable from Zomato, not money taken; Collections leaves them out too.
      dateColumn: "p.created_at", baseWhere: "p.mode <> 'zomato'", order: "p.created_at DESC, b.bill_no DESC, p.id",
      fields: {
        ...billWhen("p.created_at"), billNo: "b.bill_no", mode: "p.mode", collectedBy: "COALESCE(su.name, 'Unknown')", reference: "COALESCE(p.ref_note, '')",
        orderType: billWho.orderType, customer: billWho.customer, payments: "1", amount: "p.amount_paise",
      },
    };
  }
  if (id === "customers") {
    const bills = (extra = "") => `FROM bills v WHERE v.customer_id = c.id AND v.status <> 'void' AND v.created_at >= ${start} AND v.created_at < ${end}${extra}`;
    const points = (kinds: string) => `FROM loyalty_ledger l WHERE l.customer_id = c.id AND l.kind IN (${kinds}) AND l.created_at >= ${start} AND l.created_at < ${end}`;
    return {
      from: "customers c LEFT JOIN customer_types ct ON ct.id = c.type_id", dateColumn: null, order: "c.name COLLATE NOCASE, c.id",
      fields: {
        name: "c.name", phone: "c.phone", type: "COALESCE(ct.name, 'None')", joined: "c.created_at",
        visits: `(SELECT COUNT(*) ${bills()})`, spend: `(SELECT COALESCE(SUM(v.total_paise), 0) ${bills()})`, lastVisit: `(SELECT MAX(v.created_at) ${bills()})`,
        // Earned less redeemed plus reversed/adjusted is the change in balance over the dates.
        pointsEarned: `(SELECT COALESCE(SUM(l.points), 0) ${points("'earn'")})`, pointsRedeemed: `(SELECT COALESCE(-SUM(l.points), 0) ${points("'redeem'")})`,
        pointsOther: `(SELECT COALESCE(SUM(l.points), 0) ${points("'reverse', 'adjust'")})`,
        pointsBalance: "(SELECT COALESCE(SUM(l.points), 0) FROM loyalty_ledger l WHERE l.customer_id = c.id)",
      },
    };
  }
  throw httpError(400, "Unknown data source");
}

const formatOf = (field: CustomReportField): ReportColumn["format"] | undefined =>
  field.type === "money" ? "money" : field.type === "quantity" ? "quantity" : field.type === "time" ? "time" : undefined;

/** Runs a validated definition. Every identifier comes from the catalogue; every filter value is a bound parameter. */
export function runCustomReport(app: FastifyInstance, config: CustomReportConfigValue, query: unknown, title: string): CustomReport {
  const problem = customReportProblem(config);
  if (problem) throw httpError(400, problem);
  const { from, to, bounds } = reportRange(query);
  const source = customReportSource(config.source)!;
  const sql = sourceSql(config.source, bounds[0], bounds[1]);
  const field = (id: string) => source.fields.find((f) => f.id === id)!;
  const grouped = config.groupBy.length > 0;

  const where: string[] = [], having: string[] = [], whereParams: (string | number)[] = [], havingParams: (string | number)[] = [];
  if (sql.baseWhere) where.push(sql.baseWhere);
  if (sql.dateColumn) { where.push(`${sql.dateColumn} >= ? AND ${sql.dateColumn} < ?`); whereParams.push(...bounds); }
  for (const filter of config.filters) {
    const f = field(filter.field), expr = sql.fields[f.id]!;
    // On a grouped report a filter on a measure keeps whole groups (HAVING); otherwise it filters rows.
    const target = grouped && f.role === "measure" ? { list: having, params: havingParams, lhs: `${AGG[f.agg!]}(${expr})` } : { list: where, params: whereParams, lhs: expr };
    if (filter.op === "contains") {
      target.list.push(`${target.lhs} LIKE ? ESCAPE '\\'`); target.params.push(`%${String(filter.value).replace(/[\\%_]/g, "\\$&")}%`);
    } else {
      const op = { eq: "=", ne: "<>", gt: ">", gte: ">=", lt: "<", lte: "<=" }[filter.op];
      target.list.push(`${target.lhs} ${op} ?`); target.params.push(filter.value);
    }
  }
  const selects = config.columns.map((column, index) => {
    const f = field(column.field), expr = sql.fields[f.id]!;
    return `${grouped && f.role === "measure" ? `${AGG[f.agg!]}(${expr})` : expr} AS c${index}`;
  });
  const sortIndex = config.sort ? config.columns.findIndex((c) => c.field === config.sort!.field) : -1;
  // The default order is unique per row (or per group), so it also breaks ties in a chosen sort: the same rows survive the row cap on every run.
  const groupKeys = config.groupBy.map((id) => sql.fields[id]).join(", ");
  const tieBreak = grouped ? groupKeys : sql.order;
  const order = sortIndex >= 0 ? `c${sortIndex} ${config.sort!.dir === "desc" ? "DESC" : "ASC"}, ${tieBreak}` : tieBreak;
  const statement = `SELECT ${selects.join(", ")} FROM ${sql.from}${where.length ? ` WHERE ${where.join(" AND ")}` : ""}${grouped ? ` GROUP BY ${groupKeys}` : ""}${having.length ? ` HAVING ${having.join(" AND ")}` : ""} ORDER BY ${order} LIMIT ${CUSTOM_REPORT_LIMITS.rows + 1}`;

  const generatedAt = Date.now();
  const raw = app.db.prepare(statement).all(...whereParams, ...havingParams) as Record<string, ReportCell>[];
  const truncated = raw.length > CUSTOM_REPORT_LIMITS.rows;
  if (truncated) raw.pop();
  const columns: ReportColumn[] = config.columns.map((column) => {
    const f = field(column.field), format = formatOf(f);
    return { key: f.id, label: column.label || f.label, ...(format ? { format } : {}) };
  });
  const rows: Row[] = raw.map((r) => Object.fromEntries(config.columns.map((column, index) => {
    const f = field(column.field), value = r[`c${index}`] ?? null;
    return [f.id, f.agg === "avg" && typeof value === "number" ? Math.round(value * 100) / 100 : value];
  })));
  const notes = [`${source.title}: ${source.description} Rows are filtered by ${source.dateLabel}${sql.dateColumn ? "" : " for the activity columns"}. Amounts are in rupees.`];
  if (grouped) notes.push(`Grouped by ${config.groupBy.map((id) => field(id).label).join(", ")}. Amounts and quantities are summed per group; averages are averaged.`);
  let totals: Row | undefined;
  if (truncated) notes.push(`Only the first ${CUSTOM_REPORT_LIMITS.rows} rows are shown and totals are left out. Narrow the dates or add filters to see everything.`);
  else if (rows.length) {
    // Totals add only measures that sum; an average or latest date has no meaningful total.
    const summed = config.columns.filter((c) => field(c.field).agg === "sum");
    if (summed.length) {
      totals = Object.fromEntries(summed.map((c) => [c.field, rows.reduce((n, row) => n + Number(row[c.field] ?? 0), 0)]));
      const first = config.columns[0]!.field;
      if (!(first in totals)) totals[first] = "Total";
    }
  }
  return {
    kind: "custom", from, to, today: localDateKey(generatedAt), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, generatedAt, notes,
    tables: [{ title, columns, rows, ...(totals ? { totals } : {}) }],
  };
}

interface SavedRow { id: string; name: string; config_json: string; created_at: number; updated_at: number }
const toSaved = (r: SavedRow): SavedCustomReport => ({ id: r.id, name: r.name, config: JSON.parse(r.config_json) as SavedCustomReport["config"], createdAt: r.created_at, updatedAt: r.updated_at });

export function registerCustomReports(app: FastifyInstance): void {
  const db = app.db;
  const read = app.requirePermission("reports.read"), manage = app.requirePermission("reports.manage");
  const get = (id: string) => db.prepare("SELECT * FROM saved_reports WHERE id = ?").get(id) as SavedRow | undefined;
  const nameTaken = (name: string, exceptId = "") => db.prepare("SELECT 1 FROM saved_reports WHERE name = ? COLLATE NOCASE AND id <> ?").get(name, exceptId) !== undefined;
  const checked = (config: CustomReportConfigValue) => { const problem = customReportProblem(config); if (problem) throw httpError(400, problem); return config; };

  app.get("/api/custom-reports", { preHandler: read }, async () => ({
    reports: (db.prepare("SELECT * FROM saved_reports ORDER BY name COLLATE NOCASE").all() as SavedRow[]).map(toSaved),
  }));

  app.post("/api/custom-reports/run", { preHandler: read }, async (req, reply) => {
    const body = z.object({ config: CustomReportConfig, name: z.string().trim().max(80).optional() }).parse(req.body);
    reply.header("Cache-Control", "no-store");
    return { report: runCustomReport(app, body.config, req.body, body.name || "Custom report") };
  });

  app.post("/api/custom-reports", { preHandler: manage }, async (req, reply) => {
    const body = CustomReportSave.parse(req.body);
    checked(body.config);
    if (nameTaken(body.name)) throw httpError(409, "A report with this name already exists");
    const id = uuidv7(), now = Date.now();
    db.prepare("INSERT INTO saved_reports (id, name, config_json, created_at, updated_at, created_by) VALUES (?, ?, ?, ?, ?, ?)")
      .run(id, body.name, JSON.stringify(body.config), now, now, req.user.id);
    return reply.status(201).send({ report: toSaved(get(id)!) });
  });

  app.put("/api/custom-reports/:id", { preHandler: manage }, async (req) => {
    const { id } = req.params as { id: string };
    const body = CustomReportSave.parse(req.body);
    checked(body.config);
    if (!get(id)) throw httpError(404, "report not found");
    if (nameTaken(body.name, id)) throw httpError(409, "A report with this name already exists");
    db.prepare("UPDATE saved_reports SET name = ?, config_json = ?, updated_at = ? WHERE id = ?").run(body.name, JSON.stringify(body.config), Date.now(), id);
    return { report: toSaved(get(id)!) };
  });

  app.delete("/api/custom-reports/:id", { preHandler: manage }, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (db.prepare("DELETE FROM saved_reports WHERE id = ?").run(id).changes === 0) throw httpError(404, "report not found");
    return reply.status(204).send();
  });
}
