import { outletStorage } from "./outlet-identity";
import { useEffect, useState } from "react";
import { discardRequest, queuedRequests, queueConnected, recoveryRequests, startQueue, subscribeQueue } from "./retry-queue";
import { connectWs } from "./ws";
import { apiFetch, session } from "./api";
import { useShortcutLabels } from "./pos-shortcuts";

export function ConnectionStatus({ userId, captain = false }: { userId: string; captain?: boolean }) {
  const { bindings } = useShortcutLabels();
  const [, render] = useState(0);
  const [connected, setConnected] = useState(false);
  const [reviewStatus, setReviewStatus] = useState("");
  useEffect(() => {
    const unsubscribe = subscribeQueue(() => render((v) => v + 1));
    const stop = startQueue(userId);
    const disconnect = connectWs({ onEvent: () => {}, onStatus: setConnected, onAuthFail: () => session.clear() });
    return () => { unsubscribe(); stop(); disconnect(); };
  }, [userId]);
  const entries = queuedRequests(userId);
  const recoveries = recoveryRequests(userId);
  const review = async (entry: { id: string; path: string }, message: string) => {
    window.dispatchEvent(new CustomEvent("forkflow:queue-review", { detail: { requestId: entry.id, path: entry.path, message } }));
    const token = session.token, generation = outletStorage.getItem("forkflow.generation");
    const resource = entry.path.match(/^\/api\/(orders|bills)\/([^/]+)\//);
    if (!resource) return;
    try {
      await apiFetch(`/api/${resource[1]}/${resource[2]}`);
      if (session.token === token && outletStorage.getItem("forkflow.generation") === generation) setReviewStatus("Current server state refreshed. Review the order before another attempt.");
    } catch { if (session.token === token && outletStorage.getItem("forkflow.generation") === generation) setReviewStatus("Could not refresh the order yet. Reconnect before reviewing this action."); }
  };
  if (connected && queueConnected() && entries.length === 0 && recoveries.length === 0) return <aside className="pos-statusbar" aria-label="Connection and saved actions"><span className="pos-connected" role="status">● {captain ? "Connected to POS" : "Connected"} · All actions saved</span>{!captain && <span>{[[bindings.new_order, "New"], [bindings.save_items, "Punch"], [bindings.send_kitchen, "KOT"], [bindings.billing, "Billing"]].filter(([key]) => key).map(([key, label]) => `${key} ${label}`).join(" · ")}</span>}</aside>;
  return <aside className="pos-statusbar pos-status-warning" aria-label="Connection and saved actions">
    <strong role="status">{connected && queueConnected() ? "Saved actions" : "Reconnecting to the server… Your cart stays on this device."}</strong>
    {entries.length > 0 && <ul>{entries.map((entry) => <li key={entry.id}>{entry.label}: {recoveries.some((record) => record.entry.id === entry.id) ? "Needs review before another attempt" : entry.error ? `Needs review — ${entry.error}` : "Saved; will send when connected"}
      {entry.error && <button onClick={() => { discardRequest(entry.id); void review(entry, "Review the current order before trying again."); }} style={{ marginLeft: 12 }}>Dismiss and review order</button>}
    </li>)}</ul>}
    {recoveries.length > 0 && <ul>{recoveries.map(({ entry, reason }) => <li key={entry.id}>{entry.label}: {reason} <button onClick={() => void review(entry, reason)}>Review current order</button></li>)}</ul>}
    {reviewStatus && <p role="status">{reviewStatus}</p>}
  </aside>;
}
