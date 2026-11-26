import { Suspense, lazy, useEffect, useState } from "react";
import type { Page } from "../NavBar";
import { apiFetch, session, type User } from "../api";
import { Icon, type IconName } from "../Icon";
import type { Order, TableInfo } from "../types";
import { connectWs } from "../ws";
import { WorkspaceDialog } from "../WorkspaceDialog";
import { CashDrawer, currentCashShift, type Shift } from "./CashDrawer";
import { SalesDashboard } from "../SalesDashboard";
import { loadDashboard } from "../dynamic-dashboard/load-dashboard";
// Loaded on demand so Tailwind, BoardUI and React Aria stay out of the main POS bundle.
const DynamicDashboard = lazy(() => loadDashboard(() => import("../dynamic-dashboard/DynamicDashboard")));
import { useShortcutLabels } from "../pos-shortcuts";
import { useIntegrations } from "../integrations";
import { useModules } from "../modules";
import { userCan } from "../permissions";

export function Home({ user, onNavigate }: { user: User; onNavigate: (page: Page) => void }) {
  const { shortcut, shortcutProps } = useShortcutLabels();
  const { isEnabled } = useIntegrations();
  const modules = useModules();
  const financial = userCan(user, "reports.read");
  const canQuickBill = userCan(user, "bills.settle");
  const [stats, setStats] = useState<{ free: number; orders: number; billed: number } | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [shift, setShift] = useState<Shift | null>(null);
  useEffect(() => {
    if (!canQuickBill) return;
    let active = true;
    currentCashShift().then(current => { if (active) setShift(current); }).catch(() => {});
    return () => { active = false; };
  }, [canQuickBill, drawerOpen, user.id]);
  const [error, setError] = useState("");
  const [unavailable, setUnavailable] = useState(false);
  useEffect(() => {
    if (financial) return;
    let active = true;
    const reload = async () => {
      try {
        const [t, o] = await Promise.all([apiFetch<{ tables: TableInfo[] }>("/api/tables"), apiFetch<{ orders: Order[] }>("/api/orders")]);
        if (active) { setStats({ free: t.tables.filter((x) => x.isActive && x.status === "free").length, orders: o.orders.filter((x) => x.status === "open").length, billed: o.orders.filter((x) => x.status === "billed").length }); setError(""); }
      } catch { if (active) setError("Service totals will update when the server reconnects."); }
    };
    void reload();
    const dispose = connectWs({ onEvent: (event) => { if (event === "order.updated" || event === "table.changed") void reload(); }, onStatus: (connected) => { if (connected) void reload(); }, onAuthFail: () => session.clear() });
    const timer = window.setInterval(() => { void reload(); }, 30000);
    return () => { active = false; dispose(); window.clearInterval(timer); };
  }, [financial]);
  const links: Array<{ page: Page; icon: IconName; title: string }> = [
    { page: { name: "tables" }, icon: "tables", title: "Tables" },
    ...(financial ? [
      ...(isEnabled("kds") ? [{ page: { name: "kitchen" } as Page, icon: "kitchen" as const, title: "Kitchen" }] : []),
      { page: { name: "bills" } as Page, icon: "bills" as const, title: "Bills" },
      { page: { name: "reports" } as Page, icon: "reports" as const, title: "Reports & Analytics" },
    ] : []),
  ];
  const showSalesDashboard = financial && modules.isActive("dashboard");
  const showDynamicDashboard = showSalesDashboard && modules.isActive("dynamicReports") && userCan(user, "reports.dashboard") && !unavailable;
  const orderActions = <div className="actions dashboard-top-actions">
    <div className="actions dashboard-order-actions">
      <button type="button" className="button-icon" onClick={() => onNavigate({ name: "tables" })}><Icon name="plus" size={17} />New order</button>
      {canQuickBill && modules.isActive("takeaway") && <button type="button" className="primary button-icon" {...shortcutProps("takeaway")} title={shortcut("takeaway", "Takeaway")} onClick={() => onNavigate({ name: "takeaway" })}><Icon name="bag" size={17} />{shortcut("takeaway", "Takeaway")}</button>}
    </div>
    {canQuickBill && <button type="button" className="button-icon dashboard-drawer-action" onClick={() => setDrawerOpen(true)}>{shift ? `My cash drawer · ${shift.drawerName}` : "Open day cash"}</button>}
  </div>;
  return <section className={`screen dashboard${financial ? " financial-home" : ""}`} aria-label="Dashboard">
    {(!showSalesDashboard || showDynamicDashboard) && <div className="page-header">{orderActions}</div>}
    {drawerOpen && <WorkspaceDialog open className="cash-drawer-dialog" title={shift ? "My cash drawer" : "Open day cash"} onClose={() => setDrawerOpen(false)}>
      <CashDrawer canSettle canCloseDay={false} canReadReports={false} onOpened={() => setDrawerOpen(false)} />
    </WorkspaceDialog>}
    {!financial && error && <p className="alert" role="status">{error}</p>}
    {showSalesDashboard && (showDynamicDashboard
      ? <Suspense fallback={<p role="status">Loading dashboard…</p>}><DynamicDashboard onUnavailable={() => setUnavailable(true)} /></Suspense>
      : <SalesDashboard onNavigate={onNavigate} canManage={userCan(user, "integrations.configure")} orderActions={orderActions} />)}
    {!financial && <div className="stat-grid" aria-label="Live service counts">
      {[
        { label: "Open orders", value: stats?.orders },
        { label: "Available tables", value: stats?.free },
        { label: "Awaiting payment", value: stats?.billed },
      ].map((stat) => <div className="stat-card" key={stat.label}><p>{stat.label}</p><div className="stat-value">{stat.value ?? "—"}</div></div>)}
    </div>}
    {!financial && <div className="dashboard-actions" aria-label="Quick actions">
      {links.map((link) => <button key={link.page.name} onClick={() => onNavigate(link.page)}><Icon name={link.icon} /><span>{link.title}</span></button>)}
    </div>}
  </section>;
}
