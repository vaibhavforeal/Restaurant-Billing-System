import { SalesMetrics, SalesRangeCaption } from "./SalesReportControls";
import { PaymentBreakdown, SalesTrend } from "./SalesCharts";
import { useSalesReport } from "./useSalesReport";
import "./sales-dashboard.css";

export function SalesDashboard() {
  const { report, error, loading, refresh } = useSalesReport(undefined, true);
  return <div className="sales-dashboard" aria-busy={loading}>
    {error && <p role="alert">{error} <button onClick={refresh}>Retry</button></p>}
    {loading && <p className="sales-report-empty" role="status">Loading sales and payment collections…</p>}
    {report && <>
      <SalesRangeCaption report={report} />
      <SalesMetrics report={report} variant="dashboard" />
      <div className="sales-charts"><SalesTrend report={report} /><PaymentBreakdown report={report} /></div>
    </>}
  </div>;
}
