import { useState } from "react";
import type { FormEvent } from "react";
import { api, message } from "./api";
import type { Session } from "./api";
import { Field, Notice } from "./shared";
import { accountActionFromUrl } from "./auth-links";

type AuthMode = "login" | "request" | "reset" | "invite";
const initial = accountActionFromUrl(location.href);
export const hasAccountAction = initial.mode === "invite" || initial.mode === "reset";
// Remove one-use credentials from browser history before any subsequent navigation.
if (initial.token) history.replaceState(null, "", location.pathname);
export function Auth({ onSession }: { onSession: (session: Session) => void }) {
  const [mode, setMode] = useState<AuthMode>(initial.mode), [email, setEmail] = useState(""), [password, setPassword] = useState(""), [confirm, setConfirm] = useState(""), [token, setToken] = useState(initial.token);
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const title = mode === "login" ? "Welcome back" : mode === "request" ? "Reset your password" : mode === "invite" ? "Set up your owner account" : "Choose a new password";
  async function submit(event: FormEvent) {
    event.preventDefault(); setError(""); setNotice("");
    if ((mode === "invite" || mode === "reset") && password !== confirm) { setError("The passwords do not match."); return; }
    setBusy(true);
    try {
      if (mode === "login") { await api.post<Session>("/auth/login", { email, password }); onSession(await api.request<Session>("/auth/me")); }
      else if (mode === "request") { await api.post("/auth/reset/request", { email }); setNotice("If an account exists for that email, a password reset link has been sent. Check your inbox."); }
      else { await api.post(`/auth/${mode}/consume`, { token, password }); setPassword(""); setConfirm(""); setToken(""); setMode("login"); history.replaceState(null, "", import.meta.env.BASE_URL); setNotice(mode === "invite" ? "Invitation accepted. Sign in with your account password. Existing accounts keep their current password." : "Your password is saved. Sign in to continue."); }
    } catch (caught) { setError(message(caught)); }
    finally { setBusy(false); }
  }
  return <main className="auth-layout"><aside className="auth-brand"><a className="brand" href="/">ForkFlow<span>OWNER PORTAL</span></a><div><p className="eyebrow">YOUR RESTAURANT, IN VIEW</p><h1>Stay close.<br />From anywhere.</h1><p>Review your outlets, understand sales, and send changes to your restaurant.</p></div><p className="auth-footnote">Your outlet keeps running when the internet is unavailable. Cloud reports show the latest uploaded records.</p></aside><section className="auth-form"><div className="auth-card"><p className="eyebrow">FORKFLOW CLOUD</p><h2>{title}</h2><p className="muted">{mode === "login" ? "Sign in with the email used for your invitation." : "Use your personal account email. Restaurant staff PINs are used only at the outlet."}</p><Notice error={error}>{notice}</Notice><form onSubmit={event => void submit(event)}>{(mode === "login" || mode === "request") && <Field label="Email address"><input type="email" autoComplete="username" required value={email} onChange={event => setEmail(event.target.value)} /></Field>}{(mode === "invite" || mode === "reset") && !initial.token && <Field label="One-time token from your email"><input required value={token} onChange={event => setToken(event.target.value)} /></Field>}{mode !== "request" && <Field label="Password"><input type="password" autoComplete={mode === "login" ? "current-password" : "new-password"} minLength={mode === "login" ? 1 : 12} required value={password} onChange={event => setPassword(event.target.value)} /></Field>}{(mode === "invite" || mode === "reset") && <><small className="muted">Use at least 12 characters.</small><Field label="Confirm password"><input type="password" autoComplete="new-password" required value={confirm} onChange={event => setConfirm(event.target.value)} /></Field></>}<button className="primary full" disabled={busy}>{busy ? "Please wait…" : mode === "login" ? "Sign in" : mode === "request" ? "Send reset link" : "Save password"}</button></form><button className="text-button" disabled={busy} onClick={() => { setMode(mode === "login" ? "request" : "login"); setError(""); setNotice(""); }}>{mode === "login" ? "Forgot your password?" : "Back to sign in"}</button><p className="muted small">Accounts are invitation-only. Contact your restaurant owner or ForkFlow support if you need access.</p></div></section></main>;
}
