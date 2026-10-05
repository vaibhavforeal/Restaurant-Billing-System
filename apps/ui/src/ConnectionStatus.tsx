import { useEffect, useState } from "react";
import { discardRequest, queuedRequests, queueConnected, startQueue, subscribeQueue } from "./retry-queue";
import { connectWs } from "./ws";
import { session } from "./api";
import { useShortcutLabels } from "./pos-shortcuts";

export function ConnectionStatus({ userId, captain = false }: { userId: string; captain?: boolean }) {
  const { bindings } = useShortcutLabels();
  const [, render] = useState(0);
  const [connected, setConnected] = useState(false);
  useEffect(() => {
    const unsubscribe = subscribeQueue(() => render((v) => v + 1));
    const stop = startQueue(userId);
    const disconnect = connectWs({ onEvent: () => {}, onStatus: setConnected, onAuthFail: () => session.clear() });
    return () => { unsubscribe(); stop(); disconnect(); };
  }, [userId]);
  const entries = queuedRequests(userId);
  if (connected && queueConnected() && entries.length === 0) return <aside className="pos-statusbar" aria-label="Connection and saved actions"><span className="pos-connected" role="status">● {captain ? "Connected to POS" : "Connected"} · All actions saved</span>{!captain && <span>{[[bindings.new_order, "New"], [bindings.save_items, "Punch"], [bindings.send_kitchen, "KOT"], [bindings.billing, "Billing"]].filter(([key]) => key).map(([key, label]) => `${key} ${label}`).join(" · ")}</span>}</aside>;
  return <aside className="pos-statusbar pos-status-warning" aria-label="Connection and saved actions">
    <strong role="status">{connected && queueConnected() ? "Saved actions" : "Reconnecting to the server… Your cart stays on this device."}</strong>
    {entries.length > 0 && <ul>{entries.map((entry) => <li key={entry.id}>{entry.label}: {entry.error ? `Needs review — ${entry.error}` : "Saved; will send when connected"}
      {entry.error && <button onClick={() => discardRequest(entry.id)} style={{ marginLeft: 12 }}>Dismiss and review order</button>}
    </li>)}</ul>}
  </aside>;
}
