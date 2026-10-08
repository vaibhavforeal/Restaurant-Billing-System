import { useEffect, useState } from "react";
import type { Page } from "../NavBar";
import { apiFetch, session, type User } from "../api";
import { Icon, type IconName } from "../Icon";
import type { Order, TableInfo } from "../types";
import { connectWs } from "../ws";
import { SalesDashboard } from "../SalesDashboard";
import { useShortcutLabels } from "../pos-shortcuts";
import { useIntegrations } from "../integrations";

export function Home({ user, onNavigate }: { user: User; onNavigate: (page: Page) => void }) {
  const { shortcut, shortcutProps } = useShortcutLabels();
  const { isEnabled } = useIntegrations();
  const financial = user.role === "admin" || user.role === "cashier";
  const [stats, setStats] = useState<{ free: number; orders: number; billed: number } | null>(null);
  const [error, setError] = useState("");
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
    ...(user.role === "admin" || user.role === "cashier" ? [
      ...(isEnabled("kds") ? [{ page: { name: "kitchen" } as Page, icon: "kitchen" as const, title: "Kitchen" }] : []),
      { page: { name: "bills" } as Page, icon: "bills" as const, title: "Bills" },
      { page: { name: "reports" } as Page, icon: "reports" as const, title: "Reports & Analytics" },
    ] : []),
  ];
  return <section className={`screen dashboard${financial ? " financial-home" : ""}`}>
    <div className="page-header">
      <h2>Dashboard</h2>
      <div className="actions">
        <button className="button-icon" onClick={() => onNavigate({ name: "tables" })}><Icon name="plus" size={17} />New order</button>
        {(user.role === "admin" || user.role === "cashier") && <button className="primary button-icon" {...shortcutProps("takeaway")} title={shortcut("takeaway", "Takeaway")} onClick={() => onNavigate({ name: "takeaway" })}><Icon name="bag" size={17} />{shortcut("takeaway", "Takeaway")}</button>}
      </div>
    </div>
    {!financial && error && <p className="alert" role="status">{error}</p>}
    {financial && <SalesDashboard onNavigate={onNavigate} canManage={user.role === "admin"} />}
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
