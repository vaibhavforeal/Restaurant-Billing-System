import { useEffect, useRef, useState } from "react";
import { apiFetch, session } from "../api";
import type { Kot, KotWithContext } from "../types";
import { connectWs } from "../ws";
import { Icon } from "../Icon";

export function Kitchen({ standalone = false, onBusyChange }: { standalone?: boolean; onBusyChange?: (busy: boolean) => void }) {
  const [kots, setKots] = useState<KotWithContext[]>([]);
  const [connected, setConnected] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [busyIds, setBusyIds] = useState<Set<string>>(() => new Set());
  const actionLocks = useRef(new Set<string>());
  const reloadRevision = useRef(0);
  const [, setTick] = useState(0); // force re-render for age updates

  async function reload() {
    const revision = ++reloadRevision.current;
    try {
      const { kots } = await apiFetch<{ kots: KotWithContext[] }>("/api/kots");
      if (revision === reloadRevision.current) { setKots(kots); setLoaded(true); setLoadError(""); setLastUpdated(Date.now()); }
    } catch (error) {
      if (revision === reloadRevision.current) setLoadError(error instanceof Error ? error.message : "Could not refresh tickets.");
    }
  }

  useEffect(() => {
    void reload().catch(() => {});
    const dispose = connectWs({
      onEvent: (event) => {
        if (event === "kot.created" || event === "kot.updated" || event === "order.updated") void reload().catch(() => {});
      },
      onStatus: (c) => { setConnected(c); if (c) void reload().catch(() => {}); },
      onAuthFail: () => session.clear(),
    });
    const ageInterval = setInterval(() => setTick((t) => t + 1), 30000);
    const refreshInterval = setInterval(() => void reload(), 15000);
    return () => {
      reloadRevision.current++;
      dispose();
      clearInterval(ageInterval);
      clearInterval(refreshInterval);
    };
  }, []);

  async function updateTicket(id: string, action: "accept" | "done") {
    if (actionLocks.current.has(id)) return;
    actionLocks.current.add(id);
    onBusyChange?.(true);
    setBusyIds(new Set(actionLocks.current));
    setError("");
    try {
      const { kot } = await apiFetch<{ kot: Kot }>(`/api/kots/${id}/${action}`, { method: "POST" });
      reloadRevision.current++;
      setKots((current) => action === "done" ? current.filter((ticket) => ticket.id !== id) : current.map((ticket) => ticket.id === id ? { ...ticket, ...kot } : ticket));
      void reload().catch(() => {});
    } catch (error) {
      setError(error instanceof Error ? error.message : "Could not update the kitchen ticket. Please retry.");
      void reload().catch(() => {});
    } finally {
      actionLocks.current.delete(id);
      onBusyChange?.(actionLocks.current.size > 0);
      setBusyIds(new Set(actionLocks.current));
    }
  }

  function age(createdAt: number): string {
    const mins = Math.floor((Date.now() - createdAt) / 60000);
    return mins === 0 ? "just now" : `${mins} min`;
  }

  return <section className="screen">
    <div className="page-header"><div><h2>Kitchen display</h2></div><span className="role-badge">{kots.length} active tickets</span></div>
    {!connected && <div className="alert" role="status">Reconnecting to the main POS… {loaded ? "Showing the last received tickets." : "Waiting for live tickets."}</div>}
    {loadError && <div className="alert" role="alert">Tickets could not refresh: {loadError} <button onClick={() => void reload()}>Retry</button></div>}
    {standalone && <div className="kitchen-connection" role="status"><span>{connected && !loadError ? "Connected to POS" : "Connection needs attention"}</span>{lastUpdated && <span>Updated {new Date(lastUpdated).toLocaleTimeString()}</span>}</div>}
    {error && <div className="error-message" role="alert">{error}</div>}
    {!loaded && !loadError && <p role="status">Loading kitchen tickets…</p>}
    {loaded && !loadError && kots.length === 0 && <div className="panel empty-state"><Icon name="kitchen" size={36} /><h3>No active tickets</h3></div>}
    <div className="kitchen-grid">{kots.map((kot) => <article className="kitchen-ticket" key={kot.id}>
      <div className="ticket-header"><strong>KOT #{kot.kotNo}</strong><span><Icon name="clock" size={12} /> {age(kot.createdAt)}</span></div>
      <div className="ticket-location">{kot.orderType === "parcel" ? "Parcel" : kot.splitLabel && kot.splitLabel !== "A" ? `${kot.tableName ?? "Table"} · ${kot.splitLabel}` : kot.tableName ?? "Table"}</div>
      <p className="muted">{kot.acceptedAt != null || kot.doneAt != null ? "Accepted by kitchen" : "Awaiting kitchen acceptance"}</p>
      <ul className="ticket-items">{kot.items.map((item) => <li key={item.id} style={{ textDecoration: item.status === "cancelled" ? "line-through" : "none", opacity: item.status === "cancelled" ? .5 : 1 }}>{item.qty} × {item.name}{item.note && <small>{item.note}</small>}</li>)}</ul>
      {kot.acceptedAt != null || kot.doneAt != null ? <button className="primary soft button-icon" disabled={!connected || !!loadError || busyIds.has(kot.id)} onClick={() => void updateTicket(kot.id, "done")}><Icon name="check" size={17} />{busyIds.has(kot.id) ? "Saving…" : "Done"}</button>
        : <button className="primary button-icon" disabled={!connected || !!loadError || busyIds.has(kot.id)} onClick={() => void updateTicket(kot.id, "accept")}><Icon name="check" size={17} />{busyIds.has(kot.id) ? "Accepting…" : "Accept order"}</button>}
    </article>)}</div>
  </section>;
}
