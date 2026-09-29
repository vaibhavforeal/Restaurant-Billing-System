import { useEffect, useState } from "react";
import { discardRequest, queuedRequests, queueConnected, startQueue, subscribeQueue } from "./retry-queue";
import { connectWs } from "./ws";
import { session } from "./api";

export function ConnectionStatus({ userId }: { userId: string }) {
  const [, render] = useState(0);
  const [connected, setConnected] = useState(false);
  useEffect(() => {
    const unsubscribe = subscribeQueue(() => render((v) => v + 1));
    const stop = startQueue(userId);
    const disconnect = connectWs({ onEvent: () => {}, onStatus: setConnected, onAuthFail: () => session.clear() });
    return () => { unsubscribe(); stop(); disconnect(); };
  }, [userId]);
  const entries = queuedRequests(userId);
  if (connected && queueConnected() && entries.length === 0) return null;
  return <aside aria-label="Connection and saved actions" style={{ padding: 12, background: "#fff4d6", borderBottom: "1px solid #cba35a" }}>
    <strong role="status">{connected && queueConnected() ? "Saved actions" : "Reconnecting to the server… Your cart stays on this device."}</strong>
    {entries.length > 0 && <ul>{entries.map((entry) => <li key={entry.id}>{entry.label}: {entry.error ? `Needs review — ${entry.error}` : "Saved; will send when connected"}
      {entry.error && <button onClick={() => discardRequest(entry.id)} style={{ marginLeft: 12 }}>Dismiss and review order</button>}
    </li>)}</ul>}
  </aside>;
}
