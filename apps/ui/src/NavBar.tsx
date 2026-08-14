import { apiFetch, session, type User } from "./api";

export type Page = "home" | "catalog" | "users" | "settings";

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

  const isAdmin = user.role === "admin";
  const tabs: Page[] = isAdmin ? ["home", "catalog", "users", "settings"] : ["home"];

  return (
    <nav style={{ display: "flex", gap: 8, alignItems: "center", padding: 8, borderBottom: "1px solid #ddd", fontFamily: "system-ui" }}>
      <strong style={{ marginRight: 8 }}>ForkFlow</strong>
      {tabs.map((t) => (
        <button key={t} onClick={() => onNavigate(t)} disabled={page === t} style={{ padding: "6px 12px", textTransform: "capitalize" }}>
          {t}
        </button>
      ))}
      <span style={{ marginLeft: "auto" }}>{user.name}</span>
      <button onClick={() => void logout()} style={{ padding: "6px 12px" }}>Log out</button>
    </nav>
  );
}
