import { useRef, useState } from "react";
import { ApiError, apiFetch, session, type User } from "../api";
import { AuthLayout } from "./AuthLayout";

export function Login({ onLogin }: { onLogin: (user: User) => void }) {
  const [pin, setPin] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  async function submit(candidate: string) {
    if (lock.current) return;
    if (!/^\d{4,6}$/.test(candidate)) { setError("Enter your 4–6 digit staff PIN."); return; }
    lock.current = true; setBusy(true); setError("");
    try {
      const { token, user } = await apiFetch<{ token: string; user: User }>("/api/login", { method: "POST", body: JSON.stringify({ pin: candidate }) });
      session.set(token); onLogin(user);
    } catch (e) { setError(e instanceof ApiError ? e.status === 401 ? "Wrong PIN. Please try again." : e.message : "Server unreachable. Please try again."); setPin(""); }
    finally { lock.current = false; setBusy(false); }
  }
  function press(digit: string) {
    if (busy || pin.length >= 6) return;
    setError(""); const next = pin + digit; setPin(next);
    if (next.length === 6) void submit(next);
  }
  return <AuthLayout><form className="auth-form" onSubmit={(e) => { e.preventDefault(); void submit(pin); }}>
    <h2>Sign in</h2>
    <label>Staff PIN<input className="pin-input" aria-label="Staff PIN" type="password" inputMode="numeric" autoComplete="off" maxLength={6} value={pin} disabled={busy} onChange={(e) => { setPin(e.target.value.replace(/\D/g, "")); setError(""); }} /></label>
    <div className="error-message" role="alert">{error}</div>
    <div className="pin-pad">{["1", "2", "3", "4", "5", "6", "7", "8", "9", "⌫", "0", "OK"].map((key) => <button key={key} type="button" disabled={busy} className={key === "OK" ? "primary" : ""} aria-label={key === "⌫" ? "Delete last digit" : key} onClick={() => { if (key === "⌫") setPin((p) => p.slice(0, -1)); else if (key === "OK") void submit(pin); else press(key); }}>{key}</button>)}</div>
  </form></AuthLayout>;
}
