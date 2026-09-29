import { useRef, useState, type FormEvent } from "react";
import { apiFetch, session, type User } from "../api";
import { AuthLayout } from "./AuthLayout";

export function Setup({ onDone }: { onDone: (user: User) => void }) {
  const [restaurantName, setRestaurantName] = useState("");
  const [adminName, setAdminName] = useState("");
  const [pin, setPin] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  async function submit(e: FormEvent) {
    e.preventDefault(); if (lock.current) return;
    lock.current = true; setBusy(true);
    try {
      const { token, user } = await apiFetch<{ token: string; user: User }>("/api/setup", { method: "POST", body: JSON.stringify({ restaurantName, adminName, pin }) });
      session.set(token); onDone(user);
    } catch { setError("Setup failed. Check the fields and use a 4–6 digit PIN."); }
    finally { lock.current = false; setBusy(false); }
  }
  return <AuthLayout><form onSubmit={submit} className="auth-form"><h2>Set up ForkFlow</h2>
    <label>Restaurant name<input required placeholder="Restaurant name" value={restaurantName} onChange={(e) => setRestaurantName(e.target.value)} disabled={busy} /></label>
    <label>Your name<input required placeholder="Your name (admin)" value={adminName} onChange={(e) => setAdminName(e.target.value)} disabled={busy} /></label>
    <label>Admin PIN<input required type="password" placeholder="Admin PIN (4-6 digits)" value={pin} inputMode="numeric" pattern="[0-9]{4,6}" maxLength={6} onChange={(e) => setPin(e.target.value)} disabled={busy} /></label>
    <div className="error-message" role="alert">{error}</div><button type="submit" className="primary" style={{ width: "100%" }} disabled={busy}>{busy ? "Setting up…" : "Start"}</button>
  </form></AuthLayout>;
}
