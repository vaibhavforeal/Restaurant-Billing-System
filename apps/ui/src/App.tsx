import { useEffect, useState } from "react";
import { apiFetch, session, type User } from "./api";
import { NavBar, type Page } from "./NavBar";
import { Home } from "./screens/Home";
import { Login } from "./screens/Login";
import { Setup } from "./screens/Setup";

type State =
  | { kind: "loading" }
  | { kind: "setup" }
  | { kind: "login" }
  | { kind: "in"; user: User; page: Page };

export function App() {
  const [state, setState] = useState<State>({ kind: "loading" });

  useEffect(() => {
    void (async () => {
      try {
        const { needsSetup } = await apiFetch<{ needsSetup: boolean }>("/api/needs-setup");
        if (needsSetup) return setState({ kind: "setup" });
        if (session.token) {
          try {
            const { user } = await apiFetch<{ user: User }>("/api/me");
            return setState({ kind: "in", user, page: "home" });
          } catch {
            /* token expired — fall through to login */
          }
        }
        setState({ kind: "login" });
      } catch {
        setState({ kind: "login" }); // server down: login screen will show "Server unreachable"
      }
    })();
  }, []);

  switch (state.kind) {
    case "loading":
      return null;
    case "setup":
      return <Setup onDone={(user) => setState({ kind: "in", user, page: "home" })} />;
    case "login":
      return <Login onLogin={(user) => setState({ kind: "in", user, page: "home" })} />;
    case "in": {
      const { user, page } = state;
      const go = (next: Page) => setState({ kind: "in", user, page: next });
      return (
        <div>
          <NavBar user={user} page={page} onNavigate={go} onLogout={() => setState({ kind: "login" })} />
          {page === "home" && <Home user={user} onNavigate={go} />}
          {page === "catalog" && <p style={{ fontFamily: "system-ui", padding: 16 }}>Coming in this milestone.</p>}
          {page === "users" && <p style={{ fontFamily: "system-ui", padding: 16 }}>Coming in this milestone.</p>}
          {page === "settings" && <p style={{ fontFamily: "system-ui", padding: 16 }}>Coming in this milestone.</p>}
        </div>
      );
    }
  }
}
