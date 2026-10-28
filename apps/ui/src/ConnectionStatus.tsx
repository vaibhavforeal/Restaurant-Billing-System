import { useEffect, useState } from "react";
import { discardRequest, queuedRequests, queueConnected, retryRequest, startQueue, subscribeQueue, type QueuedRequest } from "./retry-queue";
import { connectWs } from "./ws";
import { session } from "./api";
import { useShortcutLabels } from "./pos-shortcuts";
import { readOrderCopy } from "./offline-cache";
import { WorkspaceDialog } from "./WorkspaceDialog";

function age(since: number, now: number): string {
  const minutes = Math.floor((now - since) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min ago`;
}

/** Which order a saved action belongs to, in the words the counter uses, from this device's copy of the order. */
function orderOf(userId: string, entry: QueuedRequest): { id: string; label: string } | null {
  if (entry.lane.includes(":")) return null;
  const order = readOrderCopy(userId, entry.lane)?.order;
  if (!order) return { id: entry.lane, label: "Order" };
  return { id: order.id, label: order.type === "dine_in" ? `${order.tableLabel ?? order.tableName ?? "Table"} · ${order.splitLabel ?? "A"}` : order.orderTypeName ?? "Takeaway" };
}

export function ConnectionStatus({ userId, captain = false, onOpenOrder }: { userId: string; captain?: boolean; onOpenOrder?: (orderId: string) => void }) {
  const { bindings } = useShortcutLabels();
  const [, render] = useState(0);
  const [connected, setConnected] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  useEffect(() => {
    const unsubscribe = subscribeQueue(() => render((v) => v + 1));
    const stop = startQueue(userId);
    const disconnect = connectWs({ onEvent: () => {}, onStatus: setConnected, onAuthFail: () => session.clear() });
    // Keep ages current while the list is open.
    const timer = window.setInterval(() => render((v) => v + 1), 30000);
    return () => { unsubscribe(); stop(); disconnect(); window.clearInterval(timer); };
  }, [userId]);
  const entries = queuedRequests(userId);
  const online = connected && queueConnected();
  const attention = entries.filter((entry) => entry.status === "attention");
  if (online && entries.length === 0) return <aside className="pos-statusbar" aria-label="Connection and saved actions"><span className="pos-connected" role="status">● {captain ? "Connected to POS" : "Connected"} · All actions saved</span>{!captain && <span>{[[bindings.new_order, "New"], [bindings.save_items, "Punch"], [bindings.send_kitchen, "KOT"], [bindings.billing, "Billing"]].filter(([key]) => key).map(([key, label]) => `${key} ${label}`).join(" · ")}</span>}</aside>;
  const count = (n: number) => `${n} saved ${n === 1 ? "action" : "actions"}`;
  const summary = attention.length
    ? `${attention.length} saved ${attention.length === 1 ? "action needs" : "actions need"} review`
    : !online ? entries.length ? `Working offline · ${count(entries.length)}` : "Working offline · reconnecting to the server. Your work stays on this device."
    : `Sending ${count(entries.length)}…`;
  const now = Date.now();

  function discard(entry: QueuedRequest) {
    // An action that was tried may have reached the hub with only the reply lost.
    const warning = entry.attempts > 0
      ? `Discard "${entry.label}"?\n\nIt was tried ${entry.attempts} ${entry.attempts === 1 ? "time" : "times"} and may already have reached the server. Check the order after discarding. Discarded actions are never sent.`
      : `Discard "${entry.label}"? It will never be sent.`;
    if (window.confirm(warning)) discardRequest(entry.id);
  }

  return <aside className={`pos-statusbar pos-status-warning${attention.length ? " pos-status-attention" : ""}`} aria-label="Connection and saved actions">
    <strong role="status">{summary}</strong>
    {entries.length > 0 && <button type="button" aria-haspopup="dialog" onClick={() => setReviewing(true)}>Review saved actions</button>}
    <WorkspaceDialog open={reviewing && entries.length > 0} title="Saved actions" className="saved-actions-dialog" onClose={() => setReviewing(false)}>
      <p className="muted">These were saved on this device and are sent to the server in order, one order at a time. {online ? "The server is connected." : "The server cannot be reached right now; they will send when it is back."}</p>
      {attention.length > 0 && <section aria-label="Needs review"><h3>Needs review</h3><ul className="saved-actions-list">
        {attention.map((entry) => { const order = orderOf(userId, entry); return <li key={entry.id}>
          <div><strong>{entry.label}</strong>{order && <span className="muted"> · {order.label}</span>}<small>{entry.error}</small><small className="muted">Saved {age(entry.createdAt, now)}{entry.attempts ? ` · tried ${entry.attempts} ${entry.attempts === 1 ? "time" : "times"}` : ""}</small></div>
          <div className="saved-actions-buttons">
            <button type="button" onClick={() => retryRequest(entry.id)}>Retry</button>
            {order && onOpenOrder && <button type="button" onClick={() => { setReviewing(false); onOpenOrder(order.id); }}>Open order</button>}
            <button type="button" className="danger" onClick={() => discard(entry)}>Discard</button>
          </div>
        </li>; })}
      </ul></section>}
      {entries.length > attention.length && <section aria-label="Waiting to send"><h3>Waiting to send</h3><ul className="saved-actions-list">
        {entries.filter((entry) => entry.status !== "attention").map((entry) => { const order = orderOf(userId, entry); return <li key={entry.id}>
          <div><strong>{entry.label}</strong>{order && <span className="muted"> · {order.label}</span>}{entry.lastError && <small>Last problem: {entry.lastError}</small>}<small className="muted">Saved {age(entry.createdAt, now)}{entry.attempts ? ` · tried ${entry.attempts} ${entry.attempts === 1 ? "time" : "times"}` : ""}</small></div>
          {entry.attempts > 0 && <div className="saved-actions-buttons"><button type="button" onClick={() => retryRequest(entry.id)}>Try now</button></div>}
        </li>; })}
      </ul></section>}
    </WorkspaceDialog>
  </aside>;
}
