import { useEffect, useState } from "react";
import { apiFetch, session } from "../api";
import type { KotWithContext } from "../types";
import { connectWs } from "../ws";
import { Icon } from "../Icon";

export function Kitchen() {
  const [kots, setKots] = useState<KotWithContext[]>([]);
  const [connected, setConnected] = useState(true);
  const [, setTick] = useState(0); // force re-render for age updates

  async function reload() {
    const { kots } = await apiFetch<{ kots: KotWithContext[] }>("/api/kots");
    setKots(kots);
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
    return () => {
      dispose();
      clearInterval(ageInterval);
    };
  }, []);

  async function markDone(id: string) {
    try {
      await apiFetch(`/api/kots/${id}/done`, { method: "POST" });
      await reload();
    } catch {
      void reload().catch(() => {});
    }
  }

  function age(createdAt: number): string {
    const mins = Math.floor((Date.now() - createdAt) / 60000);
    return mins === 0 ? "just now" : `${mins} min`;
  }

  return <section className="screen">
    <div className="page-header"><div><h2>Kitchen display</h2></div><span className="role-badge">{kots.length} active tickets</span></div>
    {!connected && <div className="alert" role="status">Reconnecting…</div>}
    {kots.length === 0 && <div className="panel empty-state"><Icon name="kitchen" size={36} /><h3>No active tickets</h3></div>}
    <div className="kitchen-grid">{kots.map((kot) => <article className="kitchen-ticket" key={kot.id}>
      <div className="ticket-header"><strong>KOT #{kot.kotNo}</strong><span><Icon name="clock" size={12} /> {age(kot.createdAt)}</span></div>
      <div className="ticket-location">{kot.orderType === "parcel" ? "Parcel" : kot.splitLabel && kot.splitLabel !== "A" ? `${kot.tableName ?? "Table"} · ${kot.splitLabel}` : kot.tableName ?? "Table"}</div>
      <ul className="ticket-items">{kot.items.map((item) => <li key={item.id} style={{ textDecoration: item.status === "cancelled" ? "line-through" : "none", opacity: item.status === "cancelled" ? .5 : 1 }}>{item.qty} × {item.name}{item.note && <small>{item.note}</small>}</li>)}</ul>
      <button className="primary soft button-icon" onClick={() => void markDone(kot.id)}><Icon name="check" size={17} />Done</button>
    </article>)}</div>
  </section>;
}
