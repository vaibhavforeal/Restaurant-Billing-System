import { apiFetch, session, type User } from "./api";
import { Brand, Icon, type IconName } from "./Icon";
import { ThemeToggle } from "./ThemeToggle";
import { readPreference, useShortcutLabels } from "./pos-shortcuts";

export type Page =
  | { name: "home" }
  | { name: "tables"; qrInbox?: number }
  | { name: "takeaway" }
  | { name: "order"; orderId: string }
  | { name: "kitchen" }
  | { name: "catalog" }
  | { name: "users" }
  | { name: "settings" }
  | { name: "bills" }
  | { name: "zomato" }
  | { name: "reports"; tab?: "sales" | "collections" | "day-end" | "analytics" | "bills"; period?: { from: string; to: string } }
  | { name: "inventory" };
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
  const { shortcut, shortcutProps } = useShortcutLabels();
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

  // Role→tab matrix per contracts
  const tabs: Array<{ page: Page; label: string }> =
    user.role === "admin"
      ? [
          { page: { name: "home" }, label: "home" },
          { page: { name: "tables" }, label: "tables" },
          { page: { name: "reports" }, label: "reports" },
          { page: { name: "zomato" }, label: "zomato" },
          { page: { name: "inventory" }, label: "inventory" },
          { page: { name: "kitchen" }, label: "kitchen" },
          { page: { name: "catalog" }, label: "catalog" },
          { page: { name: "users" }, label: "users" },
          { page: { name: "settings" }, label: "settings" },
        ]
      : user.role === "cashier"
        ? [
            { page: { name: "home" }, label: "home" },
            { page: { name: "tables" }, label: "tables" },
            { page: { name: "reports" }, label: "reports" },
            { page: { name: "zomato" }, label: "zomato" },
            { page: { name: "inventory" }, label: "inventory" },
            { page: { name: "kitchen" }, label: "kitchen" },
          ]
        : user.role === "waiter"
          ? [
              { page: { name: "home" }, label: "home" },
              { page: { name: "tables" }, label: "tables" },
            ]
          : [{ page: { name: "kitchen" }, label: "kitchen" }]; // kitchen role

  // Order and takeaway pages belong to tables and orders.
  const activeTab = page.name === "order" || page.name === "takeaway" ? "tables" : page.name === "bills" ? "reports" : page.name;

  return (
    <nav className="sidebar" aria-label="Main navigation">
      <Brand />
      {user.role !== "kitchen" && <button className="pos-new-order" {...shortcutProps("new_order")} title={shortcut("new_order", "New order")} onClick={() => onNavigate({ name: user.role !== "waiter" && readPreference("forkflow.order-type") === "parcel" ? "takeaway" : "tables" })}><Icon name="plus" size={16} /><span>New</span></button>}
      <div className="nav-items">
      {tabs.map((t) => (
        <button
          key={t.label}
          onClick={() => onNavigate(t.page)}
          disabled={activeTab === t.label}
          className={`nav-item ${activeTab === t.label ? "active" : ""}`}
          aria-current={activeTab === t.label ? "page" : undefined}
          aria-label={t.page.name === "reports" ? "Reports & Analytics" : t.label}
          {...(t.page.name === "tables" ? shortcutProps("tables") : {})}
          title={t.page.name === "tables" ? shortcut("tables", "Tables") : t.page.name === "reports" ? "Reports & Analytics" : t.label}
        >
          <Icon name={t.label === "zomato" ? "bag" : t.label as IconName} /><span>{t.page.name === "reports" ? "Reports & Analytics" : t.label}</span>
        </button>
      ))}
      </div>
      <ThemeToggle />
      <div className="sidebar-footer"><span className="avatar">{user.name.slice(0, 1).toUpperCase()}</span><div><strong>{user.name}</strong><small>{user.role}</small></div></div>
      <button className="nav-item logout" onClick={() => void logout()} title="Log out" aria-label="Log out">
        <Icon name="logout" /><span>Log out</span>
      </button>
    </nav>
  );
}
