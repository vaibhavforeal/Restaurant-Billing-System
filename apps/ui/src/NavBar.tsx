import { apiFetch, session, type User } from "./api";
import { Brand, Icon, type IconName } from "./Icon";

export type Page =
  | { name: "home" }
  | { name: "tables" }
  | { name: "order"; orderId: string }
  | { name: "kitchen" }
  | { name: "catalog" }
  | { name: "users" }
  | { name: "settings" }
  | { name: "bills" }
  | { name: "reports" }
  | { name: "inventory" };
// Billing and reports use the existing cashier/admin permissions.

export function NavBar({
  user,
  page,
  onNavigate,
  onLogout,
}: {
  user: User;
  page: Page;
  onNavigate: (page: Page) => void;
  onLogout: () => void;
}) {
  async function logout() {
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
          { page: { name: "bills" }, label: "bills" },
          { page: { name: "reports" }, label: "reports" },
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
            { page: { name: "bills" }, label: "bills" },
            { page: { name: "reports" }, label: "reports" },
            { page: { name: "inventory" }, label: "inventory" },
            { page: { name: "kitchen" }, label: "kitchen" },
          ]
        : user.role === "waiter"
          ? [
              { page: { name: "home" }, label: "home" },
              { page: { name: "tables" }, label: "tables" },
            ]
          : [{ page: { name: "kitchen" }, label: "kitchen" }]; // kitchen role

  // "order" page highlights tables tab
  const activeTab = page.name === "order" ? "tables" : page.name;

  return (
    <nav className="sidebar" aria-label="Main navigation">
      <Brand />
      <div className="nav-items">
      {tabs.map((t) => (
        <button
          key={t.label}
          onClick={() => onNavigate(t.page)}
          disabled={activeTab === t.label}
          className={`nav-item ${activeTab === t.label ? "active" : ""}`}
          aria-current={activeTab === t.label ? "page" : undefined}
          aria-label={t.label}
          title={t.label}
        >
          <Icon name={t.label as IconName} /><span>{t.label}</span>
        </button>
      ))}
      </div>
      <div className="sidebar-footer"><span className="avatar">{user.name.slice(0, 1).toUpperCase()}</span><div><strong>{user.name}</strong><small>{user.role}</small></div></div>
      <button className="nav-item logout" onClick={() => void logout()} title="Log out" aria-label="Log out">
        <Icon name="logout" /><span>Log out</span>
      </button>
    </nav>
  );
}
