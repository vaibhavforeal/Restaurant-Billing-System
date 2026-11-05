import { useState } from "react";
import { apiFetch, session, type User } from "./api";
import { Brand, Icon, type IconName } from "./Icon";
import { ThemeToggle } from "./ThemeToggle";
import { useIntegrations } from "./integrations";
import { useModules } from "./modules";
import { navTabVisible } from "./integrations-model";
import { useShortcutLabels } from "./pos-shortcuts";
import { STAFF_TABS, staffTabVisible } from "./integrations-model";
import { userCan } from "./permissions";
import { GetSupportButton } from "./support";
import { WorkspaceDialog } from "./WorkspaceDialog";

export type Page =
  | { name: "home" }
  | { name: "tables"; qrInbox?: number }
  | { name: "orders" }
  | { name: "takeaway"; requestId?: number }
  | { name: "order"; orderId: string; returnTo?: "tables" | "orders" }
  | { name: "kitchen" }
  | { name: "catalog" }
  | { name: "users" }
  | { name: "settings"; section?: "plan" }
  | { name: "bills" }
  | { name: "marketplace" }
  | { name: "reports"; tab?: "sales" | "collections" | "day-end" | "gst" | "analytics" | "bills" | "zomato" | "cash"; period?: { from: string; to: string } }
  | { name: "inventory" }
  | { name: "customers" };
// Billing and reports use the existing cashier/admin permissions.

export function NavBar({
  user,
  page,
  onNavigate,
  onLogout,
  beforeLogout,
}: {
  user: User;
  page: Page;
  onNavigate: (page: Page) => void;
  onLogout: () => void;
  beforeLogout?: () => boolean;
}) {
  const { bindings, shortcut, shortcutProps } = useShortcutLabels();
  const [menuOpen, setMenuOpen] = useState(false);
  const { isEnabled } = useIntegrations();
  const modules = useModules();
  async function logout() {
    if (beforeLogout && !beforeLogout()) return;
    try {
      await apiFetch<void>("/api/logout", { method: "POST" });
    } catch {
      // ignore error - local session is cleared regardless
    } finally {
      session.clear();
      onLogout();
    }
  }

  // Waiters work in the Captain app and kitchen staff on the kitchen board; everyone else gets the tabs their permissions open.
  const roleTabs: Array<{ page: Page; label: string }> =
    user.role === "waiter"
      ? [
          { page: { name: "home" }, label: "home" },
          { page: { name: "tables" }, label: "tables" },
        ]
      : user.role === "kitchen"
        ? [{ page: { name: "kitchen" }, label: "kitchen" }]
        : STAFF_TABS.filter((tab) => staffTabVisible(tab, (slug) => userCan(user, slug))).map((name) => ({ page: { name } as Page, label: name }));

  const tabs = roleTabs.filter((t) => navTabVisible(t.page.name, user.role, isEnabled) && (t.page.name !== "inventory" || modules.isActive("inventory")));

  const activeTab = page.name === "order" ? page.returnTo ?? "tables" : page.name === "bills" ? "reports" : page.name;
  const canTakeaway = user.role !== "waiter" && user.role !== "kitchen" && userCan(user, "bills.settle") && modules.isActive("takeaway");
  const salesTabs: Array<{ page: Page; label: string }> = [
    ...tabs.filter(t => t.page.name === "orders").map(t => ({ ...t, label: "My Orders" })),
    ...(canTakeaway ? [{ page: { name: "takeaway" } as Page, label: "Take New Order" }] : []),
    ...tabs.filter(t => t.page.name === "tables").map(t => ({ ...t, label: "Table View" })),
  ];
  const menuTabs = tabs.filter(t => t.page.name !== "orders" && t.page.name !== "tables");

  return (
    <><header className="sales-header">
      <div className="sales-brand"><button className="sales-menu-toggle" aria-label="Open menu" aria-haspopup="dialog" aria-expanded={menuOpen} onClick={() => setMenuOpen(true)}><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16" /></svg></button><Brand /></div>
      <nav className="sales-tabs" aria-label="Sales navigation">
        {salesTabs.map(t => <button key={t.page.name} className={activeTab === t.page.name ? "active" : ""} aria-current={activeTab === t.page.name ? "page" : undefined}
          onClick={() => { if (page.name !== t.page.name || t.page.name === "takeaway") onNavigate(t.page); }}
          {...(t.page.name === "tables" ? shortcutProps("tables") : t.page.name === "takeaway" ? { "data-shortcut": "new_order takeaway", "aria-keyshortcuts": [bindings.new_order, bindings.takeaway].filter(Boolean).join(" ") } : {})}
          title={t.page.name === "takeaway" ? shortcut("new_order", "Take a new takeaway order") : t.page.name === "tables" ? shortcut("tables", "Table View") : undefined}>{t.label}</button>)}
      </nav>
      <div className="sales-tools"><GetSupportButton /><ThemeToggle /><button className="sales-profile" aria-label={`Open menu for ${user.name}`} aria-haspopup="dialog" onClick={() => setMenuOpen(true)}><span className="avatar">{user.name.slice(0, 1).toUpperCase()}</span><span>{user.name}</span></button></div>
    </header>
    <WorkspaceDialog open={menuOpen} title="Menu" onClose={() => setMenuOpen(false)} className="sales-menu-dialog">
      <nav className="sales-menu-items" aria-label="Main navigation">
      {menuTabs.map((t) => (
        <button
          key={t.label}
          onClick={() => { setMenuOpen(false); onNavigate(t.page); }}
          disabled={activeTab === t.label}
          className={`nav-item ${activeTab === t.label ? "active" : ""}`}
          aria-current={activeTab === t.label ? "page" : undefined}
          aria-label={t.page.name === "reports" ? "Reports & Analytics" : t.label}
          title={t.page.name === "reports" ? "Reports & Analytics" : t.label}
        >
          <Icon name={t.label as IconName} /><span>{t.page.name === "reports" ? "Reports & Analytics" : t.label}</span>
        </button>
      ))}
      </nav>
      <div className="sales-menu-user"><strong>{user.name}</strong><span>{user.role}</span></div>
      <button className="nav-item logout" onClick={() => void logout()} title="Log out" aria-label="Log out">
        <Icon name="logout" /><span>Log out</span>
      </button>
    </WorkspaceDialog></>
  );
}
