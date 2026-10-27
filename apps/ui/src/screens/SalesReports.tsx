import { useState } from "react";
import { OPERATIONAL_REPORTS, type OperationalReportKind } from "@forkflow/domain/operational-reports";
import { OperationalReports, PROFIT_REPORT_TITLE } from "./OperationalReports";
import { COSTING_PRO_NOTE } from "../dish-costing";
import { useLicense } from "./LicenseSettings";
import { OrderAnalytics } from "./OrderAnalytics";
import { SalesMetrics, SalesPeriodControls, SalesRangeCaption } from "../SalesReportControls";
import { recentPeriod, reportMoney, salesReportCsv, type ReportPeriod, type SalesReportKind } from "../sales-report";
import { useSalesReport } from "../useSalesReport";
import { downloadText } from "../download";
import { DayEnd } from "./DayEnd";
import { CashDrawer } from "./CashDrawer";
import { Bills } from "./Bills";
import { ZomatoReconciliationPanel } from "./ZomatoReconciliation";
import { CustomReports } from "./CustomReports";
import { OverflowMenu } from "../PosControls";
import "../sales-dashboard.css";

export function SalesReports({ initialTab = "sales", initialPeriod, canSeeCosts, canSeeZomato = false, canSettle = false, onOpenOrder }: { canSeeCosts: boolean; /** Cashiers and admins work a cash drawer shift; only admins (canSeeCosts) close a day. */ canSettle?: boolean; /** Admins and cashiers may open the Zomato reconciliation tab, whether Zomato is on or off (receivables from closed orders stay reconcilable). */ canSeeZomato?: boolean; initialTab?: SalesReportKind | "day-end" | "analytics" | "bills" | "zomato" | "cash" | "custom" | undefined; initialPeriod?: ReportPeriod | undefined; onOpenOrder: (id: string) => void }) {
  const [view, setView] = useState<"reports" | "analytics">(initialTab === "analytics" ? "analytics" : "reports");
  const [tab, setTab] = useState<SalesReportKind | "day-end" | "bills" | "zomato" | "cash" | "custom" | OperationalReportKind | "profit">(initialTab === "analytics" ? "sales" : initialTab);
  const { status } = useLicense();
  const profit = canSeeCosts && tab === "profit";
  const operational = OPERATIONAL_REPORTS.some((r) => r.id === tab) || profit;
  const [detailPeriod, setDetailPeriod] = useState<ReportPeriod | undefined>(initialPeriod);
  const [day, setDay] = useState(initialPeriod?.to);
  const { period, setPeriod, report, error, loading, refresh } = useSalesReport(initialPeriod);
  const [exportError, setExportError] = useState("");
  const [message, setMessage] = useState("");
  function exportReport() {
    if (!report || loading || (tab !== "sales" && tab !== "collections")) return;
    try {
      downloadText(salesReportCsv(report, tab), `forkflow-${tab}-${report.from}-to-${report.to}.csv`, "text/csv;charset=utf-8");
      setExportError(""); setMessage(`${tab === "sales" ? "Sales" : "Collections"} CSV downloaded for ${report.from} to ${report.to}.`);
    } catch (e) { setMessage(""); setExportError(e instanceof Error ? e.message : "Could not download report"); }
  }
  const presets: Array<{ id: "bills" | "sales" | "collections" | "day-end" | "zomato"; title: string }> = [{ id: "sales", title: "Sales" }, { id: "collections", title: "Collections" }, { id: "bills", title: "Bills" }, { id: "day-end", title: "Day-end / GST" }, ...(canSeeZomato ? [{ id: "zomato" as const, title: "Zomato reconciliation" }] : [])];
  return <section className="sales-reports">
    <div className="page-header"><h2>Reports &amp; Analytics</h2>
      {view === "reports" && (tab === "sales" || tab === "collections") && <OverflowMenu label="Export"><button disabled={!report || loading} onClick={exportReport}>Export {tab === "sales" ? "sales" : "collections"} CSV</button></OverflowMenu>}
    </div>
    <div className="report-navigation" aria-label="Report type">
      <div className="report-tabs">{presets.map(({ id, title }) => <button key={id} aria-pressed={view === "reports" && tab === id} onClick={() => { setView("reports"); if (id === "day-end") setDay(report?.to ?? period?.to); setTab(id); setMessage(""); setExportError(""); }}>{title}</button>)}</div>
      <select className="report-more" aria-label="More reports" value={view === "analytics" ? "analytics" : operational || tab === "cash" || tab === "custom" ? tab : ""} onChange={(e) => {
        const next = e.target.value;
        if (!next) return;
        setView(next === "analytics" ? "analytics" : "reports");
        if (next !== "analytics") setTab(next as OperationalReportKind | "profit" | "cash" | "custom");
        setMessage(""); setExportError("");
      }}>
        <option value="">More reports...</option>
        <option value="analytics">Analytics</option><option value="cash">Cash &amp; day close</option><option value="custom">Custom reports</option>
        {OPERATIONAL_REPORTS.map((r) => <option key={r.id} value={r.id}>{r.title}</option>)}{canSeeCosts && <option value="profit">{PROFIT_REPORT_TITLE}</option>}
      </select>
    </div>
    {view === "analytics" ? <OrderAnalytics initialPeriod={period ?? (report ? { from: report.from, to: report.to } : undefined)} onPeriodChange={setPeriod} /> : tab === "bills" ? <Bills onOpenOrder={onOpenOrder} /> : tab === "cash" ? <CashDrawer canSettle={canSettle} canCloseDay={canSeeCosts} /> : tab === "custom" ? <CustomReports canManage={canSeeCosts} initialPeriod={detailPeriod ?? period ?? undefined} onPeriodChange={setDetailPeriod} /> : tab === "zomato" && canSeeZomato ? <ZomatoReconciliationPanel /> : profit && status?.features.recipes !== true ? <section aria-label={PROFIT_REPORT_TITLE}><p className="recipe-access-note">{COSTING_PRO_NOTE}</p></section> : operational ? <OperationalReports key={tab} kind={tab as OperationalReportKind | "profit"} initialPeriod={detailPeriod ?? period ?? undefined} onPeriodChange={setDetailPeriod} /> : tab === "day-end" ? <DayEnd key={day ?? "today"} initialDate={day} /> : <>
      <SalesPeriodControls period={report ?? period ?? recentPeriod(7)} today={report?.today} loading={loading} onChange={(next) => { setMessage(""); setExportError(""); setPeriod(next); }} onRefresh={() => { setMessage(""); refresh(); }} />
      {(error || exportError) && <p role="alert">{error || exportError}</p>}
      {message && <p role="status">{message}</p>}
      {loading && <p className="sales-report-empty" role="status">Loading report…</p>}
      {report && <>
        <SalesMetrics report={report} compact />
        <SalesRangeCaption report={report} />
        <div className="sales-report-table" role="region" aria-label={`${tab === "sales" ? "Sales" : "Collections"} daily data`} tabIndex={0}>
          <table><caption>{tab === "sales" ? "Issued bills by bill date, including void bills. Sales include GST and rounding; credit notes (voids and refunds) are taken off on the day they are issued; unpaid shows the current balance of those bills." : "Receipts by payment date, including older bills, after refunds paid out that day (per method). Totals count distinct bills with payments; complimentary bills have no payment rows."}</caption>
            {tab === "sales" ? <>
              <thead><tr><th scope="col">Bill date</th><th scope="col">Bills</th><th scope="col">Subtotal</th><th scope="col">Discount</th><th scope="col">GST</th><th scope="col">Round off</th><th scope="col">Sales</th><th scope="col">Credit notes</th><th scope="col">Net sales</th><th scope="col">Unpaid now</th></tr></thead>
              <tbody>{report.daily.map(({ date, sales, creditNotePaise, netTotalPaise }) => <tr key={date}><th scope="row"><button className="sales-date-button" title={`Open day-end report for ${date}`} onClick={() => { setDay(date); setTab("day-end"); }}>{date}</button></th><td>{sales.billCount}</td><td>{reportMoney(sales.subtotalPaise)}</td><td>{reportMoney(sales.discountPaise)}</td><td>{reportMoney(sales.cgstPaise + sales.sgstPaise)}</td><td>{reportMoney(sales.roundingPaise)}</td><td>{reportMoney(sales.totalPaise)}</td><td>{reportMoney(creditNotePaise)}</td><td>{reportMoney(netTotalPaise)}</td><td>{reportMoney(sales.outstandingPaise)}</td></tr>)}</tbody>
              <tfoot><tr><th scope="row">Total</th><td>{report.sales.billCount}</td><td>{reportMoney(report.sales.subtotalPaise)}</td><td>{reportMoney(report.sales.discountPaise)}</td><td>{reportMoney(report.sales.cgstPaise + report.sales.sgstPaise)}</td><td>{reportMoney(report.sales.roundingPaise)}</td><td>{reportMoney(report.sales.totalPaise)}</td><td>{reportMoney(report.creditNotePaise)}</td><td>{reportMoney(report.netTotalPaise)}</td><td>{reportMoney(report.sales.outstandingPaise)}</td></tr></tfoot>
            </> : <>
              <thead><tr><th scope="col">Payment date</th><th scope="col">Cash (net)</th><th scope="col">UPI (net)</th><th scope="col">Card (net)</th><th scope="col">Refunds</th><th scope="col">Received (net)</th><th scope="col">Bills with payments</th></tr></thead>
              <tbody>{report.daily.map(({ date, collections }) => <tr key={date}><th scope="row">{date}</th><td>{reportMoney(collections.cashPaise)}</td><td>{reportMoney(collections.upiPaise)}</td><td>{reportMoney(collections.cardPaise)}</td><td>{reportMoney(collections.refundPaise)}</td><td>{reportMoney(collections.totalPaise)}</td><td>{collections.billCount}</td></tr>)}</tbody>
              <tfoot><tr><th scope="row">Total</th><td>{reportMoney(report.collections.cashPaise)}</td><td>{reportMoney(report.collections.upiPaise)}</td><td>{reportMoney(report.collections.cardPaise)}</td><td>{reportMoney(report.collections.refundPaise)}</td><td>{reportMoney(report.collections.totalPaise)}</td><td>{report.collections.billCount}</td></tr></tfoot>
            </>}
          </table>
        </div>
      </>}
    </>}
  </section>;
}
