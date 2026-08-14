import type { Page } from "../NavBar";
import type { User } from "../api";

const tile = { padding: 20, fontSize: 18 } as const;

export function Home({ user, onNavigate }: { user: User; onNavigate: (page: Page) => void }) {
  const isAdmin = user.role === "admin";
  return (
    <div style={{ maxWidth: 480, margin: "8vh auto", textAlign: "center", fontFamily: "system-ui" }}>
      <p>
        Signed in as <strong>{user.name}</strong> ({user.role})
      </p>
      {isAdmin ? (
        <div style={{ display: "grid", gap: 12 }}>
          <button style={tile} onClick={() => onNavigate("catalog")}>Catalog</button>
          <button style={tile} onClick={() => onNavigate("users")}>Users</button>
          <button style={tile} onClick={() => onNavigate("settings")}>Settings</button>
        </div>
      ) : (
        <p>Ordering and billing arrive in Milestones 3-4.</p>
      )}
    </div>
  );
}
