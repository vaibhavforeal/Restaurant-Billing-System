import { useEffect, useState } from "react";
import type { AnalyticsOrderType, OrderAnalyticsReport } from "@forkflow/domain/operational-reports";
import { apiFetch } from "../api";
import { downloadText } from "../download";
import { SegmentedControl } from "../PosControls";
import { SalesPeriodControls, SalesRangeCaption } from "../SalesReportControls";
import { recentPeriod, reportMoney, type ReportPeriod } from "../sales-report";
import { analyticsCsv, averageOrder, orderShare, orderTypeLabel, rankedItems, type ItemRanking } from "../order-analytics";
import { BusyHours, OrderTrend } from "../OrderAnalyticsCharts";
import "../order-analytics.css";

const orderOptions = [{ value: "all", label: "All orders" }, { value: "parcel", label: "Quick takeaway" }, { value: "dine_in", label: "Table orders" }] as const;
const rankingOptions = [{ value: "quantity", label: "Quantity" }, { value: "sales", label: "Sales" }] as const;

export function OrderAnalytics({ initialPeriod, onPeriodChange }: { initialPeriod?: ReportPeriod | undefined; onPeriodChange: (period: ReportPeriod) => void }) {
  const [period, setPeriod] = useState<ReportPeriod | null>(initialPeriod ?? null);
  const [orderType, setOrderType] = useState<AnalyticsOrderType>("all");
  const [ranking, setRanking] = useState<ItemRanking>("quantity");
  const [report, setReport] = useState<OrderAnalyticsReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [revision, setRevision] = useState(0);
  const [showAll, setShowAll] = useState(false);
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    setLoading(true); setReport(null); setError(""); setMessage("");
    const query = new URLSearchParams({ type: orderType, ...(period ? { from: period.from, to: period.to } : {}) });
    void apiFetch<{ report: OrderAnalyticsReport }>(`/api/reports/analytics?${query}`, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]) })
      .then(({ report: result }) => { if (active) setReport(result); })
      .catch((e: unknown) => { if (active) setError(e instanceof Error ? e.message : "Could not load order analytics"); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; controller.abort(); };
  }, [period?.from, period?.to, orderType, revision]);
  function invalidate() { setReport(null); setLoading(true); setError(""); setMessage(""); }
  function exportReport() {
    if (!report || loading) return;
    try {
      downloadText(analyticsCsv(report, ranking), `forkflow-analytics-${report.orderType}-${report.from}-to-${report.to}.csv`, "text/csv;charset=utf-8");
      setMessage("Analytics CSV downloaded. Amounts are in rupees.");
    } catch (e) { setError(e instanceof Error ? e.message : "Could not export analytics"); }
  }
  const items = report ? rankedItems(report, ranking) : [];
  const visibleItems = showAll ? items : items.slice(0, 10);
  const maxItem = Math.max(1, ...items.map((row) => ranking === "sales" ? row.totalPaise : row.qty));
  const totalOrders = report?.comparison.reduce((sum, row) => sum + row.orderCount, 0) ?? 0;
  return <div className="order-analytics">
    <div className="analytics-heading"><div><h3>Order analytics</h3><p>Compare service types and see what sells best.</p></div><button disabled={!report || loading} onClick={exportReport}>Export analytics CSV</button></div>
    <SalesPeriodControls period={report ?? period ?? recentPeriod(7)} today={report?.today} loading={loading} onChange={(next) => { invalidate(); setPeriod(next); onPeriodChange(next); setRevision((value) => value + 1); }} onRefresh={() => { invalidate(); setRevision((value) => value + 1); }} />
    <div className="analytics-filter"><SegmentedControl<AnalyticsOrderType> label="Analytics order type" value={orderType} options={orderOptions} onChange={(value) => { if (value !== orderType) { invalidate(); setOrderType(value); setShowAll(false); } }} /><small>Comparison always shows both types; the filter applies to the other sections.</small></div>
    {error && <p role="alert">{error}</p>}{message && <p role="status">{message}</p>}
    {loading && <p className="sales-report-empty" role="status">Loading analytics…</p>}
    {report && <>
      <div className="sales-metrics analytics-metrics">{[
        { label: "Billed orders", value: String(report.totals.orderCount), note: "Distinct orders with issued bills" },
        { label: "Issued sales", value: reportMoney(report.totals.totalPaise), note: "Includes GST and rounding" },
        { label: "Items sold", value: String(report.totals.qty), note: "Quantity across billed items" },
        { label: "Average order", value: reportMoney(averageOrder(report.totals.totalPaise, report.totals.orderCount)), note: "Issued sales ÷ billed orders" },
      ].map((metric) => <div className="sales-metric" key={metric.label}><p>{metric.label}</p><strong>{metric.value}</strong><small>{metric.note}</small></div>)}</div>
      <SalesRangeCaption report={report} />
      {!report.totals.orderCount && <p className="sales-report-empty">No billed orders for this date range and order type. Choose another range or All orders.</p>}
      <div className="analytics-grid">
        <section className="sales-chart-panel analytics-comparison" aria-label="Quick takeaway versus table orders">
          <header><h3>Quick takeaway vs table orders</h3><small>All order types · {totalOrders} orders</small></header>
          <div className="sales-report-table" role="region" aria-label="Order comparison data" tabIndex={0}><table><caption className="analytics-sr-only">Orders and issued sales for both service types in the selected period.</caption><thead><tr><th scope="col">Order type</th><th scope="col">Orders / share</th><th scope="col">Sales</th><th scope="col">Avg. order</th></tr></thead><tbody>{report.comparison.map((row) => <tr key={row.type}><th scope="row">{orderTypeLabel(row.type)}</th><td><strong>{row.orderCount}</strong> <small>{orderShare(row.orderCount, totalOrders).toFixed(1)}%</small><div className="analytics-share" aria-hidden="true"><i className={row.type === "dine_in" ? "table-orders" : ""} style={{ width: `${orderShare(row.orderCount, totalOrders)}%` }} /></div></td><td>{reportMoney(row.totalPaise)}</td><td>{reportMoney(averageOrder(row.totalPaise, row.orderCount))}</td></tr>)}</tbody></table></div>
          <p className="sales-chart-note">Quick takeaway includes all parcel orders. Table orders include dine-in splits.</p>
        </section>
        <OrderTrend key={`${report.from}-${report.to}-${report.orderType}`} report={report} />
        <section className="sales-chart-panel analytics-items" aria-label="Highest moving items">
          <header><div><h3>Highest moving items</h3><small>{showAll ? items.length : Math.min(10, items.length)} of {items.length} items / variants · ranked by {ranking}</small></div><SegmentedControl<ItemRanking> label="Rank items by" value={ranking} options={rankingOptions} onChange={(value) => { setRanking(value); setMessage(""); }} /></header>
          {items.length ? <div className="sales-report-table" role="region" aria-label="Ranked item sales data" tabIndex={0}><table><caption className="analytics-sr-only">Item quantities by service type and sales after discounts, GST and rounding.</caption><thead><tr><th scope="col">Item / variant</th><th scope="col">Qty</th><th scope="col">Takeaway</th><th scope="col">Tables</th><th scope="col">Orders</th><th scope="col">Sales</th></tr></thead><tbody>{visibleItems.map((row, index) => <tr key={JSON.stringify([row.productId, row.variantId, row.categoryId, row.name, row.category])}><th scope="row"><div className="analytics-item-name"><span>{index + 1}</span><div><strong>{row.name}</strong><small>{row.category}</small><div className="analytics-share" aria-hidden="true"><i style={{ width: `${(ranking === "sales" ? row.totalPaise : row.qty) / maxItem * 100}%` }} /></div></div></div></th><td><strong>{row.qty}</strong></td><td>{row.takeawayQty}</td><td>{row.tableQty}</td><td>{row.orderCount}</td><td>{reportMoney(row.totalPaise)}</td></tr>)}</tbody></table></div> : <p className="sales-chart-note">No billed items for this selection.</p>}
          {items.length > 10 && <button className="analytics-show-all" onClick={() => setShowAll((value) => !value)}>{showAll ? "Show top 10" : `Show all ${items.length} items`}</button>}
        </section>
        <section className="sales-chart-panel" aria-label="Category performance"><header><h3>Category performance</h3><small>By issued sales</small></header><div className="analytics-categories">{report.categories.map((row) => <div key={JSON.stringify([row.categoryId, row.name])}><div className="payment-bar-label"><span>{row.name}<small>{row.qty} items · {row.orderCount} orders</small></span><strong>{reportMoney(row.totalPaise)}</strong></div><div className="payment-bar-track" aria-hidden="true"><div className="payment-bar-fill" style={{ width: `${row.totalPaise / Math.max(1, report.totals.totalPaise) * 100}%` }} /></div></div>)}</div>{!report.categories.length && <p className="sales-chart-note">No category sales for this selection.</p>}</section>
        <BusyHours key={`${report.from}-${report.to}-${report.orderType}`} report={report} />
      </div>
      <details className="report-notes"><summary>How analytics are calculated</summary><p>Analytics use issued bills by bill date in the server timezone. Unpaid and complimentary bills are included; void bills and cancelled items are excluded. Sales use saved bill totals after discounts, GST and rounding. Open orders are excluded until billed.</p><p>Quick takeaway includes all parcel orders. Each table split is a separate order. Item names, categories and prices are saved at billing; historical categories may be unavailable. Order counts across items and categories overlap.</p></details>
    </>}
  </div>;
}
