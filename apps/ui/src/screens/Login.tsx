import { useState } from "react";
import { ApiError, apiFetch, session, type User } from "../api";

export function Login({ onLogin }: { onLogin: (user: User) => void }) {
  const [pin, setPin] = useState("");
  const [error, setError] = useState("");

  async function submit(candidate: string) {
    try {
      const { token, user } = await apiFetch<{ token: string; user: User }>("/api/login", {
        method: "POST",
        body: JSON.stringify({ pin: candidate }),
      });
      session.set(token);
      onLogin(user);
    } catch (e) {
      setError(e instanceof ApiError && e.status === 401 ? "Wrong PIN" : "Server unreachable");
      setPin("");
    }
  }

  function press(digit: string) {
    setError("");
    const next = pin + digit;
    setPin(next);
    if (next.length === 6) void submit(next);
  }

  return (
    <div style={{ maxWidth: 280, margin: "10vh auto", textAlign: "center", fontFamily: "system-ui" }}>
      <h1>ForkFlow</h1>
      <div style={{ fontSize: 32, letterSpacing: 8, minHeight: 44 }}>{"•".repeat(pin.length)}</div>
      <div style={{ color: "crimson", minHeight: 24 }}>{error}</div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8 }}>
        {["1", "2", "3", "4", "5", "6", "7", "8", "9", "⌫", "0", "OK"].map((key) => (
          <button
            key={key}
            style={{ padding: "18px 0", fontSize: 22 }}
            onClick={() => {
              if (key === "⌫") setPin((p) => p.slice(0, -1));
              else if (key === "OK") void submit(pin);
              else press(key);
            }}
          >
            {key}
          </button>
        ))}
      </div>
    </div>
  );
}
