import { useEffect, useState } from "react";
import { apiFetch } from "../api";
import type { KotWithContext } from "../types";
import { connectWs } from "../ws";

export function Kitchen() {
  const [kots, setKots] = useState<KotWithContext[]>([]);
  const [connected, setConnected] = useState(true);
  const [, setTick] = useState(0); // force re-render for age updates

  async function reload() {
    const { kots } = await apiFetch<{ kots: KotWithContext[] }>("/api/kots");
    setKots(kots);
  }

  useEffect(() => {
    void reload();
    const dispose = connectWs({
      onEvent: (event) => {
        if (event === "kot.created" || event === "kot.updated" || event === "order.updated") void reload();
      },
      onStatus: (c) => { setConnected(c); if (c) void reload(); },
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
      void reload();
    }
  }

  function age(createdAt: number): string {
    const mins = Math.floor((Date.now() - createdAt) / 60000);
    return mins === 0 ? "just now" : `${mins} min`;
  }

  return (
    <div style={{ fontFamily: "system-ui", padding: 16 }}>
      {!connected && (
        <div style={{ padding: 12, backgroundColor: "#fff3cd", borderRadius: 4, marginBottom: 16 }}>
          Reconnecting…
        </div>
      )}
      <h2>Kitchen Display</h2>
      {kots.length === 0 && <p style={{ color: "#777" }}>No active KOTs.</p>}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))", gap: 16 }}>
        {kots.map((kot) => (
          <div key={kot.id} style={{ border: "2px solid #333", borderRadius: 8, padding: 16, backgroundColor: "#fffbf0" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
              <div style={{ fontSize: 20, fontWeight: 700 }}>KOT #{kot.kotNo}</div>
              <div style={{ fontSize: 14, color: "#555" }}>{age(kot.createdAt)}</div>
            </div>
            <div style={{ fontSize: 14, marginBottom: 8 }}>{kot.tableName ?? "Parcel"}</div>
            <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
              {kot.items.map((item) => (
                <li
                  key={item.id}
                  style={{
                    padding: "4px 0",
                    textDecoration: item.status === "cancelled" ? "line-through" : "none",
                    opacity: item.status === "cancelled" ? 0.5 : 1,
                  }}
                >
                  {item.qty} × {item.name}
                  {item.note && <div style={{ fontSize: 12, color: "#555", fontStyle: "italic" }}>({item.note})</div>}
                </li>
              ))}
            </ul>
            <button onClick={() => void markDone(kot.id)} style={{ marginTop: 12, padding: "10px 24px", fontWeight: 700, width: "100%" }}>
              Done
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
