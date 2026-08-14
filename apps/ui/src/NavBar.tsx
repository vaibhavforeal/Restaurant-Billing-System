import { apiFetch, session, type User } from "./api";

export type Page =
  | { name: "home" }
  | { name: "tables" }
  | { name: "order"; orderId: string }
  | { name: "kitchen" }
  | { name: "catalog" }
  | { name: "users" }
  | { name: "settings" };

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
          { page: { name: "kitchen" }, label: "kitchen" },
          { page: { name: "catalog" }, label: "catalog" },
          { page: { name: "users" }, label: "users" },
          { page: { name: "settings" }, label: "settings" },
        ]
      : user.role === "cashier"
        ? [
            { page: { name: "home" }, label: "home" },
            { page: { name: "tables" }, label: "tables" },
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
    <nav style={{ display: "flex", gap: 8, alignItems: "center", padding: 8, borderBottom: "1px solid #ddd", fontFamily: "system-ui" }}>
      <strong style={{ marginRight: 8 }}>ForkFlow</strong>
      {tabs.map((t) => (
        <button
          key={t.label}
          onClick={() => onNavigate(t.page)}
          disabled={activeTab === t.label}
          style={{ padding: "6px 12px", textTransform: "capitalize" }}
        >
          {t.label}
        </button>
      ))}
      <span style={{ marginLeft: "auto" }}>{user.name}</span>
      <button onClick={() => void logout()} style={{ padding: "6px 12px" }}>
        Log out
      </button>
    </nav>
  );
}
