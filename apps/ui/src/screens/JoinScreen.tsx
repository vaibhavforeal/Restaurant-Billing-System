import { useRef, useState, type FormEvent } from "react";
import type { DeviceJoined, DeviceKind, DeviceMe } from "@masalapos/domain";
import { normalizeJoinCode } from "@masalapos/domain/devices";
import { ApiError, apiFetch, session, type User } from "../api";
import { codeFromLocation } from "../join-code";
import { AuthLayout } from "./AuthLayout";
import { Login } from "./Login";

const message = (error: unknown) => error instanceof ApiError ? error.message : "Cannot reach the main POS. Check the restaurant network and try again.";

/**
 * All a browser sees until it is one of the restaurant's devices: a field for the join code an administrator made.
 * On the main POS PC there is one more way in, for when the main counter's own browser storage was cleared: an
 * administrator signs in and takes the main counter back without a code.
 */
export function JoinScreen({ me, onJoined }: { me: DeviceMe; onJoined: (kind: DeviceKind) => void }) {
  const [code, setCode] = useState(() => codeFromLocation(window.location));
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [mainPc, setMainPc] = useState<"closed" | "sign-in" | "confirm">("closed");
  const lock = useRef(false);

  async function run(work: () => Promise<void>) {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError("");
    try { await work(); }
    catch (e) { setError(message(e)); }
    finally { lock.current = false; setBusy(false); }
  }
  function join(e: FormEvent) {
    e.preventDefault();
    void run(async () => onJoined((await apiFetch<DeviceJoined>("/api/devices/join", { method: "POST", body: JSON.stringify({ code }) })).kind));
  }
  function signedIn(user: User) {
    if (user.role !== "admin") {
      session.clear(); setMainPc("closed"); setError("Only an administrator can re-join the main counter.");
      return;
    }
    // Signing in on the main PC already makes this browser the main counter when the restaurant has none.
    void run(async () => {
      const now = await apiFetch<DeviceMe>("/api/devices/me");
      if (now.joined && now.kind) onJoined(now.kind); else setMainPc("confirm");
    });
  }

  if (mainPc === "sign-in") return <>
    <Login onLogin={signedIn} />
    <p className="muted login-help" style={{ textAlign: "center" }}><button type="button" onClick={() => setMainPc("closed")}>Back to the join code</button></p>
  </>;

  return <AuthLayout>
    {mainPc === "confirm" ? <div className="auth-form">
      <h2>Re-join as main counter</h2>
      <p className="muted">This browser becomes the main counter again. The main counter's old browser will be signed out.</p>
      <div className="error-message" role="alert">{error}</div>
      <button type="button" className="primary" style={{ width: "100%" }} disabled={busy}
        onClick={() => void run(async () => onJoined((await apiFetch<DeviceJoined>("/api/devices/rejoin-main", { method: "POST" })).kind))}>
        {busy ? "Re-joining…" : "Re-join as main counter"}</button>
      <button type="button" disabled={busy} onClick={() => { session.clear(); setMainPc("closed"); setError(""); }}>Cancel</button>
    </div> : <form className="auth-form" onSubmit={join}>
      <h2>Enter join code</h2>
      <p className="muted">Ask an administrator for a code. On the main counter: Settings, Plan &amp; devices, Add a device.</p>
      <label>Join code<input aria-label="Join code" name="join-code" autoComplete="off" autoCapitalize="characters" autoCorrect="off" spellCheck={false} autoFocus maxLength={12}
        value={code} disabled={busy} onChange={(e) => { setCode(e.target.value.toUpperCase()); setError(""); }} /></label>
      <div className="error-message" role="alert">{error}</div>
      <button type="submit" className="primary" style={{ width: "100%" }} disabled={busy || !normalizeJoinCode(code)}>{busy ? "Joining…" : "Join"}</button>
      {me.mainPc && <button type="button" disabled={busy} onClick={() => { setError(""); setMainPc("sign-in"); }}>This is the main counter</button>}
    </form>}
  </AuthLayout>;
}
