import { localDateKey, type Database } from "@masalapos/domain";
import type { AnalyticsOrderType } from "@masalapos/domain/operational-reports";
import {
  compareRange, periodRange, widgetDef,
  type DashboardData, type DashboardDataRequestValue, type DateRange, type WidgetDef, type WidgetResult, type WidgetValue,
} from "@masalapos/domain/dashboard";
import { operationalReport } from "./operational-reports.js";
import { orderAnalyticsReport } from "./order-analytics.js";
import { reportRange, salesReport } from "./sales-reports.js";

const NO_ACCESS = "You no longer have access to this widget.";
const FAILED = "Could not load this widget";
const DETAIL_LIMIT = 5;

type Request = DashboardDataRequestValue["widgets"][number];
interface Reports {
  sales: ReturnType<typeof salesReport>;
  analytics: ReturnType<typeof orderAnalyticsReport>;
  cancellations: ReturnType<typeof operationalReport>;
}

const money = (value: number): WidgetValue => ({ kind: "number", value, format: "money" });
const count = (value: number): WidgetValue => ({ kind: "number", value, format: "count" });
/** Best sales first, ties by name, so a ranking by sales does not follow the report's quantity order. */
const bySales = (a: { totalPaise: number; name: string }, b: { totalPaise: number; name: string }) => b.totalPaise - a.totalPaise || a.name.localeCompare(b.name);
const pad = (hour: number) => String(hour).padStart(2, "0");

/** The first few names a query returns, for the small detail line under a status count. */
const names = (db: Database, sql: string) => db.prepare(`${sql} LIMIT ${DETAIL_LIMIT}`).pluck().all() as string[];
const scalar = (db: Database, sql: string, ...params: number[]) => Number(db.prepare(sql).pluck().get(...params) ?? 0);

function statusValue(db: Database, widget: Request["widget"], now: number): WidgetValue {
  switch (widget) {
    case "openTables": {
      const open = "SELECT table_id FROM orders WHERE status = 'open' AND type = 'dine_in' AND table_id IS NOT NULL";
      return { kind: "status", count: scalar(db, `SELECT COUNT(DISTINCT table_id) FROM (${open})`),
        detail: names(db, `SELECT name FROM dining_tables WHERE id IN (${open}) ORDER BY sort_order, name`) };
    }
    case "runningKots":
      return { kind: "status", count: scalar(db, "SELECT COUNT(*) FROM kots WHERE done_at IS NULL"), detail: [] };
    case "pendingQr":
      return { kind: "status", count: scalar(db, "SELECT COUNT(*) FROM guest_requests WHERE status = 'pending' AND expires_at > ?", now), detail: [] };
    case "lowStock": {
      const low = "FROM stock_items WHERE is_active = 1 AND low_stock_threshold IS NOT NULL AND qty <= low_stock_threshold";
      return { kind: "status", count: scalar(db, `SELECT COUNT(*) ${low}`), detail: names(db, `SELECT name ${low} ORDER BY name`) };
    }
    case "unsettledBills":
      return { kind: "status", count: scalar(db, "SELECT COUNT(*) FROM bills WHERE status = 'unpaid'"),
        amountPaise: scalar(db, "SELECT COALESCE(SUM(total_paise), 0) FROM bills WHERE status = 'unpaid'"), detail: [] };
    default:
      throw new Error(`Not a status widget: ${widget}`);
  }
}

/**
 * Every requested widget's figures from one database snapshot. The figures come from the same report functions the
 * report pages use, so a dashboard number always equals the report's. A widget the person cannot see, or that fails,
 * answers for itself and leaves the others alone.
 */
export function computeWidgets(
  db: Database, requests: Request[], visible: (def: WidgetDef) => boolean, now: number,
  log?: (error: unknown, widget: string) => void,
): DashboardData {
  const today = localDateKey(now);
  return db.transaction((): DashboardData => {
    const cache = new Map<string, Reports[keyof Reports]>();
    const report = <K extends keyof Reports>(source: K, range: DateRange, orderType: AnalyticsOrderType): Reports[K] => {
      const id = `${source}|${range.from}|${range.to}|${orderType}`;
      let found = cache.get(id);
      if (!found) {
        const bounds = reportRange(range);
        found = source === "sales" ? salesReport(db, bounds)
          : source === "analytics" ? orderAnalyticsReport(db, bounds, orderType)
          : operationalReport(db, "cancellations", bounds);
        cache.set(id, found);
      }
      return found as Reports[K];
    };

    const valueFor = (request: Request, range: DateRange, orderType: AnalyticsOrderType): WidgetValue => {
      const sales = () => report("sales", range, "all");
      const analytics = () => report("analytics", range, orderType);
      const { topN } = request.options;
      switch (request.widget) {
        case "netSales": return money(sales().netTotalPaise);
        case "billCount": return count(sales().sales.billCount);
        case "averageBill": { const s = sales().sales; return money(s.billCount ? Math.round(s.totalPaise / s.billCount) : 0); }
        case "discounts": return money(sales().sales.discountPaise);
        case "gstCollected": return money(sales().sales.cgstPaise + sales().sales.sgstPaise);
        case "creditNotes": return money(sales().creditNotePaise);
        case "outstanding": return money(sales().sales.outstandingPaise);
        case "cashCollected": return money(sales().collections.cashPaise);
        case "upiCollected": return money(sales().collections.upiPaise);
        case "cardCollected": return money(sales().collections.cardPaise);
        case "paymentMix": {
          const s = sales();
          return { kind: "series", format: "money", points: [
            { label: "Cash", value: s.collections.cashPaise }, { label: "UPI", value: s.collections.upiPaise },
            { label: "Card", value: s.collections.cardPaise }, { label: "Zomato receivable", value: s.zomatoReceivablePaise },
          ] };
        }
        case "cancellations": return money(Number(report("cancellations", range, "all").tables[0]?.totals?.value ?? 0));
        case "hourlySales":
          return { kind: "series", format: "money", points: analytics().hourly.map((h) => ({ label: pad(h.hour), value: h.totalPaise })) };
        case "dailyTrend":
          return { kind: "series", format: "money", points: analytics().daily.map((d) => ({ label: d.date, value: d.totalPaise })) };
        case "orderTypeSplit": {
          const byType = new Map(analytics().comparison.map((row) => [row.type, row.totalPaise]));
          return { kind: "series", format: "money", points: [
            { label: "Dine-in", value: byType.get("dine_in") ?? 0 }, { label: "Takeaway", value: byType.get("parcel") ?? 0 },
            { label: "Zomato", value: byType.get("zomato") ?? 0 },
          ] };
        }
        case "topItems":
          return { kind: "ranking", rows: [...analytics().items].sort(bySales).slice(0, topN).map((i) => ({ label: i.name, value: i.totalPaise, qty: i.qty })) };
        case "topCategories":
          return { kind: "ranking", rows: [...analytics().categories].sort(bySales).slice(0, topN).map((c) => ({ label: c.name, value: c.totalPaise, qty: c.qty })) };
        default:
          return statusValue(db, request.widget, now);
      }
    };

    const results: Record<string, WidgetResult> = {};
    for (const request of requests) {
      const def = widgetDef(request.widget);
      if (!visible(def)) { results[request.key] = { ok: false, error: NO_ACCESS }; continue; }
      try {
        if (def.kind === "status") {
          results[request.key] = { ok: true, range: null, current: statusValue(db, request.widget, now), compareRange: null, compare: null };
          continue;
        }
        const { options } = request;
        const orderType = def.options.orderType ? options.orderType : "all";
        const range = periodRange(options.period, today);
        const against = def.options.compare ? compareRange(options.period, range, options.compare) : null;
        results[request.key] = {
          ok: true, range, current: valueFor(request, range, orderType),
          compareRange: against, compare: against ? valueFor(request, against, orderType) : null,
        };
      } catch (error) {
        log?.(error, request.widget);
        results[request.key] = { ok: false, error: FAILED };
      }
    }
    return { results, today, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, generatedAt: now };
  })();
}
