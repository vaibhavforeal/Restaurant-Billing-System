import { apiFetch, session, type User } from "../api";

export function Home({ user, onLogout }: { user: User; onLogout: () => void }) {
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

  return (
    <div style={{ maxWidth: 480, margin: "10vh auto", textAlign: "center", fontFamily: "system-ui" }}>
      <h1>ForkFlow</h1>
      <p>
        Signed in as <strong>{user.name}</strong> ({user.role})
      </p>
      <p>Milestone 1 foundation — modules arrive in Milestones 2-5.</p>
      <button onClick={() => void logout()} style={{ padding: 12 }}>Log out</button>
    </div>
  );
}
