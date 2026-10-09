import { useEffect, useMemo, useRef, useState } from "react";
import { AlertsPanel, type OperationalAlert } from "./AlertsPanel";
import { ChannelCards } from "./ChannelCards";
import { DashboardStrip } from "./DashboardStrip";
import { OrderStatistics } from "./OrderStatistics";
import { PaymentBreakdown } from "./SalesCharts";
import { SlotChart } from "./SlotChart";
import { channelCards, orderStats, slotBars } from "./dashboard-data";
import { useIntegrations } from "./integrations";
import type { Page } from "./NavBar";
import { localDay } from "./sales-report";
import { useAggregatorOrders } from "./useAggregatorOrders";
import { useDashboard, useNow } from "./useDashboard";
import "./sales-dashboard.css";
import "./dashboard.css";

export function SalesDashboard({ onNavigate, canManage }: { onNavigate: (page: Page) => void; canManage: boolean }) {
  const today = localDay(new Date(useNow(60_000)));
  const [date, setDate] = useState(today);
  // Left open past midnight, a dashboard that was showing "today" moves on to the new day; a picked date stays.
  const shownToday = useRef(today);
  useEffect(() => {
    if (shownToday.current === today) return;
    const previous = shownToday.current; shownToday.current = today;
    setDate((current) => current === previous ? today : current);
  }, [today]);
  const { analytics, dayEnd, sales, orders, error, loading, updatedAt, refresh } = useDashboard(date);
  const { ready, isEnabled } = useIntegrations();
  const zomatoEnabled = isEnabled("zomato");
  const aggregator = useAggregatorOrders(zomatoEnabled);

  const cards = useMemo(() => analytics ? channelCards(analytics.dineIn.comparison) : null, [analytics]);
  const bars = useMemo(() => slotBars(analytics?.dineIn.hourly ?? [], analytics?.takeaway.hourly ?? []), [analytics]);
  const counts = useMemo(() => orderStats({ billCount: dayEnd?.sales.billCount ?? 0, cancelledCount: dayEnd?.cancellations.orderCount ?? 0, orders }), [dayEnd, orders]);
  const awaiting = counts.awaitingPayment;
  const operational: OperationalAlert[] = awaiting > 0
    ? [{ key: "awaiting-payment", message: `${awaiting} billed ${awaiting === 1 ? "order" : "orders"} awaiting payment` }] : [];

  return <div className="sales-dashboard dash" aria-busy={loading}>
    <DashboardStrip date={date} today={today} updatedAt={updatedAt} loading={loading} onDate={setDate} onRefresh={refresh} />
    {error && <p className="dash-error" role="alert">{error}. Figures shown may be incomplete. <button type="button" onClick={refresh}>Retry</button></p>}
    <div className="dash-layout">
      <div className="dash-main">
        <ChannelCards cards={cards} />
        {analytics ? <SlotChart bars={bars} />
          : <section className="dash-panel dash-slots" aria-label="Sales by time slot"><header className="dash-panel-head"><h3>Sales</h3></header>
            <p className="sales-report-empty" role="status">{loading ? "Loading sales by time slot…" : "Sales by time slot are unavailable. Use Retry to try again."}</p></section>}
      </div>
      <aside className="dash-side" aria-label="Alerts and statistics">
        <AlertsPanel rows={aggregator.rows} truncated={aggregator.truncated} operational={operational} ready={ready} loaded={aggregator.loaded} zomatoEnabled={zomatoEnabled}
          canManage={canManage} error={aggregator.error} onOpenZomato={() => onNavigate({ name: "tables" })} onOpenMarketplace={() => onNavigate({ name: "marketplace" })} />
        <OrderStatistics stats={dayEnd ? counts : null} />
        {sales && <PaymentBreakdown report={sales} />}
      </aside>
    </div>
  </div>;
}
