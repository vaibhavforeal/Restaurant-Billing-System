import { useEffect, useState } from "react";
import { apiFetch, session, type User } from "./api";
import { Home } from "./screens/Home";
import { Login } from "./screens/Login";
import { Setup } from "./screens/Setup";

type State =
  | { kind: "loading" }
  | { kind: "setup" }
  | { kind: "login" }
  | { kind: "home"; user: User };

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
            return setState({ kind: "home", user });
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
      return <Setup onDone={(user) => setState({ kind: "home", user })} />;
    case "login":
      return <Login onLogin={(user) => setState({ kind: "home", user })} />;
    case "home":
      return <Home user={state.user} onLogout={() => setState({ kind: "login" })} />;
  }
}
