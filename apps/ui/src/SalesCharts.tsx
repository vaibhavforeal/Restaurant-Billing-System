import { reportMoney, type SalesReport } from "./sales-report";

export function PaymentBreakdown({ report }: { report: SalesReport }) {
  const total = report.collections.totalPaise;
  return <section className="sales-chart-panel" aria-label="Collections by payment method">
    <header><h3>Payment collections</h3><small>{report.collections.billCount} bills with payments</small></header>
    <div className="payment-bars">{([{ key: "cashPaise", label: "Cash (net)" }, { key: "upiPaise", label: "UPI (net)" }, { key: "cardPaise", label: "Card (net)" }] as const).map(({ key, label }) => {
      const value = report.collections[key], percent = total > 0 ? value / total * 100 : 0;
      return <div key={key}><div className="payment-bar-label"><span>{label} <small>{percent.toFixed(1)}%</small></span><strong>{reportMoney(value)}</strong></div><div className="payment-bar-track" aria-hidden="true"><div className="payment-bar-fill" style={{ width: `${Math.min(100, Math.max(0, percent))}%` }} /></div></div>;
    })}</div>
    <div className="payment-bar-label"><span>Total received (net)</span><strong>{reportMoney(total)}</strong></div>
    <p className="sales-chart-note">Payments received in this period, including older bills, less refunds paid out{report.collections.refundPaise ? ` (${reportMoney(report.collections.refundPaise)})` : ""}.</p>
  </section>;
}
