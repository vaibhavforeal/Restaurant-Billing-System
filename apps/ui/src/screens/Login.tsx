import { useRef, useState, type FormEvent } from "react";
import { ApiError, apiFetch, session, type User } from "../api";
import { AuthLayout } from "./AuthLayout";
import { CaptainInstall } from "../CaptainInstall";
import "../login.css";

/** Everyone signs in with their username and password; an admin's PIN is only for approving at the counter. */
export function Login({ onLogin, captain = false, kitchen = false }: { onLogin: (user: User) => void; captain?: boolean; kitchen?: boolean }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const passwordField = useRef<HTMLInputElement>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (lock.current) return;
    if (!username.trim() || !password) { setError("Enter your username and password."); return; }
    lock.current = true; setBusy(true); setError("");
    try {
      const { token, user } = await apiFetch<{ token: string; user: User }>("/api/login", { method: "POST", body: JSON.stringify({ username: username.trim(), password }) });
      session.set(token); onLogin(user);
    } catch (err) {
      setError(err instanceof ApiError ? err.status === 401 ? "Wrong username or password. Please try again." : err.message : "Server unreachable. Please try again.");
      setPassword(""); passwordField.current?.focus();
    }
    finally { lock.current = false; setBusy(false); }
  }
  return <AuthLayout><form className="auth-form" onSubmit={submit}>
    <h2>{kitchen ? "Kitchen sign in" : captain ? "Captain sign in" : "Sign in"}</h2>
    {kitchen && <p className="muted">Use the kitchen staff username and password created on the main POS.</p>}
    <label>Username<input aria-label="Username" name="username" autoComplete="username" autoCapitalize="none" spellCheck={false} autoFocus maxLength={64}
      value={username} disabled={busy} onChange={(e) => { setUsername(e.target.value); setError(""); }} /></label>
    <label>Password<input ref={passwordField} aria-label="Password" name="password" type={showPassword ? "text" : "password"} autoComplete="current-password" maxLength={128}
      value={password} disabled={busy} onChange={(e) => { setPassword(e.target.value); setError(""); }} /></label>
    <label className="login-show-password"><input type="checkbox" checked={showPassword} onChange={(e) => setShowPassword(e.target.checked)} /> Show password</label>
    <div className="error-message" role="alert">{error}</div>
    <button type="submit" className="primary" style={{ width: "100%" }} disabled={busy}>{busy ? "Signing in…" : "Sign in"}</button>
    <p className="muted login-help">Forgot your password? Ask an admin to reset it from Users.</p>
  </form>{captain && <CaptainInstall />}</AuthLayout>;
}
