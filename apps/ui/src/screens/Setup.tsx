import { useState, type FormEvent } from "react";
import { apiFetch, session, type User } from "../api";

export function Setup({ onDone }: { onDone: (user: User) => void }) {
  const [restaurantName, setRestaurantName] = useState("");
  const [adminName, setAdminName] = useState("");
  const [pin, setPin] = useState("");
  const [error, setError] = useState("");

  async function submit(e: FormEvent) {
    e.preventDefault();
    try {
      const { token, user } = await apiFetch<{ token: string; user: User }>("/api/setup", {
        method: "POST",
        body: JSON.stringify({ restaurantName, adminName, pin }),
      });
      session.set(token);
      onDone(user);
    } catch {
      setError("Setup failed — check the fields (PIN must be 4-6 digits)");
    }
  }

  return (
    <form onSubmit={submit} style={{ maxWidth: 320, margin: "10vh auto", display: "grid", gap: 12, fontFamily: "system-ui" }}>
      <h1>Set up ForkFlow</h1>
      <input placeholder="Restaurant name" value={restaurantName} onChange={(e) => setRestaurantName(e.target.value)} />
      <input placeholder="Your name (admin)" value={adminName} onChange={(e) => setAdminName(e.target.value)} />
      <input type="password" placeholder="Admin PIN (4-6 digits)" value={pin} inputMode="numeric" maxLength={6} onChange={(e) => setPin(e.target.value)} />
      <button type="submit" style={{ padding: 12 }}>Start</button>
      <div style={{ color: "crimson" }}>{error}</div>
    </form>
  );
}
