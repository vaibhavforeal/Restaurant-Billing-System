import type { Page } from "../NavBar";
import type { User } from "../api";

const tile = { padding: 20, fontSize: 18 } as const;

export function Home({ user, onNavigate }: { user: User; onNavigate: (page: Page) => void }) {
  // Non-kitchen roles see Tables tile
  const showTables = user.role !== "kitchen";
  // Admin/cashier see Kitchen tile
  const showKitchen = user.role === "admin" || user.role === "cashier";
  // Admin sees catalog/users/settings tiles
  const isAdmin = user.role === "admin";

  return (
    <div style={{ maxWidth: 480, margin: "8vh auto", textAlign: "center", fontFamily: "system-ui" }}>
      <p>
        Signed in as <strong>{user.name}</strong> ({user.role})
      </p>
      <div style={{ display: "grid", gap: 12 }}>
        {showTables && (
          <button style={tile} onClick={() => onNavigate({ name: "tables" })}>
            Tables
          </button>
        )}
        {showKitchen && (
          <button style={tile} onClick={() => onNavigate({ name: "kitchen" })}>
            Kitchen
          </button>
        )}
        {isAdmin && (
          <>
            <button style={tile} onClick={() => onNavigate({ name: "catalog" })}>
              Catalog
            </button>
            <button style={tile} onClick={() => onNavigate({ name: "users" })}>
              Users
            </button>
            <button style={tile} onClick={() => onNavigate({ name: "settings" })}>
              Settings
            </button>
          </>
        )}
      </div>
    </div>
  );
}
