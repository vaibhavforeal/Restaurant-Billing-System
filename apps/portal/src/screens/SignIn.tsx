import { useState, type FormEvent } from "react";
import type { StaffUser } from "../../../licensing-worker/src/portal/api-types";
import { post } from "../api";
import { Mark } from "../icons";
import { Field, useRun } from "../ui";

export function SignIn({ onSignedIn }: { onSignedIn: (user: StaffUser) => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const { busy, run, status } = useRun();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => onSignedIn((await post<{ user: StaffUser }>("/login", { email, password })).user));
  };
  return <main className="signin"><div className="signin-card">
    <div className="brand"><Mark /><div>ForkFlow Portal<small>Staff sign-in</small></div></div>
    <h1>Sign in</h1>
    <p className="muted">Customers, orders, licences and support for ForkFlow.</p>
    <form onSubmit={submit}>
      <Field label="Email"><input type="email" autoComplete="username" required autoFocus value={email} onChange={(e) => setEmail(e.target.value)} disabled={busy} /></Field>
      <Field label="Password"><input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} disabled={busy} /></Field>
      {status}
      <button className="primary" disabled={busy}>{busy ? "Signing in…" : "Sign in"}</button>
    </form>
  </div></main>;
}

/** Changing one's own password; required straight after signing in with a temporary one. */
export function ChangePassword({ forced, onDone }: { forced?: boolean; onDone: (user: StaffUser) => void }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const { busy, run, status, setError } = useRun();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (next !== again) { setError("The new passwords don't match."); return; }
    void run(async () => onDone((await post<{ user: StaffUser }>("/password", { current, next })).user), "Your password is changed.");
  };
  const form = <form onSubmit={submit} className="stack" style={{ maxWidth: 380 }}>
    <Field label={forced ? "Temporary password" : "Current password"}><input type="password" autoComplete="current-password" required value={current} onChange={(e) => setCurrent(e.target.value)} disabled={busy} /></Field>
    <Field label="New password" hint="At least 10 characters. Your other sign-ins end when you change it."><input type="password" autoComplete="new-password" required minLength={10} value={next} onChange={(e) => setNext(e.target.value)} disabled={busy} /></Field>
    <Field label="New password again"><input type="password" autoComplete="new-password" required minLength={10} value={again} onChange={(e) => setAgain(e.target.value)} disabled={busy} /></Field>
    {status}
    <div><button className="primary" disabled={busy}>{busy ? "Saving…" : "Change password"}</button></div>
  </form>;
  if (!forced) return form;
  return <main className="signin"><div className="signin-card">
    <div className="brand"><Mark /><div>ForkFlow Portal<small>First sign-in</small></div></div>
    <h1>Choose your password</h1>
    <p className="muted">You signed in with a temporary password. Choose your own before you continue.</p>
    {form}
  </div></main>;
}
